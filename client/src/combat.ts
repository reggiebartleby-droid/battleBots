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
 *  - Weapon hits still apply a stand-in impulse (the weapon colliders don't move yet -- Phase 2
 *    turns spinners / arms / plates into real driven bodies). It is applied AT THE CONTACT POINT,
 *    so an off-centre hit spins the victim for real, and the attacker takes a share of the
 *    reaction (Newton's third law, scaled: the rest of the energy came from the spinning mass).
 */
import { Vector3, type IPhysicsCollisionEvent, PhysicsEventType } from '@babylonjs/core';
import { applyDamage, canAttack } from '../../src/core/state.js';
import { forward, type Bot } from './bot.js';
import type { Fx } from './fx.js';

/** Tuning knobs. */
export const FEEL = {
  weaponCone: Math.cos(Math.PI / 4),   // attacker must face the defender within 45° for a weapon hit
  refSpeed: 4,                         // m/s equivalent at which a hit does full weapon damage
  continuedMs: 220,                    // how often a persistent contact is re-evaluated
  spinnerStored: 2.5,                  // m/s-equivalent a fully spun spinner adds to the contact
  // Stand-in weapon impulse (per kg of defender, m/s) until Phase 2 makes weapons real bodies
  hit: { base: 3.5, perDmg: 0.22, max: 11, upKick: 0.4 },
  vertical: { up: 4.5, upPerDmg: 0.12 },   // vertical spinners launch (the only real upward kick)
  reaction: 0.35,                      // attacker gets this fraction of the hit impulse back (recoil)
};

export interface HitLog { t: number; attacker: 'A' | 'B'; socket: string; dmg: number }
export interface Stats { hits: number; dmg: number; bumps: number; maxImpulse: number }

export class Combat {
  private lastHit = new Map<string, number>();
  private lastContinued = 0;
  log: HitLog[] = [];
  stats: Record<'A' | 'B', Stats> = { A: { hits: 0, dmg: 0, bumps: 0, maxImpulse: 0 }, B: { hits: 0, dmg: 0, bumps: 0, maxImpulse: 0 } };

  constructor(private bots: Bot[], private fx: Fx) {
    for (const b of bots) {
      b.body.getCollisionObservable().add(ev => this.onCollision(b, ev));
    }
  }

  private other(b: Bot) { return this.bots.find(x => x !== b)!; }

  private onCollision(self: Bot, ev: IPhysicsCollisionEvent) {
    const other = this.other(self);
    if (ev.collidedAgainst !== other.body) return;      // wall/floor hit: no damage (hazards are a later topic)
    if (ev.type === PhysicsEventType.COLLISION_STARTED) {
      this.resolve(self, other, ev, true);
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

  private resolve(attacker: Bot, defender: Bot, ev: IPhysicsCollisionEvent, started: boolean) {
    const point = this.contactPoint(attacker, defender, ev);
    const now = performance.now();

    // Attacker must be pointing its weapon at the defender
    const toDef = defender.root.position.subtract(attacker.root.position); toDef.y = 0; toDef.normalize();
    const fwd = forward(attacker); fwd.y = 0; fwd.normalize();
    const isFbs = attacker.build.bodyId === 'full_body_spinner';
    const facing = Vector3.Dot(fwd, toDef);
    const aimed = isFbs || facing >= FEEL.weaponCone;

    const speed = this.contactSpeed(attacker, defender, ev, toDef);
    this.stats[attacker.id].maxImpulse = Math.max(this.stats[attacker.id].maxImpulse, Math.round(speed * 10) / 10);

    const power = canAttack(attacker.state) ? attacker.weapon.power() : 0;
    if (!aimed || power <= 0) { if (started) this.bump(attacker, point); return; }

    if (now - (this.lastHit.get(attacker.id) ?? -1e9) < attacker.weapon.hitCooldownMs()) return;

    // Contact hardness scales damage; spinners add stored energy proportional to spin
    let scale: number;
    if (attacker.weapon.mode === 'spinner') {
      const stored = FEEL.spinnerStored * attacker.weapon.spinLevel;
      scale = Math.min(1.5, Math.max(0.25, (speed + stored) / FEEL.refSpeed));
    } else {
      // swings / flips / grips don't need run-up speed
      scale = Math.min(1.3, Math.max(0.8, speed / FEEL.refSpeed + 0.8));
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

    // Stand-in weapon impulse at the contact point (off-centre hits spin the victim for real)
    const mag = Math.min(FEEL.hit.max, FEEL.hit.base + raw * FEEL.hit.perDmg);
    const kick = toDef.scale(mag);
    kick.y = FEEL.hit.upKick;
    if (attacker.spinAxis === 'x') kick.y = FEEL.vertical.up + raw * FEEL.vertical.upPerDmg;   // vertical spinners launch
    const mass = defender.body.getMassProperties().mass ?? 50;
    const impulse = kick.scale(mass);
    defender.body.applyImpulse(impulse, point);
    // Reaction on the attacker (recoil), at the same point: a hard vertical hit can tip the attacker too
    attacker.body.applyImpulse(impulse.scale(-FEEL.reaction), point);

    attacker.weapon.spinReset();      // any spinner hit dumps the spin; motor stays ON and ramps back
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
