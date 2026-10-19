/**
 * v0.44 CUBE OVAL bake (user: "plan it into the game build" -> design/cube-oval-build-plan.md).
 *
 * Builds the Oval Speedway cube world once, ahead of time, from the "Cube Oval Speedway" mockup layout, and writes
 * client/public/tracks/oval.cubes (gzipped). The game (cubeoval.ts) only loads and draws it -- no cube building at load.
 *
 *   tiers      ground / track / stands 0.48 m · buildings / props / banked turns 0.24 m · people / detail 0.12 m
 *   culling    only cube faces that touch open air are kept (also against bigger cubes of the other tiers)
 *   merging    same-colour neighbouring faces become one big rectangle ("greedy meshing"); the seam texture repeats
 *              once per cube on it (UVs in cube units), per-cube wear is done in the shader
 *   columns    banked-turn and outer-wall columns: top face exactly on the smooth driving surface (colliders in
 *              race.ts), so they are not on the vertical cube grid; they get a top face + only the exposed sides
 *   live parts crowd (instanced people), helicopter rotor, blimp, clouds, start-light pods: baked as separate
 *              objects in their own local coordinates; cubeoval.ts places and animates them
 *
 * Changes from the mockup (to match the game): walls sit on the race.ts colliders (|u| 5.0-5.48), kerbs on the turns
 * are inside the road (like race.ts), banked turns are 0.24 m (user 2026-10-19), text is mirrored for Babylon's
 * left-handed view, no per-cube random colour jitter (shader wear instead), mockup karts left out (the game has bots).
 *
 * Run (only when the layout changes):  node scripts/bake-oval.mjs   (from the client folder)
 * Coordinates: race.ts Oval local space -- start straight along +x at z = 0, finish at x = 0, infield +z.
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'tracks', 'oval.cubes');   // gzipped

const T = { L: 0.48, M: 0.24, S: 0.12 };
const TIERS = ['L', 'M', 'S'];
const ST = 44, RT = 16, HALF = 5, BANKDEG = 18;          // race.ts TRACKS.oval: straights 44, r 16, width 10, bank 18
const TURN_A = Math.PI * RT, LAP = 2 * ST + 2 * TURN_A;
const WALL_IN = 5.0, WALL_OUT = 5.72;                     // race.ts walls: |u| 5.0-5.3; 0.72 band so curved walls have no corner-only gaps

let seed = 1;
function R() { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }
const pick = a => a[Math.floor(R() * a.length)];
function noise(x, z) {
  const xi = Math.floor(x), zi = Math.floor(z), xf = x - xi, zf = z - zi;
  const h = (a, b) => { let n = Math.imul(a * 374761393 + b * 668265263, 1274126177); n = (n ^ (n >>> 13)) * 1274126177; return ((n ^ (n >>> 16)) >>> 0) / 4294967296; };
  const s = t => t * t * (3 - 2 * t), u = s(xf), v = s(zf);
  return (h(xi, zi) * (1 - u) + h(xi + 1, zi) * u) * (1 - v) + (h(xi, zi + 1) * (1 - u) + h(xi + 1, zi + 1) * u) * v;
}

// ------------------------------------------------------------------------------------------------ palette
const PAL = [], PIDX = new Map();
function hexRGB(hex) { const n = parseInt(hex.slice(1), 16); return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]; }
function mixHex(a, b, t) { const A = hexRGB(a), B = hexRGB(b); const c = A.map((v, i) => Math.round((v + (B[i] - v) * t) * 255)); return '#' + c.map(v => v.toString(16).padStart(2, '0')).join(''); }
/** spec: '#hex' or ['#hex', brightness mult(, ignored jitter)] -> palette index */
function colIdx(spec) {
  let hex = spec, m = 1;
  if (Array.isArray(spec)) { hex = spec[0]; if (spec[1] !== undefined) m = spec[1]; }
  const key = hex + '*' + m;
  let i = PIDX.get(key);
  if (i === undefined) { const c = hexRGB(hex); i = PAL.length; PAL.push([c[0] * m, c[1] * m, c[2] * m].map(v => +v.toFixed(4))); PIDX.set(key, i); }
  return i;
}

// ------------------------------------------------------------------------------------------------ cube store
const OFF = 2048;
const vkey = (i, j, k) => ((i + OFF) * 1024 + (j + 512)) * 4096 + (k + OFF);
const ckey = (i, k) => (i + OFF) * 4096 + (k + OFF);
function makeStore() { return { L: new Map(), M: new Map(), S: new Map(), colL: new Map(), colM: new Map() }; }
let W = makeStore();
function put(t, i, j, k, spec) { W[t].set(vkey(i, j, k), colIdx(spec)); }
const idx = (t, v) => Math.round(v / T[t]);
const BOTTOM = -0.48;
/** Column on the cube grid (x/z) whose top face is exactly at height h, filled down into the ground. */
function column(t, i, k, h, specAt) {
  const s = T[t], n = h / s;
  if (Math.abs(n - Math.round(n)) < 1e-6) {          // top on the cube grid: plain cubes
    const top = Math.round(n);
    for (let j = top - 1, m = 0; j * s >= BOTTOM - 1e-6; j--, m++) put(t, i, j, k, specAt(m));
    return;
  }
  const cols = [];
  for (let y = h, m = 0; y > BOTTOM + 1e-6; y -= s, m++) cols.push(colIdx(specAt(m)));
  W['col' + t].set(ckey(i, k), { top: h, cols });
}
function box(t, x0, x1, y0, y1, z0, z1, col, hollow) {
  const s = T[t]; const i0 = idx(t, x0), i1 = idx(t, x1) - 1, j0 = idx(t, y0), j1 = idx(t, y1) - 1, k0 = idx(t, z0), k1 = idx(t, z1) - 1;
  for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) for (let k = k0; k <= k1; k++) {
    if (hollow && i > i0 && i < i1 && j > j0 && j < j1 && k > k0 && k < k1) continue;
    const c = typeof col === 'function' ? col(i, j, k, (i + .5) * s, (j + .5) * s, (k + .5) * s) : col;
    if (c) put(t, i, j, k, c);
  }
}
function ell(t, cx, cy, cz, rx, ry, rz, col, clip) {
  const s = T[t];
  const ins = (i, j, k) => { const x = (i + .5) * s, y = (j + .5) * s, z = (k + .5) * s, dx = (x - cx) / rx, dy = (y - cy) / ry, dz = (z - cz) / rz; return dx * dx + dy * dy + dz * dz <= 1 && (!clip || clip(x, y, z)); };
  for (let i = Math.floor((cx - rx) / s); i <= Math.ceil((cx + rx) / s); i++) for (let j = Math.floor((cy - ry) / s); j <= Math.ceil((cy + ry) / s); j++) for (let k = Math.floor((cz - rz) / s); k <= Math.ceil((cz + rz) / s); k++) {
    if (!ins(i, j, k)) continue;
    if (ins(i + 1, j, k) && ins(i - 1, j, k) && ins(i, j + 1, k) && ins(i, j - 1, k) && ins(i, j, k + 1) && ins(i, j, k - 1)) continue;
    const c = typeof col === 'function' ? col((i + .5) * s, (j + .5) * s, (k + .5) * s) : col; if (c) put(t, i, j, k, c);
  }
}

// ------------------------------------------------------------------------------------------------ 5x7 pixel font
const FONT = {
  A: '01110100011000111111100011000110001', B: '11110100011000111110100011000111110', C: '01110100011000010000100001000101110',
  D: '11110100011000110001100011000111110', E: '11111100001000011110100001000011111', F: '11111100001000011110100001000010000',
  G: '01110100011000010111100011000101111', H: '10001100011000111111100011000110001', I: '01110001000010000100001000010001110',
  K: '10001100101010011000101001001010001', L: '10000100001000010000100001000011111', M: '10001110111010110101100011000110001',
  N: '10001100011100110101100111000110001', O: '01110100011000110001100011000101110', P: '11110100011000111110100001000010000',
  R: '11110100011000111110101001001010001', S: '01111100001000001110000010000111110', T: '11111001000010000100001000010000100',
  U: '10001100011000110001100011000101110', V: '10001100011000110001100010101000100', W: '10001100011000110101101011010101010',
  Y: '10001100010101000100001000010000100', ' ': '00000000000000000000000000000000000',
};
function textCells(str) { const out = []; [...str].forEach((ch, n) => { const g = FONT[ch] || FONT[' ']; for (let r = 0; r < 7; r++) for (let c = 0; c < 5; c++) if (g[r * 5 + c] === '1') out.push([n * 6 + c, r]); }); return out; }
const textW = str => str.length * 6 - 1;

// ------------------------------------------------------------------------------------------------ track maths (race.ts)
function bankAt(phi) { const d = phi * 180 / Math.PI; const k = Math.max(0, Math.min(1, d / 40, (180 - d) / 40)); return k * k * (3 - 2 * k) * BANKDEG * Math.PI / 180; }
function trackInfo(x, z) {
  if (Math.abs(x) <= 22) return { u: RT - Math.abs(z - 16), turn: 0, phi: 0, s: x + 22 };
  const sg = Math.sign(x), d = Math.hypot(x - sg * 22, z - 16);
  const phi = sg > 0 ? Math.atan2(x - 22, -(z - 16)) : Math.atan2(-(x + 22), z - 16);
  return { u: RT - d, turn: sg, phi: Math.max(0, Math.min(Math.PI, phi)), s: phi * RT };
}
const surfH = (u, phi, turn) => turn ? Math.max(0, HALF - u) * Math.tan(bankAt(phi)) : 0;
function pathAt(s, u) {
  s = ((s % LAP) + LAP) % LAP; let x, z, turn = 0, phi = 0;
  if (s < ST) { x = -22 + s; z = u; }
  else if (s < ST + TURN_A) { phi = (s - ST) / RT; turn = 1; x = 22 + (RT - u) * Math.sin(phi); z = 16 - (RT - u) * Math.cos(phi); }
  else if (s < 2 * ST + TURN_A) { x = 22 - (s - ST - TURN_A); z = 32 - u; }
  else { phi = (s - 2 * ST - TURN_A) / RT; turn = -1; x = -22 - (RT - u) * Math.sin(phi); z = 16 + (RT - u) * Math.cos(phi); }
  return { x, z, turn, phi };
}

// ------------------------------------------------------------------------------------------------ palettes
const TEAM = ['#e63946', '#1d7cf2', '#ffc400', '#39d353', '#a040ff', '#ff7a1a'];
const SEATS = ['#1f6bff', '#d92b2b', '#e0a800'];
const SKIN = ['#f1c27d', '#e0ac69', '#c68642', '#8d5524', '#ffdbac', '#5c3a21'];
const HAIR = ['#2b1d12', '#5a3a1e', '#a8742e', '#e7c27a', '#1a1a1a', '#8a8a8a'];
const SHIRT = ['#ff2bd6', '#4dd2ff', '#39ff14', '#ffc400', '#ff6a1f', '#b88cff', '#f2f2f2', '#ff3b3b', '#1f6bff', '#00e5c0'];
const PANTS = ['#1d2a4a', '#2b2e36', '#3b3b44', '#5a4a32', '#2b3d2b', '#26324f'];
const CARS = ['#d92b2b', '#1f6bff', '#f2f2f2', '#2b2e36', '#ffc400', '#8d969e', '#39a845', '#ff7a1a'];
const frameOf = c => mixHex(c, '#141826', .6);

// ------------------------------------------------------------------------------------------------ builders
/** Person cells relative to the anchor cell (0.12 m), by part. Used for baked people and the instanced crowd. */
const PERSON = (() => {
  const parts = { pants: [], shirt: [], skin: [], hair: [] };
  for (let j = 0; j < 6; j++) { parts.pants.push([-2, j, 0], [1, j, 0]); }
  for (let j = 6; j < 11; j++) for (let i = -2; i <= 1; i++) for (let k = -1; k <= 0; k++) parts.shirt.push([i, j, k]);
  for (const i of [-3, 2]) { parts.skin.push([i, 6, 0]); for (let j = 7; j < 11; j++) parts.shirt.push([i, j, 0]); }
  for (let j = 11; j < 13; j++) for (let i = -1; i <= 0; i++) for (let k = -1; k <= 0; k++) parts.skin.push([i, j, k]);
  for (let i = -1; i <= 0; i++) for (let k = -1; k <= 0; k++) parts.hair.push([i, 13, k]);
  return parts;
})();
function person(x, y, z, shirt, cap) {
  const i0 = idx('S', x), j0 = idx('S', y), k0 = idx('S', z);
  const c = { skin: pick(SKIN), pants: pick(PANTS), hair: cap || pick(HAIR), shirt: shirt || pick(SHIRT) };
  for (const [part, cells] of Object.entries(PERSON)) for (const [di, dj, dk] of cells) put('S', i0 + di, j0 + dj, k0 + dk, c[part]);
}
const CROWD = [];   // instanced people: anchor cell centre-bottom + phase + part colours
function crowdPerson(x, y, z, phase, shirt, cap) {
  const i0 = idx('S', x), j0 = idx('S', y), k0 = idx('S', z);
  const skin = pick(SKIN), pants = pick(PANTS), hair = cap || pick(HAIR); shirt = shirt || pick(SHIRT);
  CROWD.push({ x: i0 * T.S, y: j0 * T.S, z: k0 * T.S, ph: +phase.toFixed(3), c: [colIdx(pants), colIdx(shirt), colIdx(skin), colIdx(hair)] });
}
function kart(ox, oy, oz, team) {
  const fr = frameOf(team), steel = '#9ec2f2', rub = '#24202e';
  const i0 = idx('S', ox), j0 = idx('S', oy), k0 = idx('S', oz);
  const P = (i, j, k, c) => put('S', i0 + i, j0 + j, k0 + k, c);
  for (let i = -4; i <= 3; i++) for (let j = 1; j <= 3; j++) for (let k = -5; k <= 4; k++) {
    if (i > -4 && i < 3 && j > 1 && j < 3 && k > -5 && k < 4) continue;
    P(i, j, k, j === 3 ? team : fr);
  }
  for (let i = -4; i <= 3; i++) { P(i, 1, 5, steel); P(i, 2, 5, steel); P(i, 1, 6, steel); }
  for (let i = -3; i <= 2; i++) for (let k = 0; k <= 4; k++) P(i, 4, k, k === 4 ? steel : team);
  for (const i of [-5, 4]) for (const k0w of [-4, 2]) for (let j = 0; j <= 2; j++) for (let k = k0w; k < k0w + 3; k++) P(i, j, k, rub);
  P(-1, 4, -3, '#ff8a2e'); P(0, 4, -3, '#ff8a2e');
}
function car(cx, cz, body) {
  const glass = '#1b2a3a', rub = '#1d1d1f';
  box('M', cx - .96, cx + .96, .24, .96, cz - 2.16, cz + 2.16, body, true);
  box('M', cx - .84, cx + .84, .96, 1.44, cz - 1.2, cz + .96, (i, j, k, x, y) => (y > 1.3 ? body : glass), true);
  for (const sx of [-1.08, .84]) for (const sz of [-1.68, .96]) box('M', cx + sx, cx + sx + .24, 0, .48, cz + sz, cz + sz + .72, rub);
  box('M', cx - .84, cx - .36, .48, .72, cz + 2.16, cz + 2.4, ['#fff3c4', 1.4]); box('M', cx + .36, cx + .84, .48, .72, cz + 2.16, cz + 2.4, ['#fff3c4', 1.4]);
}
function tree(x, z, kind) {
  const ix = idx('M', x) * .24, iz = idx('M', z) * .24;
  const h = 2.2 + R() * 1.4;
  box('M', ix - .24, ix + .24, 0, h, iz - .24, iz + .24, '#5a3e26');
  const leaf = (x2, y, z2, top) => { const t = Math.max(0, Math.min(1, (y - h + .4) / top)); return t > .66 ? '#5fae45' : t > .33 ? '#3f8a35' : '#2f6b2c'; };
  if (kind) { const r = 1.5 + R() * .8, top = r * 1.8; ell('M', ix, h + r * .75, iz, r, r * .95, r, (X, Y, Z) => leaf(X, Y, Z, top)); }
  else { const r = 1.7 + R() * .5; for (let n = 0; n < 3; n++) { const y0 = h - .4 + n * 1.1, rr = r * (1 - n * .28); ell('M', ix, y0 + .5, iz, rr, .75, rr, (X, Y, Z) => leaf(X, Y, Z, 3.6), (X, Y) => Y >= y0); } }
}

// ------------------------------------------------------------------------------------------------ the world
const XR = 78, ZA = -42, ZB = 74;
const LOGO = new Set();
(function () { // "ROBOT" over "REVOLUTION" on the infield grass, read from the main stand (Babylon: text runs toward +x)
  const lines = ['ROBOT', 'REVOLUTION'], cx = -6.5, z0 = 23.0;
  lines.forEach((ln, li) => { const w = textW(ln); textCells(ln).forEach(([c, r]) => {
    const x = cx + (c + .5 - w / 2) * .48, z = z0 - (li * 9 + r + .5) * .48; LOGO.add(idx('L', x - .24) + ',' + idx('L', z - .24)); }); });
})();

function buildWorld() {
  seed = 7;
  // ---- ground + track
  for (let i = idx('L', -XR); i < idx('L', XR); i++) for (let k = idx('L', ZA); k < idx('L', ZB); k++) {
    const x = (i + .5) * .48, z = (k + .5) * .48, I = trackInfo(x, z), u = I.u;
    if (Math.abs(u) <= HALF) {
      const asph = (sx, sz, ss, su, turn) => {
        if (!turn && sz < 16 && Math.abs(sx) < .96) return ((idx('L', sx - .24) + idx('L', sz - .24)) & 1) ? '#f2f2f2' : '#141414';
        if (turn && su > 4.52) return (Math.floor(ss / .96) & 1) ? '#f2f2f2' : '#d92b2b';   // kerb inside the turn (race.ts)
        if (Math.abs(su + 4.66) < .25) return '#f2f2f2';
        if (Math.abs(su - 4.66) < .25) return ['#ffc400', 1.05];
        const line = turn ? (su > .8 && su < 2.8) : Math.abs(su) < 1.0;
        return line ? '#3c3f44' : '#4a4e54';
      };
      if (I.turn) {   // banked turns in 0.24 m columns (user 2026-10-19), tops on the smooth bank surface
        for (let a = 0; a < 2; a++) for (let c = 0; c < 2; c++) {
          const x2 = x - .12 + a * .24, z2 = z - .12 + c * .24, I2 = trackInfo(x2, z2);
          column('M', idx('M', x2 - .12), idx('M', z2 - .12), surfH(I2.u, I2.phi, I2.turn), m => m === 0 ? asph(x2, z2, I2.s, I2.u, I2.turn) : '#3a3d42');
        }
      } else column('L', i, k, 0, m => m === 0 ? asph(x, z, I.s, u, 0) : '#3a3d42');
      continue;
    }
    if (u > WALL_IN && u <= WALL_OUT) {                         // inner wall on the race.ts collider, 0.96 m
      for (let j = -1; j <= 1; j++) put('L', i, j, k, j === 1 ? '#e3e7eb' : '#c4c9ce'); continue;
    }
    if (u < -WALL_IN && u >= -WALL_OUT) {                       // outer wall: to the high edge, SAFER blue band, white cap
      column('L', i, k, surfH(-HALF, I.phi, I.turn) + .96, m => m === 0 ? '#eef1f4' : m === 1 ? ['#1f6bff', 1.05] : '#9aa0a6');
      continue;
    }
    let c;
    if (u > WALL_OUT && u <= 6.44) c = '#aeb4ba';                // apron inside the inner wall
    else if (u > 6.44) {                                         // infield
      if (Math.abs(x) <= 22.08 && z < 10.56) c = (Math.abs(z - 8.76) < .25 && (Math.floor((x + 22) / 1.92) & 1)) ? '#f2f2f2' : '#34373b';
      else if (Math.abs(x) <= 20.16 && z < 15.36) c = '#8f969e';
      else if (Math.abs(x) >= 21.36 && Math.abs(x) <= 25.2 && z >= 10.56 && z < 15.36) c = '#9aa0a6';
      else { const hd = Math.hypot(x - 13.5, z - 19.5);
        if (hd < 5.2) { const dx = Math.abs(x - 13.5), dz = Math.abs(z - 19.5);
          c = (hd > 4.3 && hd < 4.85) ? '#ffc400' : ((dx > .6 && dx < 1.2 && dz < 1.6) || (dx < 1.2 && dz < .3)) ? '#f2f2f2' : '#a3a9af'; }
        else if (LOGO.has(i + ',' + k)) c = '#f6f8fa';
        else c = (Math.floor((x - z) / 2.88) & 1) ? '#5aa543' : '#4c963a';
      }
    } else {                                                     // outside the track
      if (z >= -30.24 && z < -19.2 && Math.abs(x) < 36) c = (((i % 6) + 6) % 6 === 0 && Math.abs(z + 24.72) > 1.6) ? '#e8e8e8' : '#3b3e43';
      else if (z < -17.28 && z >= -19.2 && Math.abs(x) < 36) c = '#aeb4ba';
      else { const nn = noise(x * .08, z * .08); c = nn > .55 ? '#5c9a45' : nn > .35 ? '#528f3e' : '#4a8338'; }
    }
    put('L', i, -1, k, c);
  }

  // ---- catch fence on the outer wall: posts every 3 m, three cables (0.12)
  { const keys = new Set();
    for (let s = 0; s < LAP; s += .1) { const p = pathAt(s, -5.24), top = surfH(-HALF, p.phi, p.turn) + .96;
      const i = idx('S', p.x - .06), k = idx('S', p.z - .06);
      for (const h of [.84, 1.68, 2.4]) { const j = idx('S', top + h - .06), key = i + ',' + j + ',' + k; if (!keys.has(key)) { keys.add(key); put('S', i, j, k, '#c3c9cf'); } }
      if (Math.abs((s % 3)) < .1) for (let j = idx('S', top); j < idx('S', top + 2.52); j++) put('S', i, j, k, '#5c646c');
    } }

  // ---- grandstands (0.48 tiers, 0.24 seat backs, 0.12 people)
  const aisles = [-16, -8, 0, 8, 16];
  function stand(zF, dir, rows) {
    const secOf = x => { let s = 0; for (const a of aisles) if (x > a) s++; return s; };
    for (let r = 0; r < rows; r++) {
      for (let half = 0; half < 2; half++) {
        const zc = zF + dir * (r * .96 + half * .48 + .24);
        const k = idx('L', zc - .24);
        for (let i = idx('L', -20.16); i < idx('L', 20.16); i++) {
          const x = (i + .5) * .48, end = i === idx('L', -20.16) || i === idx('L', 20.16) - 1, aisle = aisles.some(a => Math.abs(x - a) < .5);
          for (let j = 0; j <= r; j++) {
            let c = '#2c3445';
            if (!end && j === r) c = aisle ? '#b9bec4' : half === 0 ? '#c9cdd2' : SEATS[(secOf(x) + (dir > 0 ? 1 : 0)) % 3];
            put('L', i, j, k, c);
          }
        }
      }
      const zb = zF + dir * (r * .96 + .72), ytop = (r + 1) * .48;
      box('M', -20.16 + .48, 20.16 - .48, ytop, ytop + .24, Math.min(zb, zb + dir * .24), Math.max(zb, zb + dir * .24),
        (i, j, kk, x) => aisles.some(a => Math.abs(x - a) < .6) ? null : SEATS[(secOf(x) + (dir > 0 ? 1 : 0)) % 3]);
      for (let x = -19.6; x < 19.6; x += .6) {
        if (aisles.some(a => Math.abs(x - a) < .75) || R() < .14) continue;
        crowdPerson(x + (R() - .5) * .1, ytop, zF + dir * (r * .96 + .6), x * .32 + (dir > 0 ? 3 : 0), null, R() < .2 ? pick(TEAM) : null);
      }
    }
    const bz0 = dir < 0 ? zF : zF - .24;
    for (let n = 0; n < 10; n++) { const x0 = -20 + n * 4.0 + .2; box('M', x0, x0 + 3.6, 0, .48, bz0, bz0 + .24, n % 2 ? ['#1f6bff', 1.05] : '#f2f2f2'); }
    box('S', -20.16, 20.16, 1.08, 1.2, zF + dir * .12 - .06, zF + dir * .12 + .06, '#8d969e');
  }
  const ZF_MAIN = -6.72, ZF_BACK = 38.72;
  stand(ZF_MAIN, -1, 10);
  stand(ZF_BACK, 1, 8);
  // main stand roof, warm lamps under the front edge, sign on top (faces the track: read from +z, so text runs -x)
  { const y0 = 8.4, zFront = ZF_MAIN + 1.2, zBack = ZF_MAIN - 9.6 - .24;
    box('M', -20.4, 20.4, y0, y0 + .24, zBack, zFront, (i, j, k, x, y, z) => z > zFront - .25 ? '#f2f2f2' : '#cfd5db');
    for (let x = -20.16; x <= 20.2; x += 8.04) box('M', x, x + .48, 4.8, y0, zBack, zBack + .48, '#5c646c');
    for (let x = -19.2; x < 19.2; x += 1.92) box('M', x, x + .48, y0 - .24, y0, zFront - .72, zFront - .48, ['#fff3c4', 1.8]);
    const msg = 'ROBOT REVOLUTION', w = textW(msg), lit = new Set(textCells(msg).map(([c, r]) => c + ',' + r));
    for (let c = -1; c <= w; c++) for (let r = -1; r <= 7; r++) {
      const x = (w / 2 - c) * .24, y = y0 + .24 + (7 - r) * .24;
      put('M', idx('M', x), idx('M', y), idx('M', zFront - .48), lit.has(c + ',' + r) ? ['#ffffff', 1.35] : '#d92b2b');
    }
  }
  // back stand: sign on posts (read from the track at -z, so text runs +x) + flags
  { const zB = ZF_BACK + 8 * .96, msg = 'OVAL SPEEDWAY', w = textW(msg), lit = new Set(textCells(msg).map(([c, r]) => c + ',' + r)), y0 = 3.84 + .96;
    for (const x of [-8, 8]) box('M', x, x + .24, 3.84, y0, zB - .24, zB, '#5c646c');
    for (let c = -1; c <= w; c++) for (let r = -1; r <= 7; r++) {
      const x = (c - w / 2) * .24, y = y0 + (7 - r) * .24;
      put('M', idx('M', x), idx('M', y), idx('M', zB - .24), lit.has(c + ',' + r) ? ['#ffffff', 1.35] : '#1f6bff');
    }
    for (let n = 0; n < 6; n++) { const x = -20 + n * 8; box('S', x, x + .12, 3.84, 7.2, zB - .12, zB, '#c3c9cf'); box('S', x + .12, x + 1.08, 6.48, 7.2, zB - .12, zB, TEAM[n]); }
  }
  // start / finish gantry: posts + checkered beam (light pods are live)
  for (const z0 of [-6.48, 6.96]) box('M', -.24, .24, 0, 5.28, z0, z0 + .48, '#3b424a');
  box('M', -.24, .24, 5.28, 6.0, -6.48, 7.44, (i, j, k) => ((j + k) & 1) ? '#f2f2f2' : '#141414');
  box('M', -.48, -.24, 4.32, 5.28, -2.88, 2.88, '#1a1d22');                 // backing plate behind the light pods
  // garages: 6 bays + hospitality floor
  { const x0 = -20.16, x1 = 20.16, z0 = 10.56, z1 = 15.36, gh = 3.12, top = 5.52, bw = 6.72;
    box('M', x0, x1, 0, top, z1 - .24, z1, '#2a3242');
    box('M', x0 + .24, x1 - .24, 0, gh, z1 - .48, z1 - .24, '#d7dbe0');
    for (const wx of [x0, x1 - .24]) box('M', wx, wx + .24, 0, top, z0, z1 - .24, '#2a3242');
    box('M', x0 + .24, x1 - .24, gh, gh + .24, z0, z1 - .24, '#3a4252');
    box('M', x0 - .24, x1 + .24, top, top + .24, z0 - .48, z1, (i, j, k, x, y, z) => z < z0 - .24 ? '#4dd2ff' : '#cfd5db');
    box('M', x0 + .24, x1 - .24, gh + .24, top, z0, z0 + .24, (i) => (((i % 5) + 5) % 5 === 0) ? '#3b424a' : ['#8fd3f5', 1.1]);
    box('M', x0 + .24, x1 - .24, gh + .24, top, z0 + 1.92, z0 + 2.16, '#2a3242');
    for (let n = 0; n < 6; n++) {
      const bx = x0 + n * bw, cx = bx + bw / 2, team = TEAM[n];
      if (n > 0) box('M', bx, bx + .24, 0, gh, z0, z1 - .48, '#2a3242');
      box('M', bx + .24, bx + bw, gh - .24, gh, z0, z0 + .24, [team, 1.25]);
      box('M', bx + .24, bx + bw, gh - .72, gh - .24, z0, z0 + .24, '#5c6672');
      box('M', cx - 1.68, cx + 1.68, 1.68, 2.64, z1 - .72, z1 - .48, (i, j, k, x, y) => (y > 2.0 && y < 2.3) ? '#f2f2f2' : [team, 1.2]);
      box('M', bx + .48, bx + 1.44, 0, .96, z1 - 1.2, z1 - .48, team);
      box('M', bx + .48, bx + 1.44, .96, 1.2, z1 - 1.2, z1 - .48, '#3b424a');
      box('M', bx + bw - 2.64, bx + bw - .48, .72, .96, z1 - 1.2, z1 - .48, '#8a6a44');
      for (const lx of [bx + bw - 2.64, bx + bw - .72]) box('M', lx, lx + .24, 0, .72, z1 - 1.2, z1 - .96, '#3b424a');
      for (const tz of [z0 + .72, z0 + 1.68]) box('M', bx + .48, bx + .96, 0, 1.44, tz, tz + .48, (i, j) => (j % 2) ? '#24202e' : '#2e2a38');
      box('M', cx - .48, cx + .48, 0, .48, z0 + 2.4, z0 + 3.12, '#3b424a');
      kart(cx, .48, z0 + 2.76, team);
      for (let p = 0; p < 3; p++) person(cx - 1.4 + p * 1.2 + (R() - .5) * .3, 0, z0 - 1.2 - R() * .6, team, '#141414');
      for (let p = 0; p < 2; p++) person(bx + 1.2 + R() * (bw - 2.4), gh + .24, z0 + 1.0, null, null);
    }
  }
  // race control tower + medical centre
  { const x0 = -25.2, x1 = -21.36, z0 = 10.56, z1 = 15.36, h = 9.12;
    box('M', x0, x1, 0, h, z0, z1, (i, j, k, x, y) => (y > 6.4 && y < 8.4) ? (((i + k) % 4 === 0) ? '#3b424a' : ['#8fd3f5', 1.1]) : '#2a3242', true);
    box('M', x0 - .24, x1 + .24, h, h + .24, z0 - .24, z1 + .24, '#cfd5db');
    box('M', (x0 + x1) / 2 - .12, (x0 + x1) / 2 + .12, h + .24, h + 1.92, (z0 + z1) / 2 - .12, (z0 + z1) / 2 + .12, '#5c646c');
  }
  { const x0 = 21.36, x1 = 24.72, z0 = 10.56, z1 = 15.36, cx = (x0 + x1) / 2;
    box('M', x0, x1, 0, 3.12, z0, z1, (i, j, k, x, y, z) => { if (z < z0 + .24) { if ((Math.abs(x - cx) < .6 && y > 1.68 && y < 2.64) || (Math.abs(x - cx) < .2 && y > 1.2 && y < 3.0)) return '#d92b2b'; } return '#f2f2f2'; }, true);
    box('M', x0 - .24, x1 + .24, 3.12, 3.36, z0 - .24, z1 + .24, '#cfd5db');
    car(cx, z1 + 3.0, '#f2f2f2');
  }
  // jumbotron frame + legs (the screen is a live LED texture)
  for (const lx of [-3.6, 3.36]) box('M', lx, lx + .48, 0, 3.92, 23.04, 23.76, '#3b424a');
  box('M', -5.76, 5.76, 3.92, 8.48, 23.04, 23.76, (i, j, k, x, y) => y > 8.24 ? '#4dd2ff' : '#141820', true);
  // helicopter on the pad (rotor is live)
  { const hx = 13.5, hz = 19.5;
    ell('M', hx, 1.3, hz, 1.0, .85, 1.6, (x, y, z) => (z < hz - .7 && y > 1.2) ? ['#8fd3f5', 1.1] : '#d92b2b');
    box('M', hx - .24, hx + .24, 1.2, 1.68, hz + 1.4, hz + 4.0, '#d92b2b'); box('M', hx - .12, hx + .12, 1.68, 2.64, hz + 3.6, hz + 4.08, '#d92b2b');
    for (const sx of [-.84, .6]) { box('M', hx + sx, hx + sx + .24, 0, .24, hz - 1.44, hz + 1.44, '#3b424a'); box('M', hx + sx, hx + sx + .24, .24, .72, hz - .48, hz - .24, '#3b424a'); box('M', hx + sx, hx + sx + .24, .24, .72, hz + .48, hz + .72, '#3b424a'); }
    box('M', hx - .24, hx + .24, 2.16, 2.4, hz - .24, hz + .24, '#3b424a');
  }
  // light towers
  for (const [tx, tz] of [[-46, 2], [46, 2], [-46, 30], [46, 30]]) {
    box('M', tx - .24, tx + .24, 0, 17.28, tz - .24, tz + .24, '#5c646c');
    const face = tx > 0 ? -1 : 1;
    box('M', tx - 1.44, tx + 1.44, 17.28, 19.2, tz - .48, tz + .48, (i, j, k, x) => ((face < 0 ? x < tx - 1.2 : x > tx + 1.2) && (j % 2 === 0)) ? ['#fff3c4', 1.9] : '#3b424a');
  }
  // trees ring + parking lot cars
  for (let n = 0; n < 80; n++) {
    const a = R() * Math.PI * 2, rr = 1 + R() * .16, x = Math.cos(a) * 62 * rr, z = 16 + Math.sin(a) * 46 * rr;
    if (z < -16 && Math.abs(x) < 40) continue; if (Math.abs(x) > XR - 2 || z < ZA + 2 || z > ZB - 2) continue;
    tree(x, z, R() < .6);
  }
  for (const zr of [-27.84, -21.6]) for (let x = -33.12; x < 33; x += 2.88) { if (R() < .3) continue; car(x + 1.44, zr, pick(CARS)); }
}

// ------------------------------------------------------------------------------------------------ meshing
/** quad records: [kind (d*2 + (sgn > 0)), tier, colour, plane, u0, u1, v0, v1, vOff] -- axes u = (d+1)%3, v = (d+2)%3 */
function solidAt(x, y, z, minSize) {
  for (const t of TIERS) {
    const s = T[t]; if (s < minSize - 1e-9) continue;
    const i = Math.floor(x / s), j = Math.floor(y / s), k = Math.floor(z / s);
    if (W[t].has(vkey(i, j, k))) return true;
    const col = W['col' + t]?.get(ckey(i, k));
    if (col && y <= col.top && y >= BOTTOM) return true;
  }
  return false;
}
function meshTier(t, out, local = false) {
  const s = T[t], map = W[t];
  const buckets = new Map();   // "d,sgn,slice" -> [a, b, colour]...
  const p = [0, 0, 0];
  for (const [key, c] of map) {
    const k = key % 4096 - OFF, rest = Math.floor(key / 4096), j = rest % 1024 - 512, i = Math.floor(rest / 1024) - OFF;
    p[0] = i; p[1] = j; p[2] = k;
    for (let d = 0; d < 3; d++) for (const sgn of [1, -1]) {
      const q = [i, j, k]; q[d] += sgn;
      const exposed = local ? !map.has(vkey(q[0], q[1], q[2])) : !solidAt((q[0] + .5) * s, (q[1] + .5) * s, (q[2] + .5) * s, s);
      if (!exposed) continue;
      const u = (d + 1) % 3, v = (d + 2) % 3, bk = d + ',' + sgn + ',' + p[d];
      let arr = buckets.get(bk); if (!arr) buckets.set(bk, arr = []);
      arr.push(p[u], p[v], c);
    }
  }
  for (const [bk, arr] of buckets) {
    const [d, sgn, slice] = bk.split(',').map(Number);
    let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
    for (let n = 0; n < arr.length; n += 3) { a0 = Math.min(a0, arr[n]); a1 = Math.max(a1, arr[n]); b0 = Math.min(b0, arr[n + 1]); b1 = Math.max(b1, arr[n + 1]); }
    const Wd = a1 - a0 + 1, Hd = b1 - b0 + 1, mask = new Int32Array(Wd * Hd);
    for (let n = 0; n < arr.length; n += 3) mask[(arr[n] - a0) + (arr[n + 1] - b0) * Wd] = arr[n + 2] + 1;
    const plane = (slice + (sgn > 0 ? 1 : 0)) * s;
    for (let b = 0; b < Hd; b++) for (let a = 0; a < Wd;) {
      const m = mask[a + b * Wd]; if (!m) { a++; continue; }
      let w = 1; while (a + w < Wd && mask[a + w + b * Wd] === m) w++;
      let h = 1; grow: while (b + h < Hd) { for (let x = 0; x < w; x++) if (mask[a + x + (b + h) * Wd] !== m) break grow; h++; }
      for (let hh = 0; hh < h; hh++) mask.fill(0, a + (b + hh) * Wd, a + w + (b + hh) * Wd);
      out.push([d * 2 + (sgn > 0 ? 1 : 0), TIERS.indexOf(t), m - 1, plane, (a0 + a) * s, (a0 + a + w) * s, (b0 + b) * s, (b0 + b + h) * s, 0]);
      a += w;
    }
  }
}
/** Off-grid columns: top face + the sides that stick up above their neighbours, one quad per colour run. */
function meshColumns(t, out) {
  const s = T[t], cols = W['col' + t];
  if (!cols) return;
  const ti = TIERS.indexOf(t);
  for (const [key, col] of cols) {
    const i = Math.floor(key / 4096) - OFF, k = key % 4096 - OFF, top = col.top;
    const x0 = i * s, x1 = x0 + s, z0 = k * s, z1 = z0 + s;
    out.push([1 * 2 + 1, ti, col.cols[0], top, z0, z1, x0, x1, 0]);                       // top (d = 1: u = z, v = x)
    for (const [di, dk] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nb = cols.get(ckey(i + di, k + dk));
      const nx = (i + di + .5) * s, nz = (k + dk + .5) * s;
      let nh;
      if (nb) nh = nb.top;
      else if (solidAt(nx, top - 1e-3, nz, s)) continue;                                   // covered by something bigger
      else nh = solidAt(nx, -0.01, nz, s) ? 0 : BOTTOM;
      if (nh >= top - 1e-4) continue;
      const d = di ? 0 : 2, sgn = di || dk;
      const plane = d === 0 ? (sgn > 0 ? x1 : x0) : (sgn > 0 ? z1 : z0);
      // runs of the same colour from the top down
      let m = 0;
      while (true) {
        const yTop = top - m * s; if (yTop <= nh + 1e-6) break;
        const c = col.cols[Math.min(m, col.cols.length - 1)];
        let m2 = m; while (m2 + 1 < col.cols.length && col.cols[m2 + 1] === c && top - (m2 + 1) * s > nh + 1e-6) m2++;
        const yBot = Math.max(nh, top - (m2 + 1) * s);
        // d = 0: u = y, v = z · d = 2: u = x, v = y
        if (d === 0) out.push([0 * 2 + (sgn > 0 ? 1 : 0), ti, c, plane, yBot, yTop, z0, z1, top]);
        else out.push([2 * 2 + (sgn > 0 ? 1 : 0), ti, c, plane, x0, x1, yBot, yTop, top]);
        m = m2 + 1;
      }
    }
  }
}

// ------------------------------------------------------------------------------------------------ run
const t0 = Date.now();
buildWorld();
const counts = { L: W.L.size + [...W.colL.values()].reduce((n, c) => n + c.cols.length, 0), M: W.M.size + [...W.colM.values()].reduce((n, c) => n + c.cols.length, 0), S: W.S.size };
const world = [];
for (const t of TIERS) { meshTier(t, world); meshColumns(t, world); }

// chunks: 32 m tiles by quad centre
const TILE = 32, CX0 = -XR, CZ0 = ZA;
const chunkMap = new Map();
for (const q of world) {
  const d = q[0] >> 1, u = (d + 1) % 3, v = (d + 2) % 3, c = [0, 0, 0];
  c[d] = q[3]; c[u] = (q[4] + q[5]) / 2; c[v] = (q[6] + q[7]) / 2;
  const key = Math.floor((c[0] - CX0) / TILE) + ',' + Math.floor((c[2] - CZ0) / TILE);
  let arr = chunkMap.get(key); if (!arr) chunkMap.set(key, arr = []);
  arr.push(q);
}
const all = [], sections = [];
for (const [key, arr] of chunkMap) {
  const [cx, cz] = key.split(',').map(Number);
  sections.push({ name: 'chunk', cx: CX0 + (cx + .5) * TILE, cz: CZ0 + (cz + .5) * TILE, offset: all.length, count: arr.length });
  all.push(...arr);
}

// live objects, each in its own local space
function object(name, build) {
  W = makeStore(); build();
  const out = [];
  for (const t of TIERS) meshTier(t, out, true);
  sections.push({ name, offset: all.length, count: out.length });
  all.push(...out);
}
object('rotor', () => { box('S', -2.64, 2.64, 0, .12, -.12, .12, '#2b2e36'); box('S', -.12, .12, 0, .12, -2.64, 2.64, '#2b2e36'); });
object('blimp', () => {
  ell('M', 0, 0, 0, 6, 1.8, 1.8, (x) => Math.abs(x) < .9 ? ['#e63946', 1.05] : '#e9edf2');
  box('M', -1.2, 1.2, -2.4, -1.68, -.48, .48, '#3b424a');
  for (const s of [-1, 1]) { box('M', -6.0, -4.56, -.12, .12, s > 0 ? 1.2 : -2.16, s > 0 ? 2.16 : -1.2, '#e63946'); box('M', -6.0, -4.56, s > 0 ? 1.2 : -2.16, s > 0 ? 2.16 : -1.2, -.12, .12, '#e63946'); }
});
seed = 5;
for (let n = 0; n < 3; n++) object('cloud' + n, () => {
  const r = 2.4 + R() * 2.2;
  for (let q = 0; q < 3; q++) ell('L', (q - 1) * r * 1.1, R() * .8, (R() - .5) * r, r * (.8 + R() * .4), r * .6, r * (.7 + R() * .3), ['#ffffff', 1.08], (x, y) => y > -r * .25);
});
object('pod', () => box('M', -.48, -.24, 4.56, 5.04, -.24, .24, '#ffffff'));
for (const part of Object.keys(PERSON)) object('person_' + part, () => { for (const [i, j, k] of PERSON[part]) put('S', i, j, k, '#ffffff'); });

// ------------------------------------------------------------------------------------------------ write
const header = {
  v: 1, tiers: T, palette: PAL, sections, crowd: CROWD.map(p => [p.x, p.y, p.z, p.ph, ...p.c]),
  bounds: { x0: -XR, x1: XR, z0: ZA, z1: ZB },
  rotor: [13.5, 2.46, 19.5], pods: [0, 1, 2, 3, 4].map(n => -2.4 + n * 1.2),
  screen: { x: -0.06, y: 6.24, w: 10.92, h: 4.08, z0: 23.04 - 0.02, z1: 23.76 + 0.02, nx: 91, ny: 34 },
  counts,
};
const hj = Buffer.from(JSON.stringify(header));
const REC = 28;
const buf = Buffer.alloc(8 + hj.length + all.length * REC);
buf.write('CUBE', 0, 'ascii'); buf.writeUInt32LE(hj.length, 4); hj.copy(buf, 8);
let o = 8 + hj.length;
for (const q of all) {
  buf.writeUInt8(q[0], o); buf.writeUInt8(q[1], o + 1); buf.writeUInt16LE(q[2], o + 2);
  for (let n = 0; n < 6; n++) buf.writeFloatLE(q[3 + n], o + 4 + n * 4);
  o += REC;
}
fs.mkdirSync(path.dirname(OUT), { recursive: true });
const gz = zlib.gzipSync(buf, { level: 9 });
fs.writeFileSync(OUT, gz);
const worldQuads = sections.filter(s => s.name === 'chunk').reduce((n, s) => n + s.count, 0);
console.log(`cubes L ${counts.L} M ${counts.M} S ${counts.S} (total ${counts.L + counts.M + counts.S}) · crowd ${CROWD.length} people`);
console.log(`world quads ${worldQuads} (${worldQuads * 2} triangles) in ${sections.filter(s => s.name === 'chunk').length} chunks · objects ${all.length - worldQuads} quads`);
console.log(`palette ${PAL.length} · wrote ${OUT} (${(gz.length / 1024).toFixed(0)} KB gzipped, ${(buf.length / 1024).toFixed(0)} KB raw) in ${Date.now() - t0} ms`);
