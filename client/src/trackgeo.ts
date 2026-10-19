/**
 * v0.45 3D race tracks (user 2026-10-19: Stunt Park + Rally Dirt). Pure track maths, no Babylon: race.ts builds the
 * colliders from it, and the cube-world bake scripts (scripts/bake-stunt.mjs, bake-rally.mjs) build the cube scenery
 * from the SAME numbers (node --experimental-strip-types), so the cube road always sits on the smooth driving surface.
 *
 * Like race.ts's Grand Prix / Oval, the centre line is built "turtle" style from segments in local (x, z), sampled
 * every SAMPLE m; heading h = direction (cos h, sin h); u = sideways offset, + = left. On top of that each sample has:
 *   y        road height at the centre line (elevation profile per segment: ramps, the corkscrew climb, the gap jump)
 *   bank     banked turns (inner edge at y, outer edge up)
 *   pipeL/R  half-pipe walls past the road edge (radius, m; 0 = none), eased in/out, cut open at the shortcut mouths
 *   gap      no road here (the gap jump)        kick  boost pad (arcade speed floor on the take-off ramp)
 *   edgeL/R  what's past the road edge: 'wall' (barrier), 'lava' (open drop into lava)
 */
export const SAMPLE = 0.5;
export type Edge = 'wall' | 'lava';
export type Tag3 = 'start' | 'straight' | 'bank' | 'sbend' | 'corkscrew' | 'jump' | 'pipe' | 'crest';
export interface Seg3 {
  tag: Tag3; len?: number; r?: number; deg?: number; sign?: 1 | -1;
  /** elevation profile: [q (m into the segment), y] points, straight lines between (default: previous y, flat) */
  y?: [number, number][];
  bank?: number;                                   // deg, eased in / out over 40 deg of turn
  pipe?: { r: number; ease: number; cut?: { side: 'L' | 'R'; q: number; w: number }[] };
  gap?: [number, number];
  kick?: [number, number];
  edge?: { L?: Edge; R?: Edge };
  /** lava edges have a low rock curb (LIP_H) except in these q ranges (the open bits you can slide off) */
  open?: [number, number][];
}
export const LIP_H = 0.24;   // v0.45 lava curb height (one 0.24 m cube): stops a slow drift, not a hit or a fast slide
export interface Sample3 {
  x: number; z: number; h: number; s: number; tag: Tag3; q: number; seg: number;
  arcR: number; arcSign: number; bank: number;
  y: number; grade: number; pipeL: number; pipeR: number; gap: boolean; kick: boolean; edgeL: Edge; edgeR: Edge;
  mouthL: boolean; mouthR: boolean;                // in a shortcut mouth: no wall on that side
  lipL: boolean; lipR: boolean;                    // lava edge with a curb
}
export interface Shortcut { s0: number; s1: number; a: { x: number; z: number }; b: { x: number; z: number }; width: number; roof: number }
export interface Geo3 {
  id: string; width: number; segs: Seg3[]; startX: number; finishS: number;
  floorY: number;                                  // physics floor top (stunt: ground 0, rally: the lava, below the road)
  shortcut?: { seg: number; q0: number; q1: number; side: 'L' | 'R'; width: number; roof: number };
}

export const nrm = (h: number) => ({ x: -Math.sin(h), z: Math.cos(h) });   // left normal

function bankAt(phiDeg: number, totalDeg: number, bankDeg: number) {
  const ease = (t: number) => t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
  const k = Math.min(ease(phiDeg / 40), ease((totalDeg - phiDeg) / 40));
  return k * bankDeg * Math.PI / 180;
}
const smooth = (t: number) => t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);

function profileY(prof: [number, number][] | undefined, q: number, prev: number) {
  if (!prof || !prof.length) return prev;
  if (q <= prof[0][0]) return prof[0][1];
  for (let i = 1; i < prof.length; i++) if (q <= prof[i][0]) {
    const [q0, y0] = prof[i - 1], [q1, y1] = prof[i];
    return y0 + (y1 - y0) * (q - q0) / Math.max(1e-6, q1 - q0);
  }
  return prof[prof.length - 1][1];
}

export interface Line3 { samples: Sample3[]; length: number; segStart: number[]; shortcut?: Shortcut }

/** Sampled centre line + per-sample road shape. Sample 0 is at the finish line (s measured from it). */
export function buildLine3(g: Geo3): Line3 {
  const out: Sample3[] = [];
  let x = g.startX, z = 0, h = 0, s = 0, yPrev = 0;
  const segStart: number[] = [];
  g.segs.forEach((sg, si) => {
    segStart.push(s);
    const len = sg.len ?? sg.r! * sg.deg! * Math.PI / 180;
    const n = Math.round(len / SAMPLE);
    const y0 = yPrev;
    const pipeAt = (q: number, side: 'L' | 'R') => {
      const P = sg.pipe; if (!P) return 0;
      let k = Math.min(smooth(q / P.ease), smooth((len - q) / P.ease));
      for (const c of P.cut ?? []) if (c.side === side) {
        const d = Math.abs(q - c.q) - c.w / 2;                      // inside the mouth: 0, eased back over 3 m
        k = Math.min(k, smooth(d / 3));
      }
      return P.r * k;
    };
    const base = { tag: sg.tag, seg: si, edgeL: sg.edge?.L ?? 'wall', edgeR: sg.edge?.R ?? 'wall' } as const;
    const mouth = (q: number, side: 'L' | 'R') => (sg.pipe?.cut ?? []).some(c => c.side === side && Math.abs(q - c.q) < c.w / 2);
    const extra = (q: number) => ({
      y: profileY(sg.y, q, y0), mouthL: mouth(q, 'L'), mouthR: mouth(q, 'R'),
      lipL: (sg.edge?.L === 'lava') && !(sg.open ?? []).some(([a, b]) => q >= a && q <= b),
      lipR: (sg.edge?.R === 'lava') && !(sg.open ?? []).some(([a, b]) => q >= a && q <= b),
      pipeL: pipeAt(q, 'L'), pipeR: pipeAt(q, 'R'),
      gap: !!sg.gap && q > sg.gap[0] && q < sg.gap[1],
      kick: !!sg.kick && q >= sg.kick[0] && q <= sg.kick[1],
    });
    if (sg.len !== undefined) {
      for (let i = 0; i < n; i++) {
        const q = i * len / n;
        out.push({ ...base, ...extra(q), x: x + Math.cos(h) * q, z: z + Math.sin(h) * q, h, s: s + q, q, arcR: 0, arcSign: 0, bank: 0, grade: 0 });
      }
      x += Math.cos(h) * len; z += Math.sin(h) * len;
    } else {
      const r = sg.r!, sn = sg.sign!, tot = sg.deg! * Math.PI / 180;
      const n0 = nrm(h), cx = x + sn * r * n0.x, cz = z + sn * r * n0.z;
      for (let i = 0; i < n; i++) {
        const phi = i * tot / n, hh = h + sn * phi, nn = nrm(hh), q = phi * r;
        out.push({ ...base, ...extra(q), x: cx - sn * r * nn.x, z: cz - sn * r * nn.z, h: hh, s: s + q, q, arcR: r, arcSign: sn,
          bank: sg.bank ? bankAt(phi * 180 / Math.PI, sg.deg!, sg.bank) : 0, grade: 0 });
      }
      h += sn * tot; const ne = nrm(h);
      x = cx - sn * r * ne.x; z = cz - sn * r * ne.z;
    }
    s += len;
    yPrev = profileY(sg.y, len, y0);
  });
  if (Math.hypot(x - g.startX, z) > 0.05) throw new Error(`track ${g.id} does not close (${x.toFixed(2)}, ${z.toFixed(2)})`);
  if (Math.abs(yPrev - out[0].y) > 0.01) throw new Error(`track ${g.id}: height does not close (${yPrev} vs ${out[0].y})`);
  const L = s;
  // grade (dy / ds) from the neighbours, before re-ordering
  for (let i = 0; i < out.length; i++) {
    const a = out[(i - 1 + out.length) % out.length], b = out[(i + 1) % out.length];
    out[i].grade = (b.y - a.y) / (2 * SAMPLE);
  }
  let shortcut: Shortcut | undefined;
  if (g.shortcut) {
    const c = g.shortcut, sg = g.segs[c.seg];
    const at = (q: number) => {
      const p = out.find(o => o.seg === c.seg && o.q >= q) ?? out[0];
      const n = nrm(p.h), u = (c.side === 'L' ? 1 : -1) * (g.width / 2 + 0.2);
      return { x: p.x + n.x * u, z: p.z + n.z * u, s: p.s };
    };
    const A = at(c.q0), B = at(c.q1);
    shortcut = { s0: A.s, s1: B.s, a: { x: A.x, z: A.z }, b: { x: B.x, z: B.z }, width: c.width, roof: c.roof };
    void sg;
  }
  for (const p of out) p.s = (p.s - g.finishS + L) % L;
  if (shortcut) { shortcut.s0 = (shortcut.s0 - g.finishS + L) % L; shortcut.s1 = (shortcut.s1 - g.finishS + L) % L; }
  const seg0 = segStart.map(v => (v - g.finishS + L) % L);
  out.sort((a, b) => a.s - b.s);
  return { samples: out, length: L, segStart: seg0, shortcut };
}

/** Road surface height (local y) at sample p, u m to the left. Gaps report the nominal height. */
export function surf3(p: Sample3, u: number, width: number): number {
  const half = width / 2;
  let y = p.y;
  if (p.bank) y += (half - p.arcSign * Math.max(-half, Math.min(half, u))) * Math.tan(p.bank);
  const R = u > 0 ? p.pipeL : p.pipeR, e = Math.abs(u) - half;
  if (R > 0.05 && e > 0) { const ee = Math.min(e, R * 0.985); y += R - Math.sqrt(R * R - ee * ee); }
  return y;
}
/** How far the drivable surface reaches on one side (+1 = left), from the centre line. */
export function extent3(p: Sample3, side: number, width: number): number {
  const R = side > 0 ? p.pipeL : p.pipeR;
  return width / 2 + (R > 0.05 ? R * 0.985 : 0);
}
/** Surface normal (local) at sample p, u. */
export function normal3(p: Sample3, u: number, width: number): { x: number; y: number; z: number } {
  const d = 0.05, dh = (surf3(p, u + d, width) - surf3(p, u - d, width)) / (2 * d);
  const n = nrm(p.h), tx = Math.cos(p.h), tz = Math.sin(p.h);
  const vx = -dh * n.x - p.grade * tx, vy = 1, vz = -dh * n.z - p.grade * tz;
  const l = Math.hypot(vx, vy, vz);
  return { x: vx / l, y: vy / l, z: vz / l };
}

// ================================================================================================ the two tracks
const STUNT_R = 18;            // both figure-8 loops (their straights cross at 90 deg, at their middles)
const STUNT_ST = 2 * STUNT_R;  // each straight: loop to loop through the crossing
export const STUNT = {
  r: STUNT_R, deckY: 3.4, lipY: 4.0, landY: 3.0, gap: [13, 23] as [number, number], kick: [9, 13] as [number, number],
  pipeR: 2.6, kickSpeed: 15.5,                    // m/s: speed floor on the take-off ramp (clears the 10 m gap)
  mouths: [STUNT_R * Math.PI / 3, STUNT_R * 7 * Math.PI / 6] as [number, number],   // shortcut mouths: 60 / 210 deg into the half-pipe loop
};
/** Stunt Park: figure-8. Ground-level straight (start / finish) -> corkscrew climb (banked spiral, left 270) -> the
 *  high straight: deck, kicker, GAP JUMP over the crossing, landing, ramp down -> half-pipe loop (right 270, ground)
 *  with the crushed-car tunnel shortcut through its middle -> back onto the start straight under the gap. */
export const STUNT_GEO: Geo3 = {
  id: 'stunt', width: 9, floorY: 0,
  startX: -STUNT_R, finishS: 9,
  segs: [
    { tag: 'start', len: STUNT_ST, y: [[0, 0], [26, 0], [STUNT_ST, 0.6]] },
    { tag: 'corkscrew', r: STUNT_R, deg: 270, sign: 1, bank: 20, y: [[0, 0.6], [STUNT_R * 1.5 * Math.PI, STUNT.deckY]] },
    { tag: 'jump', len: STUNT_ST, y: [[0, STUNT.deckY], [STUNT.kick[0], STUNT.deckY], [STUNT.kick[1], STUNT.lipY], [STUNT.gap[1], STUNT.landY], [STUNT_ST, 0]],
      gap: STUNT.gap, kick: STUNT.kick },
    { tag: 'pipe', r: STUNT_R, deg: 270, sign: -1, y: [[0, 0]],
      pipe: { r: STUNT.pipeR, ease: 5, cut: STUNT.mouths.map(q => ({ side: 'R' as const, q, w: 4.2 })) } },
  ],
  shortcut: { seg: 3, q0: STUNT.mouths[0], q1: STUNT.mouths[1], side: 'R', width: 3.2, roof: 2.6 },
};

// Rally Dirt: a bean round the volcano. Bottom: start straight + chicane; turn 1; top: chicane + crest straight
// (lava river outside); turn 2 (jungle outside, the dino crossing just after it). Inside (+u) is always the volcano
// island behind a rock berm; outside is lava except on the start straight and turn 2.
const RB = { st: 30, cr: 14, cth: 35, tr: 22, ur: 20, uth: 25 };
const fwd = (r: number, th: number) => 4 * r * Math.sin(th * Math.PI / 180);   // chicane +th, -2th, +th: forward length
const RALLY_TOP = RB.st + fwd(RB.cr, RB.cth) - fwd(RB.ur, RB.uth);
export const RALLY = { crestQ: [6, 12, 18] as [number, number, number], crestY: 0.8, herdQ: 21, lavaY: -1.6 };
export const RALLY_GEO: Geo3 = {
  id: 'rally', width: 9, floorY: RALLY.lavaY,
  startX: -RB.st / 2 - fwd(RB.cr, RB.cth) / 2, finishS: 9,
  segs: [
    { tag: 'start', len: RB.st, y: [[0, 0]] },
    { tag: 'sbend', r: RB.cr, deg: RB.cth, sign: 1, edge: { R: 'lava' } },
    { tag: 'sbend', r: RB.cr, deg: 2 * RB.cth, sign: -1, edge: { R: 'lava' } },
    { tag: 'sbend', r: RB.cr, deg: RB.cth, sign: 1, edge: { R: 'lava' } },
    { tag: 'bank', r: RB.tr, deg: 180, sign: 1, bank: 8, edge: { R: 'lava' }, open: [[RB.tr * 0.9, RB.tr * 2.3]] },   // turn 1: open round the apex
    { tag: 'sbend', r: RB.ur, deg: RB.uth, sign: 1, edge: { R: 'lava' } },
    { tag: 'sbend', r: RB.ur, deg: 2 * RB.uth, sign: -1, edge: { R: 'lava' }, open: [[4, 13]] },   // top chicane: open on the middle bend
    { tag: 'sbend', r: RB.ur, deg: RB.uth, sign: 1, edge: { R: 'lava' } },
    { tag: 'crest', len: RALLY_TOP, y: [[0, 0], [RALLY.crestQ[0], 0], [RALLY.crestQ[1], RALLY.crestY], [RALLY.crestQ[2], 0], [RALLY_TOP, 0]], edge: { R: 'lava' } },
    { tag: 'bank', r: RB.tr, deg: 180, sign: 1, bank: 8 },
  ],
};

/** Nearest sample (brute force over a coarse grid of the line; for tools / bake, not per frame). */
export function nearest3(line: Line3, x: number, z: number, y?: number): { i: number; u: number } {
  let best = 0, bd = Infinity;
  const S = line.samples;
  for (let i = 0; i < S.length; i++) {
    const p = S[i]; let d = (p.x - x) ** 2 + (p.z - z) ** 2;
    if (y !== undefined) d += 4 * (y - p.y) ** 2;
    if (d < bd) { bd = d; best = i; }
  }
  const p = S[best], n = nrm(p.h);
  return { i: best, u: (x - p.x) * n.x + (z - p.z) * n.z };
}
