/**
 * v0.23 TEST COURSE (user): a separate mode for testing each bot's mobility and weapon, one station at a time.
 * The course is its own floor far away from the arena (COURSE_ORIGIN), with the same driving-surface physics
 * (floor friction 0.8, SURFACE_BIT so the wheel treads roll on it). Stations are built on demand.
 *
 * Timing is physics time (one 1/240 s sub-step at a time, see afterPhysics), so a run takes the same time on a
 * fast or slow PC. The timer starts when the bot's centre crosses the start line.
 *
 * Stations
 *  drag    30 m straight: splits at 10 / 20 m, top speed.
 *  slalom  6 cones, 5 m apart: pass them on alternate sides (pad shows the side). +1 s per cone knocked, +2 s per
 *          cone passed on the wrong side.
 *  fig8    figure-8 round two posts through 9 gates in order (next gate is bright). Max tilt.
 *  bumps   three bumps (4 / 6 / 8 cm), a 40 cm ramp, a platform and a sheer 40 cm drop. Max tilt, flipped.
 *  push    shove a crate (same weight as your bot) into the goal box 10 m away.
 *  weapon  15 s fixed window: damage to a steel test block (no armor) + to a dummy BLUE LIFT (its own armor,
 *          never breaks). Same rules as a match: spinners / hammers score the energy they lose on contact,
 *          lifters / flippers / grabbers the energy they give the dummy (a fixed block takes none).
 */
import {
  Color3, Constants, Mesh, MeshBuilder, PhysicsAggregate, PhysicsBody, PhysicsShapeType, Quaternion, Scene, StandardMaterial, Vector3,
  type IPhysicsCollisionEvent, PhysicsEventType, type Observer,
} from '@babylonjs/core';
import { SURFACE_BIT, WALL_BIT } from './arena.js';
import { spinEnergy, armEnergy, energyOf, type Bot } from './bot.js';
import { SPIN_DMG, type Combat } from './combat.js';

export type StationId = 'drag' | 'slalom' | 'fig8' | 'bumps' | 'push' | 'weapon';
export const STATIONS: { id: StationId; name: string; blurb: string }[] = [
  { id: 'drag', name: 'DRAG STRIP', blurb: '30 m flat out · splits 10 / 20 m · top speed' },
  { id: 'slalom', name: 'SLALOM', blurb: '6 cones · alternate sides · +1 s per cone hit, +2 s per wrong side' },
  { id: 'fig8', name: 'FIGURE-8', blurb: 'round two posts through 9 gates · max tilt' },
  { id: 'bumps', name: 'BUMPS / RAMP / DROP', blurb: 'bumps, 40 cm ramp, platform, 40 cm drop · tilt · flips' },
  { id: 'push', name: 'PUSH BOX', blurb: 'shove a crate (your weight) 10 m into the goal' },
  { id: 'weapon', name: 'WEAPON TARGETS', blurb: '15 s · steel block + dummy Blue Lift · damage dealt' },
];

/** Course floor centre (world). Far from the arena so the arena colliders never matter. */
export const COURSE_ORIGIN = new Vector3(0, 0, 200);
export const COURSE = {
  size: 60,              // floor width, m
  wallH: 1.2,
  z0: -12,               // station local z=0 (the spawn) sits here on the floor
  weaponSeconds: 15,
  coneHitPenalty: 1,
  wrongSidePenalty: 2,
  coneMoved: 0.15,       // m a cone has to move (or tip) to count as hit
  gateR: 1.6,            // figure-8 gate radius
  dummyHp: 1e6,          // the dummy never breaks
};

const STEP = 1 / 240;    // = main.ts SUB_STEP_MS

export interface RunResult {
  station: StationId;
  time: number;          // s, raw
  penalty: number;       // s
  final: number;         // s, time + penalty
  splits: { label: string; t: number }[];
  topSpeed: number;      // m/s
  maxTilt: number;       // deg
  flipped: boolean;
  coneHits: number;
  wrongSide: number;
  pushDist: number;      // m the crate moved toward the goal
  crateKg: number;
  blockDmg: number | null;   // null = weapon can't score on a fixed block (hinged weapons)
  dummyDmg: number;
  hits: number;
  biggest: number;
}

interface Item { mesh: Mesh; agg?: PhysicsAggregate }
interface BlockContact { body: PhysicsBody; energy: () => number; eBefore: number; lost: number; touching: boolean; idle: number; start: number; active: boolean }

export class Course {
  private base: Mesh[] = [];
  private items: Item[] = [];
  private mats: Record<string, StandardMaterial> = {};
  station: StationId | null = null;

  // run state
  private bot: Bot | null = null;
  private dummy: Bot | null = null;
  private combat: Combat | null = null;
  private t = 0;               // physics time since begin()
  private t0 = -1;             // start-line time (-1 = not started)
  private tEnd = -1;           // finish time
  private prev = Vector3.Zero();
  private r: RunResult = blank('drag');
  private cones: { mesh: Mesh; home: Vector3; hit: boolean }[] = [];
  private coneZ: { z: number; side: -1 | 1; done: boolean }[] = [];
  private gates: { p: Vector3; mesh: Mesh }[] = [];
  private gateIdx = 0;
  private crate: Mesh | null = null;
  private crateStartZ = 0;
  private block: PhysicsAggregate | null = null;
  private blockContacts: BlockContact[] = [];
  private blockObs: { body: PhysicsBody; obs: Observer<IPhysicsCollisionEvent> }[] = [];
  private nextSplit = 0;
  private splitZ: { z: number; label: string }[] = [];
  private finishZ = Infinity;

  constructor(private scene: Scene) {
    const m = (name: string, hex: string, emissive = true) => {
      const mat = new StandardMaterial('course_' + name, scene);
      const c = Color3.FromHexString(hex);
      if (emissive) { mat.disableLighting = true; mat.emissiveColor = c; }
      else { mat.diffuseColor = c; mat.specularColor = new Color3(0.15, 0.15, 0.15); }
      this.mats[name] = mat;
      return mat;
    };
    m('black', '#000000', false);
    m('grid', '#0b3a44'); m('edge', '#00e5ff'); m('start', '#39ff14'); m('finish', '#ffffff'); m('split', '#ffc400');
    m('lane', '#1a8fa3'); m('gate', '#3a5560'); m('gateNext', '#ffc400'); m('pad', '#a040ff');
    m('cone', '#ff7a1a', false); m('steel', '#8d969e', false); m('crate', '#7a5a34', false); m('ramp', '#3b4650', false);
    const glass = new StandardMaterial('course_glass', scene);
    glass.disableLighting = true; glass.alpha = 0.5; glass.alphaMode = Constants.ALPHA_ADD; glass.backFaceCulling = false;
    glass.emissiveColor = Color3.FromHexString('#00e5ff').scale(0.06);
    this.mats.glass = glass;

    // ---- floor + perimeter (built once) ----
    const S = COURSE.size, h = S / 2, O = COURSE_ORIGIN;
    const floor = MeshBuilder.CreateBox('course_floor', { width: S, depth: S, height: 0.5 }, scene);
    floor.position = O.add(new Vector3(0, -0.25, 0));
    floor.material = this.mats.black;
    floor.receiveShadows = true;
    new PhysicsAggregate(floor, PhysicsShapeType.BOX, { mass: 0, friction: 0.8, restitution: 0.1 }, scene).shape.filterMembershipMask = SURFACE_BIT;
    this.base.push(floor);
    const walls = [{ x: 0, z: h, r: 0 }, { x: 0, z: -h, r: 0 }, { x: h, z: 0, r: Math.PI / 2 }, { x: -h, z: 0, r: Math.PI / 2 }];
    for (const [i, w] of walls.entries()) {
      const wall = MeshBuilder.CreateBox(`course_wall${i}`, { width: S + 0.5, depth: 0.25, height: COURSE.wallH }, scene);
      wall.position = O.add(new Vector3(w.x, COURSE.wallH / 2, w.z)); wall.rotation.y = w.r; wall.material = glass;
      new PhysicsAggregate(wall, PhysicsShapeType.BOX, { mass: 0, friction: 0.3, restitution: 0.4 }, scene).shape.filterMembershipMask = WALL_BIT;
      this.base.push(wall);
    }
    // floor grid every 2 m (visual), outer edge bright
    const lines: Mesh[] = [];
    for (let v = -h; v <= h + 1e-6; v += 2) {
      const edge = Math.abs(Math.abs(v) - h) < 1e-6;
      lines.push(this.line(new Vector3(v, 0.005, -h), new Vector3(v, 0.005, h), edge ? 0.06 : 0.02, edge ? 'edge' : 'grid', true));
      lines.push(this.line(new Vector3(-h, 0.005, v), new Vector3(h, 0.005, v), edge ? 0.06 : 0.02, edge ? 'edge' : 'grid', true));
    }
    const grid = Mesh.MergeMeshes(lines, true, true, undefined, false, true)!;
    grid.name = 'course_grid'; grid.isPickable = false;
    this.base.push(grid);
    this.setVisible(false);
  }

  setVisible(on: boolean) {
    for (const m of this.base) m.setEnabled(on);
    for (const it of this.items) it.mesh.setEnabled(on);
  }

  /** Course mesh? (main.ts hides everything else while the course is showing) */
  static owns(name: string) { return name.startsWith('course_'); }

  // ---------------------------------------------------------------------------------------------------
  // geometry helpers (local station coords: x right, z forward from the spawn)
  private w(x: number, y: number, z: number) { return COURSE_ORIGIN.add(new Vector3(x, y, z + COURSE.z0)); }

  /** Thin visual bar between two WORLD points (abs) or local points. */
  private line(a: Vector3, b: Vector3, t: number, mat: string, abs = false): Mesh {
    const A = abs ? COURSE_ORIGIN.add(a) : this.w(a.x, a.y, a.z), B = abs ? COURSE_ORIGIN.add(b) : this.w(b.x, b.y, b.z);
    const box = MeshBuilder.CreateBox('course_line', { width: t, height: 0.01, depth: Vector3.Distance(A, B) }, this.scene);
    box.position = A.add(B).scale(0.5);
    box.lookAt(B);
    box.material = this.mats[mat];
    box.isPickable = false;
    return box;
  }
  private mark(a: Vector3, b: Vector3, t: number, mat: string) { this.items.push({ mesh: this.line(a, b, t, mat) }); }
  /** Line across the course at local z, from x0 to x1. */
  private across(z: number, x0: number, x1: number, mat: string, t = 0.12) { this.mark(new Vector3(x0, 0.012, z), new Vector3(x1, 0.012, z), t, mat); }

  /** Static box collider (+ mesh). surface = the wheel treads roll on it (floor-like). */
  private box(name: string, x: number, y: number, z: number, sx: number, sy: number, sz: number, mat: string, surface: boolean, rotX = 0, friction = 0.8): PhysicsAggregate {
    const m = MeshBuilder.CreateBox('course_' + name, { width: sx, height: sy, depth: sz }, this.scene);
    m.position = this.w(x, y, z); m.rotation.x = rotX; m.material = this.mats[mat]; m.receiveShadows = true;
    const agg = new PhysicsAggregate(m, PhysicsShapeType.BOX, { mass: 0, friction, restitution: 0.1 }, this.scene);
    agg.shape.filterMembershipMask = surface ? SURFACE_BIT : WALL_BIT;
    this.items.push({ mesh: m, agg });
    return agg;
  }
  /** Low side curbs (walls for the treads) along a straight lane. */
  private curbs(halfW: number, z0: number, z1: number) {
    for (const x of [-halfW, halfW]) {
      this.box('curb', x, 0.15, (z0 + z1) / 2, 0.2, 0.3, z1 - z0, 'ramp', false, 0, 0.3);
      this.mark(new Vector3(x, 0.31, z0), new Vector3(x, 0.31, z1), 0.05, 'lane');
    }
  }

  private clear() {
    for (const o of this.blockObs) o.body.getCollisionObservable().remove(o.obs);
    this.blockObs = []; this.blockContacts = [];
    for (const it of this.items) { it.agg?.dispose(); it.mesh.dispose(); }
    this.items = []; this.cones = []; this.coneZ = []; this.gates = []; this.crate = null; this.block = null;
    this.splitZ = []; this.finishZ = Infinity;
  }

  /** Build one station. Returns where the bot (and the dummy) start. */
  build(id: StationId): { spawn: Vector3; facing: number; dummy?: { pos: Vector3; facing: number } } {
    this.clear();
    this.station = id;
    const startZ = 0.3;
    this.across(startZ, -2.5, 2.5, 'start');
    let dummy: { pos: Vector3; facing: number } | undefined;

    if (id === 'drag') {
      this.curbs(2.5, -2, 33);
      this.splitZ = [{ z: 10, label: '10 m' }, { z: 20, label: '20 m' }];
      for (const s of this.splitZ) this.across(s.z, -2.5, 2.5, 'split', 0.08);
      this.finishZ = 30; this.checker(30, 2.5);
    } else if (id === 'slalom') {
      this.curbs(4, -2, 37);
      for (let i = 0; i < 6; i++) {
        const z = 5 + i * 5, side: -1 | 1 = i % 2 === 0 ? 1 : -1;   // first cone: pass on its RIGHT (+x)
        this.cone(0, z);
        this.coneZ.push({ z, side, done: false });
        // pad on the side to pass
        this.mark(new Vector3(side * 1.6, 0.012, z - 0.6), new Vector3(side * 1.6, 0.012, z + 0.6), 1.6, 'pad');
      }
      this.finishZ = 34; this.checker(34, 4);
    } else if (id === 'fig8') {
      for (const x of [-4, 4]) this.post(x, 6);
      const C = new Vector3(0, 0, 6);
      const seq = [C, new Vector3(4, 0, 9.5), new Vector3(7.5, 0, 6), new Vector3(4, 0, 2.5), C,
        new Vector3(-4, 0, 9.5), new Vector3(-7.5, 0, 6), new Vector3(-4, 0, 2.5), C];
      for (const p of seq) {
        const ring = MeshBuilder.CreateTorus('course_gate', { diameter: COURSE.gateR * 2, thickness: 0.08, tessellation: 40 }, this.scene);
        ring.position = this.w(p.x, 0.03, p.z); ring.material = this.mats.gate; ring.isPickable = false;
        this.items.push({ mesh: ring });
        this.gates.push({ p, mesh: ring });
      }
      this.gateIdx = 0;
      this.splitZ = [];
    } else if (id === 'bumps') {
      this.curbs(2.5, -2, 27);
      for (const [z, hgt] of [[4, 0.04], [6, 0.06], [8, 0.08]] as const) this.bump(z, hgt, 2.4);
      // ramp 11 -> 15 m up to 0.4 m, platform 15 -> 18 m, sheer drop at 18 m
      const H = 0.4, L = 4, th = 0.2, ang = Math.atan2(H, L), len = Math.hypot(H, L);
      const n = new Vector3(0, Math.cos(ang), -Math.sin(ang));          // ramp top-surface normal (faces up + back)
      const mid = new Vector3(0, H / 2, 11 + L / 2).subtract(n.scale(th / 2));
      this.box('ramp', mid.x, mid.y, mid.z, 4.6, th, len, 'ramp', true, -ang);
      this.box('platform', 0, H / 2, 16.5, 4.6, H, 3, 'ramp', true);
      this.mark(new Vector3(-2.3, H + 0.012, 17.95), new Vector3(2.3, H + 0.012, 17.95), 0.08, 'split');
      this.finishZ = 24; this.checker(24, 2.5);
    } else if (id === 'push') {
      this.curbs(3.5, -2, 16);
      // goal box 11 -> 14 m, |x| <= 2
      for (const x of [-2, 2]) this.mark(new Vector3(x, 0.012, 11), new Vector3(x, 0.012, 14), 0.1, 'finish');
      for (const z of [11, 14]) this.across(z, -2, 2, 'finish', 0.1);
      this.crateStartZ = 3;
    } else if (id === 'weapon') {
      this.block = this.box('block', -3, 0.3, 5, 1.2, 0.6, 1.0, 'steel', false, 0, 0.5);
      this.mark(new Vector3(-4.2, 0.012, 3.8), new Vector3(-1.8, 0.012, 3.8), 0.06, 'pad');
      dummy = { pos: this.w(3, 0.6, 5.5), facing: Math.PI / 2 };   // broadside to the start: a clean target, not its wedge
      this.mark(new Vector3(1.8, 0.012, 3.8), new Vector3(4.2, 0.012, 3.8), 0.06, 'pad');
    }
    return { spawn: this.w(0, 0.6, 0), facing: 0, dummy };
  }

  private checker(z: number, halfW: number) {
    for (let x = -halfW, i = 0; x < halfW - 1e-6; x += 0.5, i++)
      this.mark(new Vector3(x, 0.012, z), new Vector3(x + 0.5, 0.012, z), 0.25, i % 2 ? 'finish' : 'black');
    this.across(z + 0.15, -halfW, halfW, 'finish', 0.05);
  }
  private cone(x: number, z: number) {
    const m = MeshBuilder.CreateCylinder('course_cone', { height: 0.6, diameterTop: 0.06, diameterBottom: 0.36, tessellation: 16 }, this.scene);
    m.position = this.w(x, 0.3, z); m.material = this.mats.cone;
    const agg = new PhysicsAggregate(m, PhysicsShapeType.CONVEX_HULL, { mass: 3, friction: 0.6, restitution: 0.1 }, this.scene);
    agg.shape.filterMembershipMask = WALL_BIT;   // the bots' treads never ride up a cone
    this.items.push({ mesh: m, agg });
    this.cones.push({ mesh: m, home: m.position.clone(), hit: false });
  }
  private post(x: number, z: number) {
    const m = MeshBuilder.CreateCylinder('course_post', { height: 1.2, diameter: 0.6, tessellation: 20 }, this.scene);
    m.position = this.w(x, 0.6, z); m.material = this.mats.steel;
    const agg = new PhysicsAggregate(m, PhysicsShapeType.CYLINDER, { mass: 0, friction: 0.3, restitution: 0.2 }, this.scene);
    agg.shape.filterMembershipMask = WALL_BIT;
    this.items.push({ mesh: m, agg });
    const ring = MeshBuilder.CreateTorus('course_postring', { diameter: 0.7, thickness: 0.05, tessellation: 24 }, this.scene);
    ring.position = this.w(x, 1.2, z); ring.material = this.mats.edge; this.items.push({ mesh: ring });
  }
  /** Round-topped bump across the lane, `hgt` tall (a cylinder sunk into the floor). */
  private bump(z: number, hgt: number, halfW: number) {
    const r = 0.35;
    const m = MeshBuilder.CreateCylinder('course_bump', { height: halfW * 2, diameter: r * 2, tessellation: 32 }, this.scene);
    m.rotation.z = Math.PI / 2;
    m.position = this.w(0, hgt - r, z); m.material = this.mats.ramp; m.receiveShadows = true;
    const agg = new PhysicsAggregate(m, PhysicsShapeType.CYLINDER, { mass: 0, friction: 0.8, restitution: 0.1 }, this.scene);
    agg.shape.filterMembershipMask = SURFACE_BIT;
    this.items.push({ mesh: m, agg });
    this.mark(new Vector3(-halfW, hgt + 0.01, z), new Vector3(halfW, hgt + 0.01, z), 0.04, 'split');
  }

  /** Crate for the push station: same mass as the bot. Called after the bot is built. */
  private makeCrate(kg: number) {
    const m = MeshBuilder.CreateBox('course_crate', { size: 1.2 }, this.scene);
    m.position = this.w(0, 0.6, this.crateStartZ); m.material = this.mats.crate;
    const agg = new PhysicsAggregate(m, PhysicsShapeType.BOX, { mass: kg, friction: 0.5, restitution: 0.05 }, this.scene);
    agg.shape.filterMembershipMask = WALL_BIT;
    this.items.push({ mesh: m, agg });
    this.crate = m;
  }

  // ---------------------------------------------------------------------------------------------------
  /** Start a run on the built station. */
  begin(bot: Bot, dummy?: Bot, combat?: Combat) {
    if (!this.station) return;
    this.bot = bot; this.dummy = dummy ?? null; this.combat = combat ?? null;
    this.t = 0; this.t0 = -1; this.tEnd = -1; this.nextSplit = 0; this.gateIdx = 0; this.blockHits = [];
    this.prev = this.local(bot.root.position);
    this.r = blank(this.station);
    for (const c of this.cones) c.hit = false;
    for (const c of this.coneZ) c.done = false;
    if (this.station === 'push') {
      if (this.crate) { const it = this.items.find(i => i.mesh === this.crate); it?.agg?.dispose(); this.crate.dispose(); this.items = this.items.filter(i => i !== it); }
      const kg = Math.round(botMass(bot));
      this.makeCrate(kg);
      this.r.crateKg = kg;
    }
    if (dummy) for (const ps of Object.values(dummy.state.parts)) { ps.hp = COURSE.dummyHp; ps.maxHp = COURSE.dummyHp; }
    this.paintGates();
    // steel block meter: energy the player's real weapons lose while touching the block
    if (this.block) {
      const add = (body: PhysicsBody, energy: () => number) => {
        const c: BlockContact = { body, energy, eBefore: 0, lost: 0, touching: false, idle: 0, start: 0, active: false };
        this.blockContacts.push(c);
        const blockBody = this.block!.body;
        const obs = body.getCollisionObservable().add(ev => {
          if (ev.collidedAgainst !== blockBody) return;
          if (ev.type === PhysicsEventType.COLLISION_STARTED || ev.type === PhysicsEventType.COLLISION_CONTINUED) c.touching = true;
        });
        this.blockObs.push({ body, obs });
      };
      if (bot.spinner) add(bot.spinner.body, () => spinEnergy(bot));
      if (bot.arm) add(bot.arm.body, () => armEnergy(bot));
      if (bot.saw) { const s = bot.saw; add(s.body, () => energyOf(s)); }
      this.r.blockDmg = this.blockContacts.length ? 0 : null;
    }
  }

  get started() { return this.t0 >= 0; }
  get done() { return this.tEnd >= 0; }
  /** Run time so far (s). */
  get elapsed() { return this.t0 < 0 ? 0 : (this.done ? this.tEnd : this.t) - this.t0; }

  beforePhysics() {
    for (const c of this.blockContacts) { c.eBefore = c.energy(); c.touching = false; }
  }

  /** Every physics sub-step: timing lines, readouts, station rules. */
  afterPhysics() {
    const b = this.bot;
    if (!b || !this.station) return;
    this.t += STEP;
    const p = this.local(b.root.position);
    const crossed = (z: number) => this.prev.z < z && p.z >= z;
    const at = (z: number) => this.t - STEP + STEP * Math.max(0, Math.min(1, (z - this.prev.z) / Math.max(1e-9, p.z - this.prev.z)));   // sub-step interpolation

    if (!this.started) {
      if (crossed(0.3)) this.t0 = at(0.3);
    } else if (!this.done) {
      const v = b.body.getLinearVelocity();
      this.r.topSpeed = Math.max(this.r.topSpeed, Math.hypot(v.x, v.z));
      const up = Vector3.Up().applyRotationQuaternion(b.root.rotationQuaternion ?? Quaternion.Identity());
      this.r.maxTilt = Math.max(this.r.maxTilt, Math.acos(Math.max(-1, Math.min(1, up.y))) * 180 / Math.PI);
      if (b.inverted) this.r.flipped = true;
      this.blockMeter();

      const s = this.station;
      if (this.nextSplit < this.splitZ.length && crossed(this.splitZ[this.nextSplit].z)) {
        const sp = this.splitZ[this.nextSplit++];
        this.r.splits.push({ label: sp.label, t: at(sp.z) - this.t0 });
      }
      if (s === 'slalom') {
        for (const c of this.coneZ) if (!c.done && crossed(c.z)) {
          c.done = true;
          if (Math.sign(p.x) !== c.side) this.r.wrongSide++;
        }
        for (const c of this.cones) if (!c.hit) {
          const d = c.mesh.position.subtract(c.home); d.y = 0;
          const up2 = Vector3.Up().applyRotationQuaternion(c.mesh.rotationQuaternion ?? Quaternion.Identity());
          if (d.length() > COURSE.coneMoved || up2.y < 0.9) c.hit = true;
        }
      }
      if (s === 'fig8' && this.gateIdx < this.gates.length) {
        const g = this.gates[this.gateIdx].p;
        if (Math.hypot(p.x - g.x, p.z - g.z) <= COURSE.gateR) {
          this.gateIdx++;
          if (this.gateIdx === 5) this.r.splits.push({ label: 'right loop', t: this.t - this.t0 });
          if (this.gateIdx >= this.gates.length) this.finish(this.t);
          this.paintGates();
        }
      }
      if (s === 'push' && this.crate) {
        const c = this.local(this.crate.position);
        this.r.pushDist = Math.max(this.r.pushDist, c.z - this.crateStartZ);
        if (c.z >= 11.6 && c.z <= 13.4 && Math.abs(c.x) <= 1.4) this.finish(this.t);   // whole crate inside the goal box
      }
      if (s === 'weapon' && this.t - this.t0 >= COURSE.weaponSeconds) this.finish(this.t0 + COURSE.weaponSeconds);
      if (this.finishZ < Infinity && crossed(this.finishZ)) this.finish(at(this.finishZ));
    }
    this.prev = p;
  }

  private finish(t: number) {
    if (this.done) return;
    this.tEnd = t;
    this.r.time = t - this.t0;
    this.r.coneHits = this.cones.filter(c => c.hit).length;
    this.r.penalty = this.r.coneHits * COURSE.coneHitPenalty + this.r.wrongSide * COURSE.wrongSidePenalty;
    this.r.final = this.r.time + this.r.penalty;
    this.flushBlock();
    this.snapCombat(this.r);
  }
  /** Dummy damage / hits from the match combat rules (block hits are counted here in course.ts). */
  private snapCombat(r: RunResult) {
    r.hits = this.blockHits.length;
    r.biggest = Math.max(0, ...this.blockHits);
    if (!this.combat) return;
    r.dummyDmg = this.combat.stats.A.dmg;
    r.hits += this.combat.stats.A.hits;
    for (const h of this.combat.log) if (h.attacker === 'A') r.biggest = Math.max(r.biggest, h.dmg);
  }

  private blockHits: number[] = [];
  private blockMeter() {
    const now = this.t * 1000;
    for (const c of this.blockContacts) {
      if (c.touching) {
        if (!c.active) { c.active = true; c.lost = 0; c.start = now; }
        c.lost += Math.max(0, c.eBefore - c.energy());
        c.idle = 0;
      } else if (c.active) c.idle++;
      if (c.active && (c.idle >= SPIN_DMG.gapSteps || now - c.start >= SPIN_DMG.maxHitMs)) this.blockHit(c);
    }
  }
  private blockHit(c: BlockContact) {
    c.active = false;
    const dmg = Math.round(c.lost / SPIN_DMG.joulesPerDmg);
    c.lost = 0;
    if (dmg < SPIN_DMG.minDmg || this.r.blockDmg === null) return;
    this.r.blockDmg += dmg;
    this.blockHits.push(dmg);
  }
  private flushBlock() { for (const c of this.blockContacts) if (c.active) this.blockHit(c); }

  private paintGates() {
    this.gates.forEach((g, i) => { g.mesh.material = i === this.gateIdx ? this.mats.gateNext : this.mats.gate; g.mesh.setEnabled(i >= this.gateIdx); });
  }

  /** World -> local station coords. */
  private local(v: Vector3) { return new Vector3(v.x - COURSE_ORIGIN.x, v.y - COURSE_ORIGIN.y, v.z - COURSE_ORIGIN.z - COURSE.z0); }

  /** Live result (final once done). */
  result(): RunResult {
    const r = { ...this.r, splits: [...this.r.splits] };
    if (!this.done) {
      r.time = this.elapsed;
      r.coneHits = this.cones.filter(c => c.hit).length;
      r.penalty = r.coneHits * COURSE.coneHitPenalty + r.wrongSide * COURSE.wrongSidePenalty;
      r.final = r.time + r.penalty;
      this.snapCombat(r);
    }
    return r;
  }

  /** Live HUD lines for the current station. */
  hudLines(): string[] {
    const r = this.result(), s = this.station!;
    const f = (n: number, d = 2) => n.toFixed(d);
    const out: string[] = [];
    if (s === 'weapon') {
      out.push(`TIME LEFT <b>${f(Math.max(0, COURSE.weaponSeconds - r.time), 1)} s</b>`);
      out.push(`BLOCK <b>${r.blockDmg === null ? '—' : r.blockDmg}</b> · DUMMY <b>${r.dummyDmg}</b> · HITS <b>${r.hits}</b>`);
    } else {
      out.push(`TIME <b>${f(r.time)} s</b>${r.penalty ? ` + ${r.penalty} s = <b>${f(r.final)} s</b>` : ''}`);
      for (const sp of r.splits) out.push(`${sp.label} <b>${f(sp.t)} s</b>`);
      out.push(`TOP SPEED <b>${f(r.topSpeed, 1)} m/s</b> · MAX TILT <b>${Math.round(r.maxTilt)}°</b>${r.flipped ? ' · <b style="color:#ff9f43">FLIPPED</b>' : ''}`);
      if (s === 'slalom') out.push(`CONES HIT <b>${r.coneHits}</b> · WRONG SIDE <b>${r.wrongSide}</b>`);
      if (s === 'fig8') out.push(`GATE <b>${Math.min(this.gateIdx + 1, this.gates.length)} / ${this.gates.length}</b>`);
      if (s === 'push') out.push(`CRATE <b>${r.crateKg} kg</b> · MOVED <b>${f(r.pushDist, 1)} m</b>`);
    }
    if (!this.started) out.push(`<i>Cross the start line to begin</i>`);
    return out;
  }
}

function blank(station: StationId): RunResult {
  return { station, time: 0, penalty: 0, final: 0, splits: [], topSpeed: 0, maxTilt: 0, flipped: false, coneHits: 0, wrongSide: 0,
    pushDist: 0, crateKg: 0, blockDmg: null, dummyDmg: 0, hits: 0, biggest: 0 };
}

/** Whole bot mass: chassis + wheels + real weapon bodies, kg. */
export function botMass(b: Bot): number {
  const m = (body: PhysicsBody) => body.getMassProperties().mass ?? 0;
  let kg = m(b.body);
  for (const w of b.wheels ?? []) kg += m(w.body);
  for (const x of [b.spinner, b.arm, b.saw, ...(b.hinges ?? [])]) if (x) kg += m(x.body);
  return kg;
}
