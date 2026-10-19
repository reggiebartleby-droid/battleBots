/**
 * v0.44 CUBE OVAL (user 2026-10-19: the Oval Speedway rebuilt as a daytime cube world; replaces raceway.ts on the Oval).
 * Plan: design/cube-oval-build-plan.md (Project). Style: STYLE-cube.md (3 cube tiers, no dead cubes).
 *
 * The static world is baked ahead of time by scripts/bake-oval.mjs into public/tracks/oval.cubes: only cube faces that
 * touch open air, same-colour faces merged into big rectangles, the seam texture repeating once per cube, per-cube
 * wear done in the shader. Here we only load it, split into 32 m chunks (off-screen chunks are skipped), and draw it:
 * one material, no shadows cast by scenery (bots only), kept out of the glow layer.
 *
 * Live: crowd (instanced cube people: stadium wave + cheering when bots go by), helicopter rotor, blimp, clouds,
 * start lights, jumbotron (LED pixels, live standings). Track cubes are cosmetic: bots drive on race.ts's smooth
 * colliders, which the cube column tops sit on.
 *
 * Phones: half the crowd, fewer clouds, far chunks hidden. If the file can't be loaded, the old raceway.ts scenery
 * and the race.ts track look are used instead.
 */
import {
  Color3, DynamicTexture, GlowLayer, MaterialDefines, MaterialPluginBase, Mesh, MeshBuilder, Scene, StandardMaterial,
  Texture, Vector3, VertexData,
} from '@babylonjs/core';
import type { Race } from './race.js';
import { Raceway } from './raceway.js';
import { MOBILE } from './mobile.js';

const FILE = 'tracks/oval.cubes';
const FAR_CHUNK = 85;          // phones: chunks further than this from the camera are hidden (m)
const CROWD_HZ_MS = 24;        // crowd matrices: at most ~40 updates a second

interface Section { name: string; offset: number; count: number; cx?: number; cz?: number }
interface Header {
  v: number; tiers: { L: number; M: number; S: number }; palette: [number, number, number][]; sections: Section[];
  crowd: [number, number, number, number, number, number, number, number][];
  bounds: { x0: number; x1: number; z0: number; z1: number };
  rotor: [number, number, number]; pods: number[];
  screen: { x: number; y: number; w: number; h: number; z0: number; z1: number; nx: number; ny: number };
  counts: { L: number; M: number; S: number };
}

/** Per-cube brightness wear (STYLE-cube.md: brightness only, most cubes near full). The cube is found from the
 *  UV (one repeat of the seam texture = one cube) and the face's plane, so merged faces still vary cube by cube. */
class CubeWear extends MaterialPluginBase {
  constructor(material: StandardMaterial) {
    super(material, 'CubeWear', 200, { CUBEWEAR: false });
    this._enable(true);
  }
  prepareDefines(defines: MaterialDefines) { defines['CUBEWEAR'] = true; }
  getClassName() { return 'CubeWearPlugin'; }
  getCustomCode(shaderType: string): { [pointName: string]: string } | null {
    if (shaderType !== 'fragment') return null;
    return {
      CUSTOM_FRAGMENT_UPDATE_DIFFUSE: `
#if defined(CUBEWEAR) && defined(DIFFUSE) && defined(NORMAL)
{
  vec2 cuW = floor(vDiffuseUV + 0.001);
  float plW = floor(dot(vPositionW, normalize(vNormalW)) * 4.17 + 0.5);
  float hW = fract(sin(dot(vec3(cuW, plW), vec3(12.9898, 78.233, 37.719))) * 43758.5453);
  diffuseColor *= 1.0 - 0.16 * pow(hW, 2.5);
}
#endif
`,
    };
  }
}

/** 5x7 pixel font for the jumbotron (uppercase, digits, a few signs). */
const FONT: Record<string, string> = {
  A: '01110100011000111111100011000110001', B: '11110100011000111110100011000111110', C: '01110100011000010000100001000101110',
  D: '11110100011000110001100011000111110', E: '11111100001000011110100001000011111', F: '11111100001000011110100001000010000',
  G: '01110100011000010111100011000101111', H: '10001100011000111111100011000110001', I: '01110001000010000100001000010001110',
  J: '00111000100001000010000101001001100', K: '10001100101010011000101001001010001', L: '10000100001000010000100001000011111',
  M: '10001110111010110101100011000110001', N: '10001100011100110101100111000110001', O: '01110100011000110001100011000101110',
  P: '11110100011000111110100001000010000', Q: '01110100011000110001101011001001101', R: '11110100011000111110101001001010001',
  S: '01111100001000001110000010000111110', T: '11111001000010000100001000010000100', U: '10001100011000110001100011000101110',
  V: '10001100011000110001100010101000100', W: '10001100011000110101101011010101010', X: '10001100010101000100010101000110001',
  Y: '10001100010101000100001000010000100', Z: '11111000010001000100010001000011111',
  '0': '01110100011001110101110011000101110', '1': '00100011000010000100001000010001110', '2': '01110100010000100010001000100011111',
  '3': '11110000010000101110000010000111110', '4': '00010001100101010010111110001000010', '5': '11111100001111000001000011000101110',
  '6': '00110010001000011110100011000101110', '7': '11111000010001000100010000100001000', '8': '01110100011000101110100011000101110',
  '9': '01110100011000101111000010001001100', '/': '00001000010001000100010001000010000', '-': '00000000000000011111000000000000000',
  '!': '00100001000010000100001000000000100', '.': '00000000000000000000000000000000100', ' ': '00000000000000000000000000000000000',
};

export class CubeOval {
  private meshes: Mesh[] = [];
  private chunks: { m: Mesh; x: number; z: number }[] = [];
  private visible = false;
  private loaded = false;
  private fallback: Raceway | null = null;
  private O: Vector3;
  private t = 0;
  private animAt = 0;
  private farAt = 0;
  // live parts
  private crowd: { x: number; y: number; z: number; ph: number; grp: number }[] = [];
  private crowdBuf: Float32Array | null = null;
  private crowdParts: Mesh[] = [];
  private rotor: Mesh | null = null;
  private blimp: Mesh | null = null;
  private clouds: Mesh[] = [];
  private pods: Mesh | null = null;
  private podState = '';
  private screen: { tex: DynamicTexture; at: number; text: string; nx: number; ny: number } | null = null;

  constructor(private scene: Scene, private race: Race) {
    this.O = race.origin.clone();
    // ?oldoval=1: the old v0.35b Oval look, for comparing frame rates (SETTINGS > PERF READOUT)
    const old = new URLSearchParams(location.search).get('oldoval') === '1';
    (old ? Promise.reject(new Error('?oldoval=1')) : this.load()).catch(err => {
      console.warn('[cube oval] could not load the baked world, using the old Oval look', err);
      this.fallback = new Raceway(scene, race);
      this.fallback.setVisible(this.visible);
    });
  }

  setVisible(on: boolean) {
    this.visible = on;
    if (this.fallback) { this.fallback.setVisible(on); return; }
    for (const m of this.meshes) m.setEnabled(on);
    if (on) this.farAt = 0;
  }

  update(dt: number, go: boolean) {
    if (this.fallback) { this.fallback.update(dt, go); return; }
    if (!this.loaded) return;
    this.t += dt;
    const t = this.t, now = performance.now();
    if (this.rotor) this.rotor.rotation.y += dt * 9;
    if (this.blimp) {
      const a = t * 0.04;
      this.blimp.position.set(this.O.x + Math.cos(a) * 58, this.O.y + 30, this.O.z + 16 + Math.sin(a) * 44);
      this.blimp.rotation.y = Math.atan2(-Math.cos(a), -Math.sin(a));   // nose (+x) along the circle
    }
    for (const c of this.clouds) { c.position.x += dt * 1.2; if (c.position.x - this.O.x > 200) c.position.x -= 400; }
    this.updatePods(go);
    this.drawScreen(go);
    if (MOBILE && now - this.farAt > 500) {   // phones: hide far chunks
      this.farAt = now;
      const cam = this.scene.activeCamera?.globalPosition;
      if (cam) for (const c of this.chunks) c.m.setEnabled(this.visible && Math.hypot(cam.x - c.x, cam.z - c.z) < FAR_CHUNK);
    }
    if (now - this.animAt < CROWD_HZ_MS) return;
    this.animAt = now;
    this.animateCrowd(t);
  }

  // ------------------------------------------------------------------------------------------------ load + build
  private async load() {
    const res = await fetch(import.meta.env.BASE_URL + FILE);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    let buf = await res.arrayBuffer();
    const head = new Uint8Array(buf, 0, 2);
    if (head[0] === 0x1f && head[1] === 0x8b) {   // gzipped (the file on disk always is; a server may already have unzipped it)
      if (typeof DecompressionStream === 'undefined') throw new Error('no DecompressionStream');
      buf = await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
    }
    const dv = new DataView(buf);
    if (String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3)) !== 'CUBE') throw new Error('not a cube file');
    const hl = dv.getUint32(4, true);
    const H = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, hl))) as Header;
    this.build(H, dv, 8 + hl);
    this.loaded = true;
    this.race.hideTrackLook();   // the cube world draws the track, walls, kerbs and lines now
    for (const m of this.meshes) m.setEnabled(this.visible);
  }

  private build(H: Header, dv: DataView, base: number) {
    const sc = this.scene;
    const seam = this.seamTexture();
    const lit = (name: string, wear: boolean) => {
      const m = new StandardMaterial('co_' + name, sc);
      m.diffuseTexture = seam; m.diffuseColor = Color3.White();
      m.specularColor = new Color3(0.14, 0.14, 0.14); m.specularPower = 48;
      if (wear) new CubeWear(m);
      return m;
    };
    const unlit = (name: string, tex: Texture) => {
      const m = new StandardMaterial('co_' + name, sc);
      m.disableLighting = true; m.diffuseColor = Color3.Black(); m.emissiveColor = Color3.White(); m.diffuseTexture = tex;
      return m;
    };
    const worldMat = lit('world', true), propMat = lit('props', false), lampMat = unlit('lamps', seam);
    const sizes = [H.tiers.L, H.tiers.M, H.tiers.S];
    const sec = (name: string) => H.sections.find(s => s.name === name)!;

    // the world, in chunks
    for (const s of H.sections) {
      if (s.name !== 'chunk') continue;
      const m = this.mesh('co_chunk', dv, base, s, sizes, H.palette, true);
      m.material = worldMat; m.position.copyFrom(this.O);
      m.receiveShadows = true; m.freezeWorldMatrix(); m.doNotSyncBoundingInfo = true;
      this.keep(m);
      this.chunks.push({ m, x: this.O.x + s.cx!, z: this.O.z + s.cz! });
    }
    this.buildSky(H);

    // helicopter rotor, blimp, clouds
    const rotor = this.mesh('co_rotor', dv, base, sec('rotor'), sizes, H.palette, true);
    rotor.material = propMat; rotor.position = this.O.add(new Vector3(...H.rotor)); this.keep(rotor); this.rotor = rotor;
    const blimp = this.mesh('co_blimp', dv, base, sec('blimp'), sizes, H.palette, true);
    blimp.material = propMat; this.keep(blimp); this.blimp = blimp;
    let seed = 5;
    const R = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    const cloudSrc = [0, 1, 2].map(n => this.mesh('co_cloud' + n, dv, base, sec('cloud' + n), sizes, H.palette, true));
    cloudSrc.forEach(m => { m.material = propMat; m.isPickable = false; m.setEnabled(false); });   // templates only (never shown)
    for (let n = 0; n < (MOBILE ? 6 : 11); n++) {
      const c = cloudSrc[n % 3].clone('co_cloud', null)!;
      c.position.set(this.O.x - 180 + R() * 360, this.O.y + 38 + R() * 14, this.O.z - 80 + R() * 200);
      this.keep(c); this.clouds.push(c);
    }

    // start lights: 5 pods (thin instances, colour per pod)
    const pods = this.mesh('co_pods', dv, base, sec('pod'), sizes, H.palette, false);
    pods.material = lampMat; pods.position.copyFrom(this.O);
    const pm = new Float32Array(H.pods.length * 16), pc = new Float32Array(H.pods.length * 4);
    H.pods.forEach((z, n) => { pm.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, z, 1], n * 16); pc.set([0.16, 0.04, 0.04, 1], n * 4); });
    pods.thinInstanceSetBuffer('matrix', pm, 16, true);
    pods.thinInstanceSetBuffer('color', pc, 4, false);
    pods.alwaysSelectAsActiveMesh = true;
    this.keep(pods); this.pods = pods;

    // jumbotron: LED pixels on both faces
    const S = H.screen, px = 11;
    const tex = new DynamicTexture('co_screen', { width: 1024, height: 512 }, sc, true, Texture.TRILINEAR_SAMPLINGMODE);
    tex.uScale = (S.nx * px) / 1024; tex.vScale = (S.ny * px) / 512; tex.vOffset = 1 - tex.vScale;
    tex.anisotropicFilteringLevel = 8;
    const scrMat = unlit('screen', tex);
    for (const face of [0, 1]) {
      const p = MeshBuilder.CreatePlane('co_screen', { width: S.w, height: S.h }, sc);
      p.material = scrMat;
      p.position = this.O.add(new Vector3(S.x, S.y, face ? S.z1 : S.z0));
      if (face) p.rotation.y = Math.PI;
      p.freezeWorldMatrix(); this.keep(p);
    }
    this.screen = { tex, at: -1e9, text: '', nx: S.nx, ny: S.ny };

    // crowd: 4 part meshes (pants, shirt, skin, hair) x thin instances, one shared matrix buffer
    const people = H.crowd.filter((_, i) => !MOBILE || i % 2 === 0);
    this.crowd = people.map(p => ({ x: p[0], y: p[1], z: p[2], ph: p[3], grp: p[2] < 16 ? 0 : 1 }));
    const mbuf = new Float32Array(people.length * 16);
    people.forEach((p, i) => mbuf.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, this.O.x + p[0], this.O.y + p[1], this.O.z + p[2], 1], i * 16));
    this.crowdBuf = mbuf;
    ['pants', 'shirt', 'skin', 'hair'].forEach((part, pi) => {
      const m = this.mesh('co_person_' + part, dv, base, sec('person_' + part), sizes, H.palette, false);
      m.material = propMat;
      const col = new Float32Array(people.length * 4);
      people.forEach((p, i) => { const c = H.palette[p[4 + pi]]; col.set([c[0], c[1], c[2], 1], i * 4); });
      m.thinInstanceSetBuffer('matrix', mbuf, 16, false);
      m.thinInstanceSetBuffer('color', col, 4, true);
      m.alwaysSelectAsActiveMesh = true;
      this.keep(m); this.crowdParts.push(m);
    });

    // far fields round the cube world
    const b = H.bounds, far = new StandardMaterial('co_far', sc);
    far.diffuseColor = Color3.FromHexString('#4a8338'); far.specularColor = Color3.Black();
    for (const [x0, x1, z0, z1] of [[-600, 600, -600, b.z0], [-600, 600, b.z1, 600], [-600, b.x0, b.z0, b.z1], [b.x1, 600, b.z0, b.z1]]) {
      const g = MeshBuilder.CreateGround('co_far', { width: x1 - x0, height: z1 - z0 }, sc);
      g.position = this.O.add(new Vector3((x0 + x1) / 2, -0.01, (z0 + z1) / 2));
      g.material = far; g.freezeWorldMatrix(); this.keep(g);
    }
    for (const m of this.meshes) m.setEnabled(false);
    console.info(`[cube oval] ${H.counts.L + H.counts.M + H.counts.S} cubes baked into ${H.sections.filter(s => s.name === 'chunk').reduce((n, s) => n + s.count, 0) * 2} triangles · crowd ${people.length}`);
  }

  private keep(m: Mesh) {
    m.isPickable = false;
    for (const l of this.scene.effectLayers) if (l instanceof GlowLayer) l.addExcludedMesh(m);   // scenery stays out of the glow pass
    this.meshes.push(m);
    return m;
  }

  /** Quads -> one mesh. Record: kind (d*2 + facing +), tier, colour, plane, u0, u1, v0, v1, vOff (axes u = d+1, v = d+2). */
  private mesh(name: string, dv: DataView, base: number, s: Section, sizes: number[], pal: [number, number, number][], colours: boolean) {
    const n = s.count, pos = new Float32Array(n * 12), nor = new Float32Array(n * 12), uv = new Float32Array(n * 8);
    const col = colours ? new Float32Array(n * 16) : null, ind = new Uint32Array(n * 6);
    const P = [0, 0, 0], N = [0, 0, 0];
    for (let q = 0; q < n; q++) {
      const o = base + (s.offset + q) * 28;
      const kind = dv.getUint8(o), tier = dv.getUint8(o + 1), ci = dv.getUint16(o + 2, true);
      const plane = dv.getFloat32(o + 4, true), u0 = dv.getFloat32(o + 8, true), u1 = dv.getFloat32(o + 12, true);
      const v0 = dv.getFloat32(o + 16, true), v1 = dv.getFloat32(o + 20, true), vOff = dv.getFloat32(o + 24, true);
      const d = kind >> 1, sgn = kind & 1 ? 1 : -1, ua = (d + 1) % 3, va = (d + 2) % 3, sz = sizes[tier];
      N[0] = N[1] = N[2] = 0; N[d] = sgn;
      const corners = sgn > 0 ? [[u0, v0], [u0, v1], [u1, v1], [u1, v0]] : [[u0, v0], [u1, v0], [u1, v1], [u0, v1]];   // Babylon front faces (left-handed)
      for (let c = 0; c < 4; c++) {
        P[d] = plane; P[ua] = corners[c][0]; P[va] = corners[c][1];
        const vi = q * 4 + c;
        pos[vi * 3] = P[0]; pos[vi * 3 + 1] = P[1]; pos[vi * 3 + 2] = P[2];
        nor[vi * 3] = N[0]; nor[vi * 3 + 1] = N[1]; nor[vi * 3 + 2] = N[2];
        // one seam-texture repeat per cube: tops (x, z), x-faces (z, y), z-faces (x, y); off-grid columns line up from their top
        if (d === 1) { uv[vi * 2] = P[0] / sz; uv[vi * 2 + 1] = P[2] / sz; }
        else if (d === 0) { uv[vi * 2] = P[2] / sz; uv[vi * 2 + 1] = (P[1] - vOff) / sz; }
        else { uv[vi * 2] = P[0] / sz; uv[vi * 2 + 1] = (P[1] - vOff) / sz; }
        if (col) { const c3 = pal[ci]; col[vi * 4] = c3[0]; col[vi * 4 + 1] = c3[1]; col[vi * 4 + 2] = c3[2]; col[vi * 4 + 3] = 1; }
      }
      const v = q * 4;
      ind.set([v, v + 1, v + 2, v, v + 2, v + 3], q * 6);
    }
    const vd = new VertexData();
    vd.positions = pos; vd.normals = nor; vd.uvs = uv; vd.indices = ind;
    if (col) vd.colors = col;
    const m = new Mesh(name, this.scene);
    vd.applyToMesh(m, false);
    if (col) m.hasVertexAlpha = false;
    return m;
  }

  /** STYLE-cube.md section 3: 64 x 64 lit-pixel face (dark seam, bevel, inner squares). */
  private seamTexture() {
    const tex = new DynamicTexture('co_seam', { width: 64, height: 64 }, this.scene, true, Texture.TRILINEAR_SAMPLINGMODE);
    const g = tex.getContext() as unknown as CanvasRenderingContext2D;
    g.fillStyle = '#5c5c5c'; g.fillRect(0, 0, 64, 64);
    g.fillStyle = '#ffffff'; g.fillRect(5, 5, 54, 54);
    g.fillStyle = '#c9c9c9'; g.fillRect(5, 54, 54, 5); g.fillRect(54, 5, 5, 54);
    g.fillStyle = '#ffffff'; g.fillRect(5, 5, 54, 4); g.fillRect(5, 5, 4, 49);
    g.fillStyle = '#ececec'; g.fillRect(18, 18, 28, 28);
    g.fillStyle = '#f7f7f7'; g.fillRect(22, 22, 20, 20);
    tex.update(true);
    tex.wrapU = Texture.WRAP_ADDRESSMODE; tex.wrapV = Texture.WRAP_ADDRESSMODE;
    tex.anisotropicFilteringLevel = 8;
    return tex;
  }

  private buildSky(H: Header) {
    void H;
    const [topHex, horHex] = this.race.def.theme.sky ?? ['#3f86d6', '#d6ebf7'];
    const top = Color3.FromHexString(topHex), hor = Color3.FromHexString(horHex);
    const sky = MeshBuilder.CreateSphere('co_sky', { diameter: 900, segments: 24, sideOrientation: Mesh.BACKSIDE }, this.scene);
    const pos = sky.getVerticesData('position')!, cols: number[] = [];
    for (let i = 0; i < pos.length; i += 3) {
      const k = Math.max(0, Math.min(1, pos[i + 1] / 450 * 1.8)), c = Color3.Lerp(hor, top, Math.pow(k, 0.7));
      cols.push(c.r, c.g, c.b, 1);
    }
    sky.setVerticesData('color', cols);
    const m = new StandardMaterial('co_skymat', this.scene);
    m.disableLighting = true; m.diffuseColor = Color3.Black(); m.emissiveColor = Color3.White(); m.specularColor = Color3.Black();
    sky.material = m; sky.infiniteDistance = true; sky.applyFog = false;
    this.keep(sky);
  }

  // ------------------------------------------------------------------------------------------------ per frame
  private animateCrowd(t: number) {
    const buf = this.crowdBuf; if (!buf) return;
    const ox = this.O.x, oz = this.O.z;
    const bots = this.race.racers.filter(r => !r.down).map(r => ({ x: r.bot.root.position.x - ox, z: r.bot.root.position.z - oz }));
    const trackZ = [0, 32];
    this.crowd.forEach((p, i) => {
      let jump = 0.22 * Math.pow(Math.max(0, Math.sin(t * 2.4 - p.ph)), 8);   // the stadium wave
      let e = 0;
      for (const b of bots) if (Math.abs(b.z - trackZ[p.grp]) < 12) e = Math.max(e, Math.exp(-((p.x - b.x) ** 2) / 30));
      if (e > 0.02) jump = Math.max(jump, e * 0.18 * Math.max(0, Math.sin(t * 8 + p.ph * 3)));
      buf[i * 16 + 13] = this.O.y + p.y + jump;
    });
    for (const m of this.crowdParts) m.thinInstanceBufferUpdated('matrix');
  }

  /** Red until GO, green for 3 s, then off. */
  private updatePods(go: boolean) {
    if (!this.pods) return;
    const st = !go ? 'red' : this.race.t < 3 ? 'green' : 'off';
    if (st === this.podState) return;
    this.podState = st;
    const c = st === 'red' ? [1.8, 0.16, 0.16] : st === 'green' ? [0.4, 1.9, 0.3] : [0.16, 0.04, 0.04];
    const n = this.pods.thinInstanceCount, col = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) col.set([c[0], c[1], c[2], 1], i * 4);
    this.pods.thinInstanceSetBuffer('color', col, 4, false);
  }

  /** Jumbotron: lap + top three in LED pixels, redrawn twice a second when it changes. */
  private drawScreen(go: boolean) {
    const S = this.screen; if (!S) return;
    const now = performance.now();
    if (now - S.at < 500) return;
    S.at = now;
    const race = this.race, st = race.standings(), lead = st[0];
    const head = !go ? 'GET READY' : lead?.finished !== undefined ? 'FINISH!' : `LAP ${lead ? race.lap(lead) : 1}/${race.laps}`;
    const lines = [{ t: head, c: '#4dd2ff', y: 1 }, ...st.slice(0, 3).map((r, n) => ({ t: `${n + 1} ${r.name.toUpperCase()}`.slice(0, 15), c: r.paint, y: 9 + n * 8 }))];
    const text = lines.map(l => l.t + l.c).join('|');
    if (text === S.text) return;
    S.text = text;
    const px = 11, lit = new Map<number, string>();
    for (const l of lines) [...l.t].forEach((ch, n) => {
      const g = FONT[ch] ?? FONT[' '];
      for (let r = 0; r < 7; r++) for (let c = 0; c < 5; c++) if (g[r * 5 + c] === '1') {
        const X = 1 + n * 6 + c, Y = l.y + r;
        if (X < S.nx && Y < S.ny) lit.set(Y * S.nx + X, l.c);
      }
    });
    const g = S.tex.getContext() as unknown as CanvasRenderingContext2D;
    g.fillStyle = '#05070c'; g.fillRect(0, 0, 1024, 512);
    for (let y = 0; y < S.ny; y++) for (let x = 0; x < S.nx; x++) {
      g.fillStyle = lit.get(y * S.nx + x) ?? '#141821';
      g.fillRect(x * px + 1, y * px + 1, px - 2, px - 2);
    }
    S.tex.update(true);
  }
}

