/**
 * Runtime bot state: per-part HP and the derived "what still works" flags.
 * Combat engines (turn-based or real-time) mutate this via applyDamage().
 */
import type { BotBuild, Catalog, PartDef, SocketType } from './types.js';
import { validateBuild } from './validate.js';

export interface PartState {
  socketId: string;
  socketType: SocketType;
  part: PartDef;
  hp: number;
  maxHp: number;
}

export interface BotState {
  build: BotBuild;
  parts: Record<string, PartState>;   // by socketId
  totalDamageTaken: number;
  breakableWeapons: boolean;          // v0.17: false = weapon + weapon motor stop at 1 HP
  /** v0.56 (user) the chassis' own HP pool (Cube Bots look sets it: cubes.ts). Undefined = no chassis HP.
   *  Hit through applyDamage(state, CHASSIS, dmg); no armour of its own; 0 HP = KO. */
  chassis?: { hp: number; maxHp: number };
}

/** v0.56 socket id used for the chassis in hits / logs (it isn't in `parts`). */
export const CHASSIS = 'chassis';

export interface StateOptions {
  /** v0.17 match setting. Default true (parts break as normal); the client defaults it to false. */
  breakableWeapons?: boolean;
}

export function createBotState(build: BotBuild, catalog: Catalog, opts: StateOptions = {}): BotState {
  const v = validateBuild(build, catalog);
  if (!v.ok) throw new Error(`Invalid build: ${v.errors.join('; ')}`);
  const body = catalog.bodies[build.bodyId];
  const parts: Record<string, PartState> = {};
  for (const socket of body.sockets) {
    const part = v.resolved[socket.id];
    if (!part) continue;
    parts[socket.id] = { socketId: socket.id, socketType: socket.type, part, hp: part.stats.hp, maxHp: part.stats.hp };
  }
  return { build, parts, totalDamageTaken: 0, breakableWeapons: opts.breakableWeapons ?? true };
}

/** Effective armor of one socket (0 once the part is destroyed). */
export function socketArmor(ps: PartState): number {
  return ps.hp > 0 ? (ps.part.stats.armor ?? 0) : 0;
}

const PROTECTED: SocketType[] = ['weapon', 'weapon_motor'];

/** v0.17: with breakable weapons off, the weapon and weapon motor can't be destroyed. */
export function isProtected(state: BotState, ps: PartState): boolean {
  return !state.breakableWeapons && PROTECTED.includes(ps.socketType);
}

/** v0.31 per-hit rules: one hit can't take more than maxDealt, and a bot that is already immobilized takes
 *  immobilizedMult x damage (immobilization still decides nothing by itself). Core default: off (no cap, x1);
 *  the game client sets its values (client/src/combat.ts). */
export const HIT = { maxDealt: Infinity, immobilizedMult: 1 };

/**
 * Apply raw damage to a part. Armor on that part reduces the hit (min 1 if any
 * damage was dealt). Returns actual HP lost. Engines decide WHICH socket is hit.
 */
export function applyDamage(state: BotState, socketId: string, rawDamage: number): number {
  if (socketId === CHASSIS) {                       // v0.56 chassis HP: no armour, same per-hit rules
    const c = state.chassis;
    if (!c || c.hp <= 0 || rawDamage <= 0) return 0;
    let dealt = Math.max(1, rawDamage);
    if (isImmobilized(state)) dealt = Math.round(dealt * HIT.immobilizedMult);
    dealt = Math.min(dealt, HIT.maxDealt);
    const lost = Math.min(c.hp, dealt);
    c.hp -= lost;
    state.totalDamageTaken += lost;
    return lost;
  }
  const ps = state.parts[socketId];
  if (!ps || ps.hp <= 0 || rawDamage <= 0) return 0;
  let dealt = Math.max(1, rawDamage - socketArmor(ps));
  if (isImmobilized(state)) dealt = Math.round(dealt * HIT.immobilizedMult);   // v0.31
  dealt = Math.min(dealt, HIT.maxDealt);                                         // v0.31
  if (isProtected(state, ps)) {
    // v0.17 unbreakable: HP stops at 1 (part keeps working); the full hit still counts as damage taken
    ps.hp -= Math.min(ps.hp - 1, dealt);
    state.totalDamageTaken += dealt;
    return dealt;
  }
  const lost = Math.min(ps.hp, dealt);
  ps.hp -= lost;
  state.totalDamageTaken += lost;
  return lost;
}

const alive = (ps?: PartState) => !!ps && ps.hp > 0;
const bySocketType = (s: BotState, t: SocketType) => Object.values(s.parts).filter(p => p.socketType === t);

/** Weapon at 0 HP -> can't attack. */
export function canAttack(state: BotState): boolean {
  return bySocketType(state, 'weapon').some(alive);
}

/** Any secondary (flame) still usable. */
export function canUseSecondary(state: BotState): boolean {
  return bySocketType(state, 'secondary').some(alive);
}

/** All wheels gone OR motor gone -> immobilized (= loss). */
export function isImmobilized(state: BotState): boolean {
  const wheelsOk = bySocketType(state, 'wheels').some(alive);
  const motorOk = bySocketType(state, 'motor').some(alive);
  return !(wheelsOk && motorOk);
}

/** Every part at 0 HP -> KO. v0.17: unbreakable weapon parts don't count. v0.56: chassis at 0 HP -> KO too. */
export function isDestroyed(state: BotState): boolean {
  if (state.chassis && state.chassis.hp <= 0) return true;
  return Object.values(state.parts).filter(p => !isProtected(state, p)).every(p => p.hp <= 0);
}

/** v0.56 the bot's starting total HP: every part + the chassis pool. */
export function totalMaxHp(state: BotState): number {
  return Object.values(state.parts).reduce((a, p) => a + p.maxHp, 0) + (state.chassis?.maxHp ?? 0);
}

/** Current speed (0 if immobilized). */
export function currentSpeed(state: BotState): number {
  if (isImmobilized(state)) return 0;
  return bySocketType(state, 'motor').filter(alive).reduce((s, p) => s + (p.part.stats.speed ?? 0), 0);
}
