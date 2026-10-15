import type { BalanceConfig, PartDef, PartStats } from './types.js';

/** weight = base(part type) + Σ(stat × coefficient). Linear for now. */
export function partWeight(part: PartDef, balance: BalanceConfig): number {
  let w = balance.baseWeight[part.type];
  for (const key of Object.keys(balance.coefficients) as (keyof PartStats)[]) {
    const v = part.stats[key];
    if (v !== undefined) w += v * balance.coefficients[key];
  }
  return Math.round(w * 100) / 100;
}
