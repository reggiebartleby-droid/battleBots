/**
 * v0.45 shared cube-world bake helpers (Stunt Park, Rally Dirt). Same file format and meshing as bake-oval.mjs
 * (which stays as it is): 3 cube tiers, only faces touching open air, same-colour faces greedy-merged, off-grid
 * "column" tops for surfaces that follow the smooth driving surface, live objects in their own local space.
 *
 * Differences from the Oval bake: columns can stop at any bottom (elevated decks, the lava basin), chunk tiles and the
 * world bounds are per track, and extra header fields are passed through for the track's live parts.
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';

export const T = { L: 0.48, M: 0.24, S: 0.12 };
export const TIERS = ['L', 'M', 'S'];

export function createBake() {
  let seed = 1;
  const R = () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const setSeed = s => { seed = s; };
  const pick = a => a[Math.floor(R() * a.length)];
  function noise(x, z) {
    const xi = Math.floor(x), zi = Math.floor(z), xf = x - xi, zf = z - zi;
    const h = (a, b) => { let n = Math.imul(a * 374761393 + b * 668265263, 1274126177); n = (n ^ (n >>> 13)) * 1274126177; return ((n ^ (n >>> 16)) >>> 0) / 4294967296; };
    const s = t => t * t * (3 - 2 * t), u = s(xf), v = s(zf);
    return (h(xi, zi) * (1 - u) + h(xi + 1, zi) * u) * (1 - v) + (h(xi, zi + 1) * (1 - u) + h(xi + 1, zi + 1) * u) * v;
  }

  // ---- palette
  const PAL = [], PIDX = new Map();
  const hexRGB = hex => { const n = parseInt(hex.slice(1), 16); return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]; };
  const mixHex = (a, b, t) => { const A = hexRGB(a), B = hexRGB(b); const c = A.map((v, i) => Math.round((v + (B[i] - v) * t) * 255)); return '#' + c.map(v => v.toString(16).padStart(2, '0')).join(''); };
  function colIdx(spec) {
    let hex = spec, m = 1;
    if (Array.isArray(spec)) { hex = spec[0]; if (spec[1] !== undefined) m = spec[1]; }
    const key = hex + '*' + m;
    let i = PIDX.get(key);
    if (i === undefined) { const c = hexRGB(hex); i = PAL.length; PAL.push([c[0] * m, c[1] * m, c[2] * m].map(v => +v.toFixed(4))); PIDX.set(key, i); }
    return i;
  }

  // ---- cube store
  const OFF = 2048;
  const vkey = (i, j, k) => ((i + OFF) * 1024 + (j + 512)) * 4096 + (k + OFF);
  const ckey = (i, k) => (i + OFF) * 4096 + (k + OFF);
  const makeStore = () => ({ L: new Map(), M: new Map(), S: new Map(), colL: new Map(), colM: new Map(), colS: new Map() });
  let W = makeStore();
  const put = (t, i, j, k, spec) => W[t].set(vkey(i, j, k), colIdx(spec));
  const del = (t, i, j, k) => W[t].delete(vkey(i, j, k));
  const has = (t, i, j, k) => W[t].has(vkey(i, j, k));
  const idx = (t, v) => Math.round(v / T[t]);
  const cell = (t, v) => Math.floor(v / T[t]);
  /** Column on the cube grid (x / z) whose top face is exactly at height h, filled down to `bottom`.
   *  specAt(m): colour of the m-th cube from the top. */
  function column(t, i, k, h, specAt, bottom = -0.48) {
    const s = T[t], n = h / s;
    if (Math.abs(n - Math.round(n)) < 1e-6) {
      const top = Math.round(n);
      for (let j = top - 1, m = 0; j * s >= bottom - 1e-6; j--, m++) put(t, i, j, k, specAt(m));
      return;
    }
    const cols = [];
    for (let y = h, m = 0; y > bottom + 1e-6; y -= s, m++) cols.push(colIdx(specAt(m)));
    W['col' + t].set(ckey(i, k), { top: h, bottom, cols });
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
  /** A line of cubes from a to b (thickness = 1 cube), e.g. pipes, cables, struts. */
  function line(t, a, b, col) {
    const s = T[t], n = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) / (s * 0.5));
    for (let q = 0; q <= n; q++) { const f = q / n; put(t, cell(t, a[0] + (b[0] - a[0]) * f), cell(t, a[1] + (b[1] - a[1]) * f), cell(t, a[2] + (b[2] - a[2]) * f), col); }
  }

  // ---- 5x7 font
  const FONT = {
    A: '01110100011000111111100011000110001', B: '11110100011000111110100011000111110', C: '01110100011000010000100001000101110',
    D: '11110100011000110001100011000111110', E: '11111100001000011110100001000011111', F: '11111100001000011110100001000010000',
    G: '01110100011000010111100011000101111', H: '10001100011000111111100011000110001', I: '01110001000010000100001000010001110',
    J: '00111000100001000010000101001001100', K: '10001100101010011000101001001010001', L: '10000100001000010000100001000011111',
    M: '10001110111010110101100011000110001', N: '10001100011100110101100111000110001', O: '01110100011000110001100011000101110',
    P: '11110100011000111110100001000010000', R: '11110100011000111110101001001010001', S: '01111100001000001110000010000111110',
    T: '11111001000010000100001000010000100', U: '10001100011000110001100011000101110', V: '10001100011000110001100010101000100',
    W: '10001100011000110101101011010101010', X: '10001100010101000100010101000110001', Y: '10001100010101000100001000010000100',
    Z: '11111000010001000100010001000011111', '!': '00100001000010000100001000000000100', ' ': '00000000000000000000000000000000000',
  };
  const textCells = str => { const out = []; [...str].forEach((ch, n) => { const g = FONT[ch] || FONT[' ']; for (let r = 0; r < 7; r++) for (let c = 0; c < 5; c++) if (g[r * 5 + c] === '1') out.push([n * 6 + c, r]); }); return out; };
  const textW = str => str.length * 6 - 1;
  /** A sign of M cubes in a vertical plane: text along `dir` ('x' / 'z' / '-x' / '-z'), bottom-left near (x, y, z). */
  function sign(msg, x, y, z, dir, fg, bg) {
    const w = textW(msg), lit = new Set(textCells(msg).map(([c, r]) => c + ',' + r)), s = T.M;
    for (let c = -1; c <= w; c++) for (let r = -1; r <= 7; r++) {
      const along = (c - w / 2) * s, yy = y + (7 - r) * s, col = lit.has(c + ',' + r) ? fg : bg;
      if (!col) continue;
      const [X, Z] = dir === 'x' ? [x + along, z] : dir === '-x' ? [x - along, z] : dir === 'z' ? [x, z + along] : [x, z - along];
      put('M', cell('M', X), cell('M', yy), cell('M', Z), col);
    }
  }

  // ---- people (0.12 m): same shape as the Oval's
  const SKIN = ['#f1c27d', '#e0ac69', '#c68642', '#8d5524', '#ffdbac', '#5c3a21'];
  const HAIR = ['#2b1d12', '#5a3a1e', '#a8742e', '#e7c27a', '#1a1a1a', '#8a8a8a'];
  const PANTS = ['#1d2a4a', '#2b2e36', '#3b3b44', '#5a4a32', '#2b3d2b', '#26324f'];
  const PERSON = (() => {
    const parts = { pants: [], shirt: [], skin: [], hair: [] };
    for (let j = 0; j < 6; j++) { parts.pants.push([-2, j, 0], [1, j, 0]); }
    for (let j = 6; j < 11; j++) for (let i = -2; i <= 1; i++) for (let k = -1; k <= 0; k++) parts.shirt.push([i, j, k]);
    for (const i of [-3, 2]) { parts.skin.push([i, 6, 0]); for (let j = 7; j < 11; j++) parts.shirt.push([i, j, 0]); }
    for (let j = 11; j < 13; j++) for (let i = -1; i <= 0; i++) for (let k = -1; k <= 0; k++) parts.skin.push([i, j, k]);
    for (let i = -1; i <= 0; i++) for (let k = -1; k <= 0; k++) parts.hair.push([i, 13, k]);
    return parts;
  })();
  const CROWD = [];
  /** instanced cheering person: anchor at feet, phase, shirt colour list, cap colour (or null) */
  function crowdPerson(x, y, z, phase, shirts, cap) {
    const i0 = idx('S', x), j0 = idx('S', y), k0 = idx('S', z);
    CROWD.push({ x: i0 * T.S, y: j0 * T.S, z: k0 * T.S, ph: +phase.toFixed(3), c: [colIdx(pick(PANTS)), colIdx(pick(shirts)), colIdx(pick(SKIN)), colIdx(cap || pick(HAIR))] });
  }

  // ---- meshing (bake-oval.mjs)
  function solidAt(x, y, z, minSize) {
    for (const t of TIERS) {
      const s = T[t]; if (s < minSize - 1e-9) continue;
      const i = Math.floor(x / s), j = Math.floor(y / s), k = Math.floor(z / s);
      if (W[t].has(vkey(i, j, k))) return true;
      const col = W['col' + t]?.get(ckey(i, k));
      if (col && y <= col.top && y >= col.bottom) return true;
    }
    return false;
  }
  let CULL_BELOW = -Infinity;   // world bottom: -y faces at or below it are never seen
  function meshTier(t, out, local = false) {
    const s = T[t], map = W[t];
    const buckets = new Map();
    const p = [0, 0, 0];
    for (const [key, c] of map) {
      const k = key % 4096 - OFF, rest = Math.floor(key / 4096), j = rest % 1024 - 512, i = Math.floor(rest / 1024) - OFF;
      p[0] = i; p[1] = j; p[2] = k;
      for (let d = 0; d < 3; d++) for (const sgn of [1, -1]) {
        const q = [i, j, k]; q[d] += sgn;
        const exposed = local ? !map.has(vkey(q[0], q[1], q[2])) : !solidAt((q[0] + .5) * s, (q[1] + .5) * s, (q[2] + .5) * s, s);
        if (!exposed) continue;
        if (!local && d === 1 && sgn < 0 && j * s <= CULL_BELOW + 1e-6) continue;
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
  function meshColumns(t, out) {
    const s = T[t], cols = W['col' + t];
    if (!cols) return;
    const ti = TIERS.indexOf(t);
    for (const [key, col] of cols) {
      const i = Math.floor(key / 4096) - OFF, k = key % 4096 - OFF, top = col.top;
      const x0 = i * s, x1 = x0 + s, z0 = k * s, z1 = z0 + s;
      out.push([1 * 2 + 1, ti, col.cols[0], top, z0, z1, x0, x1, 0]);
      for (const [di, dk] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nb = cols.get(ckey(i + di, k + dk));
        const nx = (i + di + .5) * s, nz = (k + dk + .5) * s;
        let nh;
        if (nb) { if (nb.top >= top - 1e-4) continue; nh = Math.max(nb.top, col.bottom); }
        else if (solidAt(nx, top - 1e-3, nz, s)) continue;
        else {   // highest solid thing below our top next door (the ground, a deck below), else our own bottom
          nh = col.bottom;
          for (let y = top - s * 0.5; y > col.bottom; y -= s) if (solidAt(nx, y, nz, s)) { nh = Math.min(top, y + s * 0.5); break; }
        }
        if (nh >= top - 1e-4) continue;
        const d = di ? 0 : 2, sgn = di || dk;
        const plane = d === 0 ? (sgn > 0 ? x1 : x0) : (sgn > 0 ? z1 : z0);
        let m = 0;
        while (true) {
          const yTop = top - m * s; if (yTop <= nh + 1e-6) break;
          const c = col.cols[Math.min(m, col.cols.length - 1)];
          let m2 = m; while (m2 + 1 < col.cols.length && col.cols[m2 + 1] === c && top - (m2 + 1) * s > nh + 1e-6) m2++;
          const yBot = Math.max(nh, top - (m2 + 1) * s);
          if (d === 0) out.push([0 * 2 + (sgn > 0 ? 1 : 0), ti, c, plane, yBot, yTop, z0, z1, top]);
          else out.push([2 * 2 + (sgn > 0 ? 1 : 0), ti, c, plane, x0, x1, yBot, yTop, top]);
          m = m2 + 1;
        }
      }
      // underside of a floating column (deck over open air)
      if (!solidAt((i + .5) * s, col.bottom - s * 0.5, (k + .5) * s, s) && col.bottom > -0.4) out.push([1 * 2 + 0, ti, col.cols[col.cols.length - 1], col.bottom, z0, z1, x0, x1, 0]);
    }
  }

  /** Bake: build the world, mesh it into chunks, add live objects, write the gzipped file. */
  function bake({ out, bounds, tile = 32, build, objects = [], header = {}, cullBelow = -Infinity }) {
    const t0 = Date.now(); CULL_BELOW = cullBelow;
    W = makeStore();
    build();
    const counts = { L: W.L.size + [...W.colL.values()].reduce((n, c) => n + c.cols.length, 0), M: W.M.size + [...W.colM.values()].reduce((n, c) => n + c.cols.length, 0), S: W.S.size + [...W.colS.values()].reduce((n, c) => n + c.cols.length, 0) };
    const world = [];
    for (const t of TIERS) { meshTier(t, world); meshColumns(t, world); }
    if (process.env.CUBESTATS) {   // where the triangles go: quads by tier x face direction
      const st = {}; for (const q of world) { const k = TIERS[q[1]] + ' ' + ['-x', '+x', '-y', '+y', '-z', '+z'][q[0]]; st[k] = (st[k] ?? 0) + 1; }
      console.log(Object.entries(st).sort((a, b) => b[1] - a[1]).map(([k, v]) => k + ' ' + v).join(' · '));
    }
    const chunkMap = new Map();
    for (const q of world) {
      const d = q[0] >> 1, u = (d + 1) % 3, v = (d + 2) % 3, c = [0, 0, 0];
      c[d] = q[3]; c[u] = (q[4] + q[5]) / 2; c[v] = (q[6] + q[7]) / 2;
      const key = Math.floor((c[0] - bounds.x0) / tile) + ',' + Math.floor((c[2] - bounds.z0) / tile);
      let arr = chunkMap.get(key); if (!arr) chunkMap.set(key, arr = []);
      arr.push(q);
    }
    const all = [], sections = [];
    for (const [key, arr] of chunkMap) {
      const [cx, cz] = key.split(',').map(Number);
      sections.push({ name: 'chunk', cx: bounds.x0 + (cx + .5) * tile, cz: bounds.z0 + (cz + .5) * tile, offset: all.length, count: arr.length });
      all.push(...arr);
    }
    for (const [name, fn] of objects) {
      W = makeStore(); fn();
      const o = [];
      for (const t of TIERS) meshTier(t, o, true);
      sections.push({ name, offset: all.length, count: o.length });
      all.push(...o);
    }
    for (const part of Object.keys(PERSON)) {
      W = makeStore(); for (const [i, j, k] of PERSON[part]) put('S', i, j, k, '#ffffff');
      const o = []; meshTier('S', o, true);
      sections.push({ name: 'person_' + part, offset: all.length, count: o.length });
      all.push(...o);
    }
    const head = { v: 1, tiers: T, palette: PAL, sections, crowd: CROWD.map(p => [p.x, p.y, p.z, p.ph, ...p.c]), bounds, counts, ...header };
    const hj = Buffer.from(JSON.stringify(head));
    const REC = 28;
    const buf = Buffer.alloc(8 + hj.length + all.length * REC);
    buf.write('CUBE', 0, 'ascii'); buf.writeUInt32LE(hj.length, 4); hj.copy(buf, 8);
    let o = 8 + hj.length;
    for (const q of all) {
      buf.writeUInt8(q[0], o); buf.writeUInt8(q[1], o + 1); buf.writeUInt16LE(q[2], o + 2);
      for (let n = 0; n < 6; n++) buf.writeFloatLE(q[3 + n], o + 4 + n * 4);
      o += REC;
    }
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const gz = zlib.gzipSync(buf, { level: 9 });
    fs.writeFileSync(out, gz);
    const worldQuads = sections.filter(s => s.name === 'chunk').reduce((n, s) => n + s.count, 0);
    console.log(`cubes L ${counts.L} M ${counts.M} S ${counts.S} (total ${counts.L + counts.M + counts.S}) · crowd ${CROWD.length}`);
    console.log(`world quads ${worldQuads} (${worldQuads * 2} triangles) in ${sections.filter(s => s.name === 'chunk').length} chunks · objects ${all.length - worldQuads} quads`);
    console.log(`palette ${PAL.length} · wrote ${out} (${(gz.length / 1024).toFixed(0)} KB gzipped) in ${Date.now() - t0} ms`);
    return { counts, worldQuads };
  }

  return { R, setSeed, pick, noise, colIdx, mixHex, put, del, has, idx, cell, column, box, ell, line, textCells, textW, sign, crowdPerson, PERSON, bake, T };
}
