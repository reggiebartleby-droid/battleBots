/**
 * v0.45 baked cube world loader for the 3D tracks (Stunt Park, Rally Dirt). Same file format, seam texture and
 * per-cube wear shader as the cube Oval (cubeoval.ts, left as it is). The track modules (stuntpark.ts, dinolava.ts)
 * extend this with their own live parts.
 *
 * Loaded once per page in the background; until it's there (or if it fails), race.ts's own plain track look shows.
 */
import {
  Color3, DynamicTexture, GlowLayer, MaterialDefines, MaterialPluginBase, Mesh, MeshBuilder, Scene, StandardMaterial,
  Texture, Vector3, VertexData,
} from '@babylonjs/core';
import type { Race } from './race.js';
import { MOBILE } from './mobile.js';

const FAR_CHUNK = 85;
export interface Section { name: string; offset: number; count: number; cx?: number; cz?: number }
export interface CubeHeader {
  v: number; tiers: { L: number; M: number; S: number }; palette: [number, number, number][]; sections: Section[];
  crowd: [number, number, number, number, number, number, number, number][];
  bounds: { x0: number; x1: number; z0: number; z1: number };
  counts: { L: number; M: number; S: number };
  pods?: number[]; podX?: number; far?: string;
  [k: string]: unknown;
}

class CubeWear extends MaterialPluginBase {
  constructor(material: StandardMaterial) { super(material, 'CubeWear2', 200, { CUBEWEAR2: false }); this._enable(true); }
  prepareDefines(defines: MaterialDefines) { defines['CUBEWEAR2'] = true; }
  getClassName() { return 'CubeWear2Plugin'; }
  getCustomCode(shaderType: string): { [pointName: string]: string } | null {
    if (shaderType !== 'fragment') return null;
    return {
      CUSTOM_FRAGMENT_UPDATE_DIFFUSE: `
#if defined(CUBEWEAR2) && defined(DIFFUSE) && defined(NORMAL)
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

export abstract class CubeWorld {
  protected meshes: Mesh[] = [];
  protected chunks: { m: Mesh; x: number; z: number }[] = [];
  protected visible = false;
  protected loaded = false;
  protected O: Vector3;
  protected t = 0;
  protected H!: CubeHeader;
  private dv!: DataView;
  private base = 0;
  private farAt = 0;
  private animAt = 0;
  protected propMat!: StandardMaterial;
  protected lampMat!: StandardMaterial;
  protected worldMat!: StandardMaterial;
  private crowd: { x: number; y: number; z: number; ph: number }[] = [];
  private crowdBuf: Float32Array | null = null;
  private crowdParts: Mesh[] = [];
  private pods: Mesh | null = null;
  private podState = '';

  private loading: Promise<void> | null = null;
  constructor(protected scene: Scene, protected race: Race, private file: string) {
    this.O = race.origin.clone();
    // v0.45 loaded when first needed (phones: only then); on a PC also quietly in the background a few seconds after
    // the page opens, so picking the track later doesn't wait for it
    if (!MOBILE) setTimeout(() => this.preload(), 6000 + Math.random() * 4000);
  }
  /** start loading the baked world (once) */
  preload() {
    this.loading ??= this.load(this.file).catch(err => console.warn(`[cube world] could not load ${this.file}, using the plain track look`, err));
    return this.loading;
  }

  setVisible(on: boolean) {
    this.visible = on;
    if (on) this.preload();
    for (const m of this.meshes) m.setEnabled(on && !m.metadata?.template);
    if (on) this.farAt = 0;
  }

  update(dt: number, go: boolean) {
    if (!this.loaded) return;
    this.t += dt;
    const now = performance.now();
    this.updatePods(go);
    if (MOBILE && now - this.farAt > 500) {
      this.farAt = now;
      const cam = this.scene.activeCamera?.globalPosition;
      if (cam) for (const c of this.chunks) c.m.setEnabled(this.visible && Math.hypot(cam.x - c.x, cam.z - c.z) < FAR_CHUNK);
    }
    if (now - this.animAt >= 24) { this.animAt = now; this.animateCrowd(this.t); }
    this.live(dt, go);
  }
  /** per frame: the track's own live parts */
  protected abstract live(dt: number, go: boolean): void;
  /** after loading: build the track's own live parts from the header + object sections */
  protected abstract built(): void;

  private async load(file: string) {
    const res = await fetch(import.meta.env.BASE_URL + file);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    let buf = await res.arrayBuffer();
    const head = new Uint8Array(buf, 0, 2);
    if (head[0] === 0x1f && head[1] === 0x8b) {
      if (typeof DecompressionStream === 'undefined') throw new Error('no DecompressionStream');
      buf = await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
    }
    const dv = new DataView(buf);
    if (String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3)) !== 'CUBE') throw new Error('not a cube file');
    const hl = dv.getUint32(4, true);
    this.H = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, hl))) as CubeHeader;
    this.dv = dv; this.base = 8 + hl;
    this.buildBase();
    this.built();
    this.loaded = true;
    this.race.hideTrackLook();
    for (const m of this.meshes) m.setEnabled(this.visible && !m.metadata?.template);
  }

  private buildBase() {
    const sc = this.scene, H = this.H;
    const seam = this.seamTexture();
    const lit = (name: string, wear: boolean) => {
      const m = new StandardMaterial('cw_' + name, sc);
      m.diffuseTexture = seam; m.diffuseColor = Color3.White();
      m.specularColor = new Color3(0.12, 0.12, 0.12); m.specularPower = 48;
      if (wear) new CubeWear(m);
      return m;
    };
    this.worldMat = lit('world', true); this.propMat = lit('props', false);
    const lamp = new StandardMaterial('cw_lamps', sc);
    lamp.disableLighting = true; lamp.diffuseColor = Color3.Black(); lamp.emissiveColor = Color3.White(); lamp.diffuseTexture = seam;
    this.lampMat = lamp;
    for (const s of H.sections) {
      if (s.name !== 'chunk') continue;
      const m = this.sectionMesh('cw_chunk', s, true);
      m.material = this.worldMat; m.position.copyFrom(this.O);
      m.receiveShadows = true; m.freezeWorldMatrix(); m.doNotSyncBoundingInfo = true;
      this.keep(m);
      this.chunks.push({ m, x: this.O.x + s.cx!, z: this.O.z + s.cz! });
    }
    this.buildSky();
    // far ground round the baked area
    const b = H.bounds, far = new StandardMaterial('cw_far', sc);
    far.diffuseColor = Color3.FromHexString(H.far ?? '#3a2a20'); far.specularColor = Color3.Black();
    for (const [x0, x1, z0, z1] of [[-600, 600, -600, b.z0], [-600, 600, b.z1, 600], [-600, b.x0, b.z0, b.z1], [b.x1, 600, b.z0, b.z1]]) {
      const g = MeshBuilder.CreateGround('cw_far', { width: x1 - x0, height: z1 - z0 }, sc);
      g.position = this.O.add(new Vector3((x0 + x1) / 2, this.farY(), (z0 + z1) / 2));
      g.material = far; g.freezeWorldMatrix(); this.keep(g);
    }
    // crowd
    if (H.crowd.length && H.sections.some(s => s.name === 'person_shirt')) {
      const people = H.crowd.filter((_, i) => !MOBILE || i % 2 === 0);
      this.crowd = people.map(p => ({ x: p[0], y: p[1], z: p[2], ph: p[3] }));
      const mbuf = new Float32Array(people.length * 16);
      people.forEach((p, i) => mbuf.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, this.O.x + p[0], this.O.y + p[1], this.O.z + p[2], 1], i * 16));
      this.crowdBuf = mbuf;
      ['pants', 'shirt', 'skin', 'hair'].forEach((part, pi) => {
        const m = this.object('person_' + part, false);
        m.material = this.propMat;
        const col = new Float32Array(people.length * 4);
        people.forEach((p, i) => { const c = H.palette[p[4 + pi]]; col.set([c[0], c[1], c[2], 1], i * 4); });
        m.thinInstanceSetBuffer('matrix', mbuf, 16, false);
        m.thinInstanceSetBuffer('color', col, 4, true);
        m.alwaysSelectAsActiveMesh = true;
        this.crowdParts.push(m);
      });
    }
    // start lights
    if (H.pods && H.sections.some(s => s.name === 'pod')) {
      const pods = this.object('pod', false);
      pods.material = this.lampMat; pods.position.copyFrom(this.O);
      const pm = new Float32Array(H.pods.length * 16), pc = new Float32Array(H.pods.length * 4);
      H.pods.forEach((z, n) => { pm.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, H.podX ?? 0, 0, z, 1], n * 16); pc.set([0.16, 0.04, 0.04, 1], n * 4); });
      pods.thinInstanceSetBuffer('matrix', pm, 16, true);
      pods.thinInstanceSetBuffer('color', pc, 4, false);
      pods.alwaysSelectAsActiveMesh = true;
      this.pods = pods;
    }
    console.info(`[cube world ${this.race.def.id}] ${H.counts.L + H.counts.M + H.counts.S} cubes baked into ${H.sections.filter(s => s.name === 'chunk').reduce((n, s) => n + s.count, 0) * 2} triangles · crowd ${this.crowd.length}`);
  }
  /** height of the far ground planes (local) */
  protected farY() { return -0.02; }

  /** A named object section as its own mesh (kept, hidden until the track shows). colours: vertex colours on. */
  protected object(name: string, colours = true): Mesh {
    const s = this.H.sections.find(x => x.name === name);
    if (!s) throw new Error('no section ' + name);
    const m = this.sectionMesh('cw_' + name, s, colours);
    m.material = this.propMat;
    return this.keep(m);
  }
  /** a template mesh for clones / instances: never shown itself */
  protected template(name: string, colours = true): Mesh {
    const m = this.object(name, colours);
    m.metadata = { template: true }; m.setEnabled(false);
    return m;
  }

  protected keep(m: Mesh) {
    m.isPickable = false;
    for (const l of this.scene.effectLayers) if (l instanceof GlowLayer) l.addExcludedMesh(m);
    this.meshes.push(m);
    return m;
  }

  private sectionMesh(name: string, s: Section, colours: boolean) {
    const dv = this.dv, base = this.base, pal = this.H.palette, sizes = [this.H.tiers.L, this.H.tiers.M, this.H.tiers.S];
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
      const corners = sgn > 0 ? [[u0, v0], [u0, v1], [u1, v1], [u1, v0]] : [[u0, v0], [u1, v0], [u1, v1], [u0, v1]];
      for (let c = 0; c < 4; c++) {
        P[d] = plane; P[ua] = corners[c][0]; P[va] = corners[c][1];
        const vi = q * 4 + c;
        pos[vi * 3] = P[0]; pos[vi * 3 + 1] = P[1]; pos[vi * 3 + 2] = P[2];
        nor[vi * 3] = N[0]; nor[vi * 3 + 1] = N[1]; nor[vi * 3 + 2] = N[2];
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

  private seamTexture() {
    const tex = new DynamicTexture('cw_seam', { width: 64, height: 64 }, this.scene, true, Texture.TRILINEAR_SAMPLINGMODE);
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

  private buildSky() {
    const [topHex, horHex] = this.race.def.theme.sky ?? ['#3f86d6', '#d6ebf7'];
    const top = Color3.FromHexString(topHex), hor = Color3.FromHexString(horHex);
    const sky = MeshBuilder.CreateSphere('cw_sky', { diameter: 900, segments: 24, sideOrientation: Mesh.BACKSIDE }, this.scene);
    const pos = sky.getVerticesData('position')!, cols: number[] = [];
    for (let i = 0; i < pos.length; i += 3) {
      const k = Math.max(0, Math.min(1, pos[i + 1] / 450 * 1.8)), c = Color3.Lerp(hor, top, Math.pow(k, 0.7));
      cols.push(c.r, c.g, c.b, 1);
    }
    sky.setVerticesData('color', cols);
    const m = new StandardMaterial('cw_skymat', this.scene);
    m.disableLighting = true; m.diffuseColor = Color3.Black(); m.emissiveColor = Color3.White(); m.specularColor = Color3.Black();
    sky.material = m; sky.infiniteDistance = true; sky.applyFog = false;
    this.keep(sky);
  }

  private animateCrowd(t: number) {
    const buf = this.crowdBuf; if (!buf) return;
    const ox = this.O.x, oz = this.O.z;
    const bots = this.race.racers.filter(r => !r.down).map(r => ({ x: r.bot.root.position.x - ox, z: r.bot.root.position.z - oz }));
    this.crowd.forEach((p, i) => {
      let jump = 0.2 * Math.pow(Math.max(0, Math.sin(t * 2.2 - p.ph)), 8);
      let e = 0;
      for (const b of bots) { const d2 = (p.x - b.x) ** 2 + (p.z - b.z) ** 2; if (d2 < 400) e = Math.max(e, Math.exp(-d2 / 60)); }
      if (e > 0.02) jump = Math.max(jump, e * 0.18 * Math.max(0, Math.sin(t * 8 + p.ph * 3)));
      buf[i * 16 + 13] = this.O.y + p.y + jump;
    });
    for (const m of this.crowdParts) m.thinInstanceBufferUpdated('matrix');
  }

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
}

/** Instanced cubes (puffs, sparks, lava blobs): one template, a matrix + colour per instance, rebuilt each frame. */
export class CubeSwarm {
  private mats: Float32Array;
  private cols: Float32Array;
  n = 0;
  /** unit: the template cube's size (m) -- add()'s s is then the cube size in metres */
  constructor(public mesh: Mesh, private max: number, private unit = 1) {
    this.mats = new Float32Array(max * 16); this.cols = new Float32Array(max * 4);
    mesh.thinInstanceSetBuffer('matrix', this.mats, 16, false);
    mesh.thinInstanceSetBuffer('color', this.cols, 4, false);
    mesh.thinInstanceCount = 0;
    mesh.alwaysSelectAsActiveMesh = true;
  }
  begin() { this.n = 0; }
  add(x: number, y: number, z: number, s: number, r: number, g: number, b: number, rotY = 0) {
    if (this.n >= this.max) return;
    const k = s / this.unit, c = Math.cos(rotY) * k, si = Math.sin(rotY) * k, o = this.n * 16;
    this.mats.set([c, 0, -si, 0, 0, s, 0, 0, si, 0, c, 0, x, y, z, 1], o);
    this.cols.set([r, g, b, 1], this.n * 4);
    this.n++;
  }
  end() {
    this.mesh.thinInstanceCount = this.n;
    this.mesh.thinInstanceBufferUpdated('matrix');
    this.mesh.thinInstanceBufferUpdated('color');
  }
}
