/**
 * v0.38 cube currency (user, 2026-10-19): the cubes the bots are made of are the money. Races only for now.
 *  - during a race: -1 per cube knocked off your bot, +1 per loose cube you vacuum up (cubes.ts LOOT) = the race tally
 *  - at the line: place + damage dealt + time under the track's par + the race tally = the race reward
 *  - the wallet (saved in this browser) takes the reward; a bad race can't push it below 0
 * v0.47: see REWARD below (count floored at 0, crash = reset to 0, damage = cubes knocked off rivals, clean-race bonus).
 * Amounts are in 8-bit (big) cubes (smaller cube sizes count each cube for less -- cubes.ts cubeValue).
 * v0.56 (user): currency = HP -- each cube is worth its share of its part's HP (cubes.ts valueOf), so amounts are HP.
 */
/** v0.38 the user's "Balanced" mix (60/40/25/15, +1 per 10 dmg, +1 per s under par up to 20) x10: a bot turned out to be
 *  ~1,250 cubes (8-bit), so a few hits cost 50-150 cubes and a wreck (the whole bot blows apart) ~1,250. At x1 the
 *  place / damage / time reward would be lost in that; x10 keeps the user's proportions.
 *
 *  v0.47 (user, 2026-10-19) refined:
 *   - your race COUNT starts at 0: +1 per cube vacuumed, -1 per cube knocked off you, never below 0
 *   - a crash (wrecked / KO, off the track, into the lava) resets the count to 0 -- towed when stuck is not a crash
 *   - DAMAGE = cubes: +1 per cube your bot / weapon knocks off a rival, +100 per rival your hits wreck (KO).
 *     The KO explosion itself and hazards (walls, tires, lava, raptors, saws) give nobody credit.
 *   - at the line: count + place + damage + time under par + CLEAN RACE (+100, no crashes)
 *   - so a race can only add to the wallet */
export const REWARD = {
  place: [600, 400, 250, 150],   // 1st .. 4th
  koBonus: 100,                  // v0.47 per rival your hits wrecked
  timePerS: 10,                  // cubes per second under par ...
  timeMax: 200,                  // ... up to this
  clean: 100,                    // v0.47 finished with no crash
};

/** v0.47 count = this race's cubes (floored at 0, reset by a crash); got / lost = totals, for the breakdown;
 *  dmg = cubes knocked off rivals; kos = rivals wrecked by your hits. */
export interface Tally { count: number; lost: number; got: number; repaired: number; dmg: number; kos: number; crashes: number }
export const newTally = (): Tally => ({ count: 0, lost: 0, got: 0, repaired: 0, dmg: 0, kos: 0, crashes: 0 });
/** v0.47 damage score shown everywhere (HUD, standings, results): cubes knocked off rivals + the KO bonus */
export const dmgScore = (t: Tally) => Math.round(t.dmg) + t.kos * REWARD.koBonus;

export interface Reward { place: number; placeCubes: number; dmg: number; kos: number; dmgCubes: number; under: number; timeCubes: number; clean: boolean; cleanCubes: number; crashes: number; kept: number; got: number; lost: number; total: number }

/** time = race time at the line (undefined = not finished: no time / clean bonus yet); par = the track's par time, s. */
export function reward(place: number, time: number | undefined, par: number, t: Tally): Reward {
  const placeCubes = REWARD.place[place - 1] ?? 0;
  const dmgCubes = dmgScore(t);
  const under = time === undefined ? 0 : Math.max(0, par - time);
  const timeCubes = Math.min(REWARD.timeMax, Math.floor(under * REWARD.timePerS));
  const clean = time !== undefined && t.crashes === 0, cleanCubes = clean ? REWARD.clean : 0;
  const kept = Math.max(0, Math.round(t.count));
  return { place, placeCubes, dmg: Math.round(t.dmg), kos: t.kos, dmgCubes, under, timeCubes, clean, cleanCubes, crashes: t.crashes, kept,
    got: Math.round(t.got), lost: Math.round(t.lost), total: kept + placeCubes + dmgCubes + timeCubes + cleanCubes };
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
