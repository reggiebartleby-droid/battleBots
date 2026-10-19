/**
 * v0.45 RALLY DIRT cube world (user 2026-10-19): Dinosaur Lava -- black + red, brown rock / volcano, red lava, dinos in
 * green / brown / orange / blue, some green grass and blue water on the volcano island.
 * Writes client/public/tracks/rally.cubes. Run (only when the layout changes), from the client folder:
 *   node --experimental-strip-types scripts/bake-rally.mjs        (or: npm run bake:rally)
 *
 * Track: trackgeo.ts RALLY_GEO -- a loose-dirt loop round the volcano island. Outside: the lava sea (lava river along
 * the top straight), except the jungle by the start straight + turn 2, where the dino herd lives. The lava itself is
 * a separate glowing object (dinolava.ts animates it); the driving physics floor is the lava top (race.ts).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBake } from './cubelib.mjs';
import { stampTrack } from './trackcells.mjs';
import { buildLine3, RALLY_GEO, RALLY, nearest3, nrm } from '../src/trackgeo.ts';

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'tracks', 'rally.cubes');
const B = createBake();
const { R, pick, noise, put, cell, column, box, ell, line, sign, crowdPerson, T } = B;
const LINE = buildLine3(RALLY_GEO), S = LINE.samples, WIDTH = RALLY_GEO.width, HALF = WIDTH / 2;
const BOUNDS = { x0: -96, x1: 96, z0: -64, z1: 96 };
const LAVA_Y = RALLY.lavaY, ROCK_BOTTOM = LAVA_Y - 0.48;
const VOLC = { x: 0, z: 22, r: 15.5, h: 19, crater: 3.2 };
const md = (a, n) => ((a % n) + n) % n;
const hash = (a, b) => { let n = Math.imul(a * 73856093 ^ b * 19349663, 83492791); n ^= n >>> 13; return ((n >>> 0) % 1000) / 1000; };

// ------------------------------------------------------------------------------------------------ palette
const ROCK = ['#3a2a22', '#2e221c', '#45322a'], BASALT = '#1a1415', BLACK = '#100c0d';
const DIRT = ['#7a4a2a', '#6b4024', '#83522f'], DIRT_DARK = '#5a361f';
const GRASS = ['#3f7a2e', '#4a8a34', '#356a28'], JUNGLE = ['#2f6b2c', '#3f8a35', '#245a22', '#5fae45'];
const WATER = ['#2a6fb0', '#3a86c8'], LAVA = '#ff3b1f';
const SHIRTS = ['#c8b48a', '#a89468', '#6b7a4a', '#d9661f', '#2a6fb0', '#8a5a2a'];

/** what's at local (x, z): 'road' handled separately; 'ground' (island / jungle) or 'lava' (+ river flag) */
const nearCache = new Map();
function zone(x, z) {
  const key = Math.round(x * 2) + ',' + Math.round(z * 2);
  let v = nearCache.get(key);
  if (v) return v;
  const { i, u } = nearest3(LINE, x, z);
  const p = S[i];
  if (Math.abs(u) <= HALF + 0.45) v = { kind: 'road', i, u };
  else v = { kind: (u > 0 ? p.edgeL : p.edgeR) === 'lava' ? 'lava' : 'ground', i, u, inside: u > 0 };
  nearCache.set(key, v);
  return v;
}

// ------------------------------------------------------------------------------------------------ pieces
function palm(x, z, h) {
  for (let y = 0; y < h; y += 0.24) { const lean = Math.sin(y * 0.4) * 0.3; box('M', x + lean - .12, x + lean + .12, y, y + .24, z - .12, z + .12, (Math.floor(y / 0.48) & 1) ? '#6b4a2a' : '#5a3e24'); }
  const tx = x + Math.sin(h * 0.4) * 0.3;
  for (let a = 0; a < 6; a++) {
    const ang = a / 6 * Math.PI * 2;
    for (let d = 0.2; d < 2.4; d += 0.2) { const yy = h + 0.3 - (d * d) * 0.12; put('M', cell('M', tx + Math.cos(ang) * d), cell('M', yy), cell('M', z + Math.sin(ang) * d), d > 1.6 ? JUNGLE[3] : JUNGLE[a % 2]); }
  }
}
function fern(x, z) { ell('M', x, 0.4, z, 1.0 + R() * .6, 0.7, 1.0 + R() * .6, (X, Y) => Y > 0.6 ? JUNGLE[3] : JUNGLE[0], (X, Y) => Y >= 0); }
function bigTree(x, z) {
  const h = 4 + R() * 2;
  box('M', x - .36, x + .36, 0, h, z - .36, z + .36, '#4a3320');
  ell('L', x, h + 1.4, z, 2.6 + R(), 1.9, 2.6 + R(), (X, Y) => Y > h + 2.2 ? JUNGLE[3] : Y > h + 1.2 ? JUNGLE[1] : JUNGLE[2]);
}
function rockLump(x, z, r, h) { ell('M', x, 0, z, r, h, r * 0.8, (X, Y) => Y > h * 0.6 ? ROCK[2] : ROCK[0], (X, Y) => Y >= -0.3); }
/** bones: a ribcage arch (decor) */
function ribcage(x, z, rot) {
  for (let n = 0; n < 5; n++) {
    const off = (n - 2) * 0.72;
    for (let a = 0; a <= 12; a++) { const t = a / 12 * Math.PI, X = Math.cos(t) * 1.4, Y = Math.sin(t) * 1.8; const [px, pz] = rot ? [x + off, z + X] : [x + X, z + off]; put('M', cell('M', px), cell('M', Y), cell('M', pz), '#e8dcc0'); }
  }
  const [a, b] = rot ? [[x - 2, 0.1, z], [x + 2, 0.1, z]] : [[x, 0.1, z - 2], [x, 0.1, z + 2]];
  line('M', a, b, '#d8ccb0');
}

// ------------------------------------------------------------------------------------------------ dino models (live)
/** raptor: facing +x, feet at y = 0, 0.12 m cubes. body (head, neck, torso, tail, arms) + one leg (hip at 0, 0, 0). */
function raptorBody(main, belly, stripe) {
  const P = (i, j, k, c) => put('S', i, j, k, c);
  for (let i = -6; i <= 5; i++) for (let j = 5; j <= 8; j++) for (let k = -2; k <= 1; k++) {   // torso
    if ((j === 8 || j === 5) && (k === -2 || k === 1) && (i < -4 || i > 3)) continue;
    P(i, j, k, j === 5 ? belly : (j === 8 && (i & 1) && i < 4 ? stripe : main));
  }
  for (let n = 0; n < 4; n++) for (let k = -1; k <= 0; k++) for (let j = 0; j < 2; j++) P(6 + n, 8 + n + j, k, main);   // neck
  for (let i = 9; i <= 13; i++) for (let j = 11; j <= 13; j++) for (let k = -1; k <= 0; k++) P(i, j, k, j === 11 && i > 10 ? belly : main);   // head
  P(13, 12, -2, '#f2f2f2'); P(13, 12, 1, '#f2f2f2'); P(12, 13, -2, '#ffd23f'); P(12, 13, 1, '#ffd23f');   // teeth, eyes
  for (let n = 0; n < 12; n++) for (let k = -1; k <= 0; k++) P(-7 - n, 7 + Math.round(n * 0.25) - (n > 8 ? 1 : 0), k, n % 3 === 2 ? stripe : main);   // tail
  for (const k of [-3, 2]) for (let j = 5; j <= 6; j++) P(4, j, k, main);   // arms
  P(5, 5, -3, '#e8dcc0'); P(5, 5, 2, '#e8dcc0');
}
function raptorLeg(main) {   // hip at the origin, down to the foot (y -5 .. 0 relative, the body puts it at y 5)
  for (let j = -5; j <= 0; j++) put('S', j > -3 ? 0 : 1, j, 0, main);
  for (let i = 0; i <= 3; i++) put('S', i, -5, 0, '#2a201b');
}
function brachio() {   // M cubes, facing +x: big body, long neck, tail; green with blue back
  const main = '#4a8a5a', back = '#2a6fb0', belly = '#8ab07a';
  ell('M', 0, 3.4, 0, 3.2, 1.7, 1.5, (X, Y) => Y > 4.2 ? back : Y < 2.6 ? belly : main);
  for (const [lx, lz] of [[-2, -0.8], [-2, 0.8], [2, -0.8], [2, 0.8]]) box('M', lx - .36, lx + .36, 0, 2.6, lz - .36, lz + .36, main);
  for (let n = 0; n < 28; n++) { const t = n / 28, x = 2.6 + t * 3.6, y = 4.0 + t * 5.0; box('M', x - .36, x + .36, y - .36, y + .36, -.36, .36, n % 4 === 0 ? back : main); }
  box('M', 6.0, 7.4, 8.8, 9.6, -.36, .36, main); put('M', cell('M', 7.0), cell('M', 9.4), cell('M', -0.36), '#141414'); put('M', cell('M', 7.0), cell('M', 9.4), cell('M', 0.24), '#141414');
  for (let n = 0; n < 26; n++) { const t = n / 26, x = -2.8 - t * 5.6, y = 3.6 - t * 2.6; box('M', x - .24, x + .24, y - .24, y + .24, -.24, .24, n % 4 === 0 ? back : main); }
}
function pteroBody() {
  const main = '#a3271c', head = '#d9661f';
  box('S', -0.6, 0.6, -0.18, 0.18, -0.24, 0.24, main);
  box('S', 0.6, 1.2, 0.0, 0.24, -0.12, 0.12, head); box('S', 1.2, 1.8, 0.06, 0.18, -0.06, 0.06, '#e8b21a');   // head + beak
  box('S', -0.48, 0.0, 0.18, 0.66, -0.06, 0.06, head);   // crest
}
function pteroWing(sd) { for (let k = 0; k < 18; k++) for (let i = -3; i <= 2 - Math.floor(k / 4); i++) put('S', i, 0, sd * (k + 2) - (sd < 0 ? 1 : 0), k > 14 ? '#5a1410' : '#7a2014'); }

// ------------------------------------------------------------------------------------------------ the world
const SMOKE = [], LAVAFALLS = [];
function build() {
  B.setSeed(23);
  const roadL = stampTrack(LINE, WIDTH, T.L, 0.9);
  const roadM = stampTrack(LINE, WIDTH, T.M, 0.9);
  const flatAt = c => c && !c.wall && Math.abs(c.y) < 0.02 && !S[c.si].bank;
  const dirtTop = (p, u, i, k) => {
    if (p.s < 0.5 || p.s > LINE.length - 0.5) return ((i + k) & 1) ? '#f2f2f2' : '#141414';   // finish line
    if (Math.abs(Math.abs(u) - 1.7) < 0.35) return DIRT_DARK;                               // wheel ruts
    if (Math.abs(u) > HALF - 0.3) return '#8a5a34';                                         // loose edge
    return DIRT[(Math.floor(p.s / 2.88) + (u > 0 ? 1 : 0)) % 3];
  };
  // ---- ground / lava / flat road (0.48)
  for (let i = cell('L', BOUNDS.x0); i < cell('L', BOUNDS.x1); i++) for (let k = cell('L', BOUNDS.z0); k < cell('L', BOUNDS.z1); k++) {
    const x = (i + .5) * T.L, z = (k + .5) * T.L;
    const c = roadL.get(i + ',' + k);
    const sub = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([a, b]) => roadM.get((2 * i + a) + ',' + (2 * k + b)));
    if (flatAt(c) && sub.every(flatAt)) {
      const p = S[c.si];
      column('L', i, k, 0, m => m === 0 ? dirtTop(p, c.u, i, k) : m < 2 ? DIRT_DARK : ROCK[md(m + i, 3)], ROCK_BOTTOM);
      continue;
    }
    if (sub.some(sc => sc)) continue;   // the small columns take it
    const zn = zone(x, z);
    if (zn.kind === 'lava') continue;   // the lava object draws it
    // ground: the volcano island inside, the jungle outside; grass + dirt + water pools, rock cliff down to the lava
    const dv = Math.hypot(x - VOLC.x, z - VOLC.z);
    if (zn.inside && dv < VOLC.r + 0.5) continue;   // the volcano itself (below)
    const n = noise(x * .09 + 40, z * .09), pool = noise(x * .05 + 7, z * .05 + 3);
    let top;
    if (!zn.inside && pool > 0.74 && Math.abs(zn.u) > HALF + 6) top = WATER[(i + k) & 1 ? 0 : 1];
    else top = n > 0.62 ? GRASS[1] : n > 0.45 ? GRASS[0] : n > 0.32 ? GRASS[2] : DIRT[1];
    if (zn.inside && dv < VOLC.r + 4) top = n > 0.5 ? ROCK[2] : DIRT[1];   // volcano foot: ash + rock
    column('L', i, k, 0, m => m === 0 ? top : m === 1 ? DIRT_DARK : ROCK[md(m + k, 3)], ROCK_BOTTOM);
  }
  // ---- banked turns, crest, berms (0.24)
  for (const [key, c] of roadM) {
    const [i, k] = key.split(',').map(Number);
    if (!c.wall && flatAt(c)) {
      const bi = Math.floor(i / 2), bk = Math.floor(k / 2), sub = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([a, b]) => roadM.get((2 * bi + a) + ',' + (2 * bk + b)));
      if (sub.every(flatAt) && flatAt(roadL.get(bi + ',' + bk))) continue;
    }
    const p = S[c.si];
    if (c.wall) {   // volcanic rock berm, regular bands
      column('M', i, k, c.y, m => m === 0 ? ROCK[2] : m % 3 === 0 ? BASALT : ROCK[0], ROCK_BOTTOM);
      continue;
    }
    column('M', i, k, c.y, m => m === 0 ? dirtTop(p, c.u, i, k) : m < 3 ? DIRT_DARK : ROCK[md(m + i, 3)], ROCK_BOTTOM);
  }
  // ---- the volcano: a cone of 0.48 m columns, lava channels, the crater (glow is live)
  for (let i = cell('L', VOLC.x - VOLC.r - 1); i <= cell('L', VOLC.x + VOLC.r + 1); i++) for (let k = cell('L', VOLC.z - VOLC.r - 1); k <= cell('L', VOLC.z + VOLC.r + 1); k++) {
    const x = (i + .5) * T.L, z = (k + .5) * T.L, d = Math.hypot(x - VOLC.x, z - VOLC.z);
    if (d > VOLC.r + 0.5) continue;
    const zn = zone(x, z); if (!zn.inside) continue;
    const ang = Math.atan2(z - VOLC.z, x - VOLC.x), rough = noise(ang * 3 + 5, d * 0.4) * 1.2;
    let h = VOLC.h * Math.pow(Math.max(0, 1 - d / VOLC.r), 1.15) + rough;
    if (d < VOLC.crater) h = VOLC.h - 2.2 + d * 0.3;   // crater bowl
    h = Math.max(0.48, Math.round(h / T.L) * T.L);
    const channel = [0.5, 2.6, 4.4].some(a => Math.abs(Math.atan2(Math.sin(ang - a), Math.cos(ang - a))) < 0.07 + 0.04 * (1 - d / VOLC.r)) && d > VOLC.crater && d < VOLC.r - 1;
    const topCol = d < VOLC.crater ? ['#ff6a2a', 1.7] : channel ? ['#ff3b1f', 1.6] : h > VOLC.h * 0.75 ? BLACK : h > VOLC.h * 0.4 ? ROCK[md(i + k, 2)] : ROCK[2];
    column('L', i, k, h, m => m === 0 ? topCol : (channel && m < 2) ? ['#c22a14', 1.3] : (Math.floor((h - m * 0.48) / 1.44) & 1) ? ROCK[0] : BASALT, ROCK_BOTTOM);
    if (channel && d > VOLC.r - 2.5) LAVAFALLS.push([x, h, z]);
  }
  SMOKE.push([VOLC.x, VOLC.h + 0.5, VOLC.z]);
  // ---- jungle: palms, big trees, ferns on the ground zones (not on the road / its shoulders / the volcano)
  for (let n = 0; n < 900; n++) {
    const x = BOUNDS.x0 + 4 + R() * (BOUNDS.x1 - BOUNDS.x0 - 8), z = BOUNDS.z0 + 4 + R() * (BOUNDS.z1 - BOUNDS.z0 - 8);
    const zn = zone(x, z);
    if (zn.kind !== 'ground' || Math.abs(zn.u) < HALF + 3.2) continue;
    if (Math.hypot(x - VOLC.x, z - VOLC.z) < VOLC.r + 3) continue;
    if (Math.abs(x - (-10)) < 4.5 && z < 0) continue;   // the herd's path through the jungle stays open
    if (x > -40 && x < -22 && z < -3 && z > -12) continue;   // the viewing deck
    const r = R();
    if (r < 0.25) palm(x, z, 3.5 + R() * 2.5); else if (r < 0.4) bigTree(x, z); else if (r < 0.75) fern(x, z); else if (r < 0.85) rockLump(x, z, 0.8 + R(), 0.6 + R() * 0.8);
  }
  // rock islands + spires in the lava sea
  for (let n = 0; n < 40; n++) {
    const x = BOUNDS.x0 + R() * (BOUNDS.x1 - BOUNDS.x0), z = BOUNDS.z0 + R() * (BOUNDS.z1 - BOUNDS.z0);
    const zn = zone(x, z); if (zn.kind !== 'lava' || Math.abs(zn.u) < HALF + 5) continue;
    const r = 1.2 + R() * 2.5, h = R() < 0.3 ? 4 + R() * 6 : 0.8 + R();
    ell('M', x, LAVA_Y, z, r, h, r * (0.7 + R() * 0.5), (X, Y) => Y > LAVA_Y + h * 0.7 ? ROCK[2] : Y > LAVA_Y + 0.3 ? ROCK[0] : BASALT, (X, Y) => Y >= LAVA_Y - 0.5);
  }
  ribcage(-62, -18, false); ribcage(38, -14, true);
  // ---- viewing deck (rock ledge) + safari crowd, RALLY DIRT sign, start gantry (bone posts) by the start straight
  { const x0 = -40, x1 = -22, zF = -5.2;
    for (let r = 0; r < 5; r++) {
      const z0 = zF - r * 0.96, h = (r + 1) * 0.48;
      box('L', x0, x1, 0, h, z0 - 0.96, z0, (i, j) => j === Math.round(h / .48) - 1 ? ROCK[2] : ROCK[0]);
      for (let x = x0 + .6; x < x1 - .6; x += .62) if (R() > .2) crowdPerson(x + (R() - .5) * .1, h, z0 - .42, x * .3, SHIRTS, R() < .5 ? '#c8b48a' : null);
    }
    const zb = zF - 5 * 0.96 - 0.3, y0 = 2.4 + 3.2;
    for (const x of [x0 + 2, x1 - 2]) box('M', x - .24, x + .24, 0, y0, zb - .24, zb + .24, '#e8dcc0');
    sign('RALLY DIRT', (x0 + x1) / 2, y0, zb, 'x', ['#ff6a2a', 1.6], BLACK);
  }
  { const f = S[0], n = nrm(f.h);
    for (const sd of [1, -1]) { const u = sd * (HALF + 1.0), x = f.x + n.x * u, z = f.z + n.z * u; box('M', x - .24, x + .24, 0, 5.52, z - .24, z + .24, '#e8dcc0'); ell('M', x, 5.8, z, .5, .4, .5, '#d8ccb0'); }
    box('M', f.x - .24, f.x + .24, 5.52, 6.24, -HALF - 1.2, HALF + 1.2, (i, j, k) => ((j + k) & 1) ? '#f2f2f2' : '#141414');
    box('M', f.x - .48, f.x - .24, 4.56, 5.52, -3, 3, '#1a1512');
  }
  // dino crossing signs either side of the herd path
  for (const z of [-HALF - 2.2, HALF + 2.2]) {
    const x = -10 + (z > 0 ? 6 : -6);
    box('M', x - .12, x + .12, 0, 2.4, z - .12, z + .12, '#5a3e24');
    box('M', x - .6, x + .6, 2.4, 3.6, z - .12, z + .12, (i, j, k, X, Y) => (Math.abs(X - x) < .25 && Y > 2.6 && Y < 3.4) ? BLACK : '#e8b21a');
  }
}

// ------------------------------------------------------------------------------------------------ lava (its own glowing object)
function lava() {
  for (let i = cell('L', BOUNDS.x0); i < cell('L', BOUNDS.x1); i++) for (let k = cell('L', BOUNDS.z0); k < cell('L', BOUNDS.z1); k++) {
    const x = (i + .5) * T.L, z = (k + .5) * T.L, zn = zone(x, z);
    if (zn.kind !== 'lava') continue;
    const n = noise(x * .14, z * .14 + 11), m = noise(x * .45 + 3, z * .45);
    put('L', i, cell('L', LAVA_Y - 0.24), k, n > 0.66 ? '#2a1210' : n > 0.55 ? '#7a1a0c' : m > 0.6 ? '#ffb02a' : n > 0.35 ? '#ff4a1a' : '#e0300f');
  }
}

// ------------------------------------------------------------------------------------------------ run
const VARIANTS = { o: ['#d9661f', '#e8b080', '#8a3a10'], g: ['#3f8a35', '#a8c890', '#245a22'], b: ['#2a6fb0', '#9ac0e0', '#1a3f70'], n: ['#7a5232', '#c8a07a', '#4a3320'] };
const objects = [['lava', lava]];
for (const [v, [main, belly, stripe]] of Object.entries(VARIANTS)) {
  objects.push(['raptor_' + v, () => raptorBody(main, belly, stripe)]);
  objects.push(['raptorleg_' + v, () => raptorLeg(main)]);
}
objects.push(['brachio', brachio], ['ptero', pteroBody], ['pterowingL', () => pteroWing(1)], ['pterowingR', () => pteroWing(-1)]);
objects.push(['blob', () => box('M', -0.24, 0.24, -0.24, 0.24, -0.24, 0.24, '#ffffff')]);   // 0.48 m, centred
objects.push(['pod', () => box('M', -.48, -.24, 4.80, 5.28, -.24, .24, '#ffffff')]);
const herdP = S.find(p => p.seg === 0 && p.q >= RALLY.herdQ), hn = nrm(herdP.h);
B.bake({
  out: OUT, bounds: BOUNDS, build, cullBelow: -1.9, objects,
  header: {
    pods: [-2.4, -1.2, 0, 1.2, 2.4], podX: S[0].x, far: '#2a0c08',
    volcano: VOLC, smoke: SMOKE, lavafalls: LAVAFALLS.slice(0, 12),
    herd: { x: herdP.x, z: herdP.z, nx: hn.x, nz: hn.z, from: -26, to: 16 },
    variants: Object.keys(VARIANTS),
  },
});
