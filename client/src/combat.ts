/**
 * Real-time damage resolution on top of Havok collision events.
 * Weapon-driven targeting: the hit socket is chosen from where the attacker
 * struck the defender (front / side / rear), not by the player.
 *
 * A contact only does damage if the attacker's weapon is LIVE (see weapon.ts):
 * spinner spun up, hammer/flipper mid-swing, lifter/grappler key held.
 * Everything else is a "bump" — feedback only, no damage.
 *
 * v0.4 "feel" layer (all numbers in FEEL):
 *  - every bot-bot contact gets a separation impulse scaled by closing speed,
 *    so charges bounce bots apart instead of grinding;
 *  - weapon hits knock the defender back hard and cut its traction briefly
 *    so it actually flies instead of driving through the hit;
 *  - hitstop: a short physics freeze on big hits;
 *  - wedge rule: nose-to-nose, the LOWER front wins (plow < wedge < wedgelet < none):
 *    the loser gets lifted (small up+back impulse) and loses traction.
 *  - contacts that persist (a push/grind) re-check every FEEL.continuedMs so a
 *    live weapon keeps working in a shove and the wedge rule resolves pins.
 */
import { Vector3, type IPhysicsCollisionEvent, PhysicsEventType } from '@babylonjs/core';
import { applyDamage, canAttack } from '../../src/core/state.js';
import { forward, type Bot } from './bot.js';
import type { Fx } from './fx.js';

/** Tuning knobs for collision feel. Arcade on top of real physics. */
export const FEEL = {
  weaponCone: Math.cos(Math.PI / 4),   // attacker must face the defender within 45° for a weapon hit
  refSpeed: 4,                         // m/s at which a hit does full weapon damage
  continuedMs: 220,                    // how often a persistent contact is re-evaluated
  // Separation on ANY bot-bot contact (bumps included). Impulse per kg, m/s.
  sep: { base: 1.2, perClosingSpeed: 0.55, max: 4.5 },
  // Weapon hit knockback (per kg, m/s) + defender traction loss
  hit: { base: 5.0, perDmg: 0.28, max: 14, upKick: 0.6, tractionMs: 420, tractionScale: 0.15 },
  // Vertical spinners add an upward launch
  vertical: { up: 4.5, upPerDmg: 0.12 },
  // v0.6 vertical-spinner extras:
  //  tumble: random pitch/roll (rad/s) on the launched bot; level damping is off for tumbleMs
  //  recoil: the ATTACKER pops up too (fraction of the victim's launch) and back a touch;
  //          hits >= tumbleMinDmg also give the attacker a (smaller) random tumble
  vTumble: { min: 6, max: 9, tumbleMs: 900 },
  vRecoil: { upFrac: 0.4, back: 1.2, tumbleMinDmg: 8, tumbleFrac: 0.5, tractionMs: 300, tractionScale: 0.4 },
  // Hitstop: freeze physics briefly on big hits
  hitstop: { minDmg: 8, ms: 70, bigDmg: 25, bigMs: 110 },
  // Wedge rule: lower front wins the nose-to-nose
  wedge: { cone: Math.cos(Math.PI / 3), lift: 2.2, back: 2.0, tractionMs: 500, tractionScale: 0.25, repeatMs: 450 },
};

/** Lower rank = lower to the ground = wins the wedge war. Missing/destroyed front = 3. */
export function frontRank(bot: Bot): number {
  const f = bot.state.parts['front'];
  if (!f || f.hp <= 0) return 3;
  switch (f.part.kind) { case 'plow': return 0; case 'wedge': return 1; case 'wedgelet': return 2; default: return 3; }
}

export interface HitLog { t: number; attacker: 'A' | 'B'; socket: string; dmg: number }
export interface Stats { hits: number; dmg: number; bumps: number; wedges: number }

export class Combat {
  private lastHit = new Map<string, number>();
  private lastWedge = new Map<string, number>();
  private lastContinued = 0;
  private hitstopUntil = 0;
  log: HitLog[] = [];
  stats: Record<'A' | 'B', Stats> = { A: { hits: 0, dmg: 0, bumps: 0, wedges: 0 }, B: { hits: 0, dmg: 0, bumps: 0, wedges: 0 } };
  /** Set when a hitstop starts; main.ts shows the HITSTOP sign and clears it. */
  hitstopStarted = false;

  constructor(private bots: Bot[], private fx: Fx) {
    for (const b of bots) {
      b.body.getCollisionObservable().add(ev => this.onCollision(b, ev));
    }
  }

  inHitstop(now = performance.now()) { return now < this.hitstopUntil; }

  /** 0..1 multiplier on drive force for this bot right now. */
  traction(bot: Bot, now = performance.now()): number {
    return now < (bot.lowTractionUntil ?? 0) ? (bot.lowTractionScale ?? 1) : 1;
  }

  private other(b: Bot) { return this.bots.find(x => x !== b)!; }

  private onCollision(self: Bot, ev: IPhysicsCollisionEvent) {
    const other = this.other(self);
    if (ev.collidedAgainst !== other.body) return;      // wall/floor hit: no damage (v1)
    if (ev.type === PhysicsEventType.COLLISION_STARTED) {
      this.separate(self, other, ev);
      this.resolve(self, other, ev, true);
    } else if (ev.type === PhysicsEventType.COLLISION_CONTINUED) {
      // Persistent contact (push / grind): re-check at a fixed rate, no separation impulse
      const now = performance.now();
      if (now - this.lastContinued < FEEL.continuedMs) return;
      this.lastContinued = now;
      this.resolve(self, other, ev, false);
    }
  }

  private contactPoint(a: Bot, b: Bot, ev: IPhysicsCollisionEvent) {
    return ev.point ?? a.root.position.add(b.root.position).scale(0.5);
  }

  /** Arcade separation: both bots get shoved apart along their centre line, scaled by closing speed. */
  private separate(self: Bot, other: Bot, _ev: IPhysicsCollisionEvent) {
    if (this.inHitstop()) return;
    const away = self.root.position.subtract(other.root.position); away.y = 0;
    if (away.lengthSquared() < 1e-6) return;
    away.normalize();
    const rel = other.body.getLinearVelocity().subtract(self.body.getLinearVelocity());
    const closing = Math.max(0, Vector3.Dot(rel, away));
    const mag = Math.min(FEEL.sep.max, FEEL.sep.base + closing * FEEL.sep.perClosingSpeed);
    const mass = self.body.getMassProperties().mass ?? 50;
    self.body.applyImpulse(away.scale(mag * mass), self.root.position);
  }

  private resolve(attacker: Bot, defender: Bot, ev: IPhysicsCollisionEvent, started: boolean) {
    const point = this.contactPoint(attacker, defender, ev);
    const now = performance.now();

    // Attacker must be pointing its weapon at the defender
    const toDef = defender.root.position.subtract(attacker.root.position); toDef.y = 0; toDef.normalize();
    const fwd = forward(attacker); fwd.y = 0; fwd.normalize();
    const isFbs = attacker.build.bodyId === 'full_body_spinner';
    const facing = Vector3.Dot(fwd, toDef);
    const aimed = isFbs || facing >= FEEL.weaponCone;

    // Wedge rule: both noses pointed at each other → lower front wins
    this.wedgeCheck(attacker, defender, facing, now);

    const power = canAttack(attacker.state) ? attacker.weapon.power() : 0;
    if (!aimed || power <= 0) { if (started) this.bump(attacker, point); return; }

    if (now - (this.lastHit.get(attacker.id) ?? -1e9) < attacker.weapon.hitCooldownMs()) return;

    // Relative closing speed scales damage; spinners add stored energy proportional to spin
    const rel = attacker.body.getLinearVelocity().subtract(defender.body.getLinearVelocity());
    const closing = Math.max(0, Vector3.Dot(rel, toDef));
    let scale: number;
    if (attacker.weapon.mode === 'spinner') {
      const stored = 2.5 * attacker.weapon.spinLevel;
      scale = Math.min(1.5, Math.max(0.25, (closing + stored) / FEEL.refSpeed));
    } else {
      // swings / flips / grips don't need run-up speed
      scale = Math.min(1.3, Math.max(0.8, closing / FEEL.refSpeed + 0.8));
    }

    const weapon = attacker.state.parts['weapon'];
    const raw = Math.round((weapon?.part.stats.damage ?? 0) * scale * power);
    if (raw <= 0) { if (started) this.bump(attacker, point); return; }

    const socket = pickSocket(defender, attacker);
    const dealt = applyDamage(defender.state, socket, raw);
    this.lastHit.set(attacker.id, now);
    this.log.push({ t: now, attacker: attacker.id, socket, dmg: dealt });
    this.stats[attacker.id].hits++;
    this.stats[attacker.id].dmg += dealt;
    defender.lastHit = { socket, t: now };
    this.fx.hit(point, dealt, defender, attacker.build.cosmetics.paint ?? '#fff');

    // Knockback: hard shove along the attack line + traction loss so the defender flies
    const mag = Math.min(FEEL.hit.max, FEEL.hit.base + raw * FEEL.hit.perDmg);
    const kick = toDef.scale(mag);
    kick.y = FEEL.hit.upKick;
    if (attacker.spinAxis === 'x') kick.y = FEEL.vertical.up + raw * FEEL.vertical.upPerDmg;   // vertical spinners launch
    const mass = defender.body.getMassProperties().mass ?? 50;
    defender.body.applyImpulse(kick.scale(mass), defender.root.position);
    defender.lowTractionUntil = now + FEEL.hit.tractionMs;
    defender.lowTractionScale = FEEL.hit.tractionScale;

    if (attacker.spinAxis === 'x') this.verticalExtras(attacker, defender, kick.y, raw, toDef, now);
    attacker.weapon.spinReset();      // v0.6: any spinner hit dumps the spin; motor stays ON and ramps back

    // Hitstop on big hits
    if (raw >= FEEL.hitstop.minDmg) {
      const ms = raw >= FEEL.hitstop.bigDmg ? FEEL.hitstop.bigMs : FEEL.hitstop.ms;
      this.hitstopUntil = now + ms;
      this.hitstopStarted = true;
    }
  }

  /** v0.6 vertical spinner: victim tumbles; attacker recoils (and sometimes tumbles too). */
  private verticalExtras(attacker: Bot, defender: Bot, launchUp: number, raw: number, toDef: Vector3, now: number) {
    const rnd = (lo: number, hi: number) => lo + Math.random() * (hi - lo);
    const randSpin = (mag: number) => {
      const a = Math.random() * Math.PI * 2;              // random horizontal axis = pitch/roll mix, no yaw
      return new Vector3(Math.cos(a) * mag, 0, Math.sin(a) * mag);
    };
    // Victim: tumble on top of the launch
    const t = rnd(FEEL.vTumble.min, FEEL.vTumble.max);
    defender.body.setAngularVelocity(defender.body.getAngularVelocity().add(randSpin(t)));
    defender.tumbleUntil = now + FEEL.vTumble.tumbleMs;
    // Attacker: recoil hop + a step back
    const r = FEEL.vRecoil;
    const recoil = toDef.scale(-r.back); recoil.y = launchUp * r.upFrac;
    const am = attacker.body.getMassProperties().mass ?? 50;
    attacker.body.applyImpulse(recoil.scale(am), attacker.root.position);
    attacker.lowTractionUntil = now + r.tractionMs;
    attacker.lowTractionScale = r.tractionScale;
    if (raw >= r.tumbleMinDmg) {
      attacker.body.setAngularVelocity(attacker.body.getAngularVelocity().add(randSpin(t * r.tumbleFrac)));
      attacker.tumbleUntil = now + FEEL.vTumble.tumbleMs;
    }
  }

  /** Nose-to-nose: the bot with the lower front gets under the other one. */
  private wedgeCheck(a: Bot, b: Bot, aFacing: number, now: number) {
    if (aFacing < FEEL.wedge.cone) return;
    const toA = a.root.position.subtract(b.root.position); toA.y = 0; toA.normalize();
    const bFwd = forward(b); bFwd.y = 0; bFwd.normalize();
    if (Vector3.Dot(bFwd, toA) < FEEL.wedge.cone) return;            // b isn't facing a
    const ra = frontRank(a), rb = frontRank(b);
    if (ra >= rb) return;                                            // a is not lower than b
    if (now - (this.lastWedge.get(a.id) ?? -1e9) < FEEL.wedge.repeatMs) return;
    this.lastWedge.set(a.id, now);
    this.stats[a.id].wedges++;
    // b gets lifted: up + pushed back along a's forward, and loses traction
    const aFwd = forward(a); aFwd.y = 0; aFwd.normalize();
    const kick = aFwd.scale(FEEL.wedge.back); kick.y = FEEL.wedge.lift;
    const mass = b.body.getMassProperties().mass ?? 50;
    b.body.applyImpulse(kick.scale(mass), b.root.position.add(aFwd.scale(-0.5)));   // off-centre → nose lifts
    b.lowTractionUntil = now + FEEL.wedge.tractionMs;
    b.lowTractionScale = FEEL.wedge.tractionScale;
    this.fx.wedge(b.root.position.add(new Vector3(0, 0.5, 0)));
  }

  private bump(attacker: Bot, point: Vector3) {
    this.stats[attacker.id].bumps++;
    this.fx.bump(point);
  }
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

  if (f > 0.5)  return firstAlive('front', 'weapon', 'armor', 'armor_1', 'armor_2') ?? anyAlive();
  if (f < -0.5) return firstAlive('wheels', 'wheels_1', 'wheels_2', 'motor', 'armor', 'armor_1', 'armor_2') ?? anyAlive();
  // side hits: full-body spinners have no armor, so the shell takes it
  const side = r > 0 ? ['armor_2', 'wheels_2'] : ['armor_1', 'wheels_1'];
  return firstAlive(...side, 'armor', 'wheels', 'secondary', 'weapon', 'motor') ?? anyAlive();
}
