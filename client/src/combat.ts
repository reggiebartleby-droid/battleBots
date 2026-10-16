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
 */
import { Vector3, type IPhysicsCollisionEvent, PhysicsEventType } from '@babylonjs/core';
import { applyDamage, canAttack } from '../../src/core/state.js';
import { forward, spinEnergy, armEnergy, energyOf, weaponBodies, CONTROL, type Bot } from './bot.js';
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
  gain?: boolean; jPerDmg?: number; maxHitMs?: number; crush?: boolean; eStart?: number }

export interface HitLog { t: number; attacker: 'A' | 'B'; socket: string; dmg: number }
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

export class Combat {
  private lastContinued = 0;
  log: HitLog[] = [];
  stats: Record<'A' | 'B', Stats> = { A: { hits: 0, dmg: 0, bumps: 0, maxImpulse: 0 }, B: { hits: 0, dmg: 0, bumps: 0, maxImpulse: 0 } };
  /** v0.19 arcade score + the latest bonus (HUD shows it for a moment). */
  score: Record<'A' | 'B', number> = { A: 0, B: 0 };
  lastBonus: Partial<Record<'A' | 'B', ScoreBonus>> = {};

  /** v0.19: points for a damaging hit (+ BIG HIT bonus). */
  private credit(attacker: Bot, defender: Bot, dealt: number) {
    if (dealt <= 0) return;
    this.score[attacker.id] += SCORE.perHit + dealt;
    const startHp = Object.values(defender.state.parts).reduce((a, p) => a + p.maxHp, 0);
    if (dealt >= startHp * SCORE.bigHitFrac) this.bonus(attacker, 'BIG HIT', SCORE.bigHitBonus);
  }
  private bonus(attacker: Bot, text: string, pts: number) {
    this.score[attacker.id] += pts;
    this.lastBonus[attacker.id] = { text, pts, t: performance.now() };
  }
  /** v0.19: a bot just went upside down -- if the opponent's weapon touched / hit it recently, that's a FLIP. */
  onFlipped(victim: Bot) {
    const now = performance.now();
    const other = this.other(victim);
    const touch = this.lastWeaponTouch.get(victim.id);
    const lastHit = [...this.log].reverse().find(h => h.attacker === other.id);
    const recent = (touch && touch.by === other && now - touch.t <= SCORE.flipWindowMs) || (lastHit && now - lastHit.t <= SCORE.flipWindowMs);
    if (recent) this.bonus(other, 'FLIP', SCORE.flipBonus);
  }

  private spin: SpinContact[] = [];

  constructor(private bots: Bot[], private fx: Fx) {
    for (const b of bots) {
      b.body.getCollisionObservable().add(ev => this.onCollision(b, ev));
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
        const other = this.other(b);
        const c: SpinContact = { bot: b, body: b.hinges[0].body, mass: b.hinges.reduce((a, h) => a + h.mass, 0), energy: () => botEnergy(other) + (this.pierceJ.get(b.id) ?? 0),
          eBefore: 0, lost: 0, touching: false, idle: 0, start: 0, point: Vector3.Zero(), vsWeapon: false, active: false,
          gain: true, jPerDmg: b.weaponKind === 'lifter' ? HINGE_DMG.lifterJoulesPerDmg : HINGE_DMG.joulesPerDmg, maxHitMs: b.weaponKind === 'crusher' ? CONTROL.crusher.hitMs : HINGE_DMG.maxHitMs, crush: b.weaponKind === 'crusher' };
        this.spin.push(c);
        for (const h of b.hinges) h.body.getCollisionObservable().add(ev => this.onWeaponCollision(c, ev));
      }
    }
    // v0.12 slam damage: chassis hitting floor / walls
    for (const b of bots) for (const body of [b.body, ...weaponBodies(b).map(w => w.body)]) body.getCollisionObservable().add(ev => this.onSlam(b, ev));
  }

  private pierceJ = new Map<string, number>();
  private vBefore = new Map<string, Vector3>();
  private lastWeaponTouch = new Map<string, { t: number; by: Bot }>();
  private lastSlam = new Map<string, number>();

  /** Hard landing / wall hit after being thrown by the opponent's weapon. */
  private onSlam(self: Bot, ev: IPhysicsCollisionEvent) {
    if (ev.type !== PhysicsEventType.COLLISION_STARTED) return;
    const other = this.other(self);
    if (ev.collidedAgainst === other.body || weaponBodies(other).some(w => w.body === ev.collidedAgainst)) return;
    if (ev.collidedAgainst === self.body || weaponBodies(self).some(w => w.body === ev.collidedAgainst)) return;
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
    const order = up < 0 ? ['armor', 'armor_1', 'armor_2', 'weapon', 'motor'] : ['wheels', 'wheels_1', 'wheels_2', 'armor_1', 'armor_2', 'armor', 'motor'];
    const socket = order.find(alive) ?? Object.keys(self.state.parts).find(alive);
    if (!socket) return;
    const dealt = applyDamage(self.state, socket, raw);
    const by = touch.by;
    this.log.push({ t: now, attacker: by.id, socket, dmg: dealt });
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
        this.spinHit(b, this.other(b), c);
        c.active = false; c.lost = 0;
      }
    }
  }

  private onWeaponCollision(c: SpinContact, ev: IPhysicsCollisionEvent) {
    const self = c.bot;
    const other = this.other(self);
    const hitW = weaponBodies(other).find(w => w.body === ev.collidedAgainst);
    const vsWeapon = !!hitW;
    if (ev.collidedAgainst !== other.body && !vsWeapon) return;     // floor / wall / own chassis
    if (ev.type !== PhysicsEventType.COLLISION_STARTED && ev.type !== PhysicsEventType.COLLISION_CONTINUED) return;
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
    const raw = canAttack(attacker.state) ? Math.round(c.lost / (c.jPerDmg ?? SPIN_DMG.joulesPerDmg)) : 0;
    if (raw < SPIN_DMG.minDmg) return;
    const alive = (id: string) => (defender.state.parts[id]?.hp ?? 0) > 0;
    // crusher pierces the top: top armor, then the insides (weapon motor, drive motor)
    const crushSocket = c.crush ? ['armor', 'armor_1', 'armor_2', 'weapon_motor', 'motor', 'weapon'].find(alive) : undefined;
    // a flip / lift gets under them: socket from the hit direction even if the plate touched their weapon
    const socket = crushSocket ?? (c.vsWeapon && alive('weapon') && !c.gain ? 'weapon' : pickSocket(defender, attacker));
    const dealt = applyDamage(defender.state, socket, raw);
    const now = performance.now();
    this.log.push({ t: now, attacker: attacker.id, socket, dmg: dealt });
    this.stats[attacker.id].hits++;
    this.stats[attacker.id].dmg += dealt;
    this.credit(attacker, defender, dealt);
    defender.lastHit = { socket, t: now };
    this.fx.hit(c.point, dealt, defender, attacker.build.cosmetics.paint ?? '#fff');
  }

  private other(b: Bot) { return this.bots.find(x => x !== b)!; }

  private onCollision(self: Bot, ev: IPhysicsCollisionEvent) {
    const other = this.other(self);
    // wall/floor hit: no damage (hazards are a later topic). v0.8: the other bot's real weapons count as that bot.
    const vsHub = weaponBodies(other).some(w => w.body === ev.collidedAgainst);
    if (ev.collidedAgainst !== other.body && !vsHub) return;
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
  if (f < -0.5) return firstAlive('wheels', 'wheels_1', 'wheels_2', 'motor', 'armor', 'armor_1', 'armor_2', 'weapon_motor') ?? anyAlive();
  // side hits: full-body spinners have no armor, so the shell takes it
  const side = r > 0 ? ['armor_2', 'wheels_2'] : ['armor_1', 'wheels_1'];
  return firstAlive(...side, 'armor', 'wheels', 'secondary', 'weapon_motor', 'weapon', 'motor') ?? anyAlive();
}
