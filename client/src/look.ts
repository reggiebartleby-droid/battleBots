/** v0.16 visual-only "battle-tested" look: procedural PBR materials (generated in code, no image files),
 *  a generated arena-light environment for metal reflections, and sun shadows. Nothing here touches physics. */
import {
  AbstractMesh, Color3, Constants, DirectionalLight, HDRFiltering, PBRMaterial, RawCubeTexture, RawTexture,
  Scene, ShadowGenerator, Texture,
} from '@babylonjs/core';

const N = 256;   // texture size (per material; pixel data is generated once and cached)

// ---------- noise ----------
function hash(x: number, y: number, s: number) {
  let h = (x * 374761393 + y * 668265263 + s * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function vnoise(x: number, y: number, s: number, period: number) {
  const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const w = (a: number) => ((a % period) + period) % period;   // tiles so texture edges match
  const a = hash(w(xi), w(yi), s), b = hash(w(xi + 1), w(yi), s), c = hash(w(xi), w(yi + 1), s), d = hash(w(xi + 1), w(yi + 1), s);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}
function fbm(u: number, v: number, s: number, freq: number, oct = 4) {
  let t = 0, amp = 0.5, f = freq;
  for (let i = 0; i < oct; i++) { t += amp * vnoise(u * f, v * f, s + i * 17, f); amp *= 0.5; f *= 2; }
  return t / (1 - Math.pow(0.5, oct));
}
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const smooth = (a: number, b: number, x: number) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };

/** Random straight scratches rasterised into a float field (0..1). */
function scratchField(seed: number, count: number, maxLen: number): Float32Array {
  const f = new Float32Array(N * N);
  for (let i = 0; i < count; i++) {
    let x = hash(i, 1, seed) * N, y = hash(i, 2, seed) * N;
    const a = hash(i, 3, seed) * Math.PI, len = (0.2 + 0.8 * hash(i, 4, seed)) * maxLen * N, k = 0.4 + 0.6 * hash(i, 5, seed);
    const dx = Math.cos(a), dy = Math.sin(a);
    for (let t = 0; t < len; t++) {
      const px = Math.floor(x + dx * t), py = Math.floor(y + dy * t);
      if (px < 0 || py < 0 || px >= N || py >= N) break;
      f[py * N + px] = Math.max(f[py * N + px], k);
    }
  }
  return f;
}

// ---------- surface layers ----------
interface Layers { albedo: Uint8Array; mr: Uint8Array; normal: Uint8Array }
const cache = new Map<string, Layers>();

function normalFromHeight(h: Float32Array, strength: number): Uint8Array {
  const out = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const at = (xx: number, yy: number) => h[((yy + N) % N) * N + ((xx + N) % N)];
    const dx = (at(x + 1, y) - at(x - 1, y)) * strength, dy = (at(x, y + 1) - at(x, y - 1)) * strength;
    const l = Math.sqrt(dx * dx + dy * dy + 1), i = (y * N + x) * 4;
    out[i] = (-dx / l * 0.5 + 0.5) * 255; out[i + 1] = (-dy / l * 0.5 + 0.5) * 255; out[i + 2] = (1 / l * 0.5 + 0.5) * 255; out[i + 3] = 255;
  }
  return out;
}

/** Wear pattern for a painted plate (colour-independent, computed once per seed): paint chipped back to bare
 *  steel, worst at the face edges (every box face maps the full texture, so the UV border is the plate edge),
 *  plus scratches, grime and a dark primer rim round chips. */
interface PaintMask { paint: Float32Array; shade: Float32Array; steel: Float32Array; sc: Float32Array; mr: Uint8Array; normal: Uint8Array }
const masks = new Map<number, PaintMask>();
function paintMask(seed: number): PaintMask {
  const hit = masks.get(seed); if (hit) return hit;
  const paintF = new Float32Array(N * N), shade = new Float32Array(N * N), steelF = new Float32Array(N * N), scF = new Float32Array(N * N);
  const mr = new Uint8Array(N * N * 4), height = new Float32Array(N * N);
  const scr = scratchField(seed, 22, 0.14);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const u = x / N, v = y / N, i = y * N + x;
    const edge = Math.min(u, 1 - u, v, 1 - v);                                   // 0 at the plate edge
    const n = fbm(u, v, seed, 6, 3), nHi = fbm(u, v, seed + 5, 24, 2);
    const wear = (1 - smooth(0.0, 0.11, edge)) * 0.75 + nHi * 0.55 + (n - 0.5) * 0.35;
    const paint = 1 - smooth(0.62, 0.70, wear);                                   // 1 = paint, 0 = bare steel
    const rim = smooth(0.52, 0.64, wear) * paint;                                 // primer / dirt round a chip
    const s = scr[i] * (paint > 0.5 ? 1 : 0.5);
    const grime = 0.7 + 0.3 * fbm(u, v, seed + 9, 3, 2);
    paintF[i] = paint;
    shade[i] = (0.88 + 0.12 * n) * (1 - rim * 0.6) * grime;
    steelF[i] = (0.42 + 0.18 * nHi) * grime;
    scF[i] = s * 0.22;                                                            // scratches: faint bare metal
    const metal = clamp01((1 - paint) + s * 0.8);
    const rough = paint * (0.5 + 0.2 * n) + (1 - paint) * (0.38 + 0.15 * nHi) - s * 0.1;
    mr[i * 4] = 255; mr[i * 4 + 1] = clamp01(rough) * 255; mr[i * 4 + 2] = metal * 255; mr[i * 4 + 3] = 255;
    height[i] = paint * 0.6 + (n - 0.5) * 0.5 - s * 0.1;
  }
  const M = { paint: paintF, shade, steel: steelF, sc: scF, mr, normal: normalFromHeight(height, 2.2) };
  masks.set(seed, M);
  return M;
}

/** Painted plate in a colour: cheap pass over the cached wear pattern. */
function paintedLayers(hex: string, seed: number): Layers {
  const key = `paint${hex}${seed}`;
  const hit = cache.get(key); if (hit) return hit;
  const M = paintMask(seed);
  const c = Color3.FromHexString(hex).toLinearSpace();
  const albedo = new Uint8Array(N * N * 4);
  const out = (paintCh: number, i: number, tint: number) => {
    const p = M.paint[i], st = M.steel[i] * tint;
    const ch = paintCh * M.shade[i] * p + st * (1 - p);
    return Math.round(Math.pow(clamp01(ch * (1 - M.sc[i]) + st * M.sc[i] * 1.3), 1 / 2.2) * 255);
  };
  for (let i = 0; i < N * N; i++) {
    albedo[i * 4] = out(c.r, i, 1); albedo[i * 4 + 1] = out(c.g, i, 1); albedo[i * 4 + 2] = out(c.b, i, 1.02); albedo[i * 4 + 3] = 255;
  }
  const L = { albedo, mr: M.mr, normal: M.normal };
  if (cache.size > 40) cache.clear();                                             // colour-picker drags make many colours
  cache.set(key, L);
  return L;
}

/** Hardened tool steel (weapons, wedges): brushed, scuffed, slightly heat-darkened. */
function steelLayers(seed: number): Layers {
  const key = `steel${seed}`;
  const hit = cache.get(key); if (hit) return hit;
  const albedo = new Uint8Array(N * N * 4), mr = new Uint8Array(N * N * 4), height = new Float32Array(N * N);
  const scr = scratchField(seed, 30, 0.12);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const u = x / N, v = y / N, i = y * N + x;
    const brush = vnoise(u * 4, v * 128, seed, 128) * 0.5 + vnoise(u * 8, v * 256, seed + 1, 256) * 0.5;   // streaks along u
    const blot = fbm(u, v, seed + 2, 5, 3);
    const edge = Math.min(u, 1 - u, v, 1 - v);
    const scuff = smooth(0.55, 0.8, blot) * 0.5 + (1 - smooth(0, 0.06, edge)) * 0.25;   // dark scuffs, worn edges
    const base = 0.3 + 0.06 * brush - scuff * 0.14 + scr[i] * 0.04;
    const tint = smooth(0.6, 0.9, fbm(u, v, seed + 7, 2, 2));                        // faint blue/straw heat tint
    const ch = (m: number) => Math.round(Math.pow(clamp01(base * m), 1 / 2.2) * 255);
    albedo[i * 4] = ch(1 - tint * 0.08); albedo[i * 4 + 1] = ch(1 - tint * 0.04); albedo[i * 4 + 2] = ch(1 + tint * 0.06); albedo[i * 4 + 3] = 255;
    mr[i * 4] = 255; mr[i * 4 + 1] = clamp01(0.42 + 0.1 * brush + scuff * 0.25 - scr[i] * 0.06) * 255; mr[i * 4 + 2] = 255; mr[i * 4 + 3] = 255;
    height[i] = brush * 0.12 - scr[i] * 0.12 - smooth(0.7, 0.9, blot) * 0.25;
  }
  const L = { albedo, mr, normal: normalFromHeight(height, 1.6) };
  cache.set(key, L);
  return L;
}

/** Tyre rubber with a block tread: cylinder side UV u runs round the tyre, v across its width. */
function rubberLayers(): Layers {
  const hit = cache.get('rubber'); if (hit) return hit;
  const albedo = new Uint8Array(N * N * 4), mr = new Uint8Array(N * N * 4), height = new Float32Array(N * N);
  const BLOCKS = 20;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const u = x / N, v = y / N, i = y * N + x;
    const side = v < 0.5 ? 0.25 : -0.25;                                          // chevron offset per half
    const t = (u * BLOCKS + side + Math.abs(v - 0.5) * 0.8) % 1;
    const groove = 1 - smooth(0.0, 0.06, Math.min(t, 1 - t) - 0.08);             // 1 in a groove
    const centre = 1 - smooth(0.02, 0.04, Math.abs(v - 0.5));
    const g = Math.max(groove, centre);
    const n = fbm(u, v, 77, 8, 2);
    const dust = 0.05 + 0.03 * n + (1 - g) * 0.03;
    const val = Math.round(Math.pow(dust, 1 / 2.2) * 255);
    albedo[i * 4] = val; albedo[i * 4 + 1] = val; albedo[i * 4 + 2] = val; albedo[i * 4 + 3] = 255;
    mr[i * 4] = 255; mr[i * 4 + 1] = (0.78 + 0.15 * n) * 255; mr[i * 4 + 2] = 0; mr[i * 4 + 3] = 255;
    height[i] = 1 - g + n * 0.1;
  }
  const L = { albedo, mr, normal: normalFromHeight(height, 4) };
  cache.set('rubber', L);
  return L;
}

function tex(scene: Scene, data: Uint8Array, name: string, linear: boolean): Texture {
  const t = RawTexture.CreateRGBATexture(data, N, N, scene, true, false, Texture.TRILINEAR_SAMPLINGMODE);
  t.name = name;
  t.gammaSpace = !linear;
  t.anisotropicFilteringLevel = 4;
  return t;
}

function pbr(scene: Scene, name: string, L: Layers | null, opts: { albedo?: Color3; metallic?: number; roughness?: number; bump?: number } = {}): PBRMaterial {
  const m = new PBRMaterial(name, scene);
  m.usePhysicalLightFalloff = false;              // keep the existing (StandardMaterial-tuned) light intensities
  m.emissiveColor = new Color3(0, 0, 0);          // fx.ts damage flash drives this
  if (realtime) m.realTimeFiltering = true;
  if (L) {
    m.albedoTexture = tex(scene, L.albedo, `${name}_albedo`, false);
    m.metallicTexture = tex(scene, L.mr, `${name}_mr`, true);
    m.useRoughnessFromMetallicTextureAlpha = false;
    m.useRoughnessFromMetallicTextureGreen = true;
    m.useMetallnessFromMetallicTextureBlue = true;
    m.metallic = 1; m.roughness = 1;               // multipliers on the texture
    m.bumpTexture = tex(scene, L.normal, `${name}_normal`, true);
    m.bumpTexture.level = opts.bump ?? 1;
  } else {
    m.albedoColor = opts.albedo ?? new Color3(0.6, 0.6, 0.6);
    m.metallic = opts.metallic ?? 1;
    m.roughness = opts.roughness ?? 0.4;
  }
  return m;
}

export interface BotMats {
  paint: PBRMaterial;    // chassis / shell, owner's colour
  dark: PBRMaterial;     // armour, motors: black paint chipped to bare metal
  steel: PBRMaterial;    // weapons, wedges: hardened steel
  rubber: PBRMaterial;   // tyres, belts
  bolt: PBRMaterial;     // zinc-plated fasteners, hubs
  chrome: PBRMaterial;   // hydraulic rods
  can: PBRMaterial;      // motor cans: black anodised
}

/** One material set per bot (disposed with the bot). Pixel data is cached, so this is cheap to rebuild. */
export function botMaterials(scene: Scene, id: string, paintHex: string): BotMats {
  return {
    paint: pbr(scene, `paint${id}`, paintedLayers(paintHex, 11)),
    dark: pbr(scene, `dark${id}`, paintedLayers('#1d1f23', 11)),   // same wear pattern as the paint (computed once)
    steel: pbr(scene, `steel${id}`, steelLayers(5)),
    rubber: pbr(scene, `rubber${id}`, rubberLayers(), { bump: 0.8 }),
    bolt: pbr(scene, `bolt${id}`, null, { albedo: new Color3(0.55, 0.56, 0.58), metallic: 1, roughness: 0.35 }),
    chrome: pbr(scene, `chrome${id}`, null, { albedo: new Color3(0.9, 0.9, 0.92), metallic: 1, roughness: 0.08 }),
    can: pbr(scene, `can${id}`, null, { albedo: new Color3(0.06, 0.065, 0.07), metallic: 0.7, roughness: 0.32 }),
  };
}

// ---------- environment (what metal reflects) ----------
/** A generated "arena at night" cube: dark surroundings, bright overhead light rigs, a warm crowd band
 *  at the horizon and a dim floor. Prefiltered once so rough metal gets a blurred reflection. */
export function applyEnvironment(scene: Scene, intensity = 0.7) {
  const S = 64;
  const faces: Uint8Array[] = [];
  // face order +X -X +Y -Y +Z -Z ; direction for pixel (a,b) in [-1,1]
  const dirOf = (f: number, a: number, b: number): [number, number, number] => {
    switch (f) {
      case 0: return [1, -b, -a]; case 1: return [-1, -b, a];
      case 2: return [a, 1, b];   case 3: return [a, -1, -b];
      case 4: return [a, -b, 1];  default: return [-a, -b, -1];
    }
  };
  for (let f = 0; f < 6; f++) {
    const d = new Uint8Array(S * S * 4);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const [dx, dy, dz] = dirOf(f, (x + 0.5) / S * 2 - 1, (y + 0.5) / S * 2 - 1);
      const l = Math.hypot(dx, dy, dz), ny = dy / l, nx = dx / l, nz = dz / l;
      let r = 0.05, g = 0.055, b = 0.065;                                        // dark arena
      if (ny > 0) {                                                              // overhead: light rig strips
        const strip = (Math.abs((nx * 3.0) % 1) < 0.18 || Math.abs((nz * 3.0) % 1) < 0.18) && ny > 0.55 ? 1 : 0;
        const k = 0.12 * ny + strip * 0.95 * Math.pow(ny, 2);
        r += k; g += k; b += k * 1.05;
      } else {                                                                   // floor: dim steel grey
        const k = 0.1 * -ny; r += k; g += k; b += k;
      }
      const band = Math.exp(-Math.pow(ny / 0.12, 2));                           // warm crowd / sign band at the horizon
      r += band * 0.22; g += band * 0.14; b += band * 0.08;
      const i = (y * S + x) * 4;
      d[i] = Math.min(255, Math.pow(r, 1 / 2.2) * 255); d[i + 1] = Math.min(255, Math.pow(g, 1 / 2.2) * 255);
      d[i + 2] = Math.min(255, Math.pow(b, 1 / 2.2) * 255); d[i + 3] = 255;
    }
    faces.push(d);
  }
  const env = new RawCubeTexture(scene, faces, S, Constants.TEXTUREFORMAT_RGBA, Constants.TEXTURETYPE_UNSIGNED_BYTE, true, false, Constants.TEXTURE_TRILINEAR_SAMPLINGMODE);
  env.gammaSpace = true;
  scene.environmentTexture = env;
  scene.environmentIntensity = intensity;
  try {
    const eng = scene.getEngine();
    if ((eng as any)._features?.allowTexturePrefiltering) {
      new HDRFiltering(eng, { hdrScale: 1 }).prefilter(env).catch(() => useRealtimeFiltering(scene));
    } else useRealtimeFiltering(scene);
  } catch { useRealtimeFiltering(scene); }
  return env;
}
let realtime = false;
function useRealtimeFiltering(scene: Scene) {
  realtime = true;
  for (const m of scene.materials) if (m instanceof PBRMaterial) m.realTimeFiltering = true;
}

// ---------- shadows ----------
export function makeShadows(light: DirectionalLight, size = 2048): ShadowGenerator {
  // depth range pinned round the arena (the light sits ~22 m out); bias is a fraction of this range
  light.shadowMinZ = 1;
  light.shadowMaxZ = 45;
  const sg = new ShadowGenerator(size, light);
  sg.usePercentageCloserFiltering = true;
  sg.filteringQuality = ShadowGenerator.QUALITY_MEDIUM;
  sg.bias = 0.0004;
  sg.normalBias = 0.01;
  return sg;
}

export function castShadows(sg: ShadowGenerator, meshes: AbstractMesh[]) {
  for (const m of meshes) if (m.getTotalVertices() > 0) sg.addShadowCaster(m, false);
}
