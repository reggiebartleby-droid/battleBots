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
}

export function createBotState(build: BotBuild, catalog: Catalog): BotState {
  const v = validateBuild(build, catalog);
  if (!v.ok) throw new Error(`Invalid build: ${v.errors.join('; ')}`);
  const body = catalog.bodies[build.bodyId];
  const parts: Record<string, PartState> = {};
  for (const socket of body.sockets) {
    const part = v.resolved[socket.id];
    if (!part) continue;
    parts[socket.id] = { socketId: socket.id, socketType: socket.type, part, hp: part.stats.hp, maxHp: part.stats.hp };
  }
  return { build, parts, totalDamageTaken: 0 };
}

/** Effective armor of one socket (0 once the part is destroyed). */
export function socketArmor(ps: PartState): number {
  return ps.hp > 0 ? (ps.part.stats.armor ?? 0) : 0;
}

/**
 * Apply raw damage to a part. Armor on that part reduces the hit (min 1 if any
 * damage was dealt). Returns actual HP lost. Engines decide WHICH socket is hit.
 */
export function applyDamage(state: BotState, socketId: string, rawDamage: number): number {
  const ps = state.parts[socketId];
  if (!ps || ps.hp <= 0 || rawDamage <= 0) return 0;
  const dealt = Math.max(1, rawDamage - socketArmor(ps));
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

/** Every part at 0 HP -> KO. */
export function isDestroyed(state: BotState): boolean {
  return Object.values(state.parts).every(p => p.hp <= 0);
}

/** Current speed (0 if immobilized). */
export function currentSpeed(state: BotState): number {
  if (isImmobilized(state)) return 0;
  return bySocketType(state, 'motor').filter(alive).reduce((s, p) => s + (p.part.stats.speed ?? 0), 0);
}
