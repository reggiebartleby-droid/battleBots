/**
 * v0.27 "Cube Bots" look (art theme, from the 1UP Cube Bots mockup).
 *
 * Every visible part of a bot is rebuilt from cubes (one thin-instance mesh per source mesh) and the
 * original meshes are hidden. VISUAL ONLY: colliders, mass, HP and physics are untouched -- the cube copies
 * just follow the real (hidden) meshes every frame, so spinners, arms, hinges and tyres all move as before.
 *
 * Damage:
 *  - a hit knocks cubes loose round the contact point; how many the bot may lose follows the damage it has
 *    REALLY taken (so the look never runs ahead of the HP bars), with a couple of cubes per hit as feedback
 *  - v0.28 (user: fun over strict physics in this look) a part at 0 HP falls off for real: its collider stops
 *    colliding (bot.ts dropPart) and its cubes fly off together, breaking up as they go
 *  - v0.28 KO (every breakable part at 0 HP): the whole bot blows apart and its collider goes too (main.ts)
 *  - knocked out of the arena: the whole bot explodes into cubes
 * Loose cubes are debris (no colliders): they tumble, bounce on the floor / walls and stay for the match.
 * v0.28 bots shove debris out of their path and fast spinners fling it (still visual only).
 *
 * v0.29 HP = cubes (user: the cubes decide the damage):
 *  - a hit damages the part whose nearest intact cube is closest to where it REALLY landed (combat.ts asks
 *    target()); a part that's gone, or an unbreakable weapon already at its 1-HP floor, lets hits through to
 *    the next nearest part
 *  - each part keeps exactly its share of cubes: cubes left = cubes at the start x HP left / max HP (at least
 *    one while it's alive), knocked off nearest the hit first, so hits dig in. Shares, not counts, so the
 *    cube size never changes the balance. Chassis cubes (no HP of their own) still chip for feedback.
 *  - a part that falls off flies as a real body for PART_FLY.lifeS (option 4): it shoves whatever it hits and
 *    does a little damage (combat.ts), then breaks up into ordinary debris
 *
 * Cubes buried inside a part (2+ cubes deep) carry a contrasting "glow core" colour: they show once hits
 * dig down to them. Only cubes up to KEEP_DEPTH deep exist at all (nobody sees deeper ones).
 */
import {
  type AbstractMesh, Color3, DynamicTexture, Matrix, Mesh, MeshBuilder, type Node, PhysicsBody, PhysicsMotionType,
  PhysicsShapeBox, Quaternion, type Scene, type ShadowGenerator, StandardMaterial, TransformNode, Vector3, VertexBuffer,
} from '@babylonjs/core';
import { botMeshes, chassisFor, dropPart, loosePartFilter, spinOmega, weaponBodies, type Bot } from './bot.js';
import { castShadows } from './look.js';
import { catalog } from './catalog.js';
import { isProtected, type BotState } from '../../src/core/state.js';
import { partWeight } from '../../src/core/weight.js';

// ---------------- settings (lab deploy bar, remembered in this browser) ----------------
export type CubeStyle = 'glow' | 'block' | 'energy' | 'neonEnergy';
export type CubeSize = 'big' | 'mid' | 'small';
export const CUBES = { on: true, style: 'glow' as CubeStyle, size: 'big' as CubeSize };   // v0.30 defaults: Cube Bots, Pixel Glow, 8-bit
const SETTINGS_KEY = 'bb.cubes.v1';
try { Object.assign(CUBES, JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}')); } catch { /* defaults */ }
export function saveCubes() { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(CUBES)); } catch { /* no storage */ } }

/** Cube edge, m. Bots are ~1.4 m wide: mid = ~18 cubes across. */
export const CUBE_SIZE: Record<CubeSize, number> = { big: 0.12, mid: 0.08, small: 0.055 };
/** emissive = self-lit amount (Pixel Glow), spec = shine, gap = cube size / cell (seams), glow = glow-layer halo,
 *  neon = full-saturation neon palette instead of the armoured one (v0.31). */
const STYLE: Record<CubeStyle, { emissive: number; spec: number; gap: number; glow: number; neon: boolean }> = {
  glow:       { emissive: 0.5,  spec: 0.6,  gap: 0.9,  glow: 0.5,  neon: true },    // v0.31 Energy-style shine, no animation
  block:      { emissive: 0.07, spec: 0.35, gap: 0.97, glow: 0,    neon: false },
  energy:     { emissive: 0.18, spec: 0.6,  gap: 0.93, glow: 0.4,  neon: false },
  neonEnergy: { emissive: 0.45, spec: 0.6,  gap: 0.92, glow: 0.45, neon: true },    // v0.31 combo: neon colours + gentle Energy bands
};
/** v0.31 cube palettes per part role. Armoured = weathered industrial; neon = same roles, lit up. */
type Pal = { paint: (h: number, s: number, v: number) => Color3; dark: Color3; darkMix: number; steel: string; rubber: string; chrome: string;
  can: string; core: string; wear: number; rust: number; scorch: number; scratch: number; scratchCol: string };
const PAL: Record<'armor' | 'neon', Pal> = {
  armor: { paint: (h, s, v) => hsv(h, s * 0.72, Math.min(1, v) * 0.62), dark: Color3.FromHexString('#2b2e33'), darkMix: 0.85,
    steel: '#8c9198', rubber: '#1d1d1f', chrome: '#9ba3aa', can: '#a8683a', core: '#ff6a1a',
    wear: 0.32, rust: 0.045, scorch: 0.035, scratch: 0.04, scratchCol: '#c8ccd1' },
  neon:  { paint: (h, s) => hsv(h, Math.max(s, 0.88), 1), dark: Color3.FromHexString('#141826'), darkMix: 0.6,
    steel: '#9ec2f2', rubber: '#24202e', chrome: '#b6c6da', can: '#ff8a2e', core: '#ff4a10',
    wear: 0.2, rust: 0, scorch: 0.05, scratch: 0.05, scratchCol: '#e2eeff' },
};
const KEEP_DEPTH = 3;
const CHIP = {
  base: 0.03,          // share of the cubes a bot may lose before it has taken any damage (hit feedback)
  perDamage: 0.5,      // + this share x the fraction of its breakable HP that is gone
  maxRemoved: 0.6,     // never more than this by chipping (a part dying / KO can go further)
  minPerHit: 2,        // every hit knocks at least this many loose (if the cap allows)
  radius: 1.4,         // search radius in cubes ...
  radiusPerDmg: 1 / 20,// ... + 1 cube per 20 damage ...
  radiusMax: 3.5,      // ... up to this many more
};
/** v0.28 a part at 0 HP flies off as one piece (shared push + spin), breaking up as it goes. */
const PART_OFF = { speed: [2.5, 4.5], up: [2.5, 4.5], spin: [4, 9], noise: 0.5 };
/** v0.29 option 4: the part that fell off is a real body this long, then breaks up into debris.
 *  Pieces of one part further apart than `cluster` fly separately (each tyre, front + rear skid). */
const PART_FLY = {
  lifeS: 1.5,
  graceS: 0.35,        // never hits its own bot sooner than this
  // and it only starts hitting a bot (its own or the opponent) once it's clear of it: outside the chassis box +
  // KICK margins and away from its weapon hubs (spawning inside a bot launched that bot, headless)
  kgPerWeight: 0.4,    // part weight stat -> kg (same as BODY.massScale)
  minKg: 2, maxKg: 20,
  friction: 0.5, restitution: 0.3,
  cluster: 0.5,        // m
};
/** v0.28 debris gets kicked out of the way by bots (visual only -- the cubes still have no colliders). */
const KICK = {
  minSpeed: 0.4,       // m/s: slower bots push nothing
  marginX: 0.45,       // m added to the chassis half-width (the tyres stick out)
  marginZ: 0.4,        // m added front / back (wedges, forks)
  marginY: 0.25,       // m above the chassis top
  carry: [1.0, 1.4],   // x the bot's velocity
  out: [0.8, 2.0],     // m/s sideways out of its path
  up: [0.6, 2.0],      // m/s up (x how fast the bot goes, capped at 3 m/s)
  spinMin: 15,         // rad/s: a spinner this fast flings cubes it touches
  spinR: { x: 0.65, y: 1.05 } as Record<string, number>,   // m reach of the spinning weapon (vertical / horizontal + shells)
  fling: [5, 9],       // m/s
};
const G = 9.81;
const SKIP_NAMES = ['_caparrow', '_cap', '_post', '_floorarrow'];   // v0.25 shell aids stay as they are

/** Floors debris lands on (arena, test course). Set by main. Outside them cubes fall away. */
interface FloorArea { cx: number; cz: number; half: number; wallH: number }
let FLOORS: FloorArea[] = [{ cx: 0, cz: 0, half: 8, wallH: 2.5 }];
export function setDebrisFloors(areas: FloorArea[]) { FLOORS = areas; }

// ---------------- helpers ----------------
const KEY = (i: number, j: number, k: number) => ((i + 512) * 1024 + (j + 512)) * 1024 + (k + 512);
const KI = (key: number) => Math.floor(key / 1048576) - 512;
const KJ = (key: number) => (Math.floor(key / 1024) % 1024) - 512;
const KK = (key: number) => (key % 1024) - 512;
const N6 = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const hsv = (h: number, s: number, v: number) => { const c = new Color3(); Color3.HSVtoRGBToRef(((h % 360) + 360) % 360, s, v, c); return c; };

const seamTex = new WeakMap<Scene, DynamicTexture>();
/** Bright face, dark seam, bevel highlight: the lit-pixel look. */
function seamTexture(scene: Scene): DynamicTexture {
  let t = seamTex.get(scene);
  if (t) return t;
  t = new DynamicTexture('cubeSeam', { width: 64, height: 64 }, scene, true);
  const g = t.getContext() as CanvasRenderingContext2D;
  g.fillStyle = '#5c5c5c'; g.fillRect(0, 0, 64, 64);
  g.fillStyle = '#ffffff'; g.fillRect(5, 5, 54, 54);
  g.fillStyle = '#c9c9c9'; g.fillRect(8, 54, 51, 5); g.fillRect(54, 8, 5, 51);
  g.fillStyle = '#ffffff'; g.fillRect(5, 5, 54, 4); g.fillRect(5, 5, 4, 54);
  g.fillStyle = '#ececec'; g.fillRect(18, 18, 28, 28);
  g.fillStyle = '#f7f7f7'; g.fillRect(22, 22, 20, 20);
  t.update();
  seamTex.set(scene, t);
  return t;
}

/** Colour a source mesh's cubes from its material (v0.16 material set names, see look.ts botMaterials). */
function roleColor(m: AbstractMesh, paint: Color3, accent: Color3, P: Pal): Color3 {
  const mat = m.material as (StandardMaterial & { albedoColor?: Color3 }) | null;
  const n = mat?.name ?? '';
  if (n.startsWith('paint')) return paint.clone();
  if (n.startsWith('dark')) return Color3.Lerp(paint, P.dark, P.darkMix);   // v0.31 frame: gunmetal / dark neon
  if (n.startsWith('steel')) return Color3.FromHexString(P.steel);         // weapons, wedges, forks: steel
  if (n.startsWith('rubber')) return Color3.FromHexString(P.rubber);
  if (n.startsWith('chrome')) return Color3.FromHexString(P.chrome);
  if (n.startsWith('can')) return accent.clone();
  if (mat?.albedoColor) return mat.albedoColor.clone();
  if (mat?.diffuseColor) return mat.diffuseColor.clone();
  return paint.clone();
}

/** Root-local cells (keys) a mesh fills: its surface (triangles sampled at half a cube) plus the inside (flood fill). */
function voxelize(m: Mesh, toLocal: Matrix, v: number): { keys: number[]; vol: number } {
  const pos = m.getVerticesData(VertexBuffer.PositionKind);
  const idx = m.getIndices();
  if (!pos || !idx || !idx.length) return { keys: [], vol: 0 };
  m.computeWorldMatrix(true);
  const M = m.getWorldMatrix().multiply(toLocal);
  const n = pos.length / 3, P = new Float32Array(pos.length), t = new Vector3();
  for (let i = 0; i < n; i++) {
    Vector3.TransformCoordinatesFromFloatsToRef(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2], M, t);
    P[i * 3] = t.x; P[i * 3 + 1] = t.y; P[i * 3 + 2] = t.z;
  }
  const surf = new Set<number>();
  let i0 = 1e9, i1 = -1e9, j0 = 1e9, j1 = -1e9, k0 = 1e9, k1 = -1e9;
  let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9, z0 = 1e9, z1 = -1e9;
  const mark = (x: number, y: number, z: number) => {
    const i = Math.round(x / v), j = Math.round(y / v), k = Math.round(z / v);
    surf.add(KEY(i, j, k));
    if (i < i0) i0 = i; if (i > i1) i1 = i; if (j < j0) j0 = j; if (j > j1) j1 = j; if (k < k0) k0 = k; if (k > k1) k1 = k;
  };
  const step = v * 0.45;
  for (let f = 0; f < idx.length; f += 3) {
    const a = idx[f] * 3, b = idx[f + 1] * 3, c = idx[f + 2] * 3;
    const ax = P[a], ay = P[a + 1], az = P[a + 2];
    const ux = P[b] - ax, uy = P[b + 1] - ay, uz = P[b + 2] - az;
    const wx = P[c] - ax, wy = P[c + 1] - ay, wz = P[c + 2] - az;
    const len = Math.max(Math.hypot(ux, uy, uz), Math.hypot(wx, wy, wz), Math.hypot(ux - wx, uy - wy, uz - wz));
    const s = Math.max(1, Math.ceil(len / step));
    for (let p = 0; p <= s; p++) for (let q = 0; q <= s - p; q++) {
      const fp = p / s, fq = q / s;
      mark(ax + ux * fp + wx * fq, ay + uy * fp + wy * fq, az + uz * fp + wz * fq);
    }
    for (const o of [a, b, c]) {
      if (P[o] < x0) x0 = P[o]; if (P[o] > x1) x1 = P[o];
      if (P[o + 1] < y0) y0 = P[o + 1]; if (P[o + 1] > y1) y1 = P[o + 1];
      if (P[o + 2] < z0) z0 = P[o + 2]; if (P[o + 2] > z1) z1 = P[o + 2];
    }
  }
  const keys = [...surf];
  // flood fill the outside of the cell box (1-cell margin); whatever the outside can't reach is inside
  const nx = i1 - i0 + 3, ny = j1 - j0 + 3, nz = k1 - k0 + 3;
  if (nx * ny * nz <= 4_000_000) {
    const grid = new Uint8Array(nx * ny * nz);
    const at = (i: number, j: number, k: number) => (i * ny + j) * nz + k;
    for (const key of surf) grid[at(KI(key) - i0 + 1, KJ(key) - j0 + 1, KK(key) - k0 + 1)] = 1;
    const queue = new Int32Array(nx * ny * nz);
    let qh = 0, qt = 0;
    queue[qt++] = 0; grid[0] = 2;
    while (qh < qt) {
      const c = queue[qh++];
      const i = Math.floor(c / (ny * nz)), j = Math.floor(c / nz) % ny, k = c % nz;
      for (const [di, dj, dk] of N6) {
        const a = i + di, b = j + dj, d = k + dk;
        if (a < 0 || b < 0 || d < 0 || a >= nx || b >= ny || d >= nz) continue;
        const o = at(a, b, d);
        if (grid[o] === 0) { grid[o] = 2; queue[qt++] = o; }
      }
    }
    for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) for (let k = 0; k < nz; k++)
      if (grid[at(i, j, k)] === 0) keys.push(KEY(i + i0 - 1, j + j0 - 1, k + k0 - 1));
  }
  return { keys, vol: Math.max(1e-6, (x1 - x0) * (y1 - y0) * (z1 - z0)) };
}

// ---------------- the skin ----------------
interface Holder {
  mesh: Mesh;               // the cubes (thin instances in voxel space)
  src: AbstractMesh;        // the hidden mesh it follows
  pre: Matrix;              // rootWorld0 * inverse(srcWorld0)
  socket: string | null;    // the part it belongs to (null = chassis / unknown)
  idx: number;              // position in Skin.holders
  cubes: number[];          // global cube index per slot
  mats: Float32Array;
  cols: Float32Array;
  dirtyM: boolean;
  dirtyC: boolean;
}

/** v0.29 a part that fell off, flying as its own body; its cubes ride it (st 4) until it breaks up. */
interface Ride { node: TransformNode; body: PhysicsBody; cubes: number[]; off: Float32Array; q0: Float32Array; age: number; blocked: Set<'A' | 'B'>; rad: number }
const LOOSE = new WeakSet<PhysicsBody>();
/** v0.29: is this one of the flying parts? (combat.ts: landing on one isn't a slam) */
export function isLooseBody(b: PhysicsBody | undefined): boolean { return !!b && LOOSE.has(b); }

const skins = new Map<Node, Skin>();
const sceneHooked = new WeakSet<Scene>();

export class Skin {
  readonly v: number;
  readonly style: CubeStyle;
  holders: Holder[] = [];
  bot?: Bot;
  private n = 0;
  // per cube
  private hOf!: Int32Array; private slot!: Int32Array; private lp!: Float32Array; private base!: Float32Array;
  private core!: Uint8Array; private st!: Uint8Array; private phase!: Float32Array;
  // debris
  private debris!: Mesh; private dMats!: Float32Array; private dCols!: Float32Array;
  private dp!: Float32Array; private dv!: Float32Array; private dq!: Float32Array; private dw!: Float32Array;
  private yaw!: Float32Array; private calm!: Float32Array; private walled!: Uint8Array;
  private active: number[] = [];
  private dDirtyM = false; private dDirtyC = false;
  // v0.29 HP = cubes: per part, its holders, cubes at the start, cubes still on
  private sockHolders = new Map<string, Holder[]>();
  private sockInit = new Map<string, number>();
  private sockAlive = new Map<string, number>();
  private chassisN = 0; private chassisOff = 0;
  private lastPoint?: Vector3;
  private rides: Ride[] = [];
  private deadSockets = new Set<string>();
  private ko = false;
  private flash = 0;
  private t = 0;
  private mat: StandardMaterial;

  constructor(private scene: Scene, readonly root: Mesh, meshes: AbstractMesh[], paintHex: string, socketOf: (m: AbstractMesh) => string | null, shadows?: ShadowGenerator) {
    this.v = CUBE_SIZE[CUBES.size] ?? 0.08;
    this.style = CUBES.style in STYLE ? CUBES.style : 'glow';
    const st = STYLE[this.style], v = this.v;
    // v0.31 armoured / weathered palette: team hue kept, paint darker and less saturated (industrial paint)
    const hsvP = Color3.FromHexString(paintHex).toHSV();
    const P = PAL[st.neon ? 'neon' : 'armor'];
    const paint = P.paint(hsvP.r, hsvP.g, hsvP.b);
    const accent = Color3.FromHexString(P.can);                       // motor cans: copper / brass
    const coreCol = Color3.FromHexString(P.core).scale(1.15);         // inner core: hot molten metal under the armour
    const RUST = Color3.FromHexString('#5e3a24'), SCORCH = Color3.FromHexString('#232120'), SCRATCH = Color3.FromHexString(P.scratchCol);

    root.computeWorldMatrix(true);
    const rootW = root.getWorldMatrix().clone();
    const toLocal = Matrix.Invert(rootW);

    // 1. cells per source mesh
    const srcs: { m: AbstractMesh; keys: number[]; vol: number; col: Color3; role: string }[] = [];
    for (const m of meshes) {
      if (!(m instanceof Mesh) || !m.isEnabled() || !m.isVisible || m.visibility < 0.01 || m.getTotalVertices() === 0) continue;
      if (SKIP_NAMES.some(s => m.name.includes(s))) continue;
      m.isVisible = false;                                            // the cubes take over
      if ((m.material?.name ?? '').startsWith('bolt')) continue;       // fasteners: far smaller than a cube
      const vx = voxelize(m, toLocal, v);
      if (vx.keys.length) srcs.push({ m, keys: vx.keys, vol: vx.vol, col: roleColor(m, paint, accent, P), role: m.material?.name ?? '' });
    }
    // 2. each cell belongs to one mesh: smaller meshes first (armour over chassis, tyre over wheel well, rails over edges)
    const owner = new Map<number, number>();
    const order = srcs.map((_, i) => i).sort((a, b) => srcs[a].vol - srcs[b].vol);
    for (const s of order) for (const key of srcs[s].keys) if (!owner.has(key)) owner.set(key, s);
    // 3. depth below the surface of its own part (1 = outer skin); keep up to KEEP_DEPTH
    const depth = new Map<number, number>();
    let front: number[] = [];
    for (const [key, s] of owner) {
      const i = KI(key), j = KJ(key), k = KK(key);
      if (N6.some(([a, b, c]) => owner.get(KEY(i + a, j + b, k + c)) !== s)) { depth.set(key, 1); front.push(key); }
    }
    for (let d = 2; d <= KEEP_DEPTH && front.length; d++) {
      const next: number[] = [];
      for (const key of front) {
        const s = owner.get(key)!, i = KI(key), j = KJ(key), k = KK(key);
        for (const [a, b, c] of N6) {
          const nk = KEY(i + a, j + b, k + c);
          if (owner.get(nk) === s && !depth.has(nk)) { depth.set(nk, d); next.push(nk); }
        }
      }
      front = next;
    }
    // 4. holders
    const per = new Map<number, number[]>();
    for (const [key] of depth) { const s = owner.get(key)!; let a = per.get(s); if (!a) per.set(s, a = []); a.push(key); }
    let total = 0; for (const a of per.values()) total += a.length;
    this.n = total;
    this.hOf = new Int32Array(total); this.slot = new Int32Array(total); this.lp = new Float32Array(total * 3);
    this.base = new Float32Array(total * 3); this.core = new Uint8Array(total); this.st = new Uint8Array(total);
    this.phase = new Float32Array(total);
    this.mat = new StandardMaterial(`${root.name}_cubeMat`, scene);
    this.mat.diffuseTexture = seamTexture(scene);
    this.mat.specularColor = new Color3(st.spec, st.spec, st.spec);
    this.mat.specularPower = 48;
    this.mat.emissiveColor = new Color3(st.emissive, st.emissive, st.emissive);
    const s = v * st.gap;
    let g = 0;
    for (const [si, keys] of per) {
      const src = srcs[si];
      const mesh = MeshBuilder.CreateBox(`${root.name}_cubes_${src.m.name}`, { size: 1 }, scene);
      mesh.material = this.mat; mesh.isPickable = false; mesh.alwaysSelectAsActiveMesh = true;
      mesh.rotationQuaternion = new Quaternion();
      const mats = new Float32Array(keys.length * 16), cols = new Float32Array(keys.length * 4);
      const h: Holder = { mesh, src: src.m, pre: rootW.multiply(Matrix.Invert(src.m.getWorldMatrix())), socket: socketOf(src.m), idx: this.holders.length, cubes: [], mats, cols, dirtyM: false, dirtyC: false };
      let gr = 0, gg = 0, gb = 0;
      keys.forEach((key, slot) => {
        const x = KI(key) * v, y = KJ(key) * v, z = KK(key) * v;
        const isCore = depth.get(key)! >= 2;
        // v0.31 wear: brightness mostly drops (grime); some paint cubes rust / scorch, some steel cubes scratched bright
        let c = isCore ? coreCol : src.col;
        const j = isCore ? 1 : 1.02 - Math.pow(Math.random(), 1.5) * P.wear;
        if (!isCore) {
          const r = Math.random();
          if (src.role.startsWith('paint') && r < P.rust + P.scorch) c = r < P.rust ? RUST : SCORCH;
          else if (src.role.startsWith('steel') && r < P.scratch) c = SCRATCH;
        }
        this.hOf[g] = this.holders.length; this.slot[g] = slot;
        this.lp[g * 3] = x; this.lp[g * 3 + 1] = y; this.lp[g * 3 + 2] = z;
        this.base[g * 3] = c.r * j; this.base[g * 3 + 1] = c.g * j; this.base[g * 3 + 2] = c.b * j;
        this.core[g] = isCore ? 1 : 0;
        this.phase[g] = (x * 1.2 + y * 2.0 + z * 0.7) * 5 + Math.random() * 0.6;
        const o = slot * 16;
        mats[o] = s; mats[o + 5] = s; mats[o + 10] = s; mats[o + 15] = 1;
        mats[o + 12] = x; mats[o + 13] = y; mats[o + 14] = z;
        cols[slot * 4] = this.base[g * 3]; cols[slot * 4 + 1] = this.base[g * 3 + 1]; cols[slot * 4 + 2] = this.base[g * 3 + 2]; cols[slot * 4 + 3] = 1;
        if (!isCore) { gr += c.r; gg += c.g; gb += c.b; }
        h.cubes.push(g++);
      });
      mesh.thinInstanceSetBuffer('matrix', mats, 16, false);
      mesh.thinInstanceSetBuffer('color', cols, 4, false);
      const nOut = Math.max(1, keys.filter(k => depth.get(k) === 1).length);
      mesh.metadata = { cubeGlow: glowOf(new Color3(gr / nOut, gg / nOut, gb / nOut), st.glow) };
      this.holders.push(h);
      if (h.socket) {
        let hs = this.sockHolders.get(h.socket); if (!hs) this.sockHolders.set(h.socket, hs = []);
        hs.push(h);
        this.sockInit.set(h.socket, (this.sockInit.get(h.socket) ?? 0) + h.cubes.length);
      } else this.chassisN += h.cubes.length;
    }
    for (const [sid, n] of this.sockInit) this.sockAlive.set(sid, n);
    // debris: one slot per cube, empty until the cube comes loose
    this.debris = MeshBuilder.CreateBox(`${root.name}_cubeDebris`, { size: 1 }, scene);
    this.debris.material = this.mat; this.debris.isPickable = false; this.debris.alwaysSelectAsActiveMesh = true;
    this.dMats = new Float32Array(Math.max(1, total) * 16);
    this.dCols = new Float32Array(Math.max(1, total) * 4);
    for (let i = 0; i < total; i++) { this.dCols[i * 4] = this.base[i * 3]; this.dCols[i * 4 + 1] = this.base[i * 3 + 1]; this.dCols[i * 4 + 2] = this.base[i * 3 + 2]; this.dCols[i * 4 + 3] = 1; }
    this.debris.thinInstanceSetBuffer('matrix', this.dMats, 16, false);
    this.debris.thinInstanceSetBuffer('color', this.dCols, 4, false);
    this.debris.metadata = { cubeGlow: glowOf(paint, st.glow * 0.5) };
    this.dp = new Float32Array(total * 3); this.dv = new Float32Array(total * 3);
    this.dq = new Float32Array(total * 4); this.dw = new Float32Array(total * 3);
    this.yaw = new Float32Array(total); this.calm = new Float32Array(total); this.walled = new Uint8Array(total);

    if (shadows) castShadows(shadows, [...this.holders.map(h => h.mesh), this.debris]);
    this.follow();
    skins.set(root, this);
    root.onDisposeObservable.addOnce(() => this.dispose());
    if (!sceneHooked.has(scene)) {
      sceneHooked.add(scene);
      scene.onBeforeRenderObservable.add(() => {
        const dt = Math.min(0.05, scene.getEngine().getDeltaTime() / 1000);
        for (const sk of skins.values()) if (sk.scene === scene) sk.update(dt);
      });
    }
  }

  get count() { return this.n; }
  meshes(): Mesh[] { return [...this.holders.map(h => h.mesh), this.debris]; }

  dispose() {
    for (const r of this.rides) disposeRide(r);
    this.rides = [];
    for (const h of this.holders) h.mesh.dispose();
    this.debris.dispose();
    this.mat.dispose();
    skins.delete(this.root);
  }

  /** Move every holder onto its (hidden) source mesh. */
  private follow() {
    const rootOn = this.root.isEnabled();
    const M = new Matrix();
    for (const h of this.holders) {
      if (h.src.isDisposed()) { h.mesh.setEnabled(false); continue; }
      const on = rootOn && h.src.isEnabled();
      if (h.mesh.isEnabled() !== on) h.mesh.setEnabled(on);
      if (!on) continue;
      h.src.computeWorldMatrix(true);
      h.pre.multiplyToRef(h.src.getWorldMatrix(), M);
      M.decompose(h.mesh.scaling, h.mesh.rotationQuaternion!, h.mesh.position);
    }
  }

  update(dt: number) {
    this.t += dt;
    this.follow();
    const bot = this.bot;
    if (bot && !this.ko) {
      for (const [sid, ps] of Object.entries(bot.state.parts)) {
        if (ps.hp <= 0 && !this.deadSockets.has(sid)) { this.deadSockets.add(sid); this.killPart(sid); }
      }
      this.sync(this.lastPoint ?? this.root.getAbsolutePosition());   // v0.29 HP = cubes (any HP change, any source)
    }
    // hit flash
    const e = STYLE[this.style].emissive + 0.5 * Math.max(0, this.flash) / 0.15;
    this.flash -= dt;
    this.mat.emissiveColor.set(e, e, e);
    // energy style: bright bands sweep through the cubes; cores pulse
    if (this.style === 'energy' || this.style === 'neonEnergy') {
      for (const h of this.holders) {
        for (let slot = 0; slot < h.cubes.length; slot++) {
          const g = h.cubes[slot];
          if (this.st[g] !== 0) continue;
          const f = this.shimmer(g);
          h.cols[slot * 4] = this.base[g * 3] * f; h.cols[slot * 4 + 1] = this.base[g * 3 + 1] * f; h.cols[slot * 4 + 2] = this.base[g * 3 + 2] * f;
        }
        h.dirtyC = true;
      }
      for (let g = 0; g < this.n; g++) if (this.st[g] === 1 || this.st[g] === 2) {
        const f = this.shimmer(g);
        this.dCols[g * 4] = this.base[g * 3] * f; this.dCols[g * 4 + 1] = this.base[g * 3 + 1] * f; this.dCols[g * 4 + 2] = this.base[g * 3 + 2] * f;
        this.dDirtyC = true;
      }
    }
    this.ride(dt);
    this.kick();
    this.simDebris(dt);
    for (const h of this.holders) {
      if (h.dirtyM) { h.mesh.thinInstanceBufferUpdated('matrix'); h.dirtyM = false; }
      if (h.dirtyC) { h.mesh.thinInstanceBufferUpdated('color'); h.dirtyC = false; }
    }
    if (this.dDirtyM) { this.debris.thinInstanceBufferUpdated('matrix'); this.dDirtyM = false; }
    if (this.dDirtyC) { this.debris.thinInstanceBufferUpdated('color'); this.dDirtyC = false; }
  }

  private shimmer(g: number): number {
    const soft = this.style === 'neonEnergy';                          // v0.31 combo: full neon base, gentler bands
    if (this.core[g]) return soft ? 0.9 + 0.2 * Math.sin(this.t * 6 + this.phase[g]) : 0.85 + 0.3 * Math.sin(this.t * 6 + this.phase[g]);
    const b = Math.pow(0.5 + 0.5 * Math.sin(this.t * 5 - this.phase[g]), 10);
    return soft ? 0.85 + 0.9 * b : 0.25 + 2.2 * b;
  }

  // ---------------- damage ----------------
  /** v0.29 HP = cubes: the part whose nearest intact cube is closest to `point` (world), among the parts
   *  `ok` allows (combat.ts: alive, and not an unbreakable weapon already at its floor). */
  target(point: Vector3, ok: (sid: string) => boolean): string | undefined {
    if (this.ko) return undefined;
    let best: string | undefined, bd = Infinity;
    const inv = new Matrix(), q = new Vector3();
    for (const [sid, hs] of this.sockHolders) {
      if (!ok(sid)) continue;
      for (const h of hs) {
        if (!h.mesh.isEnabled()) continue;
        h.mesh.computeWorldMatrix(true);
        h.mesh.getWorldMatrix().invertToRef(inv);
        Vector3.TransformCoordinatesToRef(point, inv, q);
        for (const g of h.cubes) {
          if (this.st[g] !== 0) continue;
          const dx = this.lp[g * 3] - q.x, dy = this.lp[g * 3 + 1] - q.y, dz = this.lp[g * 3 + 2] - q.z;
          const d = dx * dx + dy * dy + dz * dz;
          if (d < bd) { bd = d; best = sid; }
        }
      }
    }
    // a part too thin to get any cubes of its own at this cube size (8-bit Flip Side's top armor, flush under the
    // plate) is hit by where its mesh is -- otherwise it could never be damaged and the bot never KO'd
    if (this.bot) for (const [sid, m] of Object.entries(this.bot.partMeshes)) {
      if ((this.sockInit.get(sid) ?? 0) > 0 || !ok(sid)) continue;
      m.computeWorldMatrix(true);
      const d = Vector3.DistanceSquared(m.getBoundingInfo().boundingBox.centerWorld, point);
      if (d < bd) { bd = d; best = sid; }
    }
    return best;
  }

  /** v0.29 HP = cubes: every living part keeps its share of cubes (start x HP / max HP, at least 1);
   *  extra cubes come off nearest `point` first. */
  private sync(point: Vector3) {
    const bot = this.bot;
    if (!bot) return;
    const inv = new Matrix(), q = new Vector3();
    for (const [sid, hs] of this.sockHolders) {
      const ps = bot.state.parts[sid];
      if (!ps || ps.hp <= 0 || this.deadSockets.has(sid)) continue;
      const init = this.sockInit.get(sid) ?? 0;
      const want = Math.max(1, Math.ceil(init * ps.hp / Math.max(1, ps.maxHp)));
      const extra = (this.sockAlive.get(sid) ?? 0) - want;
      if (extra <= 0) continue;
      const near: { g: number; d: number }[] = [];
      for (const h of hs) {
        h.mesh.computeWorldMatrix(true);
        h.mesh.getWorldMatrix().invertToRef(inv);
        Vector3.TransformCoordinatesToRef(point, inv, q);
        for (const g of h.cubes) {
          if (this.st[g] !== 0) continue;
          const dx = this.lp[g * 3] - q.x, dy = this.lp[g * 3 + 1] - q.y, dz = this.lp[g * 3 + 2] - q.z;
          near.push({ g, d: dx * dx + dy * dy + dz * dz });
        }
      }
      near.sort((a, b) => a.d - b.d);
      for (const { g } of near.slice(0, extra)) this.loosen(g, 1);
    }
  }

  /** A hit at `point` (world) that did `dmg` (already applied to the bot's state). */
  hit(point: Vector3, dmg: number) {
    if (this.ko || !this.n) return;
    this.flash = 0.15;
    this.lastPoint = point.clone();
    this.sync(point);                       // v0.29 the part that took it loses its share of cubes
    // chassis cubes (no HP of their own): a few chip off near the hit, capped by the bot's overall damage
    if (!this.chassisN) return;
    const frac = this.bot ? damageFraction(this.bot.state) : 0;
    const cap = Math.floor(this.chassisN * CHIP.maxRemoved) - this.chassisOff;
    if (cap <= 0) return;
    const allowed = Math.floor(this.chassisN * (CHIP.base + CHIP.perDamage * frac)) - this.chassisOff;
    const take = Math.min(cap, Math.max(CHIP.minPerHit, allowed));
    const r = this.v * (CHIP.radius + Math.min(CHIP.radiusMax, dmg * CHIP.radiusPerDmg));
    const near: { g: number; d: number }[] = [];
    const inv = new Matrix(), q = new Vector3();
    for (const h of this.holders) {
      if (h.socket || !h.mesh.isEnabled()) continue;
      h.mesh.computeWorldMatrix(true);
      h.mesh.getWorldMatrix().invertToRef(inv);
      Vector3.TransformCoordinatesToRef(point, inv, q);
      for (const g of h.cubes) {
        if (this.st[g] !== 0) continue;
        const dx = this.lp[g * 3] - q.x, dy = this.lp[g * 3 + 1] - q.y, dz = this.lp[g * 3 + 2] - q.z;
        const d = dx * dx + dy * dy + dz * dz;
        if (d <= r * r) near.push({ g, d });
      }
    }
    near.sort((a, b) => a.d - b.d);
    for (const { g } of near.slice(0, take)) this.loosen(g, 1);
  }

  /** v0.28 A part reached 0 HP: it falls off for real -- its collider goes (bot.ts dropPart) and its cubes
   *  fly off together (one push + one spin). v0.29: each piece of it (a tyre, a skid) flies as a real body for
   *  PART_FLY.lifeS, carrying its cubes, then breaks up into debris. */
  private killPart(sid: string) {
    if (this.bot) dropPart(this.bot, sid);
    const hs = this.holders.filter(h => h.socket === sid);
    // pieces: holders whose cubes sit within PART_FLY.cluster of each other fly together
    const items: { h: Holder; list: number[]; pts: Vector3[]; c: Vector3 }[] = [];
    for (const h of hs) {
      h.mesh.computeWorldMatrix(true);
      const list = h.cubes.filter(g => this.st[g] === 0);
      if (!list.length) continue;
      const pts = list.map(g => this.worldOf(g));
      items.push({ h, list, pts, c: pts.reduce((a, p) => a.addInPlace(p), new Vector3()).scaleInPlace(1 / pts.length) });
    }
    if (!items.length) return;
    const grp = items.map((_, i) => i);
    const find = (i: number): number => grp[i] === i ? i : (grp[i] = find(grp[i]));
    for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++)
      if (Vector3.Distance(items[i].c, items[j].c) < PART_FLY.cluster) grp[find(i)] = find(j);
    const pieces = new Map<number, { list: number[]; pts: Vector3[] }>();
    items.forEach((it, i) => {
      const k = find(i);
      let p = pieces.get(k); if (!p) pieces.set(k, p = { list: [], pts: [] });
      p.list.push(...it.list); p.pts.push(...it.pts);
    });
    const vb = this.bot ? this.bot.body.getLinearVelocity().clone() : Vector3.Zero();
    for (const { list, pts } of pieces.values()) {
      const C = pts.reduce((a, p) => a.add(p), new Vector3()).scaleInPlace(1 / pts.length);
      const out = C.subtract(this.root.getAbsolutePosition()); out.y = 0;
      if (out.lengthSquared() < 1e-4) out.set(Math.random() - 0.5, 0, Math.random() - 0.5);
      out.normalize();
      const v0 = out.scale(rnd(PART_OFF.speed[0], PART_OFF.speed[1])).addInPlace(new Vector3(0, rnd(PART_OFF.up[0], PART_OFF.up[1]), 0)).addInPlace(vb);
      const w = new Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize().scaleInPlace(rnd(PART_OFF.spin[0], PART_OFF.spin[1]));
      if (this.launch(sid, list, pts, v0, w, pieces.size)) continue;
      list.forEach((g, i) => {
        const r = pts[i].subtract(C);
        const v = v0.add(Vector3.Cross(w, r)).addInPlace(new Vector3(rnd(-1, 1), rnd(-1, 1), rnd(-1, 1)).scaleInPlace(PART_OFF.noise));
        this.loosen(g, 1, v, w);
      });
    }
    this.flash = 0.2;
  }

  /** v0.29 option 4: one piece of a dead part becomes a real body (a box round its cubes) for PART_FLY.lifeS.
   *  Its cubes ride it. Returns false when there's no physics (lab) -- the cubes just fly as debris then. */
  private launch(sid: string, list: number[], pts: Vector3[], v0: Vector3, w: Vector3, pieces: number): boolean {
    const bot = this.bot;
    if (!bot || !this.scene.getPhysicsEngine()) return false;
    const mn = new Vector3(Infinity, Infinity, Infinity), mx = new Vector3(-Infinity, -Infinity, -Infinity);
    for (const p of pts) { mn.minimizeInPlace(p); mx.maximizeInPlace(p); }
    const C = mn.add(mx).scaleInPlace(0.5);
    const ext = mx.subtract(mn).addInPlaceFromFloats(this.v, this.v, this.v);
    ext.set(Math.max(0.12, ext.x), Math.max(0.12, ext.y), Math.max(0.12, ext.z));
    const node = new TransformNode(`${this.root.name}_off_${sid}`, this.scene);
    node.position.copyFrom(C);
    node.rotationQuaternion = Quaternion.Identity();
    const shape = new PhysicsShapeBox(Vector3.Zero(), Quaternion.Identity(), ext, this.scene);
    shape.material = { friction: PART_FLY.friction, restitution: PART_FLY.restitution };
    const blocked = new Set<'A' | 'B'>(['A', 'B']);                 // passes through both bots until clear of them
    const f = loosePartFilter([...blocked]);
    shape.filterMembershipMask = f.member; shape.filterCollideMask = f.collide;
    const body = new PhysicsBody(node, PhysicsMotionType.DYNAMIC, false, this.scene);
    body.shape = shape;
    const ps = bot.state.parts[sid];
    const kg = ps ? partWeight(ps.part, catalog.balance) * PART_FLY.kgPerWeight / pieces : PART_FLY.minKg;
    body.setMassProperties({ mass: Math.min(PART_FLY.maxKg, Math.max(PART_FLY.minKg, kg)) });
    body.setLinearVelocity(v0);
    body.setAngularVelocity(w);
    body.setCollisionCallbackEnabled(true);
    LOOSE.add(body);
    const off = new Float32Array(list.length * 3), q0 = new Float32Array(list.length * 4);
    list.forEach((g, i) => {
      const r = this.holders[this.hOf[g]].mesh.rotationQuaternion!;
      off[i * 3] = pts[i].x - C.x; off[i * 3 + 1] = pts[i].y - C.y; off[i * 3 + 2] = pts[i].z - C.z;
      q0[i * 4] = r.x; q0[i * 4 + 1] = r.y; q0[i * 4 + 2] = r.z; q0[i * 4 + 3] = r.w;
      this.detach(g);
      this.st[g] = 4;
    });
    this.rides.push({ node, body, cubes: list, off, q0, age: 0, blocked, rad: ext.length() / 2 });
    bot.onPartOff?.(body, sid);
    return true;
  }

  /** v0.29 move riding cubes with their flying part; when its time is up they break up into debris. */
  private ride(dt: number) {
    if (!this.rides.length) return;
    const s = this.v * STYLE[this.style].gap, scl = new Vector3(s, s, s);
    const M = new Matrix(), P = new Vector3(), R = new Quaternion(), o = new Vector3(), w = new Vector3(), q = new Quaternion(), tq = new Quaternion();
    const keep: Ride[] = [];
    for (const r of this.rides) {
      r.age += dt;
      P.copyFrom(r.node.position);
      if (r.blocked.size && r.body.shape) {
        const peers = [...skins.values()].filter(sk => sk.scene === this.scene && sk.bot).map(sk => sk.bot!);
        let changed = false;
        for (const id of [...r.blocked]) {
          if (id === this.bot?.id && r.age < PART_FLY.graceS) continue;
          const b = peers.find(p => p.id === id);
          if (b && !b.eliminated && insideReach(b, P, r.rad)) continue;
          r.blocked.delete(id); changed = true;
        }
        if (changed) r.body.shape.filterCollideMask = loosePartFilter([...r.blocked]).collide;
      }
      R.copyFrom(r.node.rotationQuaternion ?? Quaternion.Identity());
      const done = r.age >= PART_FLY.lifeS || P.y < -30;
      const lin = done ? r.body.getLinearVelocity().clone() : undefined;
      const ang = done ? r.body.getAngularVelocity().clone() : undefined;
      r.cubes.forEach((g, i) => {
        if (this.st[g] !== 4) return;
        w.set(r.off[i * 3], r.off[i * 3 + 1], r.off[i * 3 + 2]);
        w.rotateByQuaternionToRef(R, o);
        o.addInPlace(P);
        tq.set(r.q0[i * 4], r.q0[i * 4 + 1], r.q0[i * 4 + 2], r.q0[i * 4 + 3]);
        R.multiplyToRef(tq, q);
        if (done) {
          const o3 = g * 3;
          const v = lin!.add(Vector3.Cross(ang!, o.subtract(P)));
          this.dp[o3] = o.x; this.dp[o3 + 1] = o.y; this.dp[o3 + 2] = o.z;
          this.dv[o3] = v.x; this.dv[o3 + 1] = v.y; this.dv[o3 + 2] = v.z;
          this.dw[o3] = ang!.x; this.dw[o3 + 1] = ang!.y; this.dw[o3 + 2] = ang!.z;
          this.dq[g * 4] = q.x; this.dq[g * 4 + 1] = q.y; this.dq[g * 4 + 2] = q.z; this.dq[g * 4 + 3] = q.w;
          this.yaw[g] = Math.random() * Math.PI * 2; this.calm[g] = 0;
          this.walled[g] = FLOORS.some(f => f.wallH > 0 && Math.abs(o.x - f.cx) < f.half && Math.abs(o.z - f.cz) < f.half) ? 1 : 0;
          this.st[g] = 1;
          this.active.push(g);
        } else {
          Matrix.ComposeToRef(scl, q, o, M);
          M.copyToArray(this.dMats, g * 16);
        }
      });
      this.dDirtyM = true;
      if (done) disposeRide(r); else keep.push(r);
    }
    this.rides = keep;
  }

  /** KO (v0.28: the whole bot, its collider goes too -- main.ts dropBot) or knocked out of the arena: every cube flies. */
  knockout() {
    if (this.ko) return;
    this.ko = true;
    for (const h of this.holders) h.mesh.computeWorldMatrix();
    for (let g = 0; g < this.n; g++) if (this.st[g] === 0) this.loosen(g, 2.4);
    this.flash = 0.3;
  }

  private worldOf(g: number): Vector3 {
    const W = this.holders[this.hOf[g]].mesh.getWorldMatrix();
    return Vector3.TransformCoordinatesFromFloatsToRef(this.lp[g * 3], this.lp[g * 3 + 1], this.lp[g * 3 + 2], W, new Vector3());
  }

  /** Take one cube off its holder (bookkeeping shared by loosen and launch). */
  private detach(g: number) {
    const h = this.holders[this.hOf[g]];
    const slot = this.slot[g] * 16;
    for (let k = 0; k < 16; k++) h.mats[slot + k] = 0;
    h.dirtyM = true;
    for (let k = 0; k < 3; k++) this.dCols[g * 4 + k] = h.cols[this.slot[g] * 4 + k];
    this.dDirtyC = true;
    if (h.socket) this.sockAlive.set(h.socket, (this.sockAlive.get(h.socket) ?? 1) - 1);
    else this.chassisOff++;
  }

  /** Detach one cube: it becomes debris, flying out from the bot (or with the given velocity / spin). */
  private loosen(g: number, power: number, vel?: Vector3, spin?: Vector3) {
    const h = this.holders[this.hOf[g]];
    h.mesh.computeWorldMatrix();
    const p = this.worldOf(g);
    this.dp[g * 3] = p.x; this.dp[g * 3 + 1] = p.y; this.dp[g * 3 + 2] = p.z;
    if (vel) { this.dv[g * 3] = vel.x; this.dv[g * 3 + 1] = vel.y; this.dv[g * 3 + 2] = vel.z; }
    else {
      const out = p.subtract(this.root.getAbsolutePosition()); out.y = Math.max(out.y, 0.1); out.normalize();
      const sp = rnd(1.5, 4) * power, up = rnd(1.5, 3.5) * power;
      this.dv[g * 3] = out.x * sp + rnd(-0.8, 0.8); this.dv[g * 3 + 1] = out.y * sp + up; this.dv[g * 3 + 2] = out.z * sp + rnd(-0.8, 0.8);
    }
    const r = h.mesh.rotationQuaternion!;
    this.dq[g * 4] = r.x; this.dq[g * 4 + 1] = r.y; this.dq[g * 4 + 2] = r.z; this.dq[g * 4 + 3] = r.w;
    if (spin) { this.dw[g * 3] = spin.x; this.dw[g * 3 + 1] = spin.y; this.dw[g * 3 + 2] = spin.z; }
    else { this.dw[g * 3] = rnd(-12, 12); this.dw[g * 3 + 1] = rnd(-12, 12); this.dw[g * 3 + 2] = rnd(-12, 12); }
    this.yaw[g] = Math.random() * Math.PI * 2; this.calm[g] = 0;
    this.walled[g] = FLOORS.some(f => f.wallH > 0 && Math.abs(p.x - f.cx) < f.half && Math.abs(p.z - f.cz) < f.half) ? 1 : 0;
    this.detach(g);
    this.st[g] = 1;
    this.active.push(g);
  }

  /** v0.28 bots shove loose cubes (this skin's debris) out of their way; a fast spinner flings what it touches. */
  private kick() {
    const pushers = [...skins.values()].filter(sk => sk.scene === this.scene && sk.bot && !sk.bot.eliminated).map(sk => sk.bot!);
    if (!pushers.length) return;
    const inv = new Matrix(), lp = new Vector3(), wp = new Vector3();
    for (const b of pushers) {
      const vel = b.body.getLinearVelocity();
      const speed = Math.hypot(vel.x, vel.z);
      const omega = Math.abs(spinOmega(b));
      const hub = omega > KICK.spinMin ? weaponBodies(b).find(w => w.body === b.spinner?.body)?.hub : undefined;
      if (speed < KICK.minSpeed && !hub) continue;
      const ch = chassisFor(b.build.bodyId);
      const hx = ch.w / 2 + KICK.marginX, hz = ch.d / 2 + KICK.marginZ, hy = ch.h / 2 + KICK.marginY;
      b.root.computeWorldMatrix(true);
      b.root.getWorldMatrix().invertToRef(inv);
      const c = b.root.getAbsolutePosition();
      const R = Math.hypot(hx, hz) + 1.2;
      const hp = hub?.getAbsolutePosition();
      const hr = KICK.spinR[b.spinAxis] ?? 0.8;
      const up = Math.min(1, speed / 3);
      for (let g = 0; g < this.n; g++) {
        const s = this.st[g];
        if (s !== 1 && s !== 2) continue;
        const o = g * 3;
        const dx = this.dp[o] - c.x, dz = this.dp[o + 2] - c.z;
        if (dx * dx + dz * dz > R * R) continue;
        wp.set(this.dp[o], this.dp[o + 1], this.dp[o + 2]);
        let kicked = false;
        if (hp && Vector3.DistanceSquared(wp, hp) < hr * hr) {                  // spinning weapon: fling hard
          const out = wp.subtract(hp); out.y = Math.abs(out.y) + 0.3; out.normalize();
          const f = rnd(KICK.fling[0], KICK.fling[1]);
          this.dv[o] = out.x * f + vel.x; this.dv[o + 1] = out.y * f; this.dv[o + 2] = out.z * f + vel.z;
          kicked = true;
        } else if (speed >= KICK.minSpeed) {
          Vector3.TransformCoordinatesToRef(wp, inv, lp);
          if (Math.abs(lp.x) < hx && Math.abs(lp.z) < hz && lp.y < hy) {        // in the chassis' path: shove
            const ox = dx, oz = dz, ol = Math.hypot(ox, oz) || 1;
            const k = rnd(KICK.carry[0], KICK.carry[1]), so = rnd(KICK.out[0], KICK.out[1]);
            this.dv[o] = vel.x * k + (ox / ol) * so;
            this.dv[o + 1] = rnd(KICK.up[0], KICK.up[1]) * up + 0.4;
            this.dv[o + 2] = vel.z * k + (oz / ol) * so;
            kicked = true;
          }
        }
        if (kicked) {
          this.dw[o] = rnd(-10, 10); this.dw[o + 1] = rnd(-10, 10); this.dw[o + 2] = rnd(-10, 10);
          this.calm[g] = 0;
          if (s === 2) { this.st[g] = 1; this.active.push(g); }
        }
      }
    }
  }

  private simDebris(dt: number) {
    if (!this.active.length) return;
    const s = this.v * STYLE[this.style].gap, half = s / 2;
    const q = new Quaternion(), dq = new Quaternion(), tq = new Quaternion(), axis = new Vector3();
    const pos = new Vector3(), scl = new Vector3(s, s, s), M = new Matrix();
    const keep: number[] = [];
    for (const g of this.active) {
      const o = g * 3;
      let x = this.dp[o], y = this.dp[o + 1], z = this.dp[o + 2];
      let vx = this.dv[o], vy = this.dv[o + 1], vz = this.dv[o + 2];
      vy -= G * dt; x += vx * dt; y += vy * dt; z += vz * dt;
      q.set(this.dq[g * 4], this.dq[g * 4 + 1], this.dq[g * 4 + 2], this.dq[g * 4 + 3]);
      const wl = Math.hypot(this.dw[o], this.dw[o + 1], this.dw[o + 2]);
      if (wl > 1e-4) {
        axis.set(this.dw[o] / wl, this.dw[o + 1] / wl, this.dw[o + 2] / wl);
        Quaternion.RotationAxisToRef(axis, wl * dt, dq);
        dq.multiplyToRef(q, q);
      }
      // walls (arena only, below the wall top)
      const area = FLOORS.find(f => Math.abs(x - f.cx) <= f.half + 0.5 && Math.abs(z - f.cz) <= f.half + 0.5);
      if (this.walled[g] && area && y < area.wallH) {
        const lim = area.half - half;
        if (Math.abs(x - area.cx) > lim) { x = area.cx + Math.sign(x - area.cx) * lim; vx *= -0.4; }
        if (Math.abs(z - area.cz) > lim) { z = area.cz + Math.sign(z - area.cz) * lim; vz *= -0.4; }
      }
      const onArea = area && Math.abs(x - area.cx) <= area.half && Math.abs(z - area.cz) <= area.half;
      let grounded = false;
      if (onArea && y < half && y > -1) {
        y = half; grounded = true;
        if (vy < 0) {
          vy *= -0.3; vx *= 0.7; vz *= 0.7;
          for (let k = 0; k < 3; k++) this.dw[o + k] *= 0.55;
          if (Math.abs(vy) < 0.4) vy = 0;
        }
      }
      let settled = false;
      if (grounded && vx * vx + vy * vy + vz * vz < 0.03) {
        vx *= 0.5; vz *= 0.5;
        for (let k = 0; k < 3; k++) this.dw[o + k] *= 0.7;
        Quaternion.RotationYawPitchRollToRef(this.yaw[g], 0, 0, tq);
        Quaternion.SlerpToRef(q, tq, Math.min(1, 9 * dt), q);
        this.calm[g] += dt;
        if (this.calm[g] > 0.5) { q.copyFrom(tq); settled = true; }
      }
      this.dp[o] = x; this.dp[o + 1] = y; this.dp[o + 2] = z;
      this.dv[o] = vx; this.dv[o + 1] = vy; this.dv[o + 2] = vz;
      this.dq[g * 4] = q.x; this.dq[g * 4 + 1] = q.y; this.dq[g * 4 + 2] = q.z; this.dq[g * 4 + 3] = q.w;
      if (y < -30) {                                       // fell off the world
        for (let k = 0; k < 16; k++) this.dMats[g * 16 + k] = 0;
        this.st[g] = 3;
      } else {
        pos.set(x, y, z);
        Matrix.ComposeToRef(scl, q, pos, M);
        M.copyToArray(this.dMats, g * 16);
        if (settled) this.st[g] = 2; else keep.push(g);
      }
    }
    this.active = keep;
    this.dDirtyM = true;
  }
}

/** v0.29 is a ball (centre P, radius rad) within this bot's chassis box (+ KICK margins) or its weapons' reach? */
function insideReach(b: Bot, P: Vector3, rad: number): boolean {
  const ch = chassisFor(b.build.bodyId);
  b.root.computeWorldMatrix(true);
  const l = Vector3.TransformCoordinates(P, Matrix.Invert(b.root.getWorldMatrix()));
  if (Math.abs(l.x) < ch.w / 2 + KICK.marginX + rad && Math.abs(l.z) < ch.d / 2 + KICK.marginZ + rad && Math.abs(l.y) < ch.h / 2 + KICK.marginY + rad) return true;
  const reach = KICK.spinR[b.spinAxis] ?? 0.8;
  return weaponBodies(b).some(w => Vector3.Distance(w.hub.getAbsolutePosition(), P) < rad + reach);
}

function disposeRide(r: Ride) {
  LOOSE.delete(r.body);
  const shape = r.body.shape;
  r.body.dispose();
  shape?.dispose();
  r.node.dispose();
}

/** Glow-layer colour: the cubes' colour, brightest channel capped so pale parts don't bloom into a white blob. */
function glowOf(c: Color3, k: number): Color3 { const m = Math.max(c.r, c.g, c.b, 1e-3); return c.scale(Math.min(k, 0.4 / m)); }

/** Fraction of the bot's breakable HP that is gone (0..1). */
function damageFraction(s: BotState): number {
  let max = 0, left = 0;
  for (const p of Object.values(s.parts)) { if (isProtected(s, p)) continue; max += p.maxHp; left += Math.max(0, p.hp); }
  return max > 0 ? 1 - left / max : 0;
}

// ---------------- entry points ----------------
/** Lab preview: cube the assembled bot (no state; nothing breaks in the lab). */
export function skinPreview(scene: Scene, root: Mesh, partMeshes: Record<string, Mesh>, paint: string, shadows?: ShadowGenerator): Skin | null {
  if (!CUBES.on) return null;
  return new Skin(scene, root, [root, ...root.getChildMeshes()], paint, m => socketByAncestry(m, partMeshes), shadows);
}

/** Match / course bot: cube it and follow its real parts (weapons + tyres live on their own bodies). */
export function skinBot(bot: Bot, shadows?: ShadowGenerator): Skin | null {
  if (!CUBES.on) return null;
  const scene = bot.root.getScene();
  const tyres = new Set<Node>((bot.wheels ?? []).map(w => w.tyre));
  const weaponHubs = new Set<Node>(weaponBodies(bot).map(w => w.hub));   // v0.29: moving weapon pieces (spinner, arm, saw, plates, forks) live on their own bodies
  const socketOf = (m: AbstractMesh) => {
    for (let n: Node | null = m; n; n = n.parent) if (tyres.has(n)) return 'wheels';
    const s = socketByAncestry(m, bot.partMeshes);
    if (s) return s;
    for (let n: Node | null = m; n; n = n.parent) if (weaponHubs.has(n)) return 'weapon';
    return null;
  };
  const sk = new Skin(scene, bot.root, botMeshes(bot), bot.build.cosmetics.paint ?? (bot.id === 'A' ? '#e63946' : '#1d7cf2'), socketOf, shadows);
  sk.bot = bot;
  return sk;
}

function socketByAncestry(m: AbstractMesh, partMeshes: Record<string, Mesh>): string | null {
  for (let n: Node | null = m; n; n = n.parent) for (const [sid, pm] of Object.entries(partMeshes)) if (pm === n) return sid;
  return null;
}

export function cubeHit(bot: Bot, point: Vector3, dmg: number) { skins.get(bot.root)?.hit(point, dmg); }
export function cubeKnockout(bot: Bot) { skins.get(bot.root)?.knockout(); }
export function cubeSkinOf(root: Node): Skin | undefined { return skins.get(root); }
