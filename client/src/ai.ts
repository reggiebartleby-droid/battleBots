/**
 * Opponent AI v2.
 *  - Weapon aware: switches its spinner on and backs off to spin up before engaging;
 *    swings hammers / fires flippers only when close and lined up; grips when touching.
 *  - Flanks: if the target's weapon is live and pointed at us, approach from the side/rear.
 *  - Wall avoidance: steers back toward the centre when its nose is about to hit a wall.
 *  - Stuck escape: if it's pushing but not moving, reverse and turn for a moment.
 * Full-body spinners don't need to aim, so they just close distance (v0.12: once spun up, like real shells).
 * v0.12 flippers fire when the opponent is actually on the plate (or very close and lined up); lifters /
 * grappler / crusher hold while touching.
 */
import { Vector3 } from '@babylonjs/core';
import { forward, type Bot } from './bot.js';
import type { Drive } from './input.js';

/** Difficulty knob. Hard = the v2 AI unchanged. */
export type Difficulty = 'easy' | 'normal' | 'hard';
export const DIFFICULTY: Record<Difficulty, {
  throttle: number;    // max throttle (speed cap)
  turn: number;        // max turn rate fraction
  reactMs: number;     // decisions are only re-made this often (reaction delay)
  whiff: number;       // chance a ready swing/flip is skipped this decision
  spinReady: number;   // spin level it waits for before committing
}> = {
  easy:   { throttle: 0.7,  turn: 0.75, reactMs: 320, whiff: 0.45, spinReady: 0.35 },
  normal: { throttle: 0.85, turn: 0.9,  reactMs: 160, whiff: 0.2,  spinReady: 0.5 },
  hard:   { throttle: 1,    turn: 1,    reactMs: 0,   whiff: 0,    spinReady: 0.6 },
};

const AIM_TOLERANCE = 0.12;   // radians: close enough to floor it
const BACKOFF_DIST = 1.6;     // nose-to-nose and off-aim: back up to re-aim
const LUNGE_DIST = 6;
const WALL_MARGIN = 1.3;      // metres from the wall where avoidance kicks in
const STUCK_SECONDS = 0.8;
const ESCAPE_SECONDS = 0.7;

interface Mem { stuckT: number; escapeT: number; escapeTurn: number; nextThink: number; last: Drive }
const mem = new WeakMap<Bot, Mem>();

export function aiDrive(self: Bot, target: Bot, arenaHalf: number, dt: number, difficulty: Difficulty = 'hard'): Drive {
  const D = DIFFICULTY[difficulty];
  let m = mem.get(self);
  if (!m) { m = { stuckT: 0, escapeT: 0, escapeTurn: 1, nextThink: 0, last: { throttle: 0, turn: 0, fire: false } }; mem.set(self, m); }

  // Reaction delay: keep repeating the last decision until it's time to think again
  const now = performance.now();
  if (D.reactMs > 0 && now < m.nextThink) return m.last;
  m.nextThink = now + D.reactMs;
  const decide = (d: Drive): Drive => {
    const out = { throttle: d.throttle * D.throttle, turn: d.turn * D.turn, fire: d.fire };
    m!.last = out;
    return out;
  };

  const pos = self.root.position, tpos = target.root.position;
  const to = tpos.subtract(pos); to.y = 0;
  const dist = to.length();
  if (dist < 1e-3) return decide({ throttle: 0, turn: 0, fire: false });
  to.normalize();

  const fwd = forward(self); fwd.y = 0; fwd.normalize();
  const tfwd = forward(target); tfwd.y = 0; tfwd.normalize();
  const facing = Vector3.Dot(fwd, to);                    // 1 = dead on
  const isFbs = self.build.bodyId === 'full_body_spinner';
  const w = self.weapon;

  // ---- weapon command (fire is edge-triggered for spinners, so "true while off" = one press) ----
  let fire = false;
  switch (w.mode) {
    case 'spinner': fire = !w.spinning; break;
    case 'strike':
    case 'flipper': {
      const onPlate = self.hinges?.some(h => h.touched) ?? false;   // v0.12: they're on the plate right now
      // v0.31: swing / fire from further out (the AI hammer only swung ~1.7 times a match)
      const win = w.mode === 'strike' ? { dist: 3.0, facing: 0.7 } : { dist: 2.4, facing: 0.8 };
      fire = w.phase === 'ready' && w.refill <= 0 && (onPlate || (dist < win.dist && facing > win.facing)) && Math.random() >= D.whiff;
      break;
    }
    case 'hold': fire = dist < 2.2 && facing > 0.8; break;
  }

  // ---- stuck escape in progress ----
  if (m.escapeT > 0) { m.escapeT -= dt; return decide({ throttle: -1, turn: m.escapeTurn, fire }); }

  // ---- pick an aim point ----
  let aim = tpos.clone();
  const theirWeaponLive = target.weapon.power() > 0;
  const theyFaceUs = Vector3.Dot(tfwd, to.scale(-1)) > 0.7;
  if (!isFbs && theirWeaponLive && theyFaceUs && dist > 2.5) {
    // flank: go for a point beside and slightly behind them, on whichever side we're already on
    const right = Vector3.Cross(Vector3.Up(), tfwd);
    const side = Vector3.Dot(right, pos.subtract(tpos)) >= 0 ? 1 : -1;
    aim = tpos.add(right.scale(side * 2.0)).add(tfwd.scale(-1.0));
  }

  // ---- wall avoidance: if our nose is heading into a wall, steer for the centre ----
  const look = pos.add(fwd.scale(2.2));
  const margin = arenaHalf - WALL_MARGIN;
  const nearWall = Math.abs(look.x) > margin || Math.abs(look.z) > margin;
  if (nearWall && dist > 2.5) aim = Vector3.Zero();

  // ---- steer toward the aim point ----
  const dir = aim.subtract(pos); dir.y = 0;
  if (dir.length() < 1e-3) dir.copyFrom(to); else dir.normalize();
  const angle = Math.atan2(Vector3.Cross(fwd, dir).y, Vector3.Dot(fwd, dir));
  const turn = Math.abs(angle) < AIM_TOLERANCE ? 0 : Math.sign(angle) * Math.min(1, Math.abs(angle) * 2 + 0.3);

  const needSpin = w.mode === 'spinner' && w.spinLevel < D.spinReady;   // v0.12: shells spin up first too

  let throttle: number;
  if (needSpin && dist < 3.5) throttle = -0.7;                         // retreat while spinning up, keep facing them
  else if (isFbs) throttle = needSpin ? 0 : 1;                    // retreat while spinning up, keep facing them
  else if (Math.abs(angle) > Math.PI / 2) throttle = 0;                // facing away: spin in place
  else if (dist < BACKOFF_DIST && Math.abs(angle) > AIM_TOLERANCE * 2) throttle = -0.5;   // re-aim
  else throttle = dist > LUNGE_DIST ? 1 : 0.85;

  // ---- stuck detection ----
  const speed = self.body.getLinearVelocity().length();
  if (Math.abs(throttle) > 0.5 && speed < 0.35) m.stuckT += dt; else m.stuckT = 0;
  if (m.stuckT > STUCK_SECONDS) {
    m.stuckT = 0; m.escapeT = ESCAPE_SECONDS; m.escapeTurn = Math.random() < 0.5 ? -1 : 1;
  }

  return decide({ throttle, turn, fire });
}
