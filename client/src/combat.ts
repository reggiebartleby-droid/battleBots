/**
 * Real-time damage resolution on top of Havok collision events.
 * Weapon-driven targeting: the hit socket is chosen from where the attacker
 * struck the defender (front / side / rear), not by the player.
 *
 * A contact only does damage if the attacker's weapon is LIVE (see weapon.ts):
 * spinner spun up, hammer/flipper mid-swing, lifter/grappler key held.
 * Everything else is a "bump" — feedback only, no damage.
 *
 * v0.7 "plain physics":
 *  - NO separation impulse, NO wedge rule, NO traction cuts, NO hitstop. Shoves, lifts, climbs
 *    and tumbles come from the compound collision shapes (bot.ts) and mass.
 *  - Damage scales with the contact impulse Havok actually resolved (ev.impulse), so a hard
 *    hit hurts more than a graze; falls back to closing speed if the solver gives no impulse.
 *  - (v0.20: the old stand-in weapon impulse, aim cone and spin reset were removed -- every weapon is a
 *    real body now, so none of it ever ran.)
 *
 * v0.8 real vertical spinners (bot.spinner): no stand-in impulse, no spin reset, no aim cone.
 *  The weapon body's own collisions decide everything. Damage = rotational energy the weapon
 *  LOST while touching the opponent (measured before/after each physics step) / SPIN_DMG.joulesPerDmg.
 *  Chassis contacts of a real-spinner bot are bumps.
 *
 * v0.10 real overhead arms (bot.arm) and the saw on the arm (bot.saw) use the same rule: energy the arm
 *  (relative to the chassis) or the saw disc loses while touching the opponent = damage. Each real weapon
 *  body is tracked separately, so a hammer-saw can land a hammer hit and a saw grind at once.
 *
 * v0.12 hinged weapons (flipper plate, lifter / grappler fork + jaw, crusher beak): they move slowly or only
 *  briefly, so "energy the weapon lost" doesn't fit. Damage = energy the weapon GAVE the opponent while touching
 *  (kinetic + lifted height) / HINGE_DMG.joulesPerDmg -- small, like real flippers and lifters. The crusher adds
 *  piercing: hydraulic power pressed into their armor while the beak is closing on them (HINGE_DMG.pierce).
 *  Full-body spinners (shell / cage) are real spinners now, same rule as the others.
 *
 * v0.12 slam damage (real: being thrown is what hurts): a bot that lands hard on the floor within
 *  SLAM.windowMs of touching the opponent's weapon takes impact-energy damage, credited to that opponent.
 *  (Floor landings only for now; walls / hazards are their own topic.)
 *
 * v0.29 Cube Bots look only (user: fun over strict physics there):
 *  - HP = cubes: the part hit is the one whose cubes are nearest where the hit really landed (cubes.ts target),
 *    for weapon hits and slams alike; the crusher keeps its pierce-the-top rule. Plain look: unchanged.
 *  - option 5: a big hit (KNOCK.minDmg+) gives the victim an extra shove away from the attacker, bigger with damage
 *  - option 4: a part that fell off flies for a moment (cubes.ts); what it hits gets shoved by the real body and
 *    takes a little damage (PART_HIT), credited to whoever knocked the part off
 */
import { Vector3, type IPhysicsCollisionEvent, PhysicsEventType } from '@babylonjs/core';
import { applyDamage, canAttack, isProtected, HIT } from '../../src/core/state.js';
import { cubeSkinOf, isLooseBody, creditCubes } from './cubes.js';
import { forward, spinEnergy, armEnergy, energyOf, weaponBodies, chassisBodies, isChassis, CONTROL, type Bot, type BotId } from './bot.js';
import type { PhysicsBody } from '@babylonjs/core';
import type { Fx } from './fx.js';

/** Tuning knobs. */
export const FEEL = {
  continuedMs: 220,                    // how often a persistent contact is re-evaluated
};

/** v0.8 real spinner damage. */
export const SPIN_DMG = {
  joulesPerDmg: 60,      // J of weapon energy lost per point of raw damage
  gapSteps: 3,           // contact considered over after this many physics steps without touching
  maxHitMs: 200,         // a continuous grind is reported as separate hits this often
  minDmg: 1,             // below this the contact is silent (grinding / glancing touch)
};

/** v0.31 temporary tester balance (sandbox AI-vs-AI sims on Normal): weapon damage x this, by weapon kind.
 *  Spinners down, hammer / flipper / lifter up. Kinds not listed: x1. */
// v0.31 temporary tester balance: one hit does at most 15 (no one-shot FINISH HIM); a bot showing FINISH HIM takes x2
Object.assign(HIT, { maxDealt: 15, immobilizedMult: 2 });
export const DMG_SCALE: Record<string, number> = { h_bar: 0.35, disc: 0.7, shell: 0.6, hammer: 2.5, pneumatic_flipper: 5, lifter: 3 };

/** v0.12 hinged weapons: energy given to the opponent while touching. */
export const HINGE_DMG = {
  joulesPerDmg: 120,     // J given to the opponent (kinetic + potential) per point
  lifterJoulesPerDmg: 60,   // v0.13: lifters score 2x for what they lift / throw (Blue Lift was 13% in AI sims)
  maxHitMs: 600,         // a long lift / crush is reported in chunks this long (so armor doesn't eat every tick)
};

/** v0.12 slam damage: thrown bots hurt themselves on landing. */
export const SLAM = {
  minSpeed: 3.5,         // m/s falling speed onto the floor before it counts (a ~0.6 m drop)
  joulesPerDmg: 150,     // impact energy (1/2 m v^2) per point
  windowMs: 2500,        // only after touching the opponent's weapon this recently
  cooldownMs: 400,
};

interface SpinContact { bot: Bot; body: PhysicsBody; mass: number; energy: () => number; eBefore: number; lost: number; touching: boolean; idle: number; start: number; point: Vector3; vsWeapon: boolean; active: boolean;
  gain?: boolean; jPerDmg?: number; maxHitMs?: number; crush?: boolean; eStart?: number;
  /** v0.33 (up to 4 bots): the bot this weapon is touching / last touched (hinged weapons: the nearest one before a touch) */
  victim?: Bot }

export interface HitLog { t: number; attacker: BotId; victim?: BotId; socket: string; dmg: number }
export interface Stats { hits: number; dmg: number; bumps: number; maxImpulse: number }

/** v0.19 arcade score (display only -- the time-out winner is still decided on damage). */
export const SCORE = {
  perHit: 10,          // every damaging hit
  bigHitFrac: 0.4,     // a single hit dealing >= this share of the victim's starting total HP ...
  bigHitBonus: 50,     // ... is a BIG HIT
  flipBonus: 100,      // victim ends up upside down within flipWindowMs of your last weapon touch / hit
  flipWindowMs: 3000,
};
export interface ScoreBonus { text: string; pts: number; t: number }

/** v0.29 option 5 (Cube Bots look): big hits knock the victim further than the physics alone would. */
export const KNOCK = {
  minDmg: 10,          // a hit dealing at least this much ...
  dvPerDmg: 0.12,      // ... adds this much speed (m/s) per point from minDmg up ...
  maxDv: 3.0,          // ... up to this
  up: 0.45,            // share of it that goes upward
  atPoint: 0.5,        // 0 = through the centre (pure shove), 1 = at the contact point (more tumble)
};

/** v0.29 option 4 (Cube Bots look): a part that fell off hitting a bot. */
export const PART_HIT = {
  minSpeed: 1.5,       // m/s closing speed before it hurts
  joulesPerDmg: 30,    // impact energy per point
  maxDmg: 8,           // small: one flying part never does more than this
};

/** v0.40 every hit goes through here: race upgrades (armour plating, rear ram) soak part of it first. */
function hurt(victim: Bot, socket: string, raw: number, point: Vector3 | undefined): number {
  return applyDamage(victim.state, socket, victim.shield ? Math.round(victim.shield(raw, point)) : raw);
}

export class Combat {
  private lastContinued = 0;
  log: HitLog[] = [];
  stats: Record<string, Stats> = {};
  /** v0.19 arcade score + the latest bonus (HUD shows it for a moment). */
  score: Record<string, number> = {};
  lastBonus: Partial<Record<string, ScoreBonus>> = {};

  /** v0.19: points for a damaging hit (+ BIG HIT bonus). */
  private credit(attacker: Bot, defender: Bot, dealt: number) {
    creditCubes(defender.id, attacker.id);   // v0.47 the cubes this hit knocks off are the attacker's damage
    this.lastBy.set(defender.id, { by: attacker.id, t: performance.now() });
    if (dealt <= 0) return;
    this.score[attacker.id] += SCORE.perHit + dealt;
    const startHp = Object.values(defender.state.parts).reduce((a, p) => a + p.maxHp, 0);
    if (dealt >= startHp * SCORE.bigHitFrac) this.bonus(attacker, 'BIG HIT', SCORE.bigHitBonus);
  }
  /** v0.47 the rival that last hit each bot, and when (race: who gets the KO bonus) */
  private lastBy = new Map<string, { by: BotId; t: number }>();
  /** v0.47 the rival whose hit landed on `victim` within `ms` -- undefined = nobody (or a hazard since) */
  lastAttacker(victim: Bot, ms: number): BotId | undefined {
    const l = this.lastBy.get(victim.id);
    return l && performance.now() - l.t <= ms ? l.by : undefined;
  }
  private bonus(attacker: Bot, text: string, pts: number) {
    this.score[attacker.id] += pts;
    this.lastBonus[attacker.id] = { text, pts, t: performance.now() };
  }
  /** v0.19: a bot just went upside down -- if the opponent's weapon touched / hit it recently, that's a FLIP. */
  onFlipped(victim: Bot) {
    const now = performance.now();
    const touch = this.lastWeaponTouch.get(victim.id);
    const lastHit = [...this.log].reverse().find(h => h.attacker !== victim.id && (h.victim ?? this.other(victim).id) === victim.id);
    // v0.33: whoever touched / hit it last (2 bots: always the opponent, as before)
    const other = touch && touch.by !== victim && now - touch.t <= SCORE.flipWindowMs ? touch.by
      : lastHit && now - lastHit.t <= SCORE.flipWindowMs ? this.bots.find(b => b.id === lastHit.attacker) : undefined;
    if (other) this.bonus(other, 'FLIP', SCORE.flipBonus);
  }

  private spin: SpinContact[] = [];

  constructor(private bots: Bot[], private fx: Fx) {
    this.bots = [...bots];
    for (const b of bots) this.register(b);
  }

  /** v0.33 race: a bot respawned (new bodies) -- swap it in. Its stats / score carry on under the same id. */
  replaceBot(old: Bot | undefined, b: Bot) {
    if (old) { this.bots = this.bots.filter(x => x !== old); this.spin = this.spin.filter(c => c.bot !== old); }
    this.bots.push(b);
    this.register(b);
  }

  /** v0.49b Big Arena: a bot that's out is deleted (its bodies go) -- stop tracking it. */
  removeBot(old: Bot) { this.bots = this.bots.filter(x => x !== old); this.spin = this.spin.filter(c => c.bot !== old); }

  /** v0.40 the rear spiked ram's piston punch (upgrades.ts): a scripted hit, credited to the ram's bot. */
  scriptedHit(attacker: Bot, victim: Bot, point: Vector3, raw: number): number {
    const alive = (id: string) => (victim.state.parts[id]?.hp ?? 0) > 0;
    const socket = this.cubeSocket(victim, point) ?? ['armor', 'armor_1', 'armor_2', 'front', 'wheels', 'motor'].find(alive) ?? Object.keys(victim.state.parts).find(alive);
    if (!socket) return 0;
    const dealt = hurt(victim, socket, raw, point);
    const now = performance.now();
    this.stats[attacker.id] ??= { hits: 0, dmg: 0, bumps: 0, maxImpulse: 0 };
    this.score[attacker.id] ??= 0;
    this.log.push({ t: now, attacker: attacker.id, victim: victim.id, socket, dmg: dealt });
    this.stats[attacker.id].hits++;
    this.stats[attacker.id].dmg += dealt;
    this.credit(attacker, victim, dealt);
    victim.lastHit = { socket, t: now };
    this.lastWeaponTouch.set(victim.id, { t: now, by: attacker });
    this.fx.hit(point, dealt, victim, attacker.build.cosmetics.paint ?? '#fff');
    return dealt;
  }

  /** v0.33 race hazards (kill saws, hammer): damage with no attacker. Same part pick as a slam. */
  environmentHit(victim: Bot, point: Vector3, raw: number, color = '#ff5533'): number {
    const alive = (id: string) => (victim.state.parts[id]?.hp ?? 0) > 0;
    const socket = this.cubeSocket(victim, point) ?? ['armor', 'armor_1', 'armor_2', 'wheels', 'front', 'motor', 'weapon_motor'].find(alive) ?? Object.keys(victim.state.parts).find(alive);
    if (!socket) return 0;
    const dealt = hurt(victim, socket, raw, point);
    victim.lastHit = { socket, t: performance.now() };
    creditCubes(victim.id, undefined); this.lastBy.delete(victim.id);   // v0.47 hazards: nobody's damage, nobody's KO
    this.fx.hit(point, dealt, victim, color);
    return dealt;
  }

  private register(b: Bot) {
    this.stats[b.id] ??= { hits: 0, dmg: 0, bumps: 0, maxImpulse: 0 };
    this.score[b.id] ??= 0;
    {
      b.body.getCollisionObservable().add(ev => this.onCollision(b, ev));
      b.onPartOff = body => {                                             // v0.29 option 4
        let done = false;
        body.getCollisionObservable().add(ev => { if (!done) done = this.onLoosePart(b, body, ev); });
      };
      const add = (body: PhysicsBody, mass: number, energy: () => number) => {
        const c: SpinContact = { bot: b, body, mass, energy, eBefore: 0, lost: 0, touching: false, idle: 0, start: 0, point: Vector3.Zero(), vsWeapon: false, active: false };
        this.spin.push(c);
        body.getCollisionObservable().add(ev => this.onWeaponCollision(c, ev));
      };
      if (b.spinner) add(b.spinner.body, b.spinner.mass, () => spinEnergy(b));
      if (b.arm) add(b.arm.body, b.arm.mass, () => armEnergy(b));
      if (b.saw) { const s = b.saw; add(s.body, s.mass, () => energyOf(s)); }
      if (b.hinges?.length) {
        // one contact for all hinged pieces (fork + jaw would double count): energy GIVEN to the opponent
        const c: SpinContact = { bot: b, body: b.hinges[0].body, mass: b.hinges.reduce((a, h) => a + h.mass, 0), energy: () => (c.victim ? botEnergy(c.victim) : 0) + (this.pierceJ.get(b.id) ?? 0),
          eBefore: 0, lost: 0, touching: false, idle: 0, start: 0, point: Vector3.Zero(), vsWeapon: false, active: false,
          gain: true, jPerDmg: b.weaponKind === 'lifter' ? HINGE_DMG.lifterJoulesPerDmg : HINGE_DMG.joulesPerDmg, maxHitMs: b.weaponKind === 'crusher' ? CONTROL.crusher.hitMs : HINGE_DMG.maxHitMs, crush: b.weaponKind === 'crusher' };
        this.spin.push(c);
        for (const h of b.hinges) h.body.getCollisionObservable().add(ev => this.onWeaponCollision(c, ev));
      }
    }
    // v0.12 slam damage: chassis hitting floor / walls
    for (const body of [...chassisBodies(b), ...weaponBodies(b).map(w => w.body)]) body.getCollisionObservable().add(ev => this.onSlam(b, ev));   // v0.21: + real wheels
  }

  private pierceJ = new Map<string, number>();
  private vBefore = new Map<string, Vector3>();
  private lastWeaponTouch = new Map<string, { t: number; by: Bot }>();
  private lastSlam = new Map<string, number>();

  /** Hard landing / wall hit after being thrown by the opponent's weapon. */
  private onSlam(self: Bot, ev: IPhysicsCollisionEvent) {
    if (ev.type !== PhysicsEventType.COLLISION_STARTED) return;
    if (this.ownerOf(ev.collidedAgainst, self)) return;                  // v0.33: any other bot
    if (isChassis(self, ev.collidedAgainst) || weaponBodies(self).some(w => w.body === ev.collidedAgainst)) return;
    if (isLooseBody(ev.collidedAgainst)) return;                         // v0.29 landing on a flying part isn't a slam
    const touch = this.lastWeaponTouch.get(self.id);
    const now = performance.now();
    if (!touch || now - touch.t > SLAM.windowMs) return;
    if (now - (this.lastSlam.get(self.id) ?? -1e9) < SLAM.cooldownMs) return;
    const m = self.body.getMassProperties().mass ?? 50;
    // impact speed = velocity before the step along the contact normal (Havok splits the impulse over contact points)
    const vb = this.vBefore.get(self.id) ?? Vector3.Zero();
    // floor landings only (a bot that was just touched and then drives into a wall shouldn't count)
    const n = ev.normal && ev.normal.lengthSquared() > 0.5 ? ev.normal : new Vector3(0, 1, 0);
    if (Math.abs(n.y) < 0.7 || vb.y > 0) return;
    const v = -vb.y;
    if (v < SLAM.minSpeed) return;
    const raw = Math.round(0.5 * m * v * v / SLAM.joulesPerDmg);
    if (raw < 1) return;
    this.lastSlam.set(self.id, now);
    const up = Vector3.TransformNormal(Vector3.Up(), self.root.getWorldMatrix()).y;
    const alive = (id: string) => (self.state.parts[id]?.hp ?? 0) > 0;
    // landed on its back -> top armor takes it; on its wheels / side -> wheels, then side armor
    const order = up < 0 ? ['armor', 'armor_1', 'armor_2', 'weapon', 'motor'] : ['wheels', 'armor_1', 'armor_2', 'armor', 'motor'];
    const socket = this.cubeSocket(self, ev.point ?? undefined) ?? order.find(alive) ?? Object.keys(self.state.parts).find(alive);   // v0.29 HP = cubes
    if (!socket) return;
    const dealt = hurt(self, socket, raw, ev.point ?? undefined);
    const by = touch.by;
    this.log.push({ t: now, attacker: by.id, victim: self.id, socket, dmg: dealt });
    this.stats[by.id].hits++;
    this.stats[by.id].dmg += dealt;
    this.credit(by, self, dealt);
    self.lastHit = { socket, t: now };
    this.slams++;
    this.fx.hit(ev.point ?? self.root.position, dealt, self, by.build.cosmetics.paint ?? '#fff');
  }
  slams = 0;

  /** v0.12 crusher: hydraulic power pressed into the opponent (J), added while the beak is closing on them. */
  private addPierce(c: SpinContact, dt: number) {
    const b = c.bot;
    if (!c.crush || !b.weapon.held || !canAttack(b.state)) return;
    const beak = b.hinges?.find(h => h.role === 'beak');
    if (!beak || beak.state !== 'hold') return;
    this.pierceJ.set(b.id, (this.pierceJ.get(b.id) ?? 0) + CONTROL.crusher.pierceW * dt);
  }

  /** scene.onBeforePhysicsObservable: remember each real weapon's energy before the step. */
  beforePhysics() {
    for (const b of this.bots) this.vBefore.set(b.id, b.body.getLinearVelocity().clone());
    for (const c of this.spin) {
      if (c.gain && !c.active) c.victim = this.nearest(c.bot);           // v0.33: hinged weapons measure the nearest bot
      c.eBefore = c.energy();
      c.touching = false;
    }
  }

  /** scene.onAfterPhysicsObservable: energy the weapon lost during a step it spent touching the opponent = the hit.
   *  v0.12 hinged weapons: energy the opponent GAINED during such a step. */
  afterPhysics(dt = 1 / 60) {
    const now = performance.now();
    for (const c of this.spin) {
      const b = c.bot;
      if (c.touching) {
        if (!c.active) { c.active = true; c.lost = 0; c.start = now; c.eStart = c.eBefore; }
        if (c.gain) {
          // net gain over the contact (peak), not a sum of every jiggle
          this.addPierce(c, dt);
          c.lost = Math.max(c.lost, c.energy() - (c.eStart ?? c.eBefore));
        } else c.lost += Math.max(0, c.eBefore - c.energy());
        c.idle = 0;
      } else if (c.active) {
        c.idle++;
      }
      if (c.active && (c.idle >= SPIN_DMG.gapSteps || now - c.start >= (c.maxHitMs ?? SPIN_DMG.maxHitMs))) {
        if (c.victim) this.spinHit(b, c.victim, c);
        c.active = false; c.lost = 0;
      }
    }
  }

  private onWeaponCollision(c: SpinContact, ev: IPhysicsCollisionEvent) {
    const self = c.bot;
    if (ev.type !== PhysicsEventType.COLLISION_STARTED && ev.type !== PhysicsEventType.COLLISION_CONTINUED) return;
    const other = this.ownerOf(ev.collidedAgainst, self);                // v0.33: whichever bot it touched
    if (!other) return;                                                  // floor / wall / own chassis (v0.21: their wheels count as their chassis)
    const hitW = weaponBodies(other).find(w => w.body === ev.collidedAgainst);
    const vsWeapon = !!hitW;
    if (!c.gain || !c.active) c.victim = other;
    c.touching = true;
    this.lastWeaponTouch.set(other.id, { t: performance.now(), by: self });   // v0.12 slam credit
    c.point = this.contactPoint(self, other, ev);
    c.vsWeapon = vsWeapon;
    // hardest-contact stat (equivalent closing speed)
    const ma = c.mass, mb = (hitW ? hitW.mass : other.body.getMassProperties().mass) ?? 50;
    if (Number.isFinite(ev.impulse) && ev.impulse > 0) {
      const v = ev.impulse / ((ma * mb) / (ma + mb));
      this.stats[self.id].maxImpulse = Math.max(this.stats[self.id].maxImpulse, Math.round(v * 10) / 10);
    }
  }

  private spinHit(attacker: Bot, defender: Bot, c: SpinContact) {
    const raw = canAttack(attacker.state) ? Math.round(c.lost / (c.jPerDmg ?? SPIN_DMG.joulesPerDmg) * (DMG_SCALE[attacker.weaponKind ?? ''] ?? 1) * (attacker.dmgMul ?? 1)) : 0;   // v0.31 DMG_SCALE; v0.40 weapon upgrade
    if (raw < SPIN_DMG.minDmg) return;
    const alive = (id: string) => (defender.state.parts[id]?.hp ?? 0) > 0;
    // crusher pierces the top: top armor, then the insides (weapon motor, drive motor)
    const crushSocket = c.crush ? ['armor', 'armor_1', 'armor_2', 'weapon_motor', 'motor', 'weapon'].find(alive) : undefined;
    // a flip / lift gets under them: socket from the hit direction even if the plate touched their weapon
    const socket = crushSocket ?? this.cubeSocket(defender, c.point) ?? (c.vsWeapon && alive('weapon') && !c.gain ? 'weapon' : pickSocket(defender, attacker));   // v0.29 HP = cubes
    const dealt = hurt(defender, socket, raw, c.point);
    const now = performance.now();
    this.log.push({ t: now, attacker: attacker.id, victim: defender.id, socket, dmg: dealt });
    this.stats[attacker.id].hits++;
    this.stats[attacker.id].dmg += dealt;
    this.credit(attacker, defender, dealt);
    defender.lastHit = { socket, t: now };
    this.fx.hit(c.point, dealt, defender, attacker.build.cosmetics.paint ?? '#fff');
    this.bigKnock(attacker, defender, c.point, dealt);
  }

  /** v0.29 HP = cubes (Cube Bots look only): the part nearest where the hit landed that can still take damage
   *  (alive, and not an unbreakable weapon already at its 1-HP floor). undefined = plain look / nothing left. */
  private cubeSocket(defender: Bot, point: Vector3 | null | undefined): string | undefined {
    const sk = cubeSkinOf(defender.root);
    if (!sk?.bot || !point) return undefined;
    const st = defender.state;
    return sk.target(point, sid => {
      const ps = st.parts[sid];
      return !!ps && ps.hp > 0 && !isProtected(st, ps);   // v0.31: hits go straight past unbreakable weapons (they were free armour)
    });
  }

  /** v0.29 option 5 (Cube Bots look only): a big hit shoves the victim away from the attacker (and up). */
  private bigKnock(attacker: Bot, defender: Bot, point: Vector3, dealt: number) {
    if (dealt < KNOCK.minDmg || !cubeSkinOf(defender.root) || defender.eliminated) return;
    const dv = Math.min(KNOCK.maxDv, KNOCK.dvPerDmg * (dealt - KNOCK.minDmg + 1));
    const dir = defender.root.position.subtract(attacker.root.position); dir.y = 0;
    if (dir.lengthSquared() < 1e-4) dir.set(0, 0, 1);
    dir.normalize().scaleInPlace(1 - KNOCK.up).addInPlaceFromFloats(0, KNOCK.up, 0).normalize();
    const m = defender.body.getMassProperties().mass ?? 50;
    const at = Vector3.Lerp(defender.body.getObjectCenterWorld(), point, KNOCK.atPoint);
    defender.body.applyImpulse(dir.scale(m * dv), at);
    this.knocks++;
  }
  knocks = 0;

  /** v0.29 option 4: a part that fell off `owner` hit something. Bots take a little damage (once per part),
   *  credited to whoever knocked it off (owner's opponent) -- unless that's who it hit. true = done. */
  private onLoosePart(owner: Bot, body: PhysicsBody, ev: IPhysicsCollisionEvent): boolean {
    if (ev.type !== PhysicsEventType.COLLISION_STARTED) return false;
    const victim = this.bots.find(b => isChassis(b, ev.collidedAgainst) || weaponBodies(b).some(w => w.body === ev.collidedAgainst));
    if (!victim || victim.eliminated) return false;
    const m = body.getMassProperties().mass ?? 5, M = victim.body.getMassProperties().mass ?? 50;
    const mu = (m * M) / (m + M);
    let v = Number.isFinite(ev.impulse) && ev.impulse > 0 ? ev.impulse / mu : 0;
    if (!v) v = body.getLinearVelocity().subtract(victim.body.getLinearVelocity()).length();
    if (v < PART_HIT.minSpeed) return false;
    const raw = Math.min(PART_HIT.maxDmg, Math.round(0.5 * mu * v * v / PART_HIT.joulesPerDmg));
    if (raw < 1) return false;
    const point = ev.point ?? body.transformNode.getAbsolutePosition();
    const alive = (id: string) => (victim.state.parts[id]?.hp ?? 0) > 0;
    const socket = this.cubeSocket(victim, point) ?? Object.keys(victim.state.parts).find(alive);
    if (!socket) return true;
    const dealt = hurt(victim, socket, raw, point);
    const touch = this.lastWeaponTouch.get(owner.id);
    const knocker = touch && touch.by !== owner ? touch.by : this.bots.find(b => b !== owner);   // v0.33: who last hit the owner
    const now = performance.now();
    victim.lastHit = { socket, t: now };
    this.partHits++;
    if (!knocker || knocker === victim) creditCubes(victim.id, undefined);   // v0.47
    if (knocker && knocker !== victim) {
      this.log.push({ t: now, attacker: knocker.id, victim: victim.id, socket, dmg: dealt });
      this.stats[knocker.id].hits++;
      this.stats[knocker.id].dmg += dealt;
      this.credit(knocker, victim, dealt);
    }
    this.fx.hit(point, dealt, victim, (knocker ?? owner).build.cosmetics.paint ?? '#fff');
    return true;
  }
  partHits = 0;

  private other(b: Bot) { return this.bots.find(x => x !== b)!; }
  /** v0.33: the bot (other than `self`) that owns this body -- chassis, wheel or real weapon. */
  private ownerOf(body: PhysicsBody | undefined, self: Bot): Bot | undefined {
    if (!body) return undefined;
    return this.bots.find(b => b !== self && !b.eliminated && (isChassis(b, body) || weaponBodies(b).some(w => w.body === body)));
  }
  /** v0.33: nearest other bot still in play. */
  private nearest(self: Bot): Bot | undefined {
    let best: Bot | undefined, d = Infinity;
    for (const b of this.bots) {
      if (b === self || b.eliminated) continue;
      const x = Vector3.DistanceSquared(b.root.position, self.root.position);
      if (x < d) { d = x; best = b; }
    }
    return best;
  }

  private onCollision(self: Bot, ev: IPhysicsCollisionEvent) {
    // wall/floor hit: no damage. v0.8: the other bot's real weapons count as that bot. v0.33: any other bot.
    const other = this.ownerOf(ev.collidedAgainst, self);
    if (!other) return;
    const vsHub = weaponBodies(other).some(w => w.body === ev.collidedAgainst);
    if (ev.type === PhysicsEventType.COLLISION_STARTED) {
      this.resolve(self, other, ev, !vsHub);           // touching a spinning weapon isn't announced as a bump
    } else if (ev.type === PhysicsEventType.COLLISION_CONTINUED) {
      // Persistent contact (push / grind): re-check at a fixed rate
      const now = performance.now();
      if (now - this.lastContinued < FEEL.continuedMs) return;
      this.lastContinued = now;
      this.resolve(self, other, ev, false);
    }
  }

  private contactPoint(a: Bot, b: Bot, ev: IPhysicsCollisionEvent) {
    return ev.point ?? a.root.position.add(b.root.position).scale(0.5);
  }

  /** How hard the contact was, as an equivalent closing speed (m/s): solver impulse / reduced mass. */
  private contactSpeed(a: Bot, b: Bot, ev: IPhysicsCollisionEvent, toDef: Vector3): number {
    const ma = a.body.getMassProperties().mass ?? 50, mb = b.body.getMassProperties().mass ?? 50;
    const reduced = (ma * mb) / (ma + mb);
    const imp = ev.impulse;
    if (Number.isFinite(imp) && imp > 0) return imp / reduced;
    // fallback: relative closing speed along the attack line
    const rel = a.body.getLinearVelocity().subtract(b.body.getLinearVelocity());
    return Math.max(0, Vector3.Dot(rel, toDef));
  }

  /** Chassis-to-chassis (or chassis-to-weapon) contact. Every weapon is a real body, so its damage is measured
   *  from its own collisions (afterPhysics); a chassis contact is a bump. Only the hit-speed stat is kept here. */
  private resolve(attacker: Bot, defender: Bot, ev: IPhysicsCollisionEvent, started: boolean) {
    const point = this.contactPoint(attacker, defender, ev);
    const toDef = defender.root.position.subtract(attacker.root.position); toDef.y = 0; toDef.normalize();
    const speed = this.contactSpeed(attacker, defender, ev, toDef);
    this.stats[attacker.id].maxImpulse = Math.max(this.stats[attacker.id].maxImpulse, Math.round(speed * 10) / 10);
    if (started) this.bump(attacker, point);
  }

  private bump(attacker: Bot, point: Vector3) {
    this.stats[attacker.id].bumps++;
    this.fx.bump(point);
  }
}

/** Kinetic + potential energy of a bot's chassis, J (what a flipper / lifter puts into it). */
function botEnergy(b: Bot): number {
  const m = b.body.getMassProperties().mass ?? 50;
  const v = b.body.getLinearVelocity();
  return 0.5 * m * v.lengthSquared() + m * 9.81 * Math.max(0, b.root.position.y);
}

/** Where on the defender did the attacker hit? Front → front/armor, side → armor, rear → wheels/motor. */
function pickSocket(defender: Bot, attacker: Bot): string {
  const alive = (id: string) => (defender.state.parts[id]?.hp ?? 0) > 0;
  const toAtt = attacker.root.position.subtract(defender.root.position); toAtt.y = 0; toAtt.normalize();
  const fwd = forward(defender); fwd.y = 0; fwd.normalize();
  const right = Vector3.Cross(Vector3.Up(), fwd);
  const f = Vector3.Dot(fwd, toAtt), r = Vector3.Dot(right, toAtt);

  const firstAlive = (...ids: string[]) => ids.find(alive);
  const anyAlive = () => Object.keys(defender.state.parts).find(alive) ?? 'weapon';

  if (f > 0.5)  return firstAlive('front', 'weapon', 'weapon_motor', 'armor', 'armor_1', 'armor_2') ?? anyAlive();
  if (f < -0.5) return firstAlive('wheels', 'motor', 'armor', 'armor_1', 'armor_2', 'weapon_motor') ?? anyAlive();
  // side hits: full-body spinners have no armor, so the shell takes it
  const side = r > 0 ? ['armor_2'] : ['armor_1'];
  return firstAlive(...side, 'armor', 'wheels', 'secondary', 'weapon_motor', 'weapon', 'motor') ?? anyAlive();
}
