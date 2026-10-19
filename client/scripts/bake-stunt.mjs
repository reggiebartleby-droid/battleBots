/**
 * v0.45 STUNT PARK cube world (user 2026-10-19): Junkyard Scrap Pit -- steampunk orange / brown / red, gritty, dusk.
 * Writes client/public/tracks/stunt.cubes. Run (only when the layout changes), from the client folder:
 *   node --experimental-strip-types scripts/bake-stunt.mjs        (or: npm run bake:stunt)
 *
 * Track: trackgeo.ts STUNT_GEO (figure-8: start straight -> corkscrew climb -> gap jump over the crossing -> half-pipe
 * loop with the tunnel shortcut). Cube tiers (STYLE-cube.md): ground + flat road 0.48 m; banked / raised road, walls,
 * buildings, props 0.24 m; people + detail 0.12 m. The road columns' tops sit on race.ts's smooth colliders.
 * Coordinates: race.ts local space of the track (x, z), y up. Babylon is left-handed: a sign read by someone looking
 * toward +z runs along +x.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBake } from './cubelib.mjs';
import { stampTrack, SHOULDER } from './trackcells.mjs';
import { buildLine3, STUNT_GEO, STUNT, surf3, nrm } from '../src/trackgeo.ts';

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'tracks', 'stunt.cubes');
const B = createBake();
const { R, pick, noise, put, has, cell, column, box, ell, line, sign, crowdPerson, T } = B;
const LINE = buildLine3(STUNT_GEO), S = LINE.samples, WIDTH = STUNT_GEO.width, HALF = WIDTH / 2;
const XB = 72, BOUNDS = { x0: -XB, x1: XB, z0: -XB, z1: XB };

// ------------------------------------------------------------------------------------------------ palette
const DIRT = ['#4a3426', '#553b2a', '#3f2d22', '#5c4230'];
const RUST = ['#8a3b1a', '#a4521f', '#7a3418', '#94461c'];
const CARS = ['#8b2f1f', '#2f4f6b', '#6b6b2f', '#7a7a7a', '#3f5f3f', '#8a5a1f', '#5a2a4a', '#b0a080', '#a8401c', '#4a4440'];
const STEEL = '#6f6a66', DARK = '#2a201b', BLACK = '#1c1a19', HAZ = '#e8b21a', COPPER = '#b5652b', BRASS = '#c9973a', RED = '#a3271c', ORANGE = '#d9661f';
const ROAD = '#3a302b', ROAD2 = '#443831', PLATE = ['#8a4a22', '#7c4220', '#94532a'];
const SHIRTS = ['#d9661f', '#a3271c', '#e8b21a', '#5a3a24', '#2f4f6b', '#7a7a7a', '#c9973a', '#3f5f3f'];
const mixHexC = (a, b, t) => B.mixHex(a, b, t);
const hash = (a, b) => { let n = Math.imul(a * 73856093 ^ b * 19349663, 83492791); n ^= n >>> 13; return ((n >>> 0) % 1000) / 1000; };

// ------------------------------------------------------------------------------------------------ pieces
/** crushed car: a flat slab 1.92 x 0.48 x 0.96 (M cubes), rust spots, a window strip */
function crushed(x, y, z, alongX, col) {
  const [w, d] = alongX ? [1.92, 0.96] : [0.96, 1.92];
  // STYLE-cube.md: no random odd cubes inside a colour block -- the window is a regular band, the rust a bottom strip
  const rust = mixHexC(col, '#7a3418', 0.55), j0 = cell('M', y);
  box('M', x - w / 2, x + w / 2, y, y + 0.48, z - d / 2, z + d / 2, (i, j, k, X, Y, Z) => {
    const inner = Math.abs(alongX ? X - x : Z - z) < (alongX ? w : d) / 2 - 0.5;
    if (j === j0 + 1 && inner) return '#2a3238';   // squashed window band
    return j === j0 ? rust : col;
  });
}
function carStack(x, z, n, alongX) { for (let q = 0; q < n; q++) crushed(x + (R() - .5) * .3, q * 0.48, z + (R() - .5) * .3, q % 2 ? !alongX : alongX, pick(CARS)); }
function tire(x, y, z, axisX, ring = BLACK) {   // M-cube tire lying on its side or standing (axisX: standing, axle along x)
  for (let a = 0; a < 16; a++) {
    const t = a / 16 * Math.PI * 2, r = 0.42;
    const px = axisX ? x : x + Math.cos(t) * r, py = axisX ? y + Math.sin(t) * r : y, pz = axisX ? z + Math.cos(t) * r : z + Math.sin(t) * r;
    put('M', cell('M', px), cell('M', py), cell('M', pz), a % 4 === 0 ? '#3a3735' : ring);
  }
}
function tirePile(x, z, n) { for (let q = 0; q < n; q++) { const a = R() * 6.28, r = R() * 1.2; tire(x + Math.cos(a) * r, Math.floor(q / 4) * 0.24 + 0.12, z + Math.sin(a) * r, false, q % 7 === 0 ? '#d8d0c0' : BLACK); } }
function drum(x, z, col) { box('M', x - .24, x + .24, 0, .96, z - .24, z + .24, (i, j) => j === 1 ? '#e8e0d0' : col); }
function scrapPile(cx, cz, rx, ry, rz) {
  ell('L', cx, 0, cz, rx, ry, rz, (X, Y, Z) => { const r = hash(Math.floor(X * 3), Math.floor(Z * 3 + Y * 5)); return r < 0.35 ? pick(RUST) : r < 0.55 ? pick(CARS) : r < 0.7 ? STEEL : r < 0.85 ? DARK : pick(DIRT); }, (X, Y) => Y >= -0.48);
}
function smokestack(x, z, h, col) {
  box('M', x - .48, x + .48, 0, h, z - .48, z + .48, (i, j) => (j % 6 === 0) ? DARK : col);
  box('M', x - .72, x + .72, h, h + .48, z - .72, z + .72, BRASS);
  return [x, h + 0.6, z];
}
function lightPole(x, z, face) {   // work light: steel pole + a bright orange lamp head
  box('M', x - .12, x + .12, 0, 7.2, z - .12, z + .12, STEEL);
  box('M', x - .48, x + .48, 7.2, 7.68, z - .36, z + .36, DARK);
  box('M', x - .36, x + .36, 7.2, 7.44, z - .24 + face * .12, z + .24 + face * .12, ['#ffb060', 1.9]);
}

// ------------------------------------------------------------------------------------------------ the world
const SMOKE = [], GEARS = [], LAMPS = [];
const CRANE = [0, 0, 0];
function build() {
  B.setSeed(11);
  const roadL = stampTrack(LINE, WIDTH, T.L, 1.0);   // flat road at ground level -> 0.48 m columns
  const roadM = stampTrack(LINE, WIDTH, T.M, 1.0);   // everything raised / banked / pipe -> 0.24 m columns
  const flatAt = c => c && !c.wall && Math.abs(c.y) < 0.02 && S[c.si].pipeL < 0.05 && S[c.si].pipeR < 0.05 && !S[c.si].bank;
  // ---- ground (+ flat road in 0.48)
  for (let i = cell('L', -XB); i < cell('L', XB); i++) for (let k = cell('L', -XB); k < cell('L', XB); k++) {
    const x = (i + .5) * T.L, z = (k + .5) * T.L;
    const c = roadL.get(i + ',' + k);
    // a big cell is flat road only if all four small cells under it are flat road too
    const sub = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([a, b]) => roadM.get((2 * i + a) + ',' + (2 * k + b)));
    if (flatAt(c) && sub.every(flatAt)) {
      const p = S[c.si], u = c.u;
      let col = Math.abs(u) > HALF - 0.5 ? ((Math.floor(p.s / 0.96) & 1) ? HAZ : BLACK) : (Math.abs(Math.abs(u) - 1.6) < 0.4 ? ROAD2 : ROAD);
      if (p.s < 0.5 || p.s > LINE.length - 0.5) col = ((i + k) & 1) ? '#f2f2f2' : '#141414';   // finish line
      put('L', i, -1, k, col);
      continue;
    }
    if (sub.some(sc => sc)) { put('L', i, -2, k, DARK); continue; }   // under a raised / walled bit: the small columns take it
    const n = noise(x * .12, z * .12), m = noise(x * .22 + 9, z * .22);
    put('L', i, -1, k, m > .78 ? '#231b17' : n > .62 ? DIRT[1] : n > .42 ? DIRT[0] : n > .3 ? DIRT[3] : DIRT[2]);
  }
  // ---- raised / banked / pipe road + tire walls in 0.24 m columns (down to the ground: the embankments are scrap)
  for (const [key, c] of roadM) {
    const [i, k] = key.split(',').map(Number);
    if (!c.wall && Math.abs(c.y) < 0.02) {
      const p = S[c.si]; if (p.pipeL < 0.05 && p.pipeR < 0.05 && !p.bank) {
        const bi = Math.floor(i / 2), bk = Math.floor(k / 2), sub = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([a, b]) => roadM.get((2 * bi + a) + ',' + (2 * bk + b)));
        if (sub.every(flatAt) && flatAt(roadL.get(bi + ',' + bk))) continue;   // drawn as a big cube
      }
    }
    const p = S[c.si], x = (i + .5) * T.M, z = (k + .5) * T.M;
    if (c.wall) {   // stacked tires, a painted one now and then
      const painted = Math.floor(p.s / 1.2) % 6 === 0;   // every 7.2 m a painted stack (red / white), the rest plain black
      column('M', i, k, c.y, m => m === 0 ? '#3a3735' : painted ? (m % 2 ? '#c23a22' : '#e8e0d0') : (m % 2 ? BLACK : '#262321'), -0.48);
      continue;
    }
    const pipe = Math.abs(c.u) > HALF + 0.05 && (c.u > 0 ? p.pipeL : p.pipeR) > 0.05;
    const top = (() => {
      if (pipe) { const pl = PLATE[(Math.floor(p.s / 1.2) + (Math.abs(c.u) > HALF + 1.6 ? 1 : 0)) % 3]; return (Math.floor(p.s / 0.24) % 6 === 0) ? '#5a2f16' : pl; }
      if (p.kick) return (Math.floor(p.q / 0.48) & 1) ? ['#ff8a2a', 1.5] : BLACK;   // boost pad: glowing chevron rows
      if (Math.abs(c.u) > HALF - 0.4 && Math.abs(c.u) <= HALF + 0.3) return (Math.floor(p.s / 0.96) & 1) ? HAZ : BLACK;
      if (p.tag === 'jump' && Math.abs(p.q - STUNT.gap[0]) < 0.4) return HAZ;   // lips
      if (p.tag === 'jump' && Math.abs(p.q - STUNT.gap[1]) < 0.4) return HAZ;
      return Math.abs(Math.abs(c.u) - 1.6) < 0.3 ? ROAD2 : ROAD;
    })();
    // embankment: stacked crushed cars -- one colour per car (1.92 m along the track x 0.48 m layer), a rust band under each
    const side = c.u > 0 ? 1 : 0;
    column('M', i, k, c.y, m => {
      if (m === 0) return top;
      if (pipe) return m < 3 ? '#5a2f16' : DARK;
      const y = c.y - m * 0.24, layer = Math.floor(y / 0.48), car = Math.floor((p.s + layer * 0.7) / 1.92);
      const col = CARS[Math.floor(hash(car * 5 + side, layer * 3) * CARS.length)];
      return (y - layer * 0.48) < 0.24 ? mixHexC(col, '#7a3418', 0.55) : col;
    }, -0.48);
  }
  // ---- start / finish gantry (pipes), light pods are live
  { const f = S[0], n = nrm(f.h);
    for (const sd of [1, -1]) { const u = sd * (HALF + 0.9), x = f.x + n.x * u, z = f.z + n.z * u; box('M', x - .24, x + .24, 0, 5.52, z - .24, z + .24, COPPER); }
    box('M', f.x - .24, f.x + .24, 5.52, 6.24, -HALF - 1.2, HALF + 1.2, (i, j, k) => ((j + k) & 1) ? '#f2f2f2' : '#141414');
    box('M', f.x - .48, f.x - .24, 4.56, 5.52, -3, 3, '#1a1512');
  }
  // ---- the tunnel shortcut: crushed-car walls, corrugated roof, hazard frames + "RISKY!" signs at the mouths
  { const c = LINE.shortcut, ax = c.a.x, az = c.a.z, dx = c.b.x - ax, dz = c.b.z - az, L = Math.hypot(dx, dz), tx = dx / L, tz = dz / L, sx = -tz, sz = tx;
    for (let d = 0.6; d < L - 0.6; d += 0.24) for (const sd of [1, -1]) for (let y = 0; y < c.roof; y += 0.24) for (let w = 0; w < 0.48; w += 0.24) {
      const off = sd * (c.width / 2 + 0.05 + w), X = ax + tx * d + sx * off, Z = az + tz * d + sz * off;
      const layer = Math.floor(y / 0.48), carN = Math.floor((d + layer * 0.9) / 1.9);
      put('M', cell('M', X), cell('M', y), cell('M', Z), hash(carN * 13 + layer, sd * 7) < 0.3 ? pick(RUST) : CARS[(carN + layer * 3 + (sd > 0 ? 5 : 0)) % CARS.length]);
    }
    for (let d = 0.6; d < L - 0.6; d += 0.24) for (let off = -c.width / 2 - 0.6; off <= c.width / 2 + 0.6; off += 0.24) {
      const X = ax + tx * d + sx * off, Z = az + tz * d + sz * off;
      put('M', cell('M', X), cell('M', c.roof), cell('M', Z), (Math.floor(off / 0.48) & 1) ? '#6f6a66' : '#5c5754');   // corrugated: 0.48 m bands
    }
    for (const t of [0.36, 0.64]) for (let d = -0.7; d <= 0.7; d += 0.24) for (let off = -c.width / 2; off <= c.width / 2; off += 0.24) {
      const X = ax + tx * (L * t + d) + sx * off, Z = az + tz * (L * t + d) + sz * off;
      put('M', cell('M', X), 0, cell('M', Z), hash(Math.floor(off * 4), Math.floor(d * 4)) < 0.5 ? pick(CARS) : RUST[0]);
    }
    for (const [mx, mz, dir] of [[ax, az, 1], [c.b.x, c.b.z, -1]]) {   // hazard frame over each mouth + sign
      for (let off = -c.width / 2 - 0.5; off <= c.width / 2 + 0.5; off += 0.24) for (let y = c.roof; y < c.roof + 0.48; y += 0.24) {
        const X = mx + tx * dir * 0.7 + sx * off, Z = mz + tz * dir * 0.7 + sz * off;
        put('M', cell('M', X), cell('M', y), cell('M', Z), (Math.floor((off + y) / 0.48) & 1) ? HAZ : BLACK);
      }
    }
  }
  // ---- loop 1 (corkscrew) middle: the big scrap mountain + the crane on top (arm is live)
  scrapPile(18, 18, 9.5, 6.5, 9.5);
  box('M', 17.52, 18.48, 6, 15.6, 17.52, 18.48, (i, j) => (j % 4 === 0) ? DARK : ORANGE);
  box('M', 16.8, 19.2, 15.6, 16.56, 16.8, 19.2, '#5a3a24');
  CRANE.splice(0, 3, 18, 16.56, 18);
  // ---- loop 2 middle: crushed-car stacks either side of the tunnel
  { const c = LINE.shortcut, mx = (c.a.x + c.b.x) / 2, mz = (c.a.z + c.b.z) / 2, cx = -18, cz = -18;
    const ox = mx - cx, oz = mz - cz, ol = Math.hypot(ox, oz);
    for (const [px, pz] of [[cx - ox / ol * 4, cz - oz / ol * 4], [cx - ox / ol * 8, cz - oz / ol * 8 + 3], [cx - ox / ol * 7 + 4, cz - oz / ol * 7]]) carStack(px, pz, 3 + Math.floor(R() * 3), R() < .5);
    tirePile(cx - ox / ol * 2 + 5, cz - oz / ol * 2 - 4, 14);
  }
  // ---- SE: the scrap grandstand facing the start straight (crowd: live), STUNT PARK sign on top
  { const x0 = 6, x1 = 40, zF = -9.6;
    for (let r = 0; r < 7; r++) {
      const z0 = zF - r * 0.96, h = (r + 1) * 0.48;
      box('L', x0, x1, 0, h, z0 - 0.96, z0, (i, j, k, X) => j === Math.round(h / .48) - 1 ? ((Math.floor(X / 3.84) & 1) ? '#5a3a24' : '#6b4a30') : pick(CARS));
      for (let x = x0 + 0.6; x < x1 - 0.6; x += 0.62) if (R() > 0.18) crowdPerson(x + (R() - .5) * .1, h, z0 - 0.42, x * .3, SHIRTS, R() < .35 ? HAZ : null);
    }
    box('M', x0, x1, 0, 0.72, zF - 0.24, zF, (i, j, k, X) => (Math.floor(X / 0.96) & 1) ? HAZ : BLACK);
    const zb = zF - 7 * 0.96 - 0.24, y0 = 3.84 + 3.6;
    for (const x of [x0 + 4, x1 - 4]) box('M', x - .24, x + .24, 0, y0, zb - .24, zb + .24, COPPER);
    sign('STUNT PARK', (x0 + x1) / 2, y0, zb, 'x', ['#ffd27a', 1.6], '#5a1f12');
    for (const x of [x0 + 2, x1 - 2]) lightPole(x, zb - 1.5, 1);
  }
  // ---- NW: the steam works -- boiler house, gear wall (gears live), furnace mouth, smokestacks, catwalk crowd
  { const x0 = -42, x1 = -10, z0 = 12, z1 = 22;
    box('M', x0, x1, 0, 8.4, z0, z1, (i, j, k, X, Y, Z) => {
      if (Z < z0 + .25 && Y > 2.4 && Y < 3.4 && (Math.floor(X / 2.4) % 3 === 1)) return ['#ff7a2a', 1.8];   // furnace mouths
      if (Y > 7.9) return BRASS;
      return (j % 5 === 0) ? DARK : (j % 5 === 1 ? '#6b2a16' : '#5a3a24');
    }, true);
    for (let n = 0; n < 4; n++) { const gx = x0 + 5 + n * 7.4, gy = 5.2; GEARS.push([gx, gy, z0 - 0.3, n % 2 ? -1 : 1, n % 2 ? 1.6 : 2.2]); }
    for (let n = 0; n < 4; n++) SMOKE.push(smokestack(x0 + 4 + n * 8, z1 + 2, 13 + n % 2 * 3, n % 2 ? RED : '#5a3a24'));
    // copper pipes along the front
    for (const y of [1.2, 7.2]) line('M', [x0, y, z0 - 0.4], [x1, y, z0 - 0.4], COPPER);
    for (let x = x0 + 2; x < x1; x += 4) line('M', [x, 0, z0 - 0.4], [x, 7.2, z0 - 0.4], BRASS);
    // catwalk + crowd on the roof
    box('M', x0, x1, 8.4, 8.64, z0 - 1.2, z0, STEEL);
    for (let x = x0 + .6; x < x1 - .6; x += .7) if (R() > .25) crowdPerson(x, 8.64, z0 - .6, x * .3 + 2, SHIRTS, R() < .5 ? HAZ : null);
    sign('JUNKYARD SCRAP PIT', (x0 + x1) / 2, 9.4, z0 - 0.5, '-x', ['#ffb060', 1.6], '#2a1410');
    for (let x = x0 + 1; x < x1; x += 10) LAMPS.push([x, 8.0, z0 - 1.3]);
  }
  // ---- NE outside loop 1 + SW outside loop 2: car-stack walls, tire piles, drums, light poles
  for (let n = 0; n < 16; n++) { const a = n / 16 * Math.PI * 2, r = 54 + R() * 6, x = Math.cos(a) * r, z = Math.sin(a) * r; if (x > 4 && z < -4 && z > -44 && x < 44) continue; carStack(x, z, 2 + Math.floor(R() * 4), R() < .5); }
  for (let n = 0; n < 9; n++) { const a = R() * 6.28, r = 60 + R() * 8; scrapPile(Math.cos(a) * r, Math.sin(a) * r, 5 + R() * 4, 3 + R() * 3, 5 + R() * 4); }
  for (const [x, z] of [[44, 10], [44, 30], [10, 44], [30, 44], [-44, -10], [-44, -30], [-10, -44], [-30, -44], [-48, 4], [4, -48]]) lightPole(x, z, 0);
  for (let n = 0; n < 14; n++) { const a = R() * 6.28, r = 44 + R() * 8, x = Math.cos(a) * r, z = Math.sin(a) * r; if (x > 4 && z < -4 && z > -44 && x < 44) continue; drum(x, z, pick([RED, '#2f4f6b', '#3f5f3f', ORANGE])); }
  for (const [x, z] of [[46, -2], [-2, 46], [-46, 40], [40, -46]]) tirePile(x, z, 18);
  // a car crusher (decor) next to the steam works
  { const x = -48, z = 30; box('M', x - 3, x + 3, 0, 1.2, z - 2, z + 2, '#5a3a24'); for (const sx of [-2.6, 2.4]) box('M', x + sx, x + sx + .48, 1.2, 7.2, z - 1.6, z + 1.6, RED);
    box('M', x - 3, x + 3, 6.0, 7.2, z - 2, z + 2, (i, j) => j % 2 ? HAZ : BLACK); crushed(x, 1.2, z, true, pick(CARS)); }
  // tire chutes at the three tire spawners (stuntpark.ts uses the same places): piles + hazard boards
  for (const [q, seg, u] of [[80, 1, 0], [37, 3, 7.3], [30, 0, 6.0]]) {
    const p = S.find(o => o.seg === seg && o.q >= q), n = nrm(p.h), sd = u >= 0 ? 1 : -1;
    const bx = p.x + n.x * (u + sd * 2.2), bz = p.z + n.z * (u + sd * 2.2);
    tirePile(bx, bz, 10);
  }
}

// ------------------------------------------------------------------------------------------------ run
B.bake({
  out: OUT, bounds: BOUNDS, build, cullBelow: -0.48,
  objects: [
    ['tire', () => {   // a standing tire (axle along x), centre at 0, 0.12 cubes
      for (let a = -3; a <= 3; a++) for (let b = -3; b <= 3; b++) { const r = Math.hypot(a + .5 - .5, b), x = 0; void x; if (r <= 3.6 && r >= 1.6) for (const i of [-1, 0]) put('S', i, b, a, (Math.abs(a) + Math.abs(b)) % 3 === 0 ? '#3a3735' : BLACK); if (r < 1.6) put('S', 0, b, a, '#8a8580'); }
    }],
    ['gear', () => {   // a big gear in the x-y plane, axle along z
      for (let a = -9; a <= 9; a++) for (let b = -9; b <= 9; b++) {
        const r = Math.hypot(a, b), ang = Math.atan2(b, a), tooth = Math.cos(ang * 12) > 0.3;
        if ((r <= 7.5 || (tooth && r <= 9.2)) && r >= 1.5 && !(r > 3 && r < 6 && Math.cos(ang * 4) > 0.55)) put('S', a, b, 0, r > 7 ? BRASS : COPPER);
        if (r < 1.5) put('S', a, b, -1, DARK);
      }
    }],
    ['crane', () => {   // arm along +x from the mast top, magnet hanging at the end
      box('M', -2.4, 10.8, 0, 0.48, -0.24, 0.24, (i, j, k, X) => (Math.floor(X / 0.96) & 1) ? HAZ : BLACK);
      box('M', -2.4, -1.44, -1.2, 0, -0.48, 0.48, '#3a3735');   // counterweight
      line('S', [10.4, 0, 0], [10.4, -4.6, 0], '#3a3735');
      ell('M', 10.4, -5.0, 0, 1.0, 0.36, 1.0, '#4a4440');
    }],
    ['smoke', () => box('M', -0.24, 0.24, -0.24, 0.24, -0.24, 0.24, '#5a5450')],
    ['pod', () => box('M', -.48, -.24, 4.80, 5.28, -.24, .24, '#ffffff')],
  ],
  header: {
    pods: [-2.4, -1.2, 0, 1.2, 2.4], podX: S[0].x,
    smoke: SMOKE, gears: GEARS, crane: CRANE, lamps: LAMPS,
    far: '#3a2a20',
  },
});
