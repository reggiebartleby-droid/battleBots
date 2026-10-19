/**
 * v0.35b OVAL SPEEDWAY scenery (user: "as polished as possible, lively"). Visual only -- no colliders; everything sits
 * outside the track walls (the track, walls, kerbs and gantry frame are in race.ts).
 *
 *   ground        mowed infield (diagonal stripes, painted logo), rough outer grass, parking lot, far ground
 *   track detail  rubbered racing line, seams + patches, skid marks, double yellow apron line, sponsor boards on the
 *                 outer wall, SAFER band, catch fence
 *   pit + infield 6 team garages (interior: banner, tool chests, bench, tyre stacks, shelves, a spare bot on a stand,
 *                 roll-up door), hospitality floor, pit-wall timing stands, pit crew, race control tower (blinking
 *                 beacon), medical centre, jumbotron with live standings, helipad + helicopter (rotor turns), flags
 *   stands        2 grandstands: tiers, coloured seat sections, aisles + handrails, banners, railing, roof truss + lamps,
 *                 flags, a crowd of cube people that cheer when bots go by and do the stadium wave
 *   background    sky dome, drifting cube clouds, a circling blimp, light towers, a ring of cube trees, parked cars
 *   start lights  5 lights on the gantry: red until GO, green for 3 s
 *
 * Local coordinates as race.ts: start straight along +x at z = 0 (finish at x = 0), infield = +z, back straight at z = 32.
 */
import {
  Color3, DynamicTexture, GlowLayer, Matrix, Mesh, MeshBuilder, Quaternion, Scene, StandardMaterial, Vector3,
} from '@babylonjs/core';
import type { Race, Sample } from './race.js';

/** Seeded random: the scenery looks the same every load. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
/** Smooth value noise in [0, 1]. */
function noise2(x: number, z: number) {
  const h = (i: number, j: number) => { const s = Math.sin(i * 127.1 + j * 311.7) * 43758.5453; return s - Math.floor(s); };
  const xi = Math.floor(x), zi = Math.floor(z), xf = x - xi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), v = zf * zf * (3 - 2 * zf);
  const a = h(xi, zi), b = h(xi + 1, zi), c = h(xi, zi + 1), d = h(xi + 1, zi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
const hexRGB = (hex: string) => Color3.FromHexString(hex);

const SHIRTS = ['#ff2bd6', '#4dd2ff', '#39ff14', '#ffc400', '#ff6a1f', '#b88cff', '#f2f2f2', '#ff3b3b', '#1f6bff', '#00e5c0'];
const PANTS = ['#1d2a4a', '#222428', '#3b3b44', '#5a4a32', '#2b3d2b', '#4a2b2b'];
const SKIN = ['#f1c27d', '#e0ac69', '#c68642', '#8d5524', '#ffdbac', '#5c3a21'];
const TEAMS = ['#ff2bd6', '#4dd2ff', '#39ff14', '#ffc400', '#ff6a1f', '#b88cff'];

interface Person {
  x: number; y: number; z: number; f: 1 | -1; s: number; ph: number; hype: number;
  group: number;          // 0 / 1 = grandstand, 2 = pit crew
  sign: number; hat: number;   // index into the sign / hat instance buffers, -1 = none
}
interface Part { mesh: Mesh; buf: Float32Array; col: Float32Array }

export class Raceway {
  private meshes: Mesh[] = [];
  private mats: Record<string, StandardMaterial> = {};
  private groups: Record<string, Mesh[]> = {};
  private R = rng(20261019);
  private O: Vector3;
  private half: number;
  // animated bits
  private people: Person[] = [];
  private parts!: { legs: Part; torso: Part; head: Part; armL: Part; armR: Part; hat: Part; sign: Part };
  private flags: { x: number; y: number; z: number; yaw: number; ph: number }[] = [];
  private flagPart!: Part;
  private clouds: { m: Mesh; speed: number }[] = [];
  private blimp!: Mesh;
  private rotor!: Mesh;
  private beacon!: Mesh;
  private startLights: Mesh[] = [];
  private screen!: { tex: DynamicTexture; at: number; text: string };
  private t = 0;
  private animAt = 0;
  private standFront = [0, 0];   // z of each grandstand's front edge

  constructor(private scene: Scene, private race: Race) {
    this.O = race.origin; this.half = race.width / 2;
    this.makeMats();
    this.buildGround();
    this.buildTrackDetail();
    this.buildPits();
    this.buildInfield();
    this.buildStands();
    this.buildBackground();
    this.buildStartLights();
    this.buildCrowdMeshes();
    for (const [key, list] of Object.entries(this.groups)) this.merge(list, key);
    this.groups = {};
    this.animate(0, false);
  }

  setVisible(on: boolean) { for (const m of this.meshes) m.setEnabled(on); }

  // ------------------------------------------------------------------------------------------- helpers
  private L(x: number, y: number, z: number) { return new Vector3(this.O.x + x, this.O.y + y, this.O.z + z); }
  private at(p: Sample, u: number, y = 0) { return this.L(p.x - Math.sin(p.h) * u, y, p.z + Math.cos(p.h) * u); }
  private mat(key: string, hex: string, e = 0, opts: { unlit?: boolean; alpha?: number; spec?: number } = {}) {
    const m = new StandardMaterial('rw_' + key, this.scene);
    const c = hexRGB(hex);
    if (opts.unlit) { m.disableLighting = true; m.emissiveColor = c; m.diffuseColor = Color3.Black(); }
    else { m.diffuseColor = c; m.emissiveColor = c.scale(e); m.specularColor = new Color3(1, 1, 1).scale(opts.spec ?? 0.12); }
    if (opts.alpha !== undefined) m.alpha = opts.alpha;
    this.mats[key] = m;
    return m;
  }
  private makeMats() {
    const M = (k: string, h: string, e = 0, o: { unlit?: boolean; alpha?: number; spec?: number } = {}) => this.mat(k, h, e, o);
    M('rubber', '#25282c'); M('seam', '#202226'); M('patch', '#2e3236'); M('skid', '#1b1c1f');
    M('yellowLine', '#ffc400', 0.5); M('whiteLine', '#f2f2f2', 0.35); M('safer', '#e8ecf0', 0.15); M('saferBlue', '#1f6bff', 0.5);
    M('fence', '#9aa3ab', 0, { alpha: 0.55 }); M('steel', '#8d969e', 0, { spec: 0.4 }); M('darkSteel', '#3b424a', 0, { spec: 0.3 });
    M('concrete', '#9aa0a6'); M('concreteLight', '#c4c9ce'); M('stand', '#1a2030'); M('standSide', '#232a3c');
    M('seatB', '#1f6bff', 0.12); M('seatR', '#d92b2b', 0.12); M('seatY', '#e0a800', 0.12);
    M('cyan', '#4dd2ff', 1, { unlit: true }); M('pink', '#ff2bd6', 1, { unlit: true }); M('lime', '#39ff14', 1, { unlit: true });
    M('violet', '#b88cff', 1, { unlit: true }); M('orange', '#ff9f1c', 1, { unlit: true }); M('yellow', '#ffc400', 1, { unlit: true });
    M('lamp', '#fff3c4', 1, { unlit: true }); M('redLamp', '#ff2a2a', 1, { unlit: true }); M('greenLamp', '#39ff14', 1, { unlit: true });
    M('lampOff', '#2a0b0b'); M('glass', '#5fb8e6', 0.35, { alpha: 0.75, spec: 0.8 }); M('window', '#9fe3ff', 0.55);
    M('garageWall', '#2a3242'); M('garageIn', '#d7dbe0', 0.08); M('epoxy', '#8f969e', 0.04, { spec: 0.5 }); M('roll', '#5c6672', 0, { spec: 0.3 });
    M('tire', '#141414', 0, { spec: 0.05 }); M('wood', '#8a6a44'); M('box', '#b08a5a');
    M('white', '#f2f2f2'); M('black', '#0c0c0c'); M('red', '#d92b2b'); M('roof', '#2e3646');
    M('trunk', '#5a3e26'); M('leaf1', '#2f6b2c'); M('leaf2', '#3f8a35'); M('leaf3', '#24522a');
    M('carGlass', '#1b2a3a', 0.05, { spec: 0.8 }); M('lot', '#2b2d31');
    M('flower1', '#ff4fa3', 0.2); M('flower2', '#ffd23f', 0.2); M('flower3', '#ffffff', 0.15);
    M('cloud', '#ffffff', 1, { unlit: true, alpha: 0.92 }); M('blimp', '#e9edf2', 0.1, { spec: 0.6 });
    for (let i = 0; i < TEAMS.length; i++) { M('team' + i, TEAMS[i], 0.25); M('teamGlow' + i, TEAMS[i], 1, { unlit: true }); }
    for (const c of SHIRTS) M('car' + c, c, 0.05, { spec: 0.6 });
  }
  private add(key: string, m: Mesh) { (this.groups[key] ??= []).push(m); return m; }
  /** Axis-aligned box from local extents. */
  private box(key: string, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number) {
    const b = MeshBuilder.CreateBox('rw', { width: Math.max(0.005, Math.abs(x1 - x0)), height: Math.max(0.005, Math.abs(y1 - y0)), depth: Math.max(0.005, Math.abs(z1 - z0)) }, this.scene);
    b.position = this.L((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    return this.add(key, b);
  }
  /** Box by centre + size, turned about y. */
  private boxC(key: string, x: number, y: number, z: number, w: number, h: number, d: number, rotY = 0) {
    const b = MeshBuilder.CreateBox('rw', { width: w, height: h, depth: d }, this.scene);
    b.position = this.L(x, y, z); b.rotation.y = rotY;
    return this.add(key, b);
  }
  private cyl(key: string, x: number, y: number, z: number, diam: number, h: number, tess = 12, top?: number) {
    const c = MeshBuilder.CreateCylinder('rw', { diameter: diam, diameterTop: top ?? diam, height: h, tessellation: tess }, this.scene);
    c.position = this.L(x, y, z);
    return this.add(key, c);
  }
  /** Thin bar between two world points. */
  private barW(key: string, a: Vector3, b: Vector3, t: number, h = t) {
    const d = Vector3.Distance(a, b);
    if (d < 1e-3) return;
    const m = MeshBuilder.CreateBox('rw', { width: t, height: h, depth: d }, this.scene);
    m.position = a.add(b).scale(0.5);
    m.lookAt(b);
    this.add(key, m);
  }
  private bar(key: string, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, t: number, h = t) {
    this.barW(key, this.L(x0, y0, z0), this.L(x1, y1, z1), t, h);
  }
  private keep(m: Mesh) { m.isPickable = false; this.meshes.push(m); return m; }
  private merge(list: Mesh[], key: string) {
    if (!list.length) return;
    for (let i = 0; i < list.length; i += 2000) {   // big groups in chunks (index buffer size)
      const m = Mesh.MergeMeshes(list.slice(i, i + 2000), true, true, undefined, false, false);
      if (!m) continue;
      m.name = 'rw_' + key; m.material = this.mats[key];
      m.freezeWorldMatrix();
      this.keep(m);
    }
  }
  private noGlow(m: Mesh) { for (const l of this.scene.effectLayers) if (l instanceof GlowLayer) l.addExcludedMesh(m); }
  /** Infield = inside the inner walls. */
  private infield(x: number, z: number, margin = 0) {
    const r = 16 - this.half - 0.3 - margin;
    if (Math.abs(x) <= 22) return z > 16 - r && z < 16 + r;
    return Math.hypot(x - Math.sign(x) * 22, z - 16) < r;
  }
  /** Distance from the oval centre line (local), for "near the track". */
  private trackDist(x: number, z: number) {
    if (Math.abs(x) <= 22) return Math.min(Math.abs(z), Math.abs(z - 32));
    return Math.abs(Math.hypot(x - Math.sign(x) * 22, z - 16) - 16);
  }

  // ------------------------------------------------------------------------------------------- ground
  private buildGround() {
    // fine ground over the track area (the floor collider in race.ts is hidden): vertex colours, 1 m cells
    const x0 = -72, x1 = 72, z0 = -48, z1 = 66, sx = x1 - x0, sz = z1 - z0;
    const g = MeshBuilder.CreateGround('rw_ground', { width: sx, height: sz, subdivisionsX: sx, subdivisionsY: sz }, this.scene);
    g.position = this.L((x0 + x1) / 2, 0, (z0 + z1) / 2);
    const pos = g.getVerticesData('position')!, cols: number[] = [];
    const A = hexRGB('#1f3f1c'), B = hexRGB('#2a5426'), OUT = hexRGB('#21401d'), DRY = hexRGB('#4a4426'), LOT = hexRGB('#2c2e32'), RING = hexRGB('#cfd6c8');
    for (let i = 0; i < pos.length; i += 3) {
      const x = pos[i] + (x0 + x1) / 2, z = pos[i + 2] + (z0 + z1) / 2;
      const n = noise2(x * 0.35, z * 0.35), big = noise2(x * 0.06 + 10, z * 0.06 - 4);
      let c: Color3;
      if (this.infield(x, z)) {
        // mowed diagonal stripes + a painted logo: ring and a checkered disc
        const stripe = Math.floor((x + z) / 3.2) & 1;
        c = (stripe ? A : B).scale(0.92 + n * 0.16);
        const r = Math.hypot(x, z - 18.5);
        if (r > 2.7 && r < 3.5) c = RING.scale(0.9 + n * 0.1);
        else if (r <= 2.7) c = ((Math.floor(x / 1.35) + Math.floor((z - 18.5) / 1.35)) & 1 ? A.scale(0.75) : B.scale(1.25));
      } else if (z < -24 && z > -46 && Math.abs(x) < 46) {
        c = LOT.scale(0.9 + n * 0.2);
      } else {
        c = Color3.Lerp(OUT, DRY, Math.max(0, big - 0.62) * 2.2).scale(0.85 + n * 0.3);
        if (this.trackDist(x, z) < 7) c = c.scale(0.9);   // worn grass by the walls
      }
      cols.push(c.r, c.g, c.b, 1);
    }
    g.setVerticesData('color', cols);
    const gm = new StandardMaterial('rw_groundmat', this.scene);
    gm.diffuseColor = Color3.White(); gm.specularColor = Color3.Black();
    g.material = gm; g.receiveShadows = true;
    this.keep(g);
    // far ground out to the horizon
    const far = MeshBuilder.CreateGround('rw_far', { width: 1000, height: 1000, subdivisions: 50 }, this.scene);
    far.position = this.L(0, -0.06, 16);
    const fp = far.getVerticesData('position')!, fc: number[] = [];
    for (let i = 0; i < fp.length; i += 3) {
      const n = noise2(fp[i] * 0.02, fp[i + 2] * 0.02);
      const c = Color3.Lerp(hexRGB('#1d3a1a'), hexRGB('#3a4524'), n).scale(0.8 + n * 0.25);
      fc.push(c.r, c.g, c.b, 1);
    }
    far.setVerticesData('color', fc);
    far.material = gm;
    this.keep(far);
    // parking lot lines + light poles
    for (let row = 0; row < 4; row++) {
      const zr = -27 - row * 5;
      for (let x = -42; x <= 42; x += 2.6) this.box('whiteLine', x - 0.04, x + 0.04, 0.005, 0.012, zr - 2, zr + 0.4);
    }
    for (let x = -36; x <= 36; x += 18) { this.cyl('darkSteel', x, 3, -36, 0.18, 6, 8); this.box('lamp', x - 0.5, x + 0.5, 5.9, 6.1, -36.25, -35.75); }
  }

  // ------------------------------------------------------------------------------------------- track detail
  private buildTrackDetail() {
    const race = this.race, S = race.samples, n = S.length, half = this.half;
    const sy = (p: Sample, u: number) => race.surfaceY(p, u);
    // racing line: a rubbered band -- wide on the straights, low (inside) through the banks
    const lineU = (_p: Sample) => -0.8;   // straights only (a flat strip can't follow the bank's tilt)
    for (let i = 0; i < n; i += 2) {
      const a = S[i], b = S[(i + 2) % n];
      const ua = lineU(a), ub = lineU(b);
      if (a.tag !== 'bank' && b.tag !== 'bank') this.barW('rubber', this.at(a, ua, sy(a, ua) + 0.008), this.at(b, ub, sy(b, ub) + 0.008), 1.5, 0.004);
      // double yellow apron line (inside edge) + SAFER band on the outer wall
      for (const du of [0.95, 1.12]) this.barW('yellowLine', this.at(a, half - du, sy(a, half - du) + 0.012), this.at(b, half - du, sy(b, half - du) + 0.012), 0.07, 0.004);
      const top = (p: Sample) => sy(p, -half) ;
      this.barW('safer', this.at(a, -half + 0.03, top(a) + 0.15), this.at(b, -half + 0.03, top(b) + 0.15), 0.06, 0.3);
      this.barW('saferBlue', this.at(a, -half + 0.035, top(a) + 0.33), this.at(b, -half + 0.035, top(b) + 0.33), 0.06, 0.05);
    }
    // seams across the straights + repair patches + skid marks into the banks
    const straights = S.filter(p => p.tag !== 'bank');
    for (const p of straights) if (Math.abs((p.q % 11) - 5) < 0.26) this.barW('seam', this.at(p, -half, 0.009), this.at(p, half, 0.009), 0.05, 0.003);
    for (let k = 0; k < 14; k++) {
      const p = straights[Math.floor(this.R() * straights.length)], u = (this.R() - 0.5) * (half * 2 - 2.5);
      const c = this.at(p, u, 0.0095);
      const m = MeshBuilder.CreateBox('rw', { width: 0.8 + this.R() * 0.8, height: 0.003, depth: 1.0 + this.R() * 1.5 }, this.scene);
      m.position = c; m.rotation.y = Math.PI / 2 - p.h + (this.R() - 0.5) * 0.1;
      this.add('patch', m);
    }
    const flatIdx = S.map((p, i) => [p, i] as const).filter(([p]) => p.tag !== 'bank').map(([, i]) => i);
    for (let k = 0; k < 10; k++) {
      const i0 = flatIdx[Math.floor(this.R() * flatIdx.length)];
      let u = (this.R() - 0.5) * half * 1.4;
      const du = (this.R() - 0.5) * 0.12;
      for (let j = 0; j < 14; j++) {
        const a = S[(i0 + j) % n], b = S[(i0 + j + 1) % n];
        if (a.tag === 'bank' || b.tag === 'bank') break;   // flat road only
        const u2 = u + du;
        for (const off of [-0.32, 0.32]) this.barW('skid', this.at(a, u + off, sy(a, u + off) + 0.011), this.at(b, u2 + off, sy(b, u2 + off) + 0.011), 0.14, 0.003);
        u = u2;
      }
    }
    // outer wall sponsor boards (track side) + catch fence on top
    const wallTop = (p: Sample) => 1.0 + (p.tag === 'bank' ? race.width * Math.tan(p.bank) : 0);
    const boards = ['team0', 'team1', 'team2', 'team3', 'team4', 'team5'];
    for (let i = 0; i < n; i += 2) {
      const a = S[i], b = S[(i + 2) % n];
      const slot = Math.floor(a.s / 4.5), inGap = a.s % 4.5 > 4.1;
      if (!inGap) {
        const ya = sy(a, -half) + 0.55, yb = sy(b, -half) + 0.55;
        this.barW(boards[slot % boards.length], this.at(a, -half + 0.03, ya), this.at(b, -half + 0.03, yb), 0.04, 0.38);
      }
      // fence: posts every 3 m, three cables, a light mesh panel
      const ta = wallTop(a), tb = wallTop(b), fu = -(half + 0.15);
      if (i % 6 === 0) this.barW('darkSteel', this.at(a, fu, ta), this.at(a, fu, ta + 2.4), 0.08);
      for (const h of [0.8, 1.6, 2.4]) this.barW('steel', this.at(a, fu, ta + h), this.at(b, fu, tb + h), 0.025);
      this.barW('fence', this.at(a, fu, ta + 1.2), this.at(b, fu, tb + 1.2), 0.01, 2.35);
    }
  }

  // ------------------------------------------------------------------------------------------- pits
  private buildPits() {
    const half = this.half, wallOut = half + 0.3;
    const sx0 = -20, sx1 = 20;
    const pz0 = wallOut + 0.2, pz1 = pz0 + 3.8;
    // pit lane: surface, dashed centre line, speed-limit lines, pit boxes per team
    this.box('lot', sx0 - 2, sx1 + 2, 0, 0.012, pz0, pz1);
    for (let x = sx0 + 0.5; x < sx1 - 1; x += 2) this.box('whiteLine', x, x + 1, 0.012, 0.016, (pz0 + pz1) / 2 - 0.05, (pz0 + pz1) / 2 + 0.05);
    for (const x of [sx0 - 1.5, sx1 + 1.5]) this.box('whiteLine', x - 0.1, x + 0.1, 0.012, 0.016, pz0, pz1);
    for (let x = sx0 - 1.4; x < sx0 + 0.2; x += 0.4) this.bar('whiteLine', x, 0.014, pz0, x + 0.4, 0.014, pz0 + 0.8, 0.06, 0.004);   // hatching
    // pit wall timing stands (on the pit side of the inner track wall)
    const gN = 6, gw = (sx1 - sx0) / gN;
    for (let i = 0; i < gN; i++) {
      const cx = sx0 + (i + 0.5) * gw;
      this.box('darkSteel', cx - 1.0, cx + 1.0, 0, 0.9, pz0, pz0 + 0.7);                      // desk
      this.box('team' + i, cx - 1.0, cx + 1.0, 0.9, 0.95, pz0, pz0 + 0.7);
      for (const dx of [-0.45, 0.45]) { this.box('black', cx + dx - 0.3, cx + dx + 0.3, 0.95, 1.38, pz0 + 0.12, pz0 + 0.17); this.box('cyan', cx + dx - 0.26, cx + dx + 0.26, 0.99, 1.34, pz0 + 0.175, pz0 + 0.18); }
      this.cyl('steel', cx, 1.9, pz0 + 0.35, 0.05, 2.0, 6);                                     // umbrella
      this.cyl('team' + i, cx, 2.85, pz0 + 0.35, 0.05, 0.35, 10, 2.2);
      for (const dx of [-0.6, 0.6]) this.cyl('darkSteel', cx + dx, 0.35, pz0 + 1.0, 0.35, 0.7, 8);   // stools
    }
    // garage block: 6 bays + hospitality floor above
    const gz0 = pz1 + 0.3, gz1 = gz0 + 4.6, gh = 3.2, top = 5.8;
    this.box('garageWall', sx0, sx1, 0, top, gz1, gz1 + 0.25);                                   // back wall
    this.box('roof', sx0 - 0.3, sx1 + 0.3, top, top + 0.3, gz0 - 0.6, gz1 + 0.3);                // roof, overhangs the front
    this.box('cyan', sx0 - 0.3, sx1 + 0.3, top + 0.3, top + 0.36, gz0 - 0.62, gz0 - 0.56);
    this.box('garageWall', sx0, sx1, gh, gh + 0.35, gz0 - 0.1, gz1);                             // floor slab between levels
    // hospitality: glass front with mullions, people silhouettes inside
    this.box('window', sx0 + 0.1, sx1 - 0.1, gh + 0.45, top - 0.2, gz0 + 0.3, gz0 + 0.35);
    for (let x = sx0; x <= sx1 + 0.01; x += 1.25) this.box('darkSteel', x - 0.04, x + 0.04, gh + 0.35, top, gz0 + 0.25, gz0 + 0.4);
    this.box('darkSteel', sx0, sx1, gh + 1.25, gh + 1.32, gz0 + 0.25, gz0 + 0.4);               // hand rail line
    this.box('garageWall', sx0, sx1, gh + 0.35, top, gz0 + 1.6, gz0 + 1.7);                      // room back
    for (const wx of [sx0, sx1]) this.box('garageWall', wx - 0.15, wx + 0.15, 0, top, gz0 - 0.1, gz1 + 0.25);
    for (let i = 0; i < gN; i++) {
      const x0 = sx0 + i * gw, x1 = x0 + gw, cx = (x0 + x1) / 2, team = 'team' + i, glow = 'teamGlow' + i;
      if (i > 0) this.box('garageWall', x0 - 0.1, x0 + 0.1, 0, gh, gz0 - 0.1, gz1);              // dividers
      this.box('epoxy', x0 + 0.1, x1 - 0.1, 0, 0.03, gz0, gz1);                                  // floor
      this.box(team, x0 + 0.1, x1 - 0.1, 0.031, 0.034, gz0 + 0.3, gz0 + 0.45);                   // painted line
      this.box('garageIn', x0 + 0.1, x1 - 0.1, 0.03, gh, gz1 - 0.06, gz1);                       // back wall inside (light)
      // team banner on the back wall + ceiling lights
      this.box(glow, cx - 1.6, cx + 1.6, 1.7, 2.7, gz1 - 0.08, gz1 - 0.06);
      this.box('black', cx - 1.4, cx + 1.4, 1.9, 2.5, gz1 - 0.09, gz1 - 0.085);
      for (let k = 0; k < 4; k++) this.box(glow, cx - 1.2 + k * 0.7, cx - 0.8 + k * 0.7, 2.05, 2.35, gz1 - 0.095, gz1 - 0.09);
      for (const dz of [1.2, 3.0]) this.box('lamp', cx - 1.4, cx + 1.4, gh - 0.06, gh - 0.02, gz0 + dz, gz0 + dz + 0.25);
      // roll-up door housing + half-up door slats
      this.box('roll', x0 + 0.15, x1 - 0.15, gh - 0.55, gh - 0.05, gz0 - 0.08, gz0 + 0.25);
      for (let k = 0; k < 4; k++) this.box('darkSteel', x0 + 0.15, x1 - 0.15, gh - 0.55 - 0.18 * (k + 1), gh - 0.55 - 0.18 * k - 0.02, gz0 - 0.05, gz0 + 0.0);
      // fascia: team colour + number board
      this.box(team, x0 + 0.05, x1 - 0.05, gh - 0.05, gh + 0.35, gz0 - 0.16, gz0 - 0.1);
      this.box('black', cx - 0.45, cx + 0.45, gh - 0.02, gh + 0.32, gz0 - 0.19, gz0 - 0.16);
      this.digit(glow, i + 1, cx, gh + 0.15, gz0 - 0.2);
      // tool chests (drawers), workbench with gear, tyre stacks, shelves, a spare bot on a stand
      for (const [dx, w] of [[-2.4, 0.9], [-1.4, 0.9]] as const) {
        this.box(team, x0 + 0.3 + (dx + 2.4), x0 + 0.3 + (dx + 2.4) + w, 0, 1.05, gz1 - 0.6, gz1 - 0.08);
        for (let d = 0; d < 4; d++) this.box('darkSteel', x0 + 0.35 + (dx + 2.4), x0 + 0.25 + (dx + 2.4) + w, 0.2 + d * 0.22, 0.22 + d * 0.22, gz1 - 0.62, gz1 - 0.6);
      }
      this.box('wood', x1 - 2.4, x1 - 0.3, 0.85, 0.92, gz1 - 0.8, gz1 - 0.1);                    // bench top
      for (const lx of [x1 - 2.3, x1 - 0.4]) this.box('darkSteel', lx - 0.04, lx + 0.04, 0, 0.85, gz1 - 0.75, gz1 - 0.15);
      this.box('box', x1 - 2.2, x1 - 1.7, 0.92, 1.2, gz1 - 0.6, gz1 - 0.25);
      this.box('black', x1 - 1.3, x1 - 0.8, 0.92, 1.25, gz1 - 0.55, gz1 - 0.45);               // laptop screen
      this.box('cyan', x1 - 1.26, x1 - 0.84, 0.96, 1.21, gz1 - 0.565, gz1 - 0.56);
      for (const tz of [gz0 + 1.0, gz0 + 1.8]) for (let k = 0; k < 4; k++) {
        this.cyl('tire', x0 + 0.55, 0.13 + k * 0.26, tz, 0.62, 0.24, 14);
        this.cyl(team, x0 + 0.55, 0.13 + k * 0.26, tz, 0.3, 0.25, 10);
      }
      for (let k = 0; k < 3; k++) {
        this.box('darkSteel', x1 - 0.55, x1 - 0.12, 0.6 + k * 0.6, 0.64 + k * 0.6, gz0 + 0.8, gz0 + 2.6);
        for (let b = 0; b < 3; b++) if (this.R() < 0.8) this.box(this.R() < 0.5 ? 'box' : team, x1 - 0.5, x1 - 0.17, 0.64 + k * 0.6, 0.64 + k * 0.6 + 0.2 + this.R() * 0.15, gz0 + 0.9 + b * 0.55, gz0 + 1.3 + b * 0.55);
      }
      this.box('darkSteel', cx - 0.5, cx + 0.5, 0, 0.45, gz0 + 1.7, gz0 + 2.5);                 // bot stand
      this.box(team, cx - 0.75, cx + 0.75, 0.45, 0.8, gz0 + 1.45, gz0 + 2.75);                   // spare chassis
      this.box('darkSteel', cx - 0.6, cx + 0.6, 0.8, 0.88, gz0 + 1.6, gz0 + 2.6);
      for (const wx of [cx - 0.82, cx + 0.82]) for (const wz of [gz0 + 1.7, gz0 + 2.5]) { const c = this.cyl('tire', wx, 0.62, wz, 0.42, 0.12, 12); c.rotation.z = Math.PI / 2; }
      // front apron: tool cart, air tank, pit board
      this.box('darkSteel', cx + 1.2, cx + 1.9, 0.2, 0.75, pz1 - 1.2, pz1 - 0.7);
      this.box(team, cx + 1.2, cx + 1.9, 0.75, 0.8, pz1 - 1.2, pz1 - 0.7);
      for (const wx of [cx + 1.25, cx + 1.85]) this.cyl('tire', wx, 0.1, pz1 - 0.95, 0.18, 0.5, 8).rotation.x = Math.PI / 2;
      this.cyl('red', cx - 1.8, 0.45, pz1 - 0.6, 0.3, 0.9, 10);
      this.cyl('steel', cx - 0.9, 1.0, pz1 - 0.35, 0.05, 2.0, 6);
      this.box('black', cx - 1.3, cx - 0.5, 1.75, 2.25, pz1 - 0.38, pz1 - 0.32);
      this.box(glow, cx - 1.22, cx - 0.58, 1.82, 2.18, pz1 - 0.39, pz1 - 0.385);
      // pit crew: three in team colours on the apron
      for (let k = 0; k < 3; k++) this.person(cx - 1.2 + k * 1.0 + (this.R() - 0.5) * 0.3, 0, pz1 - 1.6 - this.R() * 0.6, -1, 2, TEAMS[i]);
    }
    // race control tower (pit exit end) + medical centre (other end)
    const tx0 = -25.2, tx1 = -21.2, tz0 = gz0, tz1 = gz1;
    this.box('garageWall', tx0, tx1, 0, 9, tz0, tz1);
    this.box('window', tx0 - 0.05, tx1 + 0.05, 6.4, 8.4, tz0 - 0.05, tz1 + 0.05);
    for (let x = tx0; x <= tx1 + 0.01; x += 0.8) this.box('darkSteel', x - 0.04, x + 0.04, 6.4, 8.4, tz0 - 0.07, tz0 - 0.03);
    this.box('roof', tx0 - 0.4, tx1 + 0.4, 9, 9.3, tz0 - 0.4, tz1 + 0.4);
    this.box('cyan', tx0 - 0.4, tx1 + 0.4, 9.3, 9.36, tz0 - 0.42, tz0 - 0.36);
    for (let k = 0; k < 3; k++) this.box('window', tx0 + 0.6 + k * 1.2, tx0 + 1.2 + k * 1.2, 1.2 + k * 1.7, 2.2 + k * 1.7, tz0 - 0.03, tz0 - 0.01);
    this.cyl('darkSteel', (tx0 + tx1) / 2, 10.5, (tz0 + tz1) / 2, 0.08, 2.4, 6);
    this.beacon = this.keep(MeshBuilder.CreateBox('rw_beacon', { size: 0.25 }, this.scene));
    this.beacon.position = this.L((tx0 + tx1) / 2, 11.8, (tz0 + tz1) / 2); this.beacon.material = this.mats.redLamp;
    const mx0 = 21.2, mx1 = 24.6;
    this.box('white', mx0, mx1, 0, 3.2, gz0, gz1);
    this.box('roof', mx0 - 0.2, mx1 + 0.2, 3.2, 3.4, gz0 - 0.2, gz1 + 0.2);
    const mc = (mx0 + mx1) / 2;
    this.box('red', mc - 0.6, mc + 0.6, 2.2, 2.5, gz0 - 0.05, gz0 - 0.02); this.box('red', mc - 0.15, mc + 0.15, 1.75, 2.95, gz0 - 0.05, gz0 - 0.02);
    this.box('window', mx0 + 0.3, mc - 0.8, 1.0, 1.9, gz0 - 0.03, gz0 - 0.01); this.box('window', mc + 0.8, mx1 - 0.3, 1.0, 1.9, gz0 - 0.03, gz0 - 0.01);
    // ambulance + safety truck parked by the medical centre
    this.vehicle(mc, gz1 + 2.2, 0, 'white', 'red', 2.6);
    this.vehicle(mc - 4, gz1 + 2.2, 0, 'yellowLine', 'darkSteel', 2.2);
  }
  /** A 7-segment digit (bars) facing -z at (x, y, z). */
  private digit(key: string, d: number, x: number, y: number, z: number) {
    const seg = ['1110111', '0010010', '1011101', '1011011', '0111010', '1101011', '1101111', '1010010', '1111111', '1111011'][d % 10];
    const w = 0.22, h = 0.12, t = 0.04;
    const S: [number, number, number, number][] = [[-w / 2, h, w / 2, h], [-w / 2, 0, -w / 2, h], [w / 2, 0, w / 2, h], [-w / 2, 0, w / 2, 0], [-w / 2, -h, -w / 2, 0], [w / 2, -h, w / 2, 0], [-w / 2, -h, w / 2, -h]];
    S.forEach(([ax, ay, bx, by], k) => { if (seg[k] === '1') this.bar(key, x + ax, y + ay, z, x + bx, y + by, z, t); });
  }
  private vehicle(x: number, z: number, rotY: number, body: string, trim: string, len = 2.4) {
    const c = Math.cos(rotY), s = Math.sin(rotY);
    const P = (dx: number, dz: number) => [x + dx * c + dz * s, z - dx * s + dz * c] as const;
    const [bx, bz] = P(0, 0);
    this.boxC(body, bx, 0.55, bz, 1.3, 0.7, len, rotY);
    const [cx, cz] = P(0, -len * 0.12);
    this.boxC(body, cx, 1.1, cz, 1.2, 0.45, len * 0.55, rotY);
    this.boxC('carGlass', cx, 1.12, cz, 1.24, 0.3, len * 0.5, rotY);
    this.boxC(trim, bx, 0.62, bz, 1.32, 0.12, len + 0.02, rotY);
    for (const wz of [-len * 0.32, len * 0.32]) { const [wx, wzz] = P(0, wz); this.boxC('tire', wx, 0.22, wzz, 1.42, 0.44, 0.44, rotY); }
  }

  // ------------------------------------------------------------------------------------------- infield
  private buildInfield() {
    // jumbotron (both sides) with live standings
    const jx = 0, jz = 23.4, jy = 6.2, W = 11, H = 4.1;
    for (const lx of [-3.5, 3.5]) {
      this.box('darkSteel', jx + lx - 0.25, jx + lx + 0.25, 0, jy - H / 2, jz - 0.25, jz + 0.25);
      for (let y = 0.8; y < jy - H / 2; y += 1.0) this.bar('steel', jx + lx - 0.25, y, jz - 0.27, jx + lx + 0.25, y + 0.8, jz - 0.27, 0.05);
    }
    this.box('black', jx - W / 2 - 0.3, jx + W / 2 + 0.3, jy - H / 2 - 0.3, jy + H / 2 + 0.3, jz - 0.35, jz + 0.35);
    this.box('cyan', jx - W / 2 - 0.3, jx + W / 2 + 0.3, jy + H / 2 + 0.3, jy + H / 2 + 0.36, jz - 0.36, jz + 0.36);
    const tex = new DynamicTexture('rw_screen', { width: 1024, height: 384 }, this.scene, true);
    const sm = new StandardMaterial('rw_screenmat', this.scene);
    sm.disableLighting = true; sm.emissiveTexture = tex; sm.diffuseColor = Color3.Black(); sm.specularColor = Color3.Black();
    for (const side of [-1, 1]) {
      const pl = MeshBuilder.CreatePlane('rw_screenpl', { width: W, height: H }, this.scene);
      pl.position = this.L(jx, jy, jz + side * 0.37);
      if (side > 0) pl.rotation.y = Math.PI;
      pl.material = sm; this.keep(pl); this.noGlow(pl);
    }
    this.screen = { tex, at: -1, text: '' };
    // helipad + helicopter (rotor spins)
    const hx = 13.5, hz = 20;
    this.cyl('concrete', hx, 0.01, hz, 5.2, 0.02, 24);
    this.box('white', hx - 0.9, hx - 0.6, 0.025, 0.03, hz - 1.2, hz + 1.2); this.box('white', hx + 0.6, hx + 0.9, 0.025, 0.03, hz - 1.2, hz + 1.2); this.box('white', hx - 0.6, hx + 0.6, 0.025, 0.03, hz - 0.15, hz + 0.15);
    this.boxC('red', hx, 1.0, hz, 1.3, 1.1, 2.4); this.boxC('carGlass', hx, 1.15, hz - 1.0, 1.2, 0.7, 0.6);
    this.boxC('red', hx, 1.25, hz + 2.2, 0.3, 0.35, 2.4); this.boxC('red', hx, 1.75, hz + 3.3, 0.08, 0.9, 0.5);
    for (const sx of [-0.55, 0.55]) this.boxC('darkSteel', hx + sx, 0.25, hz, 0.08, 0.08, 2.6);
    this.cyl('darkSteel', hx, 1.7, hz, 0.12, 0.35, 6);
    const rotor = MeshBuilder.CreateBox('rw_rotor', { width: 5.2, height: 0.04, depth: 0.22 }, this.scene);
    const r2 = MeshBuilder.CreateBox('rw_rotor2', { width: 0.22, height: 0.04, depth: 5.2 }, this.scene);
    this.rotor = Mesh.MergeMeshes([rotor, r2], true)!; this.rotor.material = this.mats.darkSteel;
    this.rotor.position = this.L(hx, 1.9, hz); this.keep(this.rotor);
    // flag poles behind the garages + flower beds round the logo + tyre barriers inside the turns
    for (const x of [-19, -15, -11, 11, 15, 19]) this.flagPole(x, 0, 16.5, 7, 0);
    for (let k = 0; k < 22; k++) {
      const a = k / 22 * Math.PI * 2, r = 4.2;
      this.boxC(['flower1', 'flower2', 'flower3'][k % 3], Math.cos(a) * r, 0.12, 18.5 + Math.sin(a) * r, 0.5, 0.24, 0.5, a);
    }
    for (const sx of [-1, 1]) for (let k = 0; k < 9; k++) {
      const a = Math.PI / 2 + (k - 4) * 0.16, cx = sx * 22 + sx * Math.cos(a - Math.PI / 2) * 8.5, cz = 16 + Math.sin(a - Math.PI / 2) * 8.5;
      for (let l = 0; l < 3; l++) { this.cyl('tire', cx, 0.12 + l * 0.24, cz, 0.6, 0.23, 12); if (l === 2) this.cyl(k % 2 ? 'red' : 'white', cx, 0.12 + l * 0.24 + 0.005, cz, 0.62, 0.08, 12); }
    }
    for (let k = 0; k < 6; k++) this.tree(-14 + k * 5.6 + (this.R() - 0.5), 25.5 - this.R() * 0.6, 0.7);   // hedge row by the back wall
  }
  private flagPole(x: number, y: number, z: number, h: number, yaw: number) {
    this.cyl('steel', x, y + h / 2, z, 0.08, h, 6);
    this.cyl('steel', x, y + h + 0.05, z, 0.16, 0.1, 6);
    this.flags.push({ x, y: y + h - 0.35, z, yaw, ph: this.R() * 6 });
  }
  private tree(x: number, z: number, k = 1) {
    const h = (1.6 + this.R() * 1.6) * k;
    this.box('trunk', x - 0.18 * k, x + 0.18 * k, 0, h * 0.5, z - 0.18 * k, z + 0.18 * k);
    const leaves = ['leaf1', 'leaf2', 'leaf3'];
    const n = 2 + Math.floor(this.R() * 3);
    for (let i = 0; i < n; i++) {
      const s = (1.0 + this.R() * 0.9) * k;
      this.boxC(leaves[Math.floor(this.R() * 3)], x + (this.R() - 0.5) * 0.8 * k, h * 0.5 + s * 0.45 + i * 0.45 * k, z + (this.R() - 0.5) * 0.8 * k, s, s * 0.8, s, this.R() * 0.6);
    }
  }

  // ------------------------------------------------------------------------------------------- grandstands
  private buildStands() {
    const half = this.half, wallOut = half + 0.3;
    this.standFront = [-(wallOut + 1.2), 32 + wallOut + 1.2];
    this.stand(0, this.standFront[0], -1);
    this.stand(1, this.standFront[1], 1);
  }
  /** dir: which way the stand climbs (-1 = toward -z, the main stand). People face the track (-dir). */
  private stand(idx: number, zFront: number, dir: 1 | -1) {
    const sx0 = -20, sx1 = 20, rows = 7, depth = 1.15, rise = 0.55;
    const aisles = [-16, -8, 0, 8, 16];
    const inAisle = (x: number, pad = 0.6) => aisles.some(a => Math.abs(x - a) < pad);
    const seats = ['seatB', 'seatR', 'seatY'];
    const face = (-dir) as 1 | -1;
    for (let k = 0; k < rows; k++) {
      const za = zFront + dir * k * depth, zb = za + dir * depth, hgt = rise * (k + 1);
      this.box('stand', sx0, sx1, 0, hgt, Math.min(za, zb), Math.max(za, zb));
      this.box('cyan', sx0, sx1, hgt, hgt + 0.03, za - 0.03, za + 0.03);
      // seat rows per section (between aisles), backs toward the top of the stand
      const zs = za + dir * (depth - 0.35);
      const edges = [sx0, ...aisles, sx1];
      for (let e = 0; e < edges.length - 1; e++) {
        const a = edges[e] + (e > 0 ? 0.6 : 0.1), b = edges[e + 1] - (e < edges.length - 2 ? 0.6 : 0.1);
        this.box(seats[(e + idx) % 3], a, b, hgt, hgt + 0.22, Math.min(zs, zs + dir * 0.3), Math.max(zs, zs + dir * 0.3));
        this.box(seats[(e + idx) % 3], a, b, hgt + 0.22, hgt + 0.5, Math.min(zs + dir * 0.25, zs + dir * 0.32), Math.max(zs + dir * 0.25, zs + dir * 0.32));
      }
      // aisle steps (half rises) + handrails
      for (const ax of aisles) {
        this.box('concreteLight', ax - 0.55, ax + 0.55, hgt, hgt + 0.02, Math.min(za, zb), Math.max(za, zb));
        this.box('concreteLight', ax - 0.55, ax + 0.55, hgt, hgt + rise / 2, Math.min(za + dir * depth / 2, zb), Math.max(za + dir * depth / 2, zb));
      }
      // the crowd on this tier
      for (let x = sx0 + 0.35; x < sx1 - 0.25; x += 0.55) {
        if (inAisle(x) || this.R() < 0.12) continue;
        this.person(x + (this.R() - 0.5) * 0.12, hgt, za + dir * (0.3 + this.R() * 0.25), face, idx);
      }
    }
    for (const ax of aisles) this.bar('steel', ax, rise + 0.9, zFront + dir * 0.2, ax, rise * rows + 0.9, zFront + dir * (rows * depth - 0.4), 0.05);
    // front: banners on the tier-0 face, a railing above
    const bannerKeys = ['pink', 'cyan', 'lime', 'orange', 'violet', 'yellow'];
    for (let x = sx0, b = idx; x < sx1 - 0.1; x += 4, b++) {
      this.box('black', x + 0.1, x + 3.9, 0.05, rise - 0.05, zFront - 0.04, zFront + 0.04);
      this.box(bannerKeys[b % bannerKeys.length], x + 0.25, x + 3.75, 0.15, rise - 0.15, zFront - dir * 0.06 - 0.01, zFront - dir * 0.06 + 0.01);
    }
    for (let x = sx0; x <= sx1 + 0.01; x += 2) this.box('steel', x - 0.03, x + 0.03, rise, rise + 1.0, zFront - 0.03, zFront + 0.03);
    this.box('steel', sx0, sx1, rise + 0.97, rise + 1.03, zFront - 0.03, zFront + 0.03);
    this.box('glass', sx0, sx1, rise + 0.1, rise + 0.95, zFront - 0.01, zFront + 0.01);
    // back + side walls, roof with truss, lamps, flags
    const zBack = zFront + dir * rows * depth, roofY = rise * rows + 3.0;
    this.box('standSide', sx0, sx1, 0, roofY, Math.min(zBack, zBack + dir * 0.3), Math.max(zBack, zBack + dir * 0.3));
    for (const wx of [sx0 - 0.3, sx1]) {
      this.box('standSide', wx, wx + 0.3, 0, roofY, Math.min(zFront, zBack), Math.max(zFront, zBack));
      this.box('cyan', wx - 0.01, wx + 0.31, roofY - 0.04, roofY, Math.min(zFront, zBack), Math.max(zFront, zBack));
    }
    const rz0 = zFront - dir * 0.8, rz1 = zBack + dir * 0.3;
    this.box('roof', sx0 - 0.5, sx1 + 0.5, roofY, roofY + 0.25, Math.min(rz0, rz1), Math.max(rz0, rz1));
    this.box('cyan', sx0 - 0.5, sx1 + 0.5, roofY + 0.25, roofY + 0.31, rz0 - 0.03, rz0 + 0.03);
    this.box('black', sx0 - 0.5, sx1 + 0.5, roofY - 0.6, roofY, rz0 - 0.05, rz0 + 0.05);                // fascia
    for (let x = sx0, b = 0; x < sx1; x += 5, b++) this.box(bannerKeys[(b + 2) % 6], x + 0.3, x + 4.7, roofY - 0.5, roofY - 0.1, rz0 + 0.06 * -dir - 0.01, rz0 + 0.06 * -dir + 0.01);
    const zl = rz0 + dir * 0.25;   // lamps just inside the fascia
    for (let x = sx0 + 1; x < sx1; x += 2) this.box('lamp', x - 0.25, x + 0.25, roofY - 0.7, roofY - 0.62, zl - 0.12, zl + 0.12);
    for (let x = sx0; x <= sx1 + 0.01; x += 4) {
      this.bar('darkSteel', x, roofY - 0.02, rz0, x, roofY - 0.02, rz1, 0.08);
      this.bar('darkSteel', x, roofY - 0.02, rz0, x, roofY - 1.2, (rz0 + rz1) / 2, 0.06);
      this.bar('darkSteel', x, roofY - 1.2, (rz0 + rz1) / 2, x, roofY - 0.02, rz1, 0.06);
    }
    for (let x = sx0 + 2; x < sx1; x += 6) this.flagPole(x, roofY + 0.25, (rz0 + rz1) / 2, 2.6, 0);
    // steps up to the stand + a few people walking the concourse below / behind
    for (const ex of [sx0 - 1.6, sx1 + 1.6]) for (let k = 0; k < rows; k++) {
      const z = zFront + dir * (k + 0.5) * depth;
      this.box('concreteLight', ex - 0.9, ex + 0.9, 0, rise * (k + 1), Math.min(z - depth / 2, z + depth / 2), Math.max(z - depth / 2, z + depth / 2));
    }
  }

  // ------------------------------------------------------------------------------------------- background
  private buildBackground() {
    // sky dome
    const [topHex, horHex] = this.race.def.theme.sky!;
    const top = hexRGB(topHex), hor = hexRGB(horHex);
    const sky = MeshBuilder.CreateSphere('rw_sky', { diameter: 900, segments: 24, sideOrientation: Mesh.BACKSIDE }, this.scene);
    const pos = sky.getVerticesData('position')!, cols: number[] = [];
    for (let i = 0; i < pos.length; i += 3) {
      const k = Math.max(0, pos[i + 1] / 450), c = Color3.Lerp(hor, top, Math.pow(k, 0.55));
      if (pos[i + 1] < 0) c.scaleInPlace(0.8);
      cols.push(c.r, c.g, c.b, 1);
    }
    sky.setVerticesData('color', cols);
    const skyMat = new StandardMaterial('rw_skymat', this.scene);
    skyMat.disableLighting = true; skyMat.diffuseColor = Color3.Black(); skyMat.emissiveColor = Color3.White(); skyMat.specularColor = Color3.Black();
    sky.material = skyMat; sky.infiniteDistance = true;
    this.keep(sky); this.noGlow(sky);
    // drifting cube clouds
    for (let c = 0; c < 14; c++) {
      const parts: Mesh[] = [];
      const n = 5 + Math.floor(this.R() * 6);
      for (let i = 0; i < n; i++) {
        const s = 6 + this.R() * 9;
        const b = MeshBuilder.CreateBox('rw', { width: s * 1.6, height: s * 0.55, depth: s }, this.scene);
        b.position.set((this.R() - 0.5) * 22, (this.R() - 0.3) * 4, (this.R() - 0.5) * 12);
        parts.push(b);
      }
      const m = Mesh.MergeMeshes(parts, true)!;
      m.material = this.mats.cloud;
      const a = this.R() * Math.PI * 2, r = 120 + this.R() * 200;
      m.position = this.L(Math.cos(a) * r, 70 + this.R() * 50, 16 + Math.sin(a) * r);
      this.keep(m); this.noGlow(m);
      this.clouds.push({ m, speed: 1.2 + this.R() * 1.5 });
    }
    // blimp: cube hull, fins, gondola, neon banners
    const bp: { m: Mesh; key: string }[] = [];
    const B = (key: string, x: number, y: number, z: number, w: number, h: number, d: number) => {
      const b = MeshBuilder.CreateBox('rw', { width: w, height: h, depth: d }, this.scene); b.position.set(x, y, z); bp.push({ m: b, key });
    };
    for (let i = -5; i <= 5; i++) { const r = Math.sqrt(1 - (i / 6) ** 2); B('blimp', 0, 0, i * 1.6, 5.2 * r, 4.4 * r, 1.65); }
    B('team1', 0, 3.2, -7.4, 0.2, 2.4, 2.2); B('team1', 0, -3.2, -7.4, 0.2, 2.4, 2.2); B('team1', 3.0, 0, -7.4, 2.4, 0.2, 2.2); B('team1', -3.0, 0, -7.4, 2.4, 0.2, 2.2);
    B('darkSteel', 0, -2.7, 0.5, 1.2, 0.8, 3.0); B('window', 0, -2.65, 0.5, 1.25, 0.3, 2.6);
    for (const sx of [-1, 1]) { B('black', sx * 2.62, 0.2, 0, 0.05, 1.6, 9); B('pink', sx * 2.66, 0.2, 0, 0.05, 1.2, 8.4); }
    const groupsB: Record<string, Mesh[]> = {};
    for (const { m, key } of bp) (groupsB[key] ??= []).push(m);
    const blimpRoot = new Mesh('rw_blimp', this.scene);
    for (const [key, list] of Object.entries(groupsB)) { const m = Mesh.MergeMeshes(list, true)!; m.material = this.mats[key]; m.parent = blimpRoot; this.keep(m); }
    this.blimp = blimpRoot; this.keep(blimpRoot);
    // light towers in the four corners
    for (const [x, z] of [[-46, -18], [46, -18], [-46, 50], [46, 50]] as const) {
      this.box('darkSteel', x - 0.35, x + 0.35, 0, 22, z - 0.35, z + 0.35);
      for (let y = 2; y < 21; y += 2) { this.bar('steel', x - 0.35, y, z - 0.37, x + 0.35, y + 1.6, z - 0.37, 0.05); this.bar('steel', x + 0.35, y, z + 0.37, x - 0.35, y + 1.6, z + 0.37, 0.05); }
      this.box('darkSteel', x - 2.2, x + 2.2, 21.6, 24.4, z - 0.25, z + 0.25);
      for (let i = 0; i < 4; i++) for (let j = 0; j < 3; j++) this.box('lamp', x - 1.9 + i * 1.0, x - 1.3 + i * 1.0, 21.8 + j * 0.9, 22.5 + j * 0.9, z + (z < 16 ? 0.26 : -0.27), z + (z < 16 ? 0.28 : -0.25));
    }
    // ring of cube trees (not over the parking lot / stands)
    for (let k = 0; k < 230; k++) {
      const a = this.R() * Math.PI * 2, r = 68 + this.R() * 75;
      const x = Math.cos(a) * r * 1.15, z = 16 + Math.sin(a) * r;
      if (z < -20 && z > -50 && Math.abs(x) < 50) continue;
      this.tree(x, z, 1.4 + this.R() * 1.2);
    }
    // parked cars
    const colours = SHIRTS;
    for (let row = 0; row < 4; row++) for (let x = -40.7; x < 41; x += 2.6) {
      if (this.R() < 0.25) continue;
      this.vehicle(x, -28.3 - row * 5, 0, 'car' + colours[Math.floor(this.R() * colours.length)], 'darkSteel', 2.4);
    }
  }

  // ------------------------------------------------------------------------------------------- start lights
  private buildStartLights() {
    const gz = this.half + 0.3 + 0.6, gy = 4.6;
    // checkered gantry over the finish line (x = 0): posts, beam, checkers both faces, neon strips, sponsor box on top
    for (const z of [-gz, gz]) {
      this.box('steel', -0.25, 0.25, 0, gy + 0.9, z - 0.25, z + 0.25);
      for (let y = 0.6; y < gy; y += 0.9) this.bar('darkSteel', -0.27, y, z - 0.25, -0.27, y + 0.7, z + 0.25, 0.04);
    }
    this.box('black', -0.25, 0.25, gy, gy + 0.9, -gz, gz);
    const nC = Math.round((gz * 2) / 0.4);
    for (let row = 0; row < 2; row++) for (let i = 0; i < nC; i++) {
      const z = -gz + (i + 0.5) * (gz * 2 / nC);
      this.boxC((i + row) % 2 ? 'white' : 'black', 0, gy + 0.25 + row * 0.4, z, 0.54, 0.38, gz * 2 / nC);
    }
    for (const x of [-0.3, 0.3]) this.box('cyan', x - 0.03, x + 0.03, gy - 0.03, gy + 0.02, -gz, gz);
    this.box('roof', -0.6, 0.6, gy + 0.9, gy + 1.7, -2.5, 2.5);
    this.box('pink', -0.62, -0.6, gy + 1.0, gy + 1.6, -2.3, 2.3); this.box('pink', 0.6, 0.62, gy + 1.0, gy + 1.6, -2.3, 2.3);
    this.box('black', -0.32, -0.26, gy - 0.75, gy - 0.05, -1.6, 1.6);
    for (let i = 0; i < 5; i++) {
      const m = MeshBuilder.CreateBox('rw_startlight', { width: 0.06, height: 0.42, depth: 0.42 }, this.scene);
      m.position = this.L(-0.34, gy - 0.4, -1.2 + i * 0.6);
      m.material = this.mats.lampOff;
      this.keep(m); this.startLights.push(m);
    }
  }

  // ------------------------------------------------------------------------------------------- crowd (thin instances)
  private person(x: number, y: number, z: number, f: 1 | -1, group: number, shirt?: string) {
    const R = this.R;
    this.people.push({ x, y, z, f, s: 0.9 + R() * 0.25, ph: R() * Math.PI * 2, hype: group === 2 ? 0.05 : R() < 0.15 ? 0.3 + R() * 0.3 : R() * 0.1,
      group, sign: -1, hat: -1, ...(shirt ? { shirt } : {}) } as Person & { shirt?: string });
  }
  private buildCrowdMeshes() {
    const unit = (name: string, w: number, h: number, d: number, ox: number, oy: number, oz: number, e = 0.06) => {
      const m = MeshBuilder.CreateBox('rw_' + name, { width: w, height: h, depth: d }, this.scene);
      m.bakeTransformIntoVertices(Matrix.Translation(ox, oy, oz));
      const mat = new StandardMaterial('rw_crowd_' + name, this.scene);
      mat.diffuseColor = Color3.White(); mat.specularColor = new Color3(0.1, 0.1, 0.1); mat.emissiveColor = new Color3(e, e, e);
      m.material = mat; m.alwaysSelectAsActiveMesh = true; m.isPickable = false;
      this.keep(m);
      return m;
    };
    const P = this.people, n = P.length;
    const nSign = P.filter(p => p.group < 2 && this.R() < 0.07).length;
    let si = 0, hi = 0;
    for (const p of P) {
      if (p.group < 2 && si < nSign && this.R() < 0.08) p.sign = si++;
      if (this.R() < (p.group === 2 ? 1 : 0.3)) p.hat = hi++;
    }
    const mk = (mesh: Mesh, count: number): Part => {
      const buf = new Float32Array(Math.max(1, count) * 16), col = new Float32Array(Math.max(1, count) * 4);
      return { mesh, buf, col };
    };
    this.parts = {
      legs: mk(unit('legs', 0.24, 0.36, 0.16, 0, 0.18, 0), n),
      torso: mk(unit('torso', 0.32, 0.34, 0.2, 0, 0.53, 0), n),
      head: mk(unit('head', 0.22, 0.22, 0.22, 0, 0.82, 0), n),
      armL: mk(unit('armL', 0.09, 0.3, 0.09, 0, -0.13, 0), n),
      armR: mk(unit('armR', 0.09, 0.3, 0.09, 0, -0.13, 0), n),
      hat: mk(unit('hat', 0.25, 0.08, 0.28, 0, 0.97, 0.02), hi),
      sign: mk(unit('sign', 0.62, 0.3, 0.03, 0, 1.28, 0.04, 0.35), si),
    };
    const setCol = (part: Part, i: number, hex: string, j = 1) => { const c = hexRGB(hex); part.col.set([c.r * j, c.g * j, c.b * j, 1], i * 4); };
    P.forEach((p, i) => {
      const shirt = (p as Person & { shirt?: string }).shirt ?? SHIRTS[Math.floor(this.R() * SHIRTS.length)];
      const j = 0.85 + this.R() * 0.2;
      setCol(this.parts.legs, i, p.group === 2 ? '#222428' : PANTS[Math.floor(this.R() * PANTS.length)], j);
      setCol(this.parts.torso, i, shirt, j);
      setCol(this.parts.head, i, SKIN[Math.floor(this.R() * SKIN.length)]);
      const sleeves = this.R() < 0.5 ? shirt : SKIN[Math.floor(this.R() * SKIN.length)];
      setCol(this.parts.armL, i, sleeves, j); setCol(this.parts.armR, i, sleeves, j);
      if (p.hat >= 0) setCol(this.parts.hat, p.hat, p.group === 2 ? shirt : SHIRTS[Math.floor(this.R() * SHIRTS.length)]);
      if (p.sign >= 0) setCol(this.parts.sign, p.sign, SHIRTS[Math.floor(this.R() * SHIRTS.length)], 1.1);
    });
    for (const part of Object.values(this.parts)) {
      part.mesh.thinInstanceSetBuffer('matrix', part.buf, 16, false);
      part.mesh.thinInstanceSetBuffer('color', part.col, 4, true);
    }
    // flags (thin instances too, they wave)
    const flag = unit('flag', 0.95, 0.55, 0.02, 0.5, 0, 0, 0.25);
    this.flagPart = mk(flag, this.flags.length);
    this.flags.forEach((_, i) => setCol(this.flagPart, i, TEAMS[i % TEAMS.length]));
    flag.thinInstanceSetBuffer('matrix', this.flagPart.buf, 16, false);
    flag.thinInstanceSetBuffer('color', this.flagPart.col, 4, true);
  }

  /** Row-major instance matrix: scale s, turn about local x by a (arms), face f (+1 = +z, -1 = -z), pivot P, then T. */
  private static put(buf: Float32Array, k: number, f: number, s: number, a: number, px: number, py: number, pz: number, tx: number, ty: number, tz: number) {
    const o = k * 16, c = Math.cos(a), sn = Math.sin(a);
    buf[o] = f * s; buf[o + 1] = 0; buf[o + 2] = 0; buf[o + 3] = 0;
    buf[o + 4] = 0; buf[o + 5] = s * c; buf[o + 6] = f * s * sn; buf[o + 7] = 0;
    buf[o + 8] = 0; buf[o + 9] = -s * sn; buf[o + 10] = f * s * c; buf[o + 11] = 0;
    buf[o + 12] = f * s * px + tx; buf[o + 13] = s * py + ty; buf[o + 14] = f * s * pz + tz; buf[o + 15] = 1;
  }

  // ------------------------------------------------------------------------------------------- per frame
  update(dt: number, go: boolean) { this.animate(dt, go); }

  private animate(dt: number, go: boolean) {
    this.t += dt;
    const t = this.t, now = performance.now();
    // clouds drift, blimp circles, rotor spins, beacon blinks
    for (const c of this.clouds) { c.m.position.x += c.speed * dt; if (c.m.position.x - this.O.x > 330) c.m.position.x -= 660; }
    const ba = t * 0.035;
    this.blimp.position = this.L(Math.cos(ba) * 85, 38 + Math.sin(t * 0.3) * 1.2, 16 + Math.sin(ba) * 70);
    this.blimp.rotation.y = -ba;   // nose along the circle
    this.rotor.rotation.y += dt * 2.2;
    this.beacon.material = Math.floor(t / 0.6) % 2 ? this.mats.redLamp : this.mats.lampOff;
    // start lights: red until GO, green for 3 s, then off
    const rt = this.race.t;
    const lightMat = !go ? this.mats.redLamp : rt < 3 ? this.mats.greenLamp : this.mats.lampOff;
    for (const m of this.startLights) m.material = lightMat;
    this.drawScreen(go);
    // crowd + flags: at most ~40 updates a second
    if (now - this.animAt < 24 && dt > 0) return;
    this.animAt = now;
    const O = this.O, ox = O.x, oy = O.y, oz = O.z;
    const bots = this.race.racers.filter(r => !r.down).map(r => ({ x: r.bot.root.position.x - ox, z: r.bot.root.position.z - oz }));
    const trackZ = [0, 32];
    const len = 40;
    const P = this.parts, put = Raceway.put;
    this.people.forEach((p, i) => {
      let e = p.hype;
      if (p.group < 2) {
        const waveX = -28 + ((t * 7 + p.group * 23) % (len + 16));
        e = Math.max(e, Math.exp(-((p.x - waveX) ** 2) / 1.4));
        for (const b of bots) if (Math.abs(b.z - trackZ[p.group]) < 12) e = Math.max(e, Math.exp(-((p.x - b.x) ** 2) / 30));
      } else for (const b of bots) if (Math.abs(b.z) < 8) e = Math.max(e, 0.6 * Math.exp(-((p.x - b.x) ** 2) / 20));
      e = Math.min(1, e);
      const jump = e * 0.2 * Math.max(0, Math.sin(t * 8 + p.ph)) + 0.012 * Math.sin(t * 2 + p.ph);
      const tx = p.x + ox, ty = p.y + oy + jump, tz = p.z + oz, f = p.f, s = p.s;
      put(P.legs.buf, i, f, s, 0, 0, 0, 0, tx, ty, tz);
      put(P.torso.buf, i, f, s, 0, 0, 0, 0, tx, ty, tz);
      put(P.head.buf, i, f, s, 0, 0, 0, 0, tx, ty, tz);
      const aL = -(0.15 + 2.65 * e) + e * 0.35 * Math.sin(t * 11 + p.ph), aR = -(0.15 + 2.65 * e) + e * 0.35 * Math.sin(t * 11 + p.ph + 1.3);
      put(P.armL.buf, i, f, s, aL, -0.205, 0.66, 0, tx, ty, tz);
      put(P.armR.buf, i, f, s, aR, 0.205, 0.66, 0, tx, ty, tz);
      if (p.hat >= 0) put(P.hat.buf, p.hat, f, s, 0, 0, 0, 0, tx, ty, tz);
      if (p.sign >= 0) put(P.sign.buf, p.sign, f, s, 0, 0, 0.08 * Math.sin(t * 5 + p.ph) * e, 0, tx, ty, tz);
    });
    for (const part of Object.values(P)) part.mesh.thinInstanceBufferUpdated('matrix');
    // flags wave
    const q = new Quaternion(), m = new Matrix(), one = new Vector3(1, 1, 1);
    this.flags.forEach((fl, i) => {
      Quaternion.RotationYawPitchRollToRef(fl.yaw + 0.35 * Math.sin(t * 3.1 + fl.ph) + 0.15 * Math.sin(t * 7.3 + fl.ph * 2), 0, 0.05 * Math.sin(t * 5 + fl.ph), q);
      Matrix.ComposeToRef(one, q, new Vector3(fl.x + ox, fl.y + oy, fl.z + oz), m);
      m.copyToArray(this.flagPart.buf, i * 16);
    });
    this.flagPart.mesh.thinInstanceBufferUpdated('matrix');
  }

  /** Jumbotron: lap + top four, redrawn twice a second. */
  private drawScreen(go: boolean) {
    const race = this.race, now = performance.now();
    if (now - this.screen.at < 500) return;
    this.screen.at = now;
    const st = race.standings();
    const lead = st[0];
    const lap = lead ? race.lap(lead) : 1;
    const head = !go ? 'GET READY' : lead?.finished !== undefined ? 'CHECKERED FLAG!' : `LAP ${lap} / ${race.laps}`;
    const text = head + '|' + st.map(r => r.name + (r.finished !== undefined ? '*' : '')).join('|');
    if (text === this.screen.text) return;
    this.screen.text = text;
    const ctx = this.screen.tex.getContext() as unknown as CanvasRenderingContext2D;
    ctx.fillStyle = '#05070c'; ctx.fillRect(0, 0, 1024, 384);
    ctx.fillStyle = '#4dd2ff'; ctx.fillRect(0, 0, 1024, 70);
    ctx.fillStyle = '#05070c'; ctx.font = 'bold 44px system-ui, sans-serif'; ctx.textBaseline = 'middle';
    ctx.fillText('ROBOT REVOLUTION SPEEDWAY', 24, 37);
    ctx.fillStyle = '#ffc400'; ctx.font = 'bold 62px system-ui, sans-serif';
    ctx.fillText(head, 24, 120);
    ctx.font = 'bold 40px system-ui, sans-serif';
    st.slice(0, 4).forEach((r, i) => {
      const y = 190 + i * 48;
      ctx.fillStyle = '#8fa3ad'; ctx.fillText(`${i + 1}`, 30, y);
      ctx.fillStyle = r.paint; ctx.fillText(r.name + (r.human ? '  (YOU)' : ''), 80, y);
      if (r.finished !== undefined) { ctx.fillStyle = '#39ff14'; ctx.fillText('FIN', 880, y); }
    });
    this.screen.tex.update();
  }
}
