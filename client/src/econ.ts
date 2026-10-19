/**
 * v0.38 cube currency (user, 2026-10-19): the cubes the bots are made of are the money. Races only for now.
 *  - during a race: -1 per cube knocked off your bot, +1 per loose cube you vacuum up (cubes.ts LOOT) = the race tally
 *  - at the line: place + damage dealt + time under the track's par + the race tally = the race reward
 *  - the wallet (saved in this browser) takes the reward; a bad race can't push it below 0
 * Amounts are in 8-bit (big) cubes (smaller cube sizes count each cube for less -- cubes.ts cubeValue).
 */
/** v0.38 the user's "Balanced" mix (60/40/25/15, +1 per 10 dmg, +1 per s under par up to 20) x10: a bot turned out to be
 *  ~1,250 cubes (8-bit), so a few hits cost 50-150 cubes and a wreck (the whole bot blows apart) ~1,250. At x1 the
 *  place / damage / time reward would be lost in that; x10 keeps the user's proportions. */
export const REWARD = {
  place: [600, 400, 250, 150],   // 1st .. 4th
  dmgPer: 1,                     // +1 cube per this much damage dealt to other bots
  timePerS: 10,                  // cubes per second under par ...
  timeMax: 200,                  // ... up to this
};

export interface Tally { lost: number; got: number; repaired: number }
export const newTally = (): Tally => ({ lost: 0, got: 0, repaired: 0 });

export interface Reward { place: number; placeCubes: number; dmg: number; dmgCubes: number; under: number; timeCubes: number; got: number; lost: number; total: number }

/** time = race time at the line (undefined = not finished: no time bonus yet); par = the track's par time, s. */
export function reward(place: number, dmg: number, time: number | undefined, par: number, t: Tally): Reward {
  const placeCubes = REWARD.place[place - 1] ?? 0;
  const dmgCubes = Math.floor(Math.max(0, dmg) / REWARD.dmgPer);
  const under = time === undefined ? 0 : Math.max(0, par - time);
  const timeCubes = Math.min(REWARD.timeMax, Math.floor(under * REWARD.timePerS));
  const got = Math.round(t.got), lost = Math.round(t.lost);
  return { place, placeCubes, dmg, dmgCubes, under, timeCubes, got, lost, total: placeCubes + dmgCubes + timeCubes + got - lost };
}

// ---------------- wallet (this browser) ----------------
const WALLET_KEY = 'bb.wallet.v1';
let wallet = 0;
try { const w = JSON.parse(localStorage.getItem(WALLET_KEY) ?? '{}'); if (Number.isFinite(w.cubes)) wallet = Math.max(0, Math.round(w.cubes)); } catch { /* new wallet */ }
export function walletCubes() { return wallet; }
/** Adds a race reward (can be negative); never below 0. Returns the new total. */
export function payWallet(n: number): number {
  wallet = Math.max(0, wallet + Math.round(n));
  try { localStorage.setItem(WALLET_KEY, JSON.stringify({ cubes: wallet })); } catch { /* no storage: this page load only */ }
  return wallet;
}

/** Cube icon for the HUD / cards. */
export const CUBE_ICON = '<span class="cube-ico"></span>';
export const signed = (n: number) => (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n);
