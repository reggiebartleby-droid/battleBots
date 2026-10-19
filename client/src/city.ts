/**
 * v0.36 NIGHT CITY scenery for the Grand Prix (user: rain, night, neon signs, streetlights, slippery wet patches; extras:
 * neon billboards + skyline, crowd on balconies / rooftops with umbrellas, background traffic, lightning + thunder).
 * Visual only, apart from the wet-patch spray -- the grip itself is in race.ts (wetAt / beforePhysics), the tunnel
 * roof collider too.
 *
 *   ground      wet asphalt city floor, sidewalks + curbs along the track, a ring road with lane lines, crosswalks,
 *               avenues, manholes with steam
 *   track       puddles on the wet patches (glossy, shimmering), neon reflections, streetlights with light pools,
 *               lantern strings over the road, police cars + barricades at the hazard alley, chevron boards
 *   tunnel      over the start straight (dry inside): walls, lamps, portals with neon, jumbotron above the west portal
 *   overpass    elevated highway crossing the hairpin end, pillars, traffic on it
 *   buildings   near ring (shops, balconies, rooftop crowds, neon signs), mid + far skyline (lit windows, antennas
 *               with blinking lights, water towers, rooftop neon)
 *   crowd       cube people (umbrellas) on sidewalks, balconies and rooftops -- cheer when bots go by
 *   traffic     cube cars with head / tail lights on the ring road, the overpass and the avenues
 *   sky         night dome with city glow, low clouds, lightning bolts + flash + thunder, searchlight helicopter
 *               that follows the leader
 *   rain        streaks round the camera (none in the tunnel), splashes, spray behind the bots on the wet
 *
 * Local coordinates as race.ts: start straight along +x at z = 0 (finish at x = 0), the loop runs anticlockwise
 * seen from above (+z side is inside).
 */
import {
  Color3, Constants, DynamicTexture, GlowLayer, Matrix, Mesh, MeshBuilder, Quaternion, Scene, StandardMaterial, Texture, Vector3, Vector4,
} from '@babylonjs/core';
import { CITY_TUNNEL, type Race, type Sample } from './race.js';
import { forward } from './bot.js';

function rng(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const hex = (h: string) => Color3.FromHexString(h);

const SHIRTS = ['#ff2bd6', '#4dd2ff', '#39ff14', '#ffc400', '#ff6a1f', '#b88cff', '#f2f2f2', '#ff3b3b', '#1f6bff', '#00e5c0', '#2a2d36', '#3b2a4a'];
const PANTS = ['#1d2a4a', '#222428', '#3b3b44', '#5a4a32', '#2b3d2b', '#141418'];
const SKIN = ['#f1c27d', '#e0ac69', '#c68642', '#8d5524', '#ffdbac', '#5c3a21'];
const BRELLA = ['#ff2bd6', '#4dd2ff', '#ffc400', '#39ff14', '#ff3b3b', '#f2f2f2', '#1a1a1a', '#b88cff', '#ff9f1c', '#1f6bff'];
const CARS = ['#c9ccd2', '#1a1c22', '#8a1c1c', '#1d3f8a', '#e8e8e8', '#3a3f48', '#5a1f6a', '#0f5a4a'];
const NEON = ['#ff2bd6', '#4dd2ff', '#39ff14', '#ffc400', '#ff6a1f', '#b88cff', '#ff3b5c', '#00e5c0'];
const SIGNS = ['ROBOT REVOLUTION', 'VOLT COLA', 'NEON NOODLE', 'CUBE BAR', 'HOTEL 24', 'GEAR & BOLT', 'PIXEL ARCADE', 'SUSHI BOT',
  'KARAOKE', 'SPARK PLUG', 'NITRO', 'RAMEN', 'LIVE RACING', 'BOLT BANK', 'OIL & ICE', 'CHROME CLUB', 'ARCADE', 'OPEN 24H'];
const BLADES = ['HOTEL', 'BAR', 'RAMEN', 'CLUB', 'TAXI', 'GAMES', 'OPEN', 'NOODLE'];

interface Person { x: number; y: number; z: number; yaw: number; s: number; ph: number; hype: number; brella: number; reach: number }
interface Part { mesh: Mesh; buf: Float32Array; col: Float32Array }
interface Car { path: number; d: number; speed: number }
interface Path { pts: Vector3[]; len: number[]; total: number; loop: boolean }
interface Occluder { min: Vector3; max: Vector3; meshes: Mesh[]; vis: number }

export class NightCity {
  private meshes: Mesh[] = [];
  private mats: Record<string, StandardMaterial> = {};
  private groups: Record<string, Mesh[]> = {};
  private R = rng(20261036);
  private O: Vector3;
  private half: number;
  private t = 0;
  private animAt = 0;
  /** lightning flash 0..1 (race.flash -> main.ts lights) */
  flash = 0;
  // animated
  private people: Person[] = [];
  private crowd!: { legs: Part; torso: Part; head: Part; armL: Part; armR: Part; stick: Part; brella: Part };
  private rain!: { part: Part; ox: Float32Array; oz: Float32Array; y: Float32Array; v: Float32Array; ax: number; az: number };
  private splash!: { part: Part; age: Float32Array; x: Float32Array; z: Float32Array; y: Float32Array };
  private spray!: { part: Part; age: Float32Array; p: Float32Array; v: Float32Array; next: number; carry: number[] };
  private steam!: { part: Part; age: Float32Array; vent: Int16Array; vents: Vector3[] };
  private cars: Car[] = [];
  private paths: Path[] = [];
  private carParts!: { body: Part; cabin: Part; head: Part; tail: Part; beam: Part };
  private police: { bar: Mesh[]; ph: number }[] = [];
  private blinkers: Mesh[] = [];        // red aircraft lights (merged), on / off
  private amber: Mesh[] = [];           // barricade blinkers
  private flicker: { m: Mesh; ph: number; rate: number }[] = [];
  private puddleMat!: StandardMaterial;
  private bolts: Mesh[] = [];
  private boltOn = -1;
  private nextBolt = 6;
  private flashT = -9;
  private cloudMat!: StandardMaterial;
  private heli!: { root: Mesh; rotor: Mesh; beam: Mesh; pool: Mesh; light: Mesh; aim: Vector3 };
  private startLights: Mesh[] = [];
  private screen!: { tex: DynamicTexture; at: number; text: string };
  private occluders: Occluder[] = [];
  private trafficLights: { r: Mesh; g: Mesh; ph: number }[] = [];
  private audio: AudioContext | null = null;
  private visible = false;

  constructor(private scene: Scene, private race: Race) {
    this.O = race.origin; this.half = race.width / 2;
    this.makeMats();
    this.buildGround();
    this.buildTrackDetail();
    this.buildStreetlights();
    this.buildTunnel();
    this.buildOverpass();
    this.buildInfield();
    this.buildBuildings();
    this.buildSidewalkCrowd();
    this.buildSky();
    this.buildStartLights();
    for (const [key, list] of Object.entries(this.groups)) this.merge(list, key);
    this.groups = {};
    this.buildCrowdMeshes();
    this.buildTraffic();
    this.buildRain();
    this.animate(0, false);
  }

  setVisible(on: boolean) { this.visible = on; for (const m of this.meshes) m.setEnabled(on); }

  // ------------------------------------------------------------------------------------------- helpers
  private L(x: number, y: number, z: number) { return new Vector3(this.O.x + x, this.O.y + y, this.O.z + z); }
  private at(p: Sample, u: number, y = 0) { return this.L(p.x - Math.sin(p.h) * u, y, p.z + Math.cos(p.h) * u); }
  private mat(key: string, h: string, e = 0, o: { unlit?: boolean; alpha?: number; spec?: number; add?: boolean } = {}) {
    const m = new StandardMaterial('nc_' + key, this.scene);
    const c = hex(h);
    if (o.unlit) { m.disableLighting = true; m.emissiveColor = c; m.diffuseColor = Color3.Black(); }
    else { m.diffuseColor = c; m.emissiveColor = c.scale(e); m.specularColor = new Color3(1, 1, 1).scale(o.spec ?? 0.15); }
    if (o.alpha !== undefined) m.alpha = o.alpha;
    if (o.add) {   // additive glow with a soft round falloff
      m.alphaMode = Constants.ALPHA_ADD; m.disableDepthWrite = true; m.backFaceCulling = false;
      m.emissiveTexture = this.softTex(c.scale(o.alpha ?? 1)); m.emissiveColor = Color3.Black(); m.alpha = 1;
    }
    this.mats[key] = m;
    return m;
  }
  /** radial colour-to-black gradient (soft light pools). NB: a StandardMaterial ADDS emissiveColor to its
   *  emissiveTexture, so textured materials here keep emissiveColor black and the colour lives in the texture. */
  private softTex(c: Color3) {
    const tex = new DynamicTexture('nc_soft', { width: 128, height: 128 }, this.scene, true);
    const ctx = tex.getContext() as unknown as CanvasRenderingContext2D;
    const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    const css = (k: number) => `rgb(${Math.round(Math.min(1, c.r) * 255 * k)},${Math.round(Math.min(1, c.g) * 255 * k)},${Math.round(Math.min(1, c.b) * 255 * k)})`;
    g.addColorStop(0, css(1)); g.addColorStop(0.35, css(0.6)); g.addColorStop(1, '#000000');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 128, 128);
    tex.update();
    return tex;
  }
  private makeMats() {
    const M = (k: string, h: string, e = 0, o: { unlit?: boolean; alpha?: number; spec?: number; add?: boolean } = {}) => this.mat(k, h, e, o);
    M('asphalt', '#0e1014', 0, { spec: 0.45 }); this.mats.asphalt.specularPower = 140;
    M('sidewalk', '#2a2d34', 0, { spec: 0.3 }); this.mats.sidewalk.specularPower = 90; M('curb', '#6a6f78', 0, { spec: 0.3 }); M('concrete', '#4a4f58'); M('concreteDark', '#2b2f36');
    M('laneW', '#cfd3da', 0.25); M('laneY', '#ffc400', 0.45); M('cross', '#d8dce2', 0.2);
    M('steel', '#8d969e', 0, { spec: 0.5 }); M('darkSteel', '#2c3138', 0, { spec: 0.4 }); M('black', '#0a0a0c');
    M('sodium', '#ffb35c', 1, { unlit: true }); M('white', '#f4f4ff', 1, { unlit: true });
    {   // shop windows: warm lit interior, mullions, shelves + a few silhouettes
      const tex = new DynamicTexture('nc_shop', { width: 512, height: 128 }, this.scene, true);
      const ctx = tex.getContext() as unknown as CanvasRenderingContext2D;
      const g = ctx.createLinearGradient(0, 0, 0, 128); g.addColorStop(0, '#ffd7a0'); g.addColorStop(1, '#a8673a');
      ctx.fillStyle = g; ctx.fillRect(0, 0, 512, 128);
      ctx.fillStyle = '#3a2416';
      for (let y = 40; y < 128; y += 34) ctx.fillRect(0, y, 512, 5);                           // shelves
      const R = rng(77);
      for (let i = 0; i < 9; i++) { const x = R() * 500; ctx.fillRect(x, 50 + R() * 20, 14, 78); ctx.fillRect(x + 1, 38 + R() * 15, 12, 14); }   // people
      ctx.fillStyle = '#141018';
      for (let x = 0; x <= 512; x += 128) ctx.fillRect(x - 4, 0, 8, 128);                     // mullions
      ctx.fillRect(0, 0, 512, 6);
      tex.update();
      const m = new StandardMaterial('nc_warmWin', this.scene);
      m.disableLighting = true; m.diffuseColor = Color3.Black(); m.emissiveTexture = tex; m.emissiveColor = Color3.Black(); tex.level = 0.85;
      this.mats.warmWin = m;
    }
    M('pool', '#ffc070', 0, { unlit: true, alpha: 0.36, add: true }); M('poolCyan', '#4dd2ff', 0, { unlit: true, alpha: 0.4, add: true });
    M('refl', '#ffffff', 0, { unlit: true, alpha: 0.35, add: true });
    M('reflPink', '#ff2bd6', 0, { unlit: true, alpha: 0.6, add: true }); M('reflCyan', '#4dd2ff', 0, { unlit: true, alpha: 0.6, add: true });
    M('red', '#ff2a2a', 1, { unlit: true }); M('blue', '#2a6bff', 1, { unlit: true }); M('amber', '#ffae00', 1, { unlit: true }); M('amberOff', '#3a2600');
    M('redOff', '#2a0606'); M('green', '#39ff14', 1, { unlit: true }); M('greenOff', '#062a06');
    M('lampOff', '#2a0b0b'); M('glass', '#2a4a66', 0.2, { alpha: 0.55, spec: 0.9 });
    M('tunnel', '#3a3f48', 0, { spec: 0.25 }); M('tunnelTile', '#c9ced6', 0.12, { spec: 0.6 }); M('tile', '#7b818a', 0.05);
    M('violet', '#7a4fc0', 0.4); M('chevY', '#ffc400', 0.7); M('chevB', '#111111'); M('barrier', '#e8e8e8', 0.1); M('barrierR', '#d92b2b', 0.25);
    M('police', '#f2f2f2', 0.05, { spec: 0.6 }); M('policeB', '#101828', 0, { spec: 0.6 });
    M('water', '#7fa0b8', 0, { spec: 0.6 }); M('wood', '#5a4430'); M('roofTop', '#1c1f26');
    M('cloud', '#1c1428', 0, { unlit: true, alpha: 0.96 });
    M('bolt', '#dfe8ff', 1, { unlit: true }); M('blink', '#ff2a2a', 1, { unlit: true });
    M('tire', '#141414', 0, { spec: 0.05 });
    for (const c of NEON) M('neon' + c, c, 1, { unlit: true });
    this.cloudMat = this.mats.cloud;
    // puddles: almost black, very glossy, faint purple sheen (shimmers in animate)
    const pm = M('puddle', '#0b1020', 0, { spec: 1, alpha: 0.92 });
    pm.specularPower = 70; pm.emissiveColor = hex('#2a2050'); pm.backFaceCulling = false;
    this.puddleMat = pm;
    // building windows: two tiled window textures (warm + cool), walls tinted by vertex colour
    for (const [k, seed, warm] of [['bldA', 11, true], ['bldB', 23, false]] as const) {
      const tex = new DynamicTexture('nc_win_' + k, { width: 512, height: 512 }, this.scene, true);
      const ctx = tex.getContext() as unknown as CanvasRenderingContext2D;
      const R = rng(seed);
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 512, 512);
      for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) {
        const lit = R() < 0.55;
        const pal = warm ? ['#ffd9a0', '#ffcf86', '#ffe9c4', '#ffb070'] : ['#bfe4ff', '#d8f0ff', '#9fd0ff', '#e8e8ff'];
        let c = lit ? pal[Math.floor(R() * pal.length)] : '#0c111b';
        if (lit && R() < 0.06) c = NEON[Math.floor(R() * NEON.length)];
        ctx.fillStyle = c;
        const x = i * 64, y = j * 64;
        if (R() < 0.25) { ctx.fillRect(x + 10, y + 14, 44, 36); }               // one big window
        else { ctx.fillRect(x + 8, y + 14, 21, 36); ctx.fillRect(x + 35, y + 14, 21, 36); }
        if (lit && R() < 0.3) { ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(x + 8, y + 14 + R() * 20, 48, 6); }   // blinds
      }
      tex.update();
      tex.wrapU = Texture.WRAP_ADDRESSMODE; tex.wrapV = Texture.WRAP_ADDRESSMODE;
      const m = new StandardMaterial('nc_' + k, this.scene);
      // NB the standard shader multiplies emissive by the vertex colour too: walls are dark by diffuseColor, the
      // per-building vertex tint stays light so the windows stay bright
      m.diffuseColor = new Color3(0.13, 0.13, 0.16); m.specularColor = new Color3(0.08, 0.08, 0.1);
      m.emissiveTexture = tex; m.emissiveColor = Color3.Black(); tex.level = 0.9;
      this.mats[k] = m;
    }
  }
  private add(key: string, m: Mesh) { (this.groups[key] ??= []).push(m); return m; }
  private box(key: string, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number) {
    const b = MeshBuilder.CreateBox('nc', { width: Math.max(0.005, Math.abs(x1 - x0)), height: Math.max(0.005, Math.abs(y1 - y0)), depth: Math.max(0.005, Math.abs(z1 - z0)) }, this.scene);
    b.position = this.L((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    return this.add(key, b);
  }
  private boxC(key: string, x: number, y: number, z: number, w: number, h: number, d: number, rotY = 0) {
    const b = MeshBuilder.CreateBox('nc', { width: w, height: h, depth: d }, this.scene);
    b.position = this.L(x, y, z); b.rotation.y = rotY;
    return this.add(key, b);
  }
  private cyl(key: string, x: number, y: number, z: number, diam: number, h: number, tess = 10, top?: number) {
    const c = MeshBuilder.CreateCylinder('nc', { diameter: diam, diameterTop: top ?? diam, height: h, tessellation: tess }, this.scene);
    c.position = this.L(x, y, z);
    return this.add(key, c);
  }
  private barW(key: string, a: Vector3, b: Vector3, t: number, h = t) {
    const d = Vector3.Distance(a, b);
    if (d < 1e-3) return;
    const m = MeshBuilder.CreateBox('nc', { width: t, height: h, depth: d }, this.scene);
    m.position = a.add(b).scale(0.5);
    m.lookAt(b);
    this.add(key, m);
  }
  private bar(key: string, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, t: number, h = t) {
    this.barW(key, this.L(x0, y0, z0), this.L(x1, y1, z1), t, h);
  }
  private keep(m: Mesh) { m.isPickable = false; this.meshes.push(m); return m; }
  /** key = material, or "occN|material" for meshes that fade out when they hide the player (occluder N). */
  private merge(list: Mesh[], key: string) {
    if (!list.length) return;
    const [occ, matKey] = key.includes('|') ? key.split('|') : ['', key];
    const hasCol = list.some(m => m.isVerticesDataPresent('color'));
    for (let i = 0; i < list.length; i += 1500) {
      const chunk = list.slice(i, i + 1500);
      if (hasCol) for (const m of chunk) if (!m.isVerticesDataPresent('color')) this.tint(m, Color3.White());
      const m = Mesh.MergeMeshes(chunk, true, true, undefined, false, false);
      if (!m) continue;
      m.name = 'nc_' + key; m.material = this.mats[matKey];
      m.freezeWorldMatrix();
      this.keep(m);
      if (occ) this.occluders[Number(occ.slice(3))].meshes.push(m);
      if (matKey === 'blink') this.blinkers.push(m);
    }
  }
  private tint(m: Mesh, c: Color3) {
    const n = m.getTotalVertices(), cols = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) cols.set([c.r, c.g, c.b, 1], i * 4);
    m.setVerticesData('color', cols);
  }
  private noGlow(m: Mesh) { for (const l of this.scene.effectLayers) if (l instanceof GlowLayer) l.addExcludedMesh(m); }
  private occluder(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number) {
    this.occluders.push({ min: this.L(Math.min(x0, x1), y0, Math.min(z0, z1)), max: this.L(Math.max(x0, x1), y1, Math.max(z0, z1)), meshes: [], vis: 1 });
    return 'occ' + (this.occluders.length - 1) + '|';
  }
  /** Distance from the track centre line (local x, z), coarse. */
  private trackDist(x: number, z: number) {
    let d = Infinity;
    const S = this.race.samples;
    for (let i = 0; i < S.length; i += 2) { const p = S[i]; const dd = (p.x - x) ** 2 + (p.z - z) ** 2; if (dd < d) d = dd; }
    return Math.sqrt(d);
  }
  /** Track distance at sample i to the nearest OTHER part of the track (|s| more than 20 m away along the lap). */
  private otherDist(p: Sample, u: number) {
    const S = this.race.samples, L = this.race.length;
    const n = { x: -Math.sin(p.h), z: Math.cos(p.h) }, x = p.x + n.x * u, z = p.z + n.z * u;
    let d = Infinity;
    for (let i = 0; i < S.length; i += 2) {
      const q = S[i];
      let ds = Math.abs(q.s - p.s); ds = Math.min(ds, L - ds);
      if (ds < 20) continue;
      const dd = (q.x - x) ** 2 + (q.z - z) ** 2; if (dd < d) d = dd;
    }
    return Math.sqrt(d);
  }
  private inTunnel(x: number, z: number) { const T = CITY_TUNNEL; return x > T.x0 - 0.3 && x < T.x1 + 0.3 && Math.abs(z) < T.halfW + 0.6; }
  /** a text sign texture (neon on black) */
  private signTex(text: string, colour: string, w = 512, h = 128, vertical = false) {
    const tex = new DynamicTexture('nc_sign', { width: w, height: h }, this.scene, true);
    const ctx = tex.getContext() as unknown as CanvasRenderingContext2D;
    ctx.fillStyle = '#05040a'; ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = colour; ctx.lineWidth = Math.max(4, h * 0.05); ctx.strokeRect(ctx.lineWidth, ctx.lineWidth, w - ctx.lineWidth * 2, h - ctx.lineWidth * 2);
    ctx.fillStyle = colour; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.shadowColor = colour; ctx.shadowBlur = 12;
    if (vertical) {
      const ch = text.split(''), step = (h - 30) / ch.length;
      ctx.font = `bold ${Math.floor(Math.min(w * 0.7, step * 0.85))}px system-ui, sans-serif`;
      ch.forEach((c, i) => ctx.fillText(c, w / 2, 15 + step * (i + 0.5)));
    } else {
      let size = h * 0.62;
      ctx.font = `bold ${size}px system-ui, sans-serif`;
      while (ctx.measureText(text).width > w * 0.88 && size > 10) { size -= 2; ctx.font = `bold ${size}px system-ui, sans-serif`; }
      ctx.fillText(text, w / 2, h / 2 + 2);
    }
    tex.update();
    return tex;
  }
  /** A neon sign board facing yaw (0 = facing -z ... same convention as plane rotation.y). */
  private sign(text: string, colour: string, x: number, y: number, z: number, w: number, h: number, yaw: number, vertical = false, flick = false) {
    const p = MeshBuilder.CreatePlane('nc_signp', { width: w, height: h, sideOrientation: Mesh.DOUBLESIDE }, this.scene);
    p.position = this.L(x, y, z); p.rotation.y = yaw;
    const m = new StandardMaterial('nc_signm', this.scene);
    m.disableLighting = true; m.diffuseColor = Color3.Black();
    m.emissiveTexture = this.signTex(text, colour, vertical ? 128 : 512, vertical ? 512 : 128, vertical); m.emissiveColor = Color3.Black(); m.specularColor = Color3.Black();
    p.material = m; this.keep(p);
    if (flick) this.flicker.push({ m: p, ph: this.R() * 10, rate: 0.5 + this.R() * 2 });
    return p;
  }

  // ------------------------------------------------------------------------------------------- ground + streets
  private buildGround() {
    const g = MeshBuilder.CreateGround('nc_ground', { width: 700, height: 700, subdivisions: 2 }, this.scene);
    g.position = this.L(10, -0.04, 10); g.material = this.mats.asphalt; g.receiveShadows = true;
    this.keep(g);
    // ring road round the track: 8 m wide, two lanes, sidewalks both sides
    const RX0 = -36, RX1 = 54, RZ0 = -16, RZ1 = 36, RW = 4;
    const ring = [[RX0, RZ0], [RX1, RZ0], [RX1, RZ1], [RX0, RZ1]] as const;
    for (let k = 0; k < 4; k++) {
      const [x0, z0] = ring[k], [x1, z1] = ring[(k + 1) % 4];
      const horiz = z0 === z1;
      // centre dashes (yellow double), edge lines
      const len = horiz ? Math.abs(x1 - x0) : Math.abs(z1 - z0);
      for (const off of [-0.12, 0.12]) {
        if (horiz) this.box('laneY', Math.min(x0, x1) + RW, Math.max(x0, x1) - RW, 0.005, 0.012, z0 + off - 0.05, z0 + off + 0.05);
        else this.box('laneY', x0 + off - 0.05, x0 + off + 0.05, 0.005, 0.012, Math.min(z0, z1) + RW, Math.max(z0, z1) - RW);
      }
      void len;
      // outer sidewalks (the track side has its own sidewalks + the band)
      for (const side of [-1, 1]) {
        const o = side * (RW + 1.6);
        if (horiz) { this.box('sidewalk', Math.min(x0, x1) - RW - 3.2, Math.max(x0, x1) + RW + 3.2, 0, 0.15, z0 + o - 1.6, z0 + o + 1.6); this.box('curb', Math.min(x0, x1) - RW - 3.2, Math.max(x0, x1) + RW + 3.2, 0, 0.17, z0 + side * RW - 0.1, z0 + side * RW + 0.1); }
        else { this.box('sidewalk', x0 + o - 1.6, x0 + o + 1.6, 0, 0.15, Math.min(z0, z1) - RW - 3.2, Math.max(z0, z1) + RW + 3.2); this.box('curb', x0 + side * RW - 0.1, x0 + side * RW + 0.1, 0, 0.17, Math.min(z0, z1) - RW - 3.2, Math.max(z0, z1) + RW + 3.2); }
      }
    }
    // crosswalks + traffic lights at the four corners
    for (const [cx, cz] of ring) {
      for (let i = -3; i <= 3; i++) {
        this.box('cross', cx + i * 1.1 - 0.35, cx + i * 1.1 + 0.35, 0.005, 0.013, cz + (cz < 10 ? 5 : -5) - 1.2, cz + (cz < 10 ? 5 : -5) + 1.2);
        this.box('cross', cx + (cx < 10 ? 5 : -5) - 1.2, cx + (cx < 10 ? 5 : -5) + 1.2, 0.005, 0.013, cz + i * 1.1 - 0.35, cz + i * 1.1 + 0.35);
      }
      const px = cx + (cx < 10 ? -RW - 1 : RW + 1), pz = cz + (cz < 10 ? -RW - 1 : RW + 1);
      this.cyl('darkSteel', px, 2.2, pz, 0.16, 4.4, 8);
      this.box('black', px - 0.22, px + 0.22, 3.6, 4.6, pz - 0.18, pz + 0.18);
      const r = MeshBuilder.CreateBox('nc_tl', { width: 0.3, height: 0.26, depth: 0.42 }, this.scene); r.position = this.L(px, 4.35, pz);
      const gr = MeshBuilder.CreateBox('nc_tl', { width: 0.3, height: 0.26, depth: 0.42 }, this.scene); gr.position = this.L(px, 3.85, pz);
      this.keep(r); this.keep(gr);
      this.trafficLights.push({ r, g: gr, ph: this.R() * 10 });
    }
    // avenues further out: lane lines
    for (const x of [-70, 98]) for (let z = -200; z < 200; z += 6) this.box('laneW', x - 0.07, x + 0.07, 0.005, 0.012, z, z + 3);
    for (const z of [-54, 86]) for (let x = -200; x < 200; x += 6) this.box('laneW', x, x + 3, 0.005, 0.012, z - 0.07, z + 0.07);
    // manholes with steam (steam puffs are thin instances, buildRain)
    const vents = [[-30, -10], [48, 30], [20, -12], [-30, 30], [52, 0], [5, 30]].map(([x, z]) => this.L(x, 0, z));
    for (const v of vents) { const m = this.cyl('darkSteel', v.x - this.O.x, 0.01, v.z - this.O.z, 0.9, 0.02, 14); void m; }
    this.steam = { part: null as unknown as Part, age: new Float32Array(0), vent: new Int16Array(0), vents };
  }

  // ------------------------------------------------------------------------------------------- track detail
  private buildTrackDetail() {
    const race = this.race, S = race.samples, n = S.length, half = this.half;
    const sy = (p: Sample, u: number) => race.surfaceY(p, u);
    const isJump = (p: Sample) => p.tag === 'jump' && p.q > 2.5 && p.q < 18.5;
    // sidewalks + curbs outside both walls (not where another part of the track is close, not on the jump decks)
    for (let i = 0; i < n; i += 2) {
      const a = S[i], b = S[(i + 2) % n];
      for (const side of [1, -1]) {
        const u0 = side * (half + 0.35), u1 = side * (half + 3.2);
        if (this.otherDist(a, (u0 + u1) / 2) < half + 2.0) continue;
        const ya = 0;
        const A0 = this.at(a, u0, ya), A1 = this.at(a, u1, ya), B0 = this.at(b, u0, ya), B1 = this.at(b, u1, ya);
        const rib = MeshBuilder.CreateRibbon('nc', { pathArray: side > 0 ? [[A1, B1], [A0, B0]] : [[A0, B0], [A1, B1]] }, this.scene);
        rib.position.y = 0.12;
        this.add('sidewalk', rib);
        this.barW('curb', this.at(a, u1, 0.08), this.at(b, u1, 0.08), 0.2, 0.18);
      }
      // centre line on the flat (dashed) + road edge reflections are separate
      if (a.tag !== 'bank' && !isJump(a) && Math.floor(a.s / 2) % 2 === 0) this.barW('laneW', this.at(a, 0, sy(a, 0) + 0.011), this.at(b, 0, sy(b, 0) + 0.011), 0.1, 0.004);
    }
    // wet patches: glossy puddles with ragged edges + neon reflections on them
    for (const pt of race.def.wet?.patches ?? []) {
      const ps = S.filter(p => p.s >= pt.s0 && p.s <= pt.s1);
      if (ps.length < 2) continue;
      const paths: Vector3[][] = [];
      for (let j = 0; j < 5; j++) {
        const k = j / 4;
        paths.push(ps.map((p, i) => {
          const edge = Math.sin((i / ps.length) * Math.PI);   // round ends
          const wob = 1 + 0.18 * Math.sin(i * 1.7 + j * 2.3);
          const u = pt.u + (k - 0.5) * pt.w * (0.35 + 0.65 * edge) * wob;
          return this.at(p, u, sy(p, u) + 0.016);
        }));
      }
      const rib = MeshBuilder.CreateRibbon('nc_puddle', { pathArray: paths }, this.scene);
      rib.material = this.puddleMat; this.keep(rib); rib.receiveShadows = true;
      // reflection streaks (coloured, along the road)
      for (let k = 0; k < 9; k++) {
        const p = ps[Math.floor(this.R() * ps.length)], q = ps[Math.min(ps.length - 1, ps.indexOf(p) + 3)];
        const u = pt.u + (this.R() - 0.5) * pt.w * 0.6;
        this.barW(k % 3 === 0 ? 'reflPink' : k % 3 === 1 ? 'reflCyan' : 'refl', this.at(p, u, sy(p, u) + 0.022), this.at(q, u, sy(q, u) + 0.022), 0.25 + this.R() * 0.35, 0.003);
      }
    }
    // chevron boards on the outside of the hairpin + the banked turn exit
    for (let i = 0; i < n; i += 3) {
      const p = S[i];
      if (p.tag !== 'hairpin') continue;
      const out = -(half + 0.32);
      const c = this.at(p, out, 0.62);
      const m = MeshBuilder.CreateBox('nc', { width: 0.04, height: 0.5, depth: 0.9 }, this.scene);
      m.position = c; m.rotation.y = Math.PI / 2 - p.h; this.add(Math.floor(i / 3) % 2 ? 'chevY' : 'chevB', m);
    }
    // lantern strings over the road (S-bends, hairpin exit, after the jump)
    for (const s of [90, 128, 84, 135]) {
      const p = race.sampleAt(s), a = this.at(p, half + 2.5, 6.4), b = this.at(p, -half - 2.5, 6.4);
      for (const e of [a, b]) this.barW('darkSteel', new Vector3(e.x, this.O.y, e.z), e, 0.14);
      const N = 14;
      for (let k = 0; k <= N; k++) {
        const t = k / N, pos = Vector3.Lerp(a, b, t); pos.y -= Math.sin(t * Math.PI) * 0.9;
        if (k < N) { const q = Vector3.Lerp(a, b, (k + 1) / N); q.y -= Math.sin(((k + 1) / N) * Math.PI) * 0.9; this.barW('black', pos, q, 0.025); }
        if (k > 0 && k < N) { const l = MeshBuilder.CreateBox('nc', { width: 0.26, height: 0.32, depth: 0.26 }, this.scene); l.position = pos.subtract(new Vector3(0, 0.2, 0)); this.add('neon' + (k % 3 === 0 ? '#ffc400' : k % 3 === 1 ? '#ff3b5c' : '#ff6a1f'), l); }
      }
    }
    // hazard alley: police cars with light bars + barricades with amber blinkers outside the walls
    const hz = S.filter(p => p.tag === 'hazard');
    if (hz.length) {
      const p0 = hz[0], p1 = hz[hz.length - 1];
      for (const [p, u] of [[p0, half + 2.2], [p1, -(half + 2.4)]] as const) {
        const c = this.at(p, u, 0); this.police.push(this.policeCar(c.x - this.O.x, c.z - this.O.z, Math.PI / 2 - p.h));
      }
      for (let k = 0; k < hz.length; k += 6) {
        const p = hz[k];
        for (const side of [1, -1]) {
          const c = this.at(p, side * (half + 1.0), 0);
          const yaw = Math.PI / 2 - p.h;
          const b = MeshBuilder.CreateBox('nc', { width: 1.4, height: 0.25, depth: 0.08 }, this.scene); b.position = c.add(new Vector3(0, 0.8, 0)); b.rotation.y = yaw + Math.PI / 2; this.add(k % 12 ? 'barrierR' : 'barrier', b);
          for (const o of [-0.6, 0.6]) { const l = MeshBuilder.CreateBox('nc', { width: 0.06, height: 0.8, depth: 0.06 }, this.scene); l.position = c.add(new Vector3(Math.cos(p.h) * o, 0.4, Math.sin(p.h) * o)); this.add('darkSteel', l); }
          const bl = MeshBuilder.CreateBox('nc_blink', { width: 0.14, height: 0.14, depth: 0.14 }, this.scene); bl.position = c.add(new Vector3(0, 1.02, 0)); this.keep(bl); bl.material = this.mats.amber; this.amber.push(bl);
        }
      }
    }
  }
  private policeCar(x: number, z: number, yaw: number) {
    const part = (key: string, w: number, h: number, d: number, ox: number, oy: number, oz: number) => {
      const b = MeshBuilder.CreateBox('nc', { width: w, height: h, depth: d }, this.scene);
      const c = Math.cos(yaw), s = Math.sin(yaw);
      b.position = this.L(x + ox * c + oz * s, oy, z - ox * s + oz * c); b.rotation.y = yaw; return { b, key };
    };
    const list = [part('policeB', 1.7, 0.6, 4.2, 0, 0.55, 0), part('police', 1.72, 0.3, 1.6, 0, 0.6, -0.2), part('policeB', 1.5, 0.5, 2.1, 0, 1.1, -0.2),
      part('tire', 0.3, 0.6, 0.6, 0.8, 0.3, 1.3), part('tire', 0.3, 0.6, 0.6, -0.8, 0.3, 1.3), part('tire', 0.3, 0.6, 0.6, 0.8, 0.3, -1.3), part('tire', 0.3, 0.6, 0.6, -0.8, 0.3, -1.3)];
    for (const { b, key } of list) this.add(key, b);
    const r = part('red', 0.5, 0.14, 0.3, 0.3, 1.42, -0.2).b, bl = part('blue', 0.5, 0.14, 0.3, -0.3, 1.42, -0.2).b;
    this.keep(r); this.keep(bl); r.material = this.mats.red; bl.material = this.mats.blue;
    return { bar: [r, bl], ph: this.R() };
  }

  // ------------------------------------------------------------------------------------------- streetlights
  private buildStreetlights() {
    const race = this.race, S = race.samples, half = this.half;
    let k = 0;
    for (let i = 0; i < S.length; i += 20) {
      const p = S[i];
      const side = k++ % 2 ? 1 : -1;
      const u = side * (half + 1.3);
      const c = this.at(p, u, 0), lx = c.x - this.O.x, lz = c.z - this.O.z;
      if (this.otherDist(p, u) < half + 1.5 || this.inTunnel(lx, lz) || Math.abs(lx) < 2 && Math.abs(lz) < 6) continue;
      if (p.tag === 'jump' && p.q > 2 && p.q < 19) continue;
      const base = p.tag === 'bank' && side < 0 ? race.width * Math.tan(p.bank) : 0;   // outside of the bank: stands above the high edge
      this.cyl('darkSteel', lx, base + 2.9, lz, 0.16, 5.8, 8);
      const head = this.at(p, side * (half - 0.2), base + 5.8);
      this.barW('darkSteel', new Vector3(c.x, this.O.y + base + 5.8, c.z), head, 0.1);
      const lamp = MeshBuilder.CreateBox('nc', { width: 0.7, height: 0.12, depth: 0.35 }, this.scene); lamp.position = head.subtract(new Vector3(0, 0.08, 0)); lamp.rotation.y = Math.PI / 2 - p.h; this.add('sodium', lamp);
      // light pool on the road under it
      const pu = side * (half - 1.4), pc = this.at(p, pu, race.surfaceY(p, pu) + 0.02);
      if (p.tag !== 'bank') {
        const pool = MeshBuilder.CreateDisc('nc', { radius: 2.1, tessellation: 20 }, this.scene);
        pool.position = pc; pool.rotation.x = Math.PI / 2; pool.scaling.y = 1.4; pool.rotation.y = Math.PI / 2 - p.h;
        this.add('pool', pool);
        this.barW('refl', this.at(p, pu - side * 0.3, 0.025), this.at(race.sampleAt(p.s + 2.5), pu - side * 1.6, 0.025), 0.35, 0.003);
      }
    }
  }

  // ------------------------------------------------------------------------------------------- tunnel
  private buildTunnel() {
    const T = CITY_TUNNEL, o = this.occluder(T.x0 - 0.6, T.x1 + 0.6, T.roof - 0.4, T.roof + 1.4, -T.halfW - 0.8, T.halfW + 0.8);
    // walls outside the track walls, roof, portals
    for (const s of [1, -1]) {
      this.box(o + 'tunnel', T.x0, T.x1, 0, T.roof, s * T.halfW, s * (T.halfW + 0.5));
      this.box('tunnelTile', T.x0, T.x1, 0.05, 2.0, s * (T.halfW - 0.01), s * (T.halfW - 0.03));   // tiled lower wall
      this.box('neon#4dd2ff', T.x0, T.x1, 2.05, 2.12, s * (T.halfW - 0.04), s * (T.halfW - 0.06));      // neon guide strip
      for (let x = T.x0 + 1.5; x < T.x1; x += 3) this.box('white', x - 0.5, x + 0.5, T.roof - 0.25, T.roof - 0.12, s * 1.6 - 0.15, s * 1.6 + 0.15);   // ceiling lamps
      for (let x = T.x0 + 2; x < T.x1; x += 4) this.box('green', x - 0.25, x + 0.25, 2.6, 2.9, s * (T.halfW - 0.05), s * (T.halfW - 0.08));         // exit signs
    }
    this.box(o + 'concreteDark', T.x0 - 0.5, T.x1 + 0.5, T.roof, T.roof + 0.6, -T.halfW - 0.5, T.halfW + 0.5);
    this.box(o + 'tile', T.x0, T.x1, T.roof - 0.02, T.roof, -T.halfW, T.halfW);
    // jet fans
    for (const x of [T.x0 + 5, T.x1 - 5]) for (const z of [-1.4, 1.4]) { const f = this.cyl(o + 'darkSteel', x, T.roof - 0.5, z, 0.7, 2.0, 12); f.rotation.z = Math.PI / 2; }
    // portals: thick frames with neon edges, "NIGHT CITY" over the exit
    for (const x of [T.x0, T.x1]) {
      const d = x === T.x0 ? -1 : 1;
      this.box(o + 'concrete', x - (d < 0 ? 0.5 : 0), x + (d > 0 ? 0.5 : 0), T.roof, T.roof + 1.4, -T.halfW - 0.8, T.halfW + 0.8);
      for (const s of [1, -1]) this.box('concrete', x - 0.25, x + 0.25, 0, T.roof + 1.4, s * (T.halfW + 0.5), s * (T.halfW + 0.8));
      this.box('neon#ff2bd6', x + d * 0.52 - 0.02, x + d * 0.52 + 0.02, T.roof + 0.02, T.roof + 0.08, -T.halfW - 0.8, T.halfW + 0.8);
      this.box('neon#ff2bd6', x + d * 0.52 - 0.02, x + d * 0.52 + 0.02, 0, T.roof, T.halfW + 0.7, T.halfW + 0.76);
      this.box('neon#ff2bd6', x + d * 0.52 - 0.02, x + d * 0.52 + 0.02, 0, T.roof, -T.halfW - 0.76, -T.halfW - 0.7);
    }
    this.sign('NIGHT CITY', '#4dd2ff', T.x0 - 0.56, T.roof + 0.7, 0, 6, 1.0, Math.PI / 2);   // on the entry portal, under the screen
    // jumbotron above the west portal, facing the cars coming down the straight (-x)
    const sx = T.x0 - 0.7, sy0 = T.roof + 1.6, sh = 4.2, sw = 7.6;
    this.box(o + 'darkSteel', sx - 0.2, sx + 0.3, sy0 - 0.2, sy0 + sh + 0.2, -sw / 2 - 0.2, sw / 2 + 0.2);
    for (const z of [-2.5, 2.5]) this.box(o + 'darkSteel', sx + 0.1, sx + 0.4, T.roof + 1.4, sy0, z - 0.15, z + 0.15);
    this.box('neon#ff2bd6', sx - 0.24, sx - 0.2, sy0 - 0.25, sy0 + sh + 0.25, -sw / 2 - 0.25, -sw / 2 - 0.2);
    this.box('neon#ff2bd6', sx - 0.24, sx - 0.2, sy0 - 0.25, sy0 + sh + 0.25, sw / 2 + 0.2, sw / 2 + 0.25);
    const tex = new DynamicTexture('nc_screen', { width: 1024, height: 576 }, this.scene, true);
    const scr = MeshBuilder.CreatePlane('nc_screenp', { width: sw, height: sh }, this.scene);
    scr.position = this.L(sx - 0.22, sy0 + sh / 2, 0); scr.rotation.y = Math.PI / 2;
    const sm = new StandardMaterial('nc_screenm', this.scene);
    sm.disableLighting = true; sm.diffuseColor = Color3.Black(); sm.emissiveTexture = tex; sm.emissiveColor = Color3.Black(); sm.specularColor = Color3.Black();
    scr.material = sm; this.keep(scr); this.noGlow(scr);
    this.occluders[this.occluders.length - 1].meshes.push(scr);
    this.screen = { tex, at: -1e9, text: '' };
  }

  // ------------------------------------------------------------------------------------------- overpass
  private buildOverpass() {
    const X = -14, Y = 7.0, W = 5.2;
    const o = this.occluder(X - W / 2 - 0.6, X + W / 2 + 0.6, Y - 1.2, Y + 1.6, -40, 60);
    this.box(o + 'concreteDark', X - W / 2, X + W / 2, Y - 0.9, Y, -260, 260);
    this.box('concrete', X - W / 2 - 0.3, X - W / 2, Y, Y + 1.0, -260, 260); this.box('concrete', X + W / 2, X + W / 2 + 0.3, Y, Y + 1.0, -260, 260);
    this.box(o + 'concrete', X - W / 2 - 0.3, X - W / 2, Y - 0.9, Y + 1.0, -40, 60); this.box(o + 'concrete', X + W / 2, X + W / 2 + 0.3, Y - 0.9, Y + 1.0, -40, 60);
    this.box('neon#4dd2ff', X - W / 2 - 0.32, X - W / 2 - 0.29, Y - 0.6, Y - 0.5, -260, 260); this.box('neon#4dd2ff', X + W / 2 + 0.29, X + W / 2 + 0.32, Y - 0.6, Y - 0.5, -260, 260);
    for (let z = -250; z < 250; z += 6) this.box('laneW', X - 0.06, X + 0.06, Y + 0.005, Y + 0.012, z, z + 3);
    // pillars: only where they're clear of the track (and of the hammer)
    for (let z = -110; z <= 130; z += 11.5) {
      if (this.trackDist(X, z) < this.half + 1.6) continue;
      this.box('concrete', X - 0.5, X + 0.5, 0, Y - 0.9, z - 0.5, z + 0.5);
      this.box('concreteDark', X - 1.6, X + 1.6, Y - 1.4, Y - 0.9, z - 0.7, z + 0.7);
    }
    // lamps along the overpass
    for (let z = -200; z < 200; z += 16) { this.cyl('darkSteel', X + W / 2 + 0.15, Y + 2.2, z, 0.12, 2.4, 6); this.box('sodium', X + W / 2 - 0.4, X + W / 2 + 0.15, Y + 3.35, Y + 3.45, z - 0.15, z + 0.15); }
    // a billboard on the side facing the start
    this.sign('NITRO', '#ff6a1f', X + W / 2 + 0.34, Y - 0.1, -5, 3.6, 1.0, -Math.PI / 2, false, true);
    this.sign('VOLT COLA', '#39ff14', X - W / 2 - 0.34, Y - 0.1, 14, 4.4, 1.0, Math.PI / 2);
  }

  // ------------------------------------------------------------------------------------------- infield block
  private buildInfield() {
    // a low parking-garage block inside the loop, rooftop crowd + neon
    const x0 = 11, x1 = 23, z0 = 6.2, z1 = 14.2, h = 4.2;
    const o = this.occluder(x0 - 0.2, x1 + 0.2, 0, h + 2.2, z0 - 0.2, z1 + 0.2);
    const b = MeshBuilder.CreateBox('nc', { width: x1 - x0, height: h, depth: z1 - z0, faceUV: this.bldUV(x1 - x0, h, z1 - z0) }, this.scene);
    b.position = this.L((x0 + x1) / 2, h / 2, (z0 + z1) / 2); this.tint(b, hex('#d8c8f0')); this.add(o + 'bldA', b);
    for (const x of [x0 - 0.05, x1 + 0.05]) this.box('neon#ff2bd6', x - 0.03, x + 0.03, h - 0.1, h, z0, z1);
    for (const z of [z0 - 0.05, z1 + 0.05]) this.box('neon#ff2bd6', x0, x1, h - 0.1, h, z - 0.03, z + 0.03);
    this.box(o + 'concreteDark', x0, x1, h, h + 0.9, z0, z0 + 0.15); this.box(o + 'concreteDark', x0, x1, h, h + 0.9, z1 - 0.15, z1);
    this.sign('LIVE RACING', '#ffc400', (x0 + x1) / 2, h + 1.6, z0 - 0.05, 6, 1.1, 0, false, false);
    for (let x = x0 + 0.6; x < x1 - 0.3; x += 0.75) {
      this.person(x, h, z0 + 0.5, Math.PI, 0.7, 14);
      if (this.R() < 0.6) this.person(x + 0.3, h, z1 - 0.5, 0, 0.7, 14);
    }
  }

  // ------------------------------------------------------------------------------------------- buildings
  private bldUV(w: number, h: number, d: number): Vector4[] {
    const o = () => Math.floor(this.R() * 8) / 8;
    const side = (len: number) => { const u = o(); return new Vector4(u, 0, u + len / 32, h / 32); };
    const top = new Vector4(0.001, 0.001, 0.002, 0.002);
    return [side(w), side(w), side(d), side(d), top, top];
  }
  private buildBuildings() {
    const R = this.R;
    // track zone (ring road + its sidewalks + the band): no buildings
    const ZX0 = -46, ZX1 = 64, ZZ0 = -26, ZZ1 = 46;
    const cx = 9, cz = 10;
    const pitch = 30, blk = 22;
    const tints = ['#1c1b24', '#221f29', '#191d26', '#26222b', '#1d2220', '#28252e', '#17181e', '#2a2531'];
    for (let gx = -6; gx <= 6; gx++) for (let gz = -6; gz <= 6; gz++) {
      let bx0 = cx - 11 + gx * pitch, bx1 = bx0 + blk, bz0 = cz - 11 + gz * pitch, bz1 = bz0 + blk;
      // keep clear of the zone + overpass + avenues
      if (bx1 > ZX0 && bx0 < ZX1 && bz1 > ZZ0 && bz0 < ZZ1) {
        // trim the block to the part outside the zone (biggest strip)
        const strips = [[bx0, Math.min(bx1, ZX0), bz0, bz1], [Math.max(bx0, ZX1), bx1, bz0, bz1], [bx0, bx1, bz0, Math.min(bz1, ZZ0)], [bx0, bx1, Math.max(bz0, ZZ1), bz1]]
          .filter(([a, b, c, d]) => b - a >= 6 && d - c >= 6);
        if (!strips.length) continue;
        strips.sort((A, B) => (B[1] - B[0]) * (B[3] - B[2]) - (A[1] - A[0]) * (A[3] - A[2]));
        [bx0, bx1, bz0, bz1] = strips[0];
      }
      if (bx1 > -21 && bx0 < -7) { if (bx0 > -21) bx0 = -7; else bx1 = -21; if (bx1 - bx0 < 6) continue; }   // overpass corridor
      const dist = Math.hypot((bx0 + bx1) / 2 - cx, (bz0 + bz1) / 2 - cz);
      if (dist > 210) continue;
      // lots: split the block into 1-4 buildings
      const lots: [number, number, number, number][] = [];
      const splitX = bx1 - bx0 > 12 && R() < 0.7, splitZ = bz1 - bz0 > 12 && R() < 0.7;
      const mx = bx0 + (bx1 - bx0) * (0.4 + R() * 0.2), mz = bz0 + (bz1 - bz0) * (0.4 + R() * 0.2);
      for (const [a, b] of splitX ? [[bx0, mx], [mx, bx1]] : [[bx0, bx1]]) for (const [c, d] of splitZ ? [[bz0, mz], [mz, bz1]] : [[bz0, bz1]]) lots.push([a, b, c, d]);
      for (const [a, b, c, d] of lots) {
        const near = dist < 72;
        const h = near ? 8 + R() * 14 : dist < 120 ? 20 + R() * 40 : 40 + R() * 90;
        const inset = 0.4;
        this.building(a + inset, b - inset, c + inset, d - inset, h, hex(tints[Math.floor(R() * tints.length)]).scale(0.8 + R() * 0.4), near, cx, cz);
      }
    }
    // far skyline ring: tall silhouettes
    for (let k = 0; k < 70; k++) {
      const a = (k / 70) * Math.PI * 2 + R() * 0.05, r = 240 + R() * 70;
      const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r, w = 14 + R() * 22, h = 60 + R() * 150;
      this.building(x - w / 2, x + w / 2, z - w / 2, z + w / 2, h, hex('#1a1824').scale(0.9 + R() * 0.3), false, cx, cz);
    }
  }
  /** One building: windowed box, rooftop bits; near ones get shopfronts, balconies + crowds, neon signs facing the track. */
  private building(x0: number, x1: number, z0: number, z1: number, h: number, tint: Color3, near: boolean, cx: number, cz: number) {
    const R = this.R, w = x1 - x0, d = z1 - z0, mx = (x0 + x1) / 2, mz = (z0 + z1) / 2;
    const b = MeshBuilder.CreateBox('nc', { width: w, height: h, depth: d, faceUV: this.bldUV(w, h, d) }, this.scene);
    b.position = this.L(mx, h / 2, mz); this.tint(b, new Color3(Math.min(1, tint.r * 2.4 + 0.45), Math.min(1, tint.g * 2.4 + 0.45), Math.min(1, tint.b * 2.4 + 0.45)));
    this.add(R() < 0.5 ? 'bldA' : 'bldB', b);
    // roof: parapet, AC units, water tower, antenna with a blinking light
    this.box('roofTop', x0 + 0.2, x1 - 0.2, h, h + 0.05, z0 + 0.2, z1 - 0.2);
    if (w > 6 && d > 6) for (let k = 0; k < 2 + Math.floor(R() * 3); k++) { const ax = x0 + 1.5 + R() * (w - 3), az = z0 + 1.5 + R() * (d - 3); this.box('darkSteel', ax - 0.6, ax + 0.6, h, h + 0.8, az - 0.5, az + 0.5); }
    if (R() < 0.25 && w > 8) {
      const tx = x0 + 2 + R() * (w - 4), tz = z0 + 2 + R() * (d - 4);
      for (const [ox, oz] of [[-0.8, -0.8], [0.8, -0.8], [-0.8, 0.8], [0.8, 0.8]]) this.bar('wood', tx + ox, h, tz + oz, tx + ox * 0.8, h + 2, tz + oz * 0.8, 0.12);
      this.cyl('wood', tx, h + 3, tz, 2.4, 2, 12); this.cyl('roofTop', tx, h + 4.3, tz, 2.6, 0.6, 12, 0.2);
    }
    if (h > 30 && R() < 0.7) {
      const ax = mx + (R() - 0.5) * w * 0.4, az = mz + (R() - 0.5) * d * 0.4, ah = 4 + R() * 10;
      this.bar('steel', ax, h, az, ax, h + ah, az, 0.15);
      const bl = MeshBuilder.CreateBox('nc', { width: 0.4, height: 0.4, depth: 0.4 }, this.scene); bl.position = this.L(ax, h + ah, az); this.add('blink', bl);
    }
    if (h > 25 && R() < 0.35) {   // neon crown
      const c = 'neon' + NEON[Math.floor(R() * NEON.length)];
      for (const y of [h - 0.4, h - 1.6]) {
        this.box(c, x0 - 0.05, x1 + 0.05, y, y + 0.12, z0 - 0.05, z0 + 0.02); this.box(c, x0 - 0.05, x1 + 0.05, y, y + 0.12, z1 - 0.02, z1 + 0.05);
        this.box(c, x0 - 0.05, x0 + 0.02, y, y + 0.12, z0, z1); this.box(c, x1 - 0.02, x1 + 0.05, y, y + 0.12, z0, z1);
      }
    }
    if (!near) {
      if (R() < 0.15 && h < 70) this.sign(SIGNS[Math.floor(R() * SIGNS.length)], NEON[Math.floor(R() * NEON.length)], mx, h + 2.2, mz, Math.min(w, 16), 3.2, Math.atan2(cx - mx, cz - mz) + Math.PI);
      return;
    }
    // near: which face looks at the track?
    const dx = cx - mx, dz = cz - mz;
    let f: { n: [number, number]; along: 'x' | 'z'; at: number; a0: number; a1: number; yaw: number };
    if (Math.abs(dx) * 1.4 > Math.abs(dz)) f = dx > 0 ? { n: [1, 0], along: 'z', at: x1, a0: z0, a1: z1, yaw: -Math.PI / 2 } : { n: [-1, 0], along: 'z', at: x0, a0: z0, a1: z1, yaw: Math.PI / 2 };
    else f = dz > 0 ? { n: [0, 1], along: 'x', at: z1, a0: x0, a1: x1, yaw: Math.PI } : { n: [0, -1], along: 'x', at: z0, a0: x0, a1: x1, yaw: 0 };
    const P = (along: number, out: number, y: number): [number, number, number] => f.along === 'x' ? [along, y, f.at + f.n[1] * out] : [f.at + f.n[0] * out, y, along];
    const slab = (key: string, a0: number, a1: number, o0: number, o1: number, y0: number, y1: number) => {
      const A = P(a0, o0, y0), B = P(a1, o1, y1);
      this.box(key, A[0], B[0], A[1], B[1], A[2], B[2]);
    };
    // shopfront: bright window band + coloured awning + a glowing strip
    const shop = NEON[Math.floor(R() * NEON.length)];
    slab('warmWin', f.a0 + 0.6, f.a1 - 0.6, 0.02, 0.06, 0.5, 2.7);
    slab('neon' + shop, f.a0 + 0.3, f.a1 - 0.3, 0.02, 1.4, 3.0, 3.12);
    slab('darkSteel', f.a0 + 0.3, f.a1 - 0.3, 0.02, 1.4, 3.12, 3.2);
    // a neon sign over the shop + a vertical blade sign
    const sp = P((f.a0 + f.a1) / 2, 0.08, 3.9);
    this.sign(SIGNS[Math.floor(R() * SIGNS.length)], NEON[Math.floor(R() * NEON.length)], sp[0], sp[1], sp[2], Math.min(f.a1 - f.a0 - 1, 7), 1.2, f.yaw, false, R() < 0.25);
    if (h > 12) {
      const bp = P(f.a0 + 1.2, 0.8, 7 + R() * 3);
      this.sign(BLADES[Math.floor(R() * BLADES.length)], NEON[Math.floor(R() * NEON.length)], bp[0], bp[1], bp[2], 0.9, 4.2, f.yaw + Math.PI / 2, true, R() < 0.2);
    }
    // balconies with railings + people (some with umbrellas)
    for (let y = 6; y < h - 2; y += 3.2) {
      if (R() < 0.35) continue;
      const a0 = f.a0 + 1 + R() * 2, a1 = Math.min(f.a1 - 1, a0 + 3 + R() * 5);
      if (a1 - a0 < 2) continue;
      slab('concrete', a0, a1, 0, 1.3, y - 0.15, y);
      slab('glass', a0, a1, 1.25, 1.3, y, y + 1.0);
      slab('steel', a0, a1, 1.22, 1.32, y + 1.0, y + 1.06);
      for (let a = a0 + 0.4; a < a1 - 0.2; a += 0.7) if (R() < 0.6) { const q = P(a, 0.7, y); this.person(q[0], q[1], q[2], f.yaw + Math.PI, 0.3, 26); }
    }
    // rooftop crowd at the front edge + a rooftop billboard
    slab('concreteDark', f.a0, f.a1, 0, 0.15, h, h + 0.9);
    for (let a = f.a0 + 0.5; a < f.a1 - 0.3; a += 0.65) if (R() < 0.75) { const q = P(a, -0.6, h); this.person(q[0], q[1], q[2], f.yaw + Math.PI, 0.75, 30); }
    if (R() < 0.45) {
      const q = P((f.a0 + f.a1) / 2, -2.5, h + 3.2);
      this.sign(SIGNS[Math.floor(R() * SIGNS.length)], NEON[Math.floor(R() * NEON.length)], q[0], q[1], q[2], Math.min(f.a1 - f.a0 - 1, 10), 2.4, f.yaw, false, R() < 0.2);
      const l0 = P(f.a0 + 1, -2.6, h), l1 = P(f.a1 - 1, -2.6, h);
      this.bar('darkSteel', l0[0], h, l0[2], l0[0], h + 2, l0[2], 0.15); this.bar('darkSteel', l1[0], h, l1[2], l1[0], h + 2, l1[2], 0.15);
    }
  }

  // ------------------------------------------------------------------------------------------- sidewalk crowd
  private buildSidewalkCrowd() {
    const race = this.race, S = race.samples, half = this.half;
    // spectators behind the walls on the sidewalk: start straight (outside), bank outside, jump straight, hairpin
    for (let i = 0; i < S.length; i += 1) {
      const p = S[i];
      const sections = (p.tag === 'start' && (p.x < -1 || p.x > 26)) || p.tag === 'hairpin' || (p.tag === 'jump' && p.q > 2 && p.q < 19);
      if (!sections || this.R() < 0.35) continue;
      const side = -1;   // the loop turns left: outside is -u
      for (const du of [1.1, 1.8, 2.5]) {
        if (this.R() < 0.4) continue;
        const u = side * (half + du);
        if (this.otherDist(p, u) < half + 1.5) continue;
        const c = this.at(p, u, 0);
        if (this.inTunnel(c.x - this.O.x, c.z - this.O.z)) continue;
        this.person(c.x - this.O.x, 0.15, c.z - this.O.z, -p.h, 0.55, 12);   // facing the road
      }
    }
    // barricade line along the start straight + hairpin (between the wall and the crowd)
    for (let i = 0; i < S.length; i += 4) {
      const p = S[i];
      if (!((p.tag === 'start' && (p.x < -1 || p.x > 26)) || p.tag === 'hairpin')) continue;
      const a = this.at(p, -(half + 0.75), 0.9), b = this.at(S[(i + 4) % S.length], -(half + 0.75), 0.9);
      this.barW('steel', a, b, 0.05); this.barW('darkSteel', new Vector3(a.x, this.O.y + 0.12, a.z), a, 0.05);
    }
    // (user) a bar on the start straight: THE LAVENDER TAINT -- lavender neon, awning, a doorman, a queue
    {
      const x0 = -10.5, x1 = -1, z0 = -9.2, z1 = -7.6, h = 4.4;
      this.box('concreteDark', x0, x1, 0, h, z0 - 2.6, z0);
      this.box('neon#b88cff', x0 + 0.5, x1 - 0.5, 0.4, 2.6, z0 + 0.01, z0 + 0.05);                       // lit window front
      this.box('black', x0 + 4.6, x0 + 6.0, 0, 2.4, z0 + 0.02, z0 + 0.08);                               // door
      this.box('neon#b88cff', x0 + 0.3, x1 - 0.3, 2.9, 3.0, z0, z1 - 0.3);                               // awning edge
      this.box('violet', x0 + 0.3, x1 - 0.3, 3.0, 3.08, z0, z1 - 0.3);
      this.sign('THE LAVENDER TAINT', '#c9a0ff', (x0 + x1) / 2, 3.75, z0 + 0.12, 9.5, 1.25, Math.PI, false, false);
      this.sign('BAR', '#ff2bd6', x1 - 0.4, 6.0, z0 + 0.7, 0.9, 3.0, Math.PI / 2, true, true);
      this.person(x0 + 5.3, 0.15, z0 + 0.7, 0, 0, 6);                                                    // doorman
      for (let k = 0; k < 6; k++) this.person(x0 + 6.6 + k * 0.6, 0.15, z0 + 0.8 + this.R() * 0.3, -Math.PI / 2 + 0.6, 0.6, 10);   // the queue
    }
    // vending machines + a food cart near the hairpin
    for (const [x, z, c] of [[-30, -6, '#4dd2ff'], [-30, -4.6, '#ff2bd6'], [44, -8, '#39ff14']] as const) {
      this.box('darkSteel', x - 0.5, x + 0.5, 0.15, 2.0, z - 0.6, z + 0.6); this.box('neon' + c, x + 0.49, x + 0.53, 0.5, 1.8, z - 0.5, z + 0.5);
    }
    this.box('wood', -29.5, -27.5, 0.15, 1.1, 10, 11.4); this.box('neon#ffc400', -29.6, -27.4, 2.2, 2.3, 9.9, 11.5);
    this.box('barrierR', -29.6, -27.4, 2.3, 2.45, 9.8, 11.6);
    for (const x of [-29.4, -27.6]) this.bar('darkSteel', x, 1.1, 10, x, 2.2, 10, 0.06);
    for (let k = 0; k < 6; k++) { const l = this.cyl('neon#ff3b5c', -29.4 + k * 0.36, 2.0, 11.45, 0.22, 0.28, 8); void l; }
  }

  // ------------------------------------------------------------------------------------------- sky
  private buildSky() {
    const [topHex, horHex] = this.race.def.theme.sky!;
    const top = hex(topHex), hor = hex(horHex), glow = hex('#5a2a4a');
    const sky = MeshBuilder.CreateSphere('nc_sky', { diameter: 900, segments: 24, sideOrientation: Mesh.BACKSIDE }, this.scene);
    const pos = sky.getVerticesData('position')!, cols: number[] = [];
    for (let i = 0; i < pos.length; i += 3) {
      const k = Math.max(0, pos[i + 1] / 450);
      const c = Color3.Lerp(Color3.Lerp(glow, hor, Math.min(1, k * 6)), top, Math.pow(k, 0.5));
      cols.push(c.r, c.g, c.b, 1);
    }
    sky.setVerticesData('color', cols);
    const sm = new StandardMaterial('nc_skym', this.scene);
    sm.disableLighting = true; sm.diffuseColor = Color3.Black(); sm.emissiveColor = Color3.White(); sm.fogEnabled = false;
    sky.material = sm; sky.infiniteDistance = true; this.keep(sky); this.noGlow(sky);
    // low cloud deck (cube clouds), lit by the city from below; lightning brightens it
    const parts: Mesh[] = [];
    for (let c = 0; c < 26; c++) {
      const a = this.R() * Math.PI * 2, r = 40 + this.R() * 230, x = 9 + Math.cos(a) * r, z = 10 + Math.sin(a) * r, y = 85 + this.R() * 30;
      for (let i = 0; i < 6; i++) {
        const s = 14 + this.R() * 18;
        const b = MeshBuilder.CreateBox('nc', { width: s * 1.8, height: s * 0.35, depth: s }, this.scene);
        b.position = this.L(x + (this.R() - 0.5) * 40, y + (this.R() - 0.5) * 5, z + (this.R() - 0.5) * 25);
        parts.push(b);
      }
    }
    const clouds = Mesh.MergeMeshes(parts, true)!; clouds.material = this.cloudMat; this.keep(clouds); this.noGlow(clouds);
    this.cloudMat.fogEnabled = false;
    // lightning bolts (3 shapes, shown one at a time during a strike)
    for (let k = 0; k < 3; k++) {
      const segs: Mesh[] = [];
      let p = new Vector3(0, 150, 0);
      const R = rng(500 + k);
      while (p.y > 25) {
        const q = p.add(new Vector3((R() - 0.5) * 14, -6 - R() * 8, (R() - 0.5) * 6));
        const m = MeshBuilder.CreateBox('nc', { width: 0.9, height: 0.9, depth: Vector3.Distance(p, q) }, this.scene);
        m.position = p.add(q).scale(0.5); m.lookAt(q); segs.push(m);
        if (R() < 0.25) {   // a branch
          let b = q.clone();
          for (let j = 0; j < 3; j++) { const c = b.add(new Vector3((R() - 0.5) * 16, -5 - R() * 5, (R() - 0.5) * 6)); const mm = MeshBuilder.CreateBox('nc', { width: 0.5, height: 0.5, depth: Vector3.Distance(b, c) }, this.scene); mm.position = b.add(c).scale(0.5); mm.lookAt(c); segs.push(mm); b = c; }
        }
        p = q;
      }
      const bolt = Mesh.MergeMeshes(segs, true)!; bolt.material = this.mats.bolt; bolt.setEnabled(false); bolt.isPickable = false;
      this.bolts.push(bolt);
    }
    // searchlight helicopter
    const hp: Mesh[] = [];
    const B = (w: number, h: number, d: number, x: number, y: number, z: number) => { const b = MeshBuilder.CreateBox('nc', { width: w, height: h, depth: d }, this.scene); b.position.set(x, y, z); hp.push(b); };
    B(1.8, 1.6, 3.2, 0, 0, 0); B(0.5, 0.5, 4.2, 0, 0.3, -3.4); B(0.1, 1.2, 0.8, 0, 0.8, -5.3); B(2.4, 0.12, 0.12, 0, -1.0, 0.8); B(2.4, 0.12, 0.12, 0, -1.0, -0.8);
    const root = Mesh.MergeMeshes(hp, true)!; root.material = this.mats.policeB; this.keep(root);
    const rotor = MeshBuilder.CreateBox('nc_rotor', { width: 9, height: 0.06, depth: 0.35 }, this.scene); rotor.parent = root; rotor.position.y = 1.0; rotor.material = this.mats.darkSteel; this.keep(rotor);
    const light = MeshBuilder.CreateBox('nc_hl', { width: 0.3, height: 0.3, depth: 0.3 }, this.scene); light.parent = root; light.position.set(0, -0.8, 1.6); light.material = this.mats.red; this.keep(light);
    const beam = MeshBuilder.CreateCylinder('nc_beam', { diameterTop: 0.6, diameterBottom: 7, height: 1, tessellation: 16, cap: Mesh.NO_CAP }, this.scene);
    const bm = this.mat('beam', '#bfd8ff', 0, { unlit: true, alpha: 0.07 }); bm.alphaMode = Constants.ALPHA_ADD; bm.disableDepthWrite = true; bm.backFaceCulling = false; beam.material = bm; this.keep(beam); this.noGlow(beam);
    const pool = MeshBuilder.CreateDisc('nc_hpool', { radius: 3.6, tessellation: 24 }, this.scene); pool.rotation.x = Math.PI / 2;
    pool.material = this.mat('hpool', '#dfe8ff', 0, { unlit: true, alpha: 0.6, add: true }); this.keep(pool); this.noGlow(pool);
    this.heli = { root, rotor, beam, pool, light, aim: this.L(0, 0, 0) };
  }

  // ------------------------------------------------------------------------------------------- start lights
  private buildStartLights() {
    const gz = this.half + 0.9, gy = 4.4;
    for (const z of [-gz, gz]) this.box('steel', -0.25, 0.25, 0, gy + 0.9, z - 0.25, z + 0.25);
    this.box('black', -0.25, 0.25, gy, gy + 0.9, -gz, gz);
    const nC = Math.round((gz * 2) / 0.4);
    for (let row = 0; row < 2; row++) for (let i = 0; i < nC; i++) {
      const z = -gz + (i + 0.5) * (gz * 2 / nC);
      this.boxC((i + row) % 2 ? 'white' : 'black', 0, gy + 0.25 + row * 0.4, z, 0.54, 0.38, gz * 2 / nC);
    }
    for (const x of [-0.3, 0.3]) this.box('neon#ff2bd6', x - 0.03, x + 0.03, gy - 0.03, gy + 0.02, -gz, gz);
    this.box('black', -0.32, -0.26, gy - 0.75, gy - 0.05, -1.6, 1.6);
    for (let i = 0; i < 5; i++) {
      const m = MeshBuilder.CreateBox('nc_startlight', { width: 0.06, height: 0.42, depth: 0.42 }, this.scene);
      m.position = this.L(-0.34, gy - 0.4, -1.2 + i * 0.6); m.material = this.mats.lampOff;
      this.keep(m); this.startLights.push(m);
    }
  }

  // ------------------------------------------------------------------------------------------- crowd (thin instances)
  private person(x: number, y: number, z: number, yaw: number, brellaChance: number, reach: number) {
    const R = this.R;
    this.people.push({ x, y, z, yaw: yaw + (R() - 0.5) * 0.5, s: 0.88 + R() * 0.25, ph: R() * Math.PI * 2, hype: R() < 0.12 ? 0.3 + R() * 0.3 : R() * 0.08, brella: R() < brellaChance ? 1 : -1, reach });
  }
  private unit(name: string, w: number, h: number, d: number, ox: number, oy: number, oz: number, e = 0.06, unlit = false) {
    const m = MeshBuilder.CreateBox('nc_' + name, { width: w, height: h, depth: d }, this.scene);
    m.bakeTransformIntoVertices(Matrix.Translation(ox, oy, oz));
    const mat = new StandardMaterial('nc_i_' + name, this.scene);
    if (unlit) { mat.disableLighting = true; mat.emissiveColor = Color3.White(); mat.diffuseColor = Color3.Black(); }
    else { mat.diffuseColor = Color3.White(); mat.specularColor = new Color3(0.15, 0.15, 0.15); mat.emissiveColor = new Color3(e, e, e); }
    m.material = mat; m.alwaysSelectAsActiveMesh = true; m.isPickable = false;
    this.keep(m);
    return m;
  }
  private part(mesh: Mesh, count: number): Part {
    return { mesh, buf: new Float32Array(Math.max(1, count) * 16), col: new Float32Array(Math.max(1, count) * 4).fill(1) };
  }
  private static setCol(part: Part, i: number, c: Color3, a = 1) { part.col.set([c.r, c.g, c.b, a], i * 4); }
  private bind(part: Part, colours = true) {
    part.mesh.thinInstanceSetBuffer('matrix', part.buf, 16, false);
    if (colours) part.mesh.thinInstanceSetBuffer('color', part.col, 4, false);
  }
  private buildCrowdMeshes() {
    const P = this.people, n = P.length;
    let bi = 0;
    for (const p of P) if (p.brella >= 0) p.brella = bi++;
    this.crowd = {
      legs: this.part(this.unit('legs', 0.24, 0.36, 0.16, 0, 0.18, 0), n),
      torso: this.part(this.unit('torso', 0.32, 0.34, 0.2, 0, 0.53, 0), n),
      head: this.part(this.unit('head', 0.22, 0.22, 0.22, 0, 0.82, 0), n),
      armL: this.part(this.unit('armL', 0.09, 0.3, 0.09, 0, -0.13, 0), n),
      armR: this.part(this.unit('armR', 0.09, 0.3, 0.09, 0, -0.13, 0), n),
      stick: this.part(this.unit('stick', 0.03, 0.9, 0.03, 0.2, 1.02, 0.1), bi),
      brella: this.part(this.unit('brella', 1.0, 0.07, 1.0, 0.2, 1.48, 0.1, 0.12), bi),
    };
    const C = this.crowd, R = this.R, sc = NightCity.setCol;
    P.forEach((p, i) => {
      const j = 0.8 + R() * 0.25, shirt = hex(SHIRTS[Math.floor(R() * SHIRTS.length)]).scale(j);
      sc(C.legs, i, hex(PANTS[Math.floor(R() * PANTS.length)]).scale(j));
      sc(C.torso, i, shirt);
      sc(C.head, i, hex(SKIN[Math.floor(R() * SKIN.length)]));
      const sleeve = R() < 0.6 ? shirt : hex(SKIN[Math.floor(R() * SKIN.length)]);
      sc(C.armL, i, sleeve); sc(C.armR, i, sleeve);
      if (p.brella >= 0) { sc(C.stick, p.brella, hex('#222222')); sc(C.brella, p.brella, hex(BRELLA[Math.floor(R() * BRELLA.length)])); }
    });
    for (const part of Object.values(C)) this.bind(part);
  }

  /** Instance matrix: scale s, turn about local x by a (arms), yaw, pivot (px, py, pz) in local space, then T. */
  private static put(buf: Float32Array, k: number, yaw: number, s: number, a: number, px: number, py: number, pz: number, tx: number, ty: number, tz: number) {
    const o = k * 16, cy = Math.cos(yaw), sy = Math.sin(yaw), ca = Math.cos(a), sa = Math.sin(a);
    // R = Ry(yaw) * Rx(a), row-major (Babylon: row vectors, v * M)
    const r00 = cy, r01 = 0, r02 = -sy;
    const r10 = sy * sa, r11 = ca, r12 = cy * sa;
    const r20 = sy * ca, r21 = -sa, r22 = cy * ca;
    buf[o] = s * r00; buf[o + 1] = s * r01; buf[o + 2] = s * r02; buf[o + 3] = 0;
    buf[o + 4] = s * r10; buf[o + 5] = s * r11; buf[o + 6] = s * r12; buf[o + 7] = 0;
    buf[o + 8] = s * r20; buf[o + 9] = s * r21; buf[o + 10] = s * r22; buf[o + 11] = 0;
    // pivot: rotate the pivot offset by yaw only (arms swing about the shoulder)
    buf[o + 12] = s * (px * cy + pz * sy) + tx; buf[o + 13] = s * py + ty; buf[o + 14] = s * (-px * sy + pz * cy) + tz; buf[o + 15] = 1;
  }

  // ------------------------------------------------------------------------------------------- traffic
  private path(pts: [number, number, number][], loop: boolean): number {
    const P = pts.map(([x, y, z]) => this.L(x, y, z));
    const len: number[] = [0];
    const segs = loop ? P.length : P.length - 1;
    for (let i = 0; i < segs; i++) len.push(len[i] + Vector3.Distance(P[i], P[(i + 1) % P.length]));
    this.paths.push({ pts: P, len, total: len[len.length - 1], loop });
    return this.paths.length - 1;
  }
  private pathAt(pi: number, d: number, out: Vector3): number {
    const p = this.paths[pi];
    d = ((d % p.total) + p.total) % p.total;
    let i = 0; while (i < p.len.length - 2 && p.len[i + 1] < d) i++;
    const a = p.pts[i], b = p.pts[(i + 1) % p.pts.length], k = (d - p.len[i]) / Math.max(1e-6, p.len[i + 1] - p.len[i]);
    Vector3.LerpToRef(a, b, k, out);
    return Math.atan2(b.x - a.x, b.z - a.z);
  }
  private buildTraffic() {
    // ring road: clockwise in the outer lane, anticlockwise in the inner lane (drive on the right)
    const X0 = -36, X1 = 54, Z0 = -16, Z1 = 36, o = 2;
    const outer = this.path([[X0 - o, 0, Z0 - o], [X0 - o, 0, Z1 + o], [X1 + o, 0, Z1 + o], [X1 + o, 0, Z0 - o]], true);
    const inner = this.path([[X0 + o, 0, Z0 + o], [X1 - o, 0, Z0 + o], [X1 - o, 0, Z1 - o], [X0 + o, 0, Z1 - o]], true);
    const over1 = this.path([[-15.3, 7.0, -250], [-15.3, 7.0, 250]], true), over2 = this.path([[-12.7, 7.0, 250], [-12.7, 7.0, -250]], true);
    const av = [this.path([[-71.5, 0, -220], [-71.5, 0, 220]], true), this.path([[-68.5, 0, 220], [-68.5, 0, -220]], true),
      this.path([[96.5, 0, 220], [96.5, 0, -220]], true), this.path([[99.5, 0, -220], [99.5, 0, 220]], true),
      this.path([[-220, 0, -52.5], [220, 0, -52.5]], true), this.path([[220, 0, -55.5], [-220, 0, -55.5]], true),
      this.path([[220, 0, 87.5], [-220, 0, 87.5]], true), this.path([[-220, 0, 84.5], [220, 0, 84.5]], true)];
    const add = (pi: number, n: number, sp: number) => { for (let k = 0; k < n; k++) this.cars.push({ path: pi, d: (k / n) * this.paths[pi].total + this.R() * 6, speed: sp * (0.85 + this.R() * 0.3) }); };
    add(outer, 8, 9); add(inner, 7, 8); add(over1, 7, 15); add(over2, 7, 15);
    for (const a of av) add(a, 5, 11);
    const n = this.cars.length;
    this.carParts = {
      body: this.part(this.unit('carbody', 1.8, 0.62, 4.1, 0, 0.5, 0, 0.04), n),
      cabin: this.part(this.unit('carcab', 1.6, 0.5, 2.1, 0, 1.05, -0.25, 0.02), n),
      head: this.part(this.unit('carhead', 1.5, 0.16, 0.06, 0, 0.6, 2.07, 0, true), n),
      tail: this.part(this.unit('cartail', 1.5, 0.14, 0.06, 0, 0.66, -2.07, 0, true), n),
      beam: this.part(this.unit('carbeam', 2.6, 0.01, 6, 0, 0.03, 5.2, 0, true), n),
    };
    const C = this.carParts, sc = NightCity.setCol;
    (C.beam.mesh.material as StandardMaterial).alpha = 0.22; (C.beam.mesh.material as StandardMaterial).alphaMode = Constants.ALPHA_ADD; (C.beam.mesh.material as StandardMaterial).disableDepthWrite = true;
    this.noGlow(C.beam.mesh);
    this.cars.forEach((_, i) => {
      const taxi = this.R() < 0.15;
      sc(C.body, i, hex(taxi ? '#ffc400' : CARS[Math.floor(this.R() * CARS.length)]));
      sc(C.cabin, i, hex('#0d1420'));
      sc(C.head, i, hex('#fff4d6')); sc(C.tail, i, hex('#ff1a1a')); sc(C.beam, i, hex('#ffe9b8').scale(0.6));
    });
    for (const part of Object.values(C)) this.bind(part);
  }

  // ------------------------------------------------------------------------------------------- rain, splashes, spray, steam
  private buildRain() {
    const N = 2600;
    const streak = this.unit('rain', 0.018, 0.8, 0.018, 0, 0, 0, 0, true);
    streak.bakeTransformIntoVertices(Matrix.RotationX(0.12));   // wind slant
    const rm = streak.material as StandardMaterial; rm.emissiveColor = hex('#9fb4d8'); rm.alpha = 0.32; rm.alphaMode = Constants.ALPHA_ADD; rm.disableDepthWrite = true;
    this.noGlow(streak);
    const part = this.part(streak, N);
    for (let i = 0; i < N; i++) { const o = i * 16; part.buf[o] = 1; part.buf[o + 5] = 1; part.buf[o + 10] = 1; part.buf[o + 15] = 1; }
    this.bind(part, false);
    const ox = new Float32Array(N), oz = new Float32Array(N), y = new Float32Array(N), v = new Float32Array(N);
    for (let i = 0; i < N; i++) { ox[i] = (this.R() - 0.5) * 50; oz[i] = (this.R() - 0.5) * 50; y[i] = this.R() * 22; v[i] = 17 + this.R() * 6; }
    this.rain = { part, ox, oz, y, v, ax: 0, az: 0 };
    // splashes: little flat rings that pop and fade
    const M = 420;
    const ring = this.unit('splash', 0.32, 0.01, 0.32, 0, 0, 0, 0, true);
    const sm = ring.material as StandardMaterial; sm.emissiveColor = hex('#c8d8f0'); sm.alpha = 0.5; sm.alphaMode = Constants.ALPHA_ADD; sm.disableDepthWrite = true;
    this.noGlow(ring);
    const sp = this.part(ring, M);
    this.bind(sp);
    this.splash = { part: sp, age: new Float32Array(M).map(() => this.R() * 0.3), x: new Float32Array(M), z: new Float32Array(M), y: new Float32Array(M) };
    // spray behind the bots on the wet
    const K = 420;
    const drop = this.unit('spray', 0.09, 0.09, 0.09, 0, 0, 0, 0, true);
    const dm = drop.material as StandardMaterial; dm.emissiveColor = hex('#b8c8e0'); dm.alpha = 0.55; dm.alphaMode = Constants.ALPHA_ADD; dm.disableDepthWrite = true;
    this.noGlow(drop);
    const dp = this.part(drop, K);
    this.bind(dp);
    this.spray = { part: dp, age: new Float32Array(K).fill(9), p: new Float32Array(K * 3), v: new Float32Array(K * 3), next: 0, carry: [0, 0, 0, 0] };
    // steam from the manholes
    const Q = 90;
    const puff = this.unit('steam', 0.8, 0.8, 0.8, 0, 0, 0, 0, true);
    const pm = puff.material as StandardMaterial; pm.emissiveColor = hex('#6a6478'); pm.alpha = 0.18; pm.alphaMode = Constants.ALPHA_ADD; pm.disableDepthWrite = true;
    this.noGlow(puff);
    const pp = this.part(puff, Q);
    this.bind(pp);
    this.steam = { ...this.steam, part: pp, age: new Float32Array(Q).map(() => this.R() * 3), vent: new Int16Array(Q).map((_, i) => i % this.steam.vents.length) };
  }

  // ------------------------------------------------------------------------------------------- per frame
  update(dt: number, go: boolean) { this.animate(dt, go); }

  private animate(dt: number, go: boolean) {
    this.t += dt;
    const t = this.t, now = performance.now(), R = this.R;
    const cam = this.scene.activeCamera;
    const camPos = cam ? cam.globalPosition : this.L(0, 5, 0);
    // start lights, police bars, blinkers, traffic lights, flicker
    const rt = this.race.t;
    const lightMat = !go ? this.mats.red : rt < 3 ? this.mats.green : this.mats.lampOff;
    for (const m of this.startLights) m.material = lightMat;
    for (const pc of this.police) { const k = Math.floor((t + pc.ph) * 6) % 2; pc.bar[0].material = k ? this.mats.red : this.mats.redOff; pc.bar[1].material = k ? this.mats.policeB : this.mats.blue; }
    const amberOn = Math.floor(t * 2.5) % 2 === 0;
    for (const m of this.amber) m.material = amberOn ? this.mats.amber : this.mats.amberOff;
    const blinkOn = Math.floor(t / 0.9) % 2 === 0;
    for (const m of this.blinkers) m.setEnabled(this.visible && blinkOn);
    for (const tl of this.trafficLights) { const red = Math.floor((t + tl.ph) / 6) % 2 === 0; tl.r.material = red ? this.mats.red : this.mats.redOff; tl.g.material = red ? this.mats.greenOff : this.mats.green; }
    for (const f of this.flicker) f.m.visibility = Math.sin(t * f.rate * 7 + f.ph) > -0.85 || Math.sin(t * 31 + f.ph) > 0.5 ? 1 : 0.15;
    this.puddleMat.emissiveColor.set(0.15 + 0.04 * Math.sin(t * 1.7), 0.12 + 0.03 * Math.sin(t * 2.3 + 1), 0.3 + 0.06 * Math.sin(t * 1.1 + 2));
    this.heli.rotor.rotation.y += dt * 30;
    this.heli.light.setEnabled(this.visible && Math.floor(t * 1.5) % 2 === 0);
    this.lightning(dt);
    this.drawScreen(go);
    this.fadeOccluders(camPos, dt);
    this.updateRain(dt, camPos);
    this.updateSpray(dt);
    this.updateTraffic(dt);
    this.updateHeli(dt);
    // crowd at most ~40 updates a second
    if (now - this.animAt < 24 && dt > 0) return;
    this.animAt = now;
    const ox = this.O.x, oy = this.O.y, oz = this.O.z;
    const bots = this.race.racers.filter(r => !r.down).map(r => ({ x: r.bot.root.position.x - ox, z: r.bot.root.position.z - oz }));
    const C = this.crowd, put = NightCity.put;
    this.people.forEach((p, i) => {
      let e = p.hype;
      for (const b of bots) { const d2 = (p.x - b.x) ** 2 + (p.z - b.z) ** 2; if (d2 < p.reach * p.reach * 4) e = Math.max(e, Math.exp(-d2 / (p.reach * p.reach))); }
      e = Math.min(1, e);
      const jump = e * 0.18 * Math.max(0, Math.sin(t * 8 + p.ph)) + 0.01 * Math.sin(t * 2 + p.ph);
      const tx = p.x + ox, ty = p.y + oy + jump, tz = p.z + oz, s = p.s, yaw = p.yaw;
      put(C.legs.buf, i, yaw, s, 0, 0, 0, 0, tx, ty, tz);
      put(C.torso.buf, i, yaw, s, 0, 0, 0, 0, tx, ty, tz);
      put(C.head.buf, i, yaw, s, 0, 0, 0, 0, tx, ty, tz);
      const swing = e * 0.35 * Math.sin(t * 11 + p.ph);
      const aL = -(0.15 + 2.6 * e) + swing;
      const aR = p.brella >= 0 ? -1.2 : -(0.15 + 2.6 * e) + e * 0.35 * Math.sin(t * 11 + p.ph + 1.3);   // the umbrella hand stays up
      put(C.armL.buf, i, yaw, s, aL, -0.205, 0.66, 0, tx, ty, tz);
      put(C.armR.buf, i, yaw, s, aR, 0.205, 0.66, 0, tx, ty, tz);
      if (p.brella >= 0) {
        const bob = e * 0.06 * Math.sin(t * 8 + p.ph);
        put(C.stick.buf, p.brella, yaw, s, 0, 0, 0, 0, tx, ty + bob, tz);
        put(C.brella.buf, p.brella, yaw + 0.3 * Math.sin(t * 0.7 + p.ph), s, 0.04 * Math.sin(t * 1.3 + p.ph), 0, 0, 0, tx, ty + bob, tz);
      }
    });
    for (const part of Object.values(C)) part.mesh.thinInstanceBufferUpdated('matrix');
  }

  /** Strikes every 6-16 s: a bolt far out, a double flash (race.flash -> lights), clouds lit up, thunder a bit later. */
  private lightning(dt: number) {
    this.nextBolt -= dt;
    if (this.nextBolt <= 0 && this.visible) {
      this.nextBolt = 6 + this.R() * 10;
      this.flashT = 0;
      this.boltOn = Math.floor(this.R() * this.bolts.length);
      const a = this.R() * Math.PI * 2, r = 130 + this.R() * 120;
      const b = this.bolts[this.boltOn];
      b.position = this.L(9 + Math.cos(a) * r, 0, 10 + Math.sin(a) * r); b.rotation.y = this.R() * Math.PI;
      this.thunder(r);
    }
    if (this.flashT > -1) {
      this.flashT += dt;
      const ft = this.flashT;
      const f = ft < 0.08 ? 1 : ft < 0.16 ? 0.25 : ft < 0.24 ? 0.85 : Math.max(0, 0.85 - (ft - 0.24) * 2.5);
      this.flash = f;
      this.bolts.forEach((b, i) => b.setEnabled(this.visible && i === this.boltOn && ft < 0.32 && !(ft > 0.08 && ft < 0.16)));
      if (ft > 0.6) { this.flashT = -9; this.flash = 0; for (const b of this.bolts) b.setEnabled(false); }
    }
    const f = this.flash;
    this.cloudMat.emissiveColor.set(0.11 + f * 0.6, 0.08 + f * 0.6, 0.16 + f * 0.75);
  }
  /** Thunder: low filtered noise, rumbling, delayed by the distance (sound only once the browser allows audio). */
  private thunder(dist: number) {
    try {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      this.audio ??= new AC();
      const ac = this.audio;
      if (ac.state === 'suspended') void ac.resume();
      const len = 3.5, buf = ac.createBuffer(1, Math.floor(ac.sampleRate * len), ac.sampleRate), d = buf.getChannelData(0);
      let last = 0;
      for (let i = 0; i < d.length; i++) { last = last * 0.97 + (Math.random() * 2 - 1) * 0.03; d[i] = last * 6 * (Math.random() < 0.002 ? 3 : 1); }
      const src = ac.createBufferSource(); src.buffer = buf;
      const lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 160 + Math.random() * 80;
      const g = ac.createGain();
      const t0 = ac.currentTime + Math.min(2.5, dist / 120);
      const vol = Math.max(0.15, 0.55 - dist / 600);
      g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(vol, t0 + 0.08); g.gain.exponentialRampToValueAtTime(vol * 0.5, t0 + 0.9);
      g.gain.linearRampToValueAtTime(vol * 0.7, t0 + 1.3); g.gain.exponentialRampToValueAtTime(0.001, t0 + len);
      src.connect(lp); lp.connect(g); g.connect(ac.destination);
      src.start(t0); src.stop(t0 + len);
    } catch { /* no audio: fine */ }
  }

  /** Tunnel roof, overpass, infield block: see-through while they're between the camera and your bot. */
  private fadeOccluders(camPos: Vector3, dt: number) {
    const me = this.race.player()?.bot.root.position;
    for (const o of this.occluders) {
      const hide = !!me && segBox(camPos, me.add(new Vector3(0, 0.4, 0)), o.min, o.max);
      const want = hide ? 0.18 : 1;
      o.vis += (want - o.vis) * Math.min(1, dt * 8);
      if (Math.abs(o.vis - want) < 0.01) o.vis = want;
      for (const m of o.meshes) m.visibility = o.vis;
    }
  }

  private updateRain(dt: number, cam: Vector3) {
    const r = this.rain, N = r.ox.length, buf = r.part.buf;
    const ox = this.O.x, oz = this.O.z, T = CITY_TUNNEL;
    const wind = 1.2;
    for (let i = 0; i < N; i++) {
      r.y[i] -= r.v[i] * dt;
      r.oz[i] -= wind * dt;
      let x = r.ox[i], z = r.oz[i];
      // keep the streaks in a 50 m box round the camera (wrap)
      x = cam.x + (((x - cam.x + 25) % 50) + 50) % 50 - 25; z = cam.z + (((z - cam.z + 25) % 50) + 50) % 50 - 25;
      r.ox[i] = x; r.oz[i] = z;
      if (r.y[i] < 0) r.y[i] += 18 + this.R() * 4;
      const lx = x - ox, lz = z - oz;
      const y = r.y[i] + cam.y - 6;
      const hidden = y < this.O.y || (lx > T.x0 && lx < T.x1 && Math.abs(lz) < T.halfW + 0.5 && y < T.roof + this.O.y + 0.6);
      const o = i * 16;
      buf[o + 12] = x; buf[o + 13] = hidden ? -500 : y; buf[o + 14] = z;
    }
    r.part.mesh.thinInstanceBufferUpdated('matrix');
    // splashes round the camera
    const s = this.splash, M = s.age.length, sb = s.part.buf, sc = s.part.col;
    for (let i = 0; i < M; i++) {
      s.age[i] += dt;
      if (s.age[i] > 0.28) {
        s.age[i] = 0;
        const a = this.R() * Math.PI * 2, d = Math.sqrt(this.R()) * 20;
        s.x[i] = cam.x + Math.cos(a) * d; s.z[i] = cam.z + Math.sin(a) * d;
        const lx = s.x[i] - ox, lz = s.z[i] - oz;
        s.y[i] = this.inTunnel(lx, lz) ? -500 : this.O.y + 0.02;
      }
      const k = s.age[i] / 0.28, sz = 0.3 + k * 1.1, o = i * 16;
      sb[o] = sz; sb[o + 5] = 1; sb[o + 10] = sz; sb[o + 15] = 1;
      sb[o + 12] = s.x[i]; sb[o + 13] = s.y[i]; sb[o + 14] = s.z[i];
      const f = 1 - k;
      sc[i * 4] = f; sc[i * 4 + 1] = f; sc[i * 4 + 2] = f; sc[i * 4 + 3] = 1;
    }
    s.part.mesh.thinInstanceBufferUpdated('matrix'); s.part.mesh.thinInstanceBufferUpdated('color');
    // steam
    const st = this.steam, Q = st.age.length, pb = st.part.buf, pc = st.part.col;
    for (let i = 0; i < Q; i++) {
      st.age[i] += dt;
      if (st.age[i] > 3) st.age[i] -= 3;
      const v = st.vents[st.vent[i]], k = st.age[i] / 3, sz = 0.6 + k * 2.2, o = i * 16;
      pb[o] = sz; pb[o + 5] = sz; pb[o + 10] = sz; pb[o + 15] = 1;
      pb[o + 12] = v.x + Math.sin(i * 7.1 + k * 2) * 0.6 * k; pb[o + 13] = v.y + 0.3 + k * 4.5; pb[o + 14] = v.z + Math.cos(i * 3.3) * 0.5 * k - k * 1.5;
      const f = Math.sin(k * Math.PI);
      pc[i * 4] = f; pc[i * 4 + 1] = f; pc[i * 4 + 2] = f; pc[i * 4 + 3] = 1;
    }
    st.part.mesh.thinInstanceBufferUpdated('matrix'); st.part.mesh.thinInstanceBufferUpdated('color');
  }

  /** Spray thrown up behind each bot on the wet (lots on a wet patch). */
  private updateSpray(dt: number) {
    const sp = this.spray, K = sp.age.length, buf = sp.part.buf, col = sp.part.col;
    this.race.racers.forEach((r, ri) => {
      if (r.down || r.bot.eliminated || !r.wet || r.wet === 'dry') return;
      const v = r.bot.body.getLinearVelocity(), speed = Math.hypot(v.x, v.z);
      if (speed < 2) return;
      sp.carry[ri] = (sp.carry[ri] ?? 0) + dt * (r.wet === 'patch' ? 220 : 35) * Math.min(1, speed / 8);
      const fwd = forward(r.bot); fwd.y = 0; fwd.normalize();
      const right = new Vector3(fwd.z, 0, -fwd.x), pos = r.bot.root.position;
      while (sp.carry[ri] >= 1) {
        sp.carry[ri] -= 1;
        const i = sp.next; sp.next = (sp.next + 1) % K;
        const side = this.R() < 0.5 ? -1 : 1;
        sp.p[i * 3] = pos.x - fwd.x * 0.5 + right.x * side * 0.45; sp.p[i * 3 + 1] = pos.y - 0.15; sp.p[i * 3 + 2] = pos.z - fwd.z * 0.5 + right.z * side * 0.45;
        const k = r.wet === 'patch' ? 1 : 0.6;
        sp.v[i * 3] = -fwd.x * speed * 0.25 + right.x * side * (0.6 + this.R() * 1.5) * k + v.x * 0.3;
        sp.v[i * 3 + 1] = (1.5 + this.R() * 2.5) * k;
        sp.v[i * 3 + 2] = -fwd.z * speed * 0.25 + right.z * side * (0.6 + this.R() * 1.5) * k + v.z * 0.3;
        sp.age[i] = 0;
      }
    });
    for (let i = 0; i < K; i++) {
      const o = i * 16;
      if (sp.age[i] > 0.7) { buf[o + 13] = -500; continue; }
      sp.age[i] += dt;
      sp.v[i * 3 + 1] -= 9.8 * dt;
      sp.p[i * 3] += sp.v[i * 3] * dt; sp.p[i * 3 + 1] += sp.v[i * 3 + 1] * dt; sp.p[i * 3 + 2] += sp.v[i * 3 + 2] * dt;
      const k = sp.age[i] / 0.7, sz = 0.6 + k * 1.6;
      buf[o] = sz; buf[o + 5] = sz; buf[o + 10] = sz; buf[o + 15] = 1;
      buf[o + 12] = sp.p[i * 3]; buf[o + 13] = sp.p[i * 3 + 1]; buf[o + 14] = sp.p[i * 3 + 2];
      const f = 1 - k; col[i * 4] = f; col[i * 4 + 1] = f; col[i * 4 + 2] = f; col[i * 4 + 3] = 1;
    }
    sp.part.mesh.thinInstanceBufferUpdated('matrix'); sp.part.mesh.thinInstanceBufferUpdated('color');
  }

  private updateTraffic(dt: number) {
    const C = this.carParts, at = new Vector3(), m = new Matrix(), q = new Quaternion(), one = new Vector3(1, 1, 1);
    this.cars.forEach((c, i) => {
      c.d += c.speed * dt;
      const yaw = this.pathAt(c.path, c.d, at);
      at.y += 0.02;
      Quaternion.RotationYawPitchRollToRef(yaw, 0, 0, q);
      Matrix.ComposeToRef(one, q, at, m);
      for (const part of [C.body, C.cabin, C.head, C.tail, C.beam]) m.copyToArray(part.buf, i * 16);
    });
    for (const part of [C.body, C.cabin, C.head, C.tail, C.beam]) part.mesh.thinInstanceBufferUpdated('matrix');
  }

  /** The helicopter circles the track; its searchlight follows the race leader. */
  private updateHeli(dt: number) {
    const h = this.heli, t = this.t, a = t * 0.06;
    h.root.position = this.L(9 + Math.cos(a) * 48, 30 + Math.sin(t * 0.4) * 1.5, 10 + Math.sin(a) * 36);
    h.root.rotation.y = -a; h.root.rotation.z = 0.12;
    const lead = this.race.standings().find(r => !r.down);
    const want = lead ? lead.bot.root.position.clone() : this.L(9, 0, 10);
    Vector3.LerpToRef(h.aim, want, Math.min(1, dt * 1.5), h.aim);
    const from = h.root.position.add(new Vector3(0, -1, 0)), to = new Vector3(h.aim.x, this.O.y + 0.02, h.aim.z);
    const len = Vector3.Distance(from, to);
    h.beam.scaling.y = len;
    h.beam.position = from.add(to).scale(0.5);
    const dir = to.subtract(from).normalize();
    const axis = Vector3.Cross(Vector3.Up(), dir.scale(-1)), ang = Math.acos(Math.max(-1, Math.min(1, Vector3.Dot(Vector3.Up(), dir.scale(-1)))));
    h.beam.rotationQuaternion = axis.lengthSquared() > 1e-6 ? Quaternion.RotationAxis(axis.normalize(), ang) : Quaternion.Identity();
    h.pool.position = to.add(new Vector3(0, 0.02, 0));
  }

  /** Jumbotron over the tunnel: lap + top four, twice a second. */
  private drawScreen(go: boolean) {
    const race = this.race, now = performance.now();
    if (now - this.screen.at < 500) return;
    this.screen.at = now;
    const st = race.standings(), lead = st[0], lap = lead ? race.lap(lead) : 1;
    const head = !go ? 'GET READY' : lead?.finished !== undefined ? 'CHECKERED FLAG!' : `LAP ${lap} / ${race.laps}`;
    const text = head + '|' + st.map(r => r.name + (r.finished !== undefined ? '*' : '')).join('|');
    if (text === this.screen.text) return;
    this.screen.text = text;
    const ctx = this.screen.tex.getContext() as unknown as CanvasRenderingContext2D;
    ctx.fillStyle = '#07040e'; ctx.fillRect(0, 0, 1024, 576);
    ctx.fillStyle = '#ff2bd6'; ctx.fillRect(0, 0, 1024, 86);
    ctx.fillStyle = '#07040e'; ctx.font = 'bold 54px system-ui, sans-serif'; ctx.textBaseline = 'middle';
    ctx.fillText('NIGHT CITY GRAND PRIX', 28, 45);
    ctx.fillStyle = '#4dd2ff'; ctx.font = 'bold 80px system-ui, sans-serif';
    ctx.fillText(head, 28, 160);
    ctx.font = 'bold 54px system-ui, sans-serif';
    st.slice(0, 4).forEach((r, i) => {
      const y = 262 + i * 76;
      ctx.fillStyle = '#8fa3ad'; ctx.fillText(`${i + 1}`, 34, y);
      ctx.fillStyle = r.paint; ctx.fillText(r.name + (r.human ? '  (YOU)' : ''), 100, y);
      if (r.finished !== undefined) { ctx.fillStyle = '#39ff14'; ctx.fillText('FIN', 880, y); }
    });
    this.screen.tex.update();
  }
}

/** Does the segment a-b pass through the box? (slab test) */
function segBox(a: Vector3, b: Vector3, min: Vector3, max: Vector3) {
  let t0 = 0, t1 = 1;
  for (const k of ['x', 'y', 'z'] as const) {
    const d = b[k] - a[k];
    if (Math.abs(d) < 1e-9) { if (a[k] < min[k] || a[k] > max[k]) return false; continue; }
    let u0 = (min[k] - a[k]) / d, u1 = (max[k] - a[k]) / d;
    if (u0 > u1) [u0, u1] = [u1, u0];
    t0 = Math.max(t0, u0); t1 = Math.min(t1, u1);
    if (t0 > t1) return false;
  }
  return true;
}
