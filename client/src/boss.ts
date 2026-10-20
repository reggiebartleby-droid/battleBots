/**
 * v0.58 BOSS BATTLE (user, 2026-10-20): you + 3 AI allies against STINGWHEEL, the Xeno-bug scorpion, in the round Big
 * Arena. Plan: design/boss-battle-plan.md in the Project. Super meter / overdrive / combos come in v0.59.
 *
 * Stingwheel
 *  - ~3x a bot: body 4.2 m long, 2.4 m wide, low and wide. Cube Bots look (bigger cubes, BOSS.cube), violet shell,
 *    alien-green core, glowing eyes.
 *  - drive (user, 2026-10-20): an ARCADE drive base -- one heavy hidden body pushed toward where the AI wants to go
 *    (not real tyres). Bots still bump it; roll / pitch are held near level (very hard to tip).
 *  - the tail arcs over the back and holds a toothed 1.5 m disc in front of the face: a REAL vertical spinner (its own
 *    body on a motor hinge, front edge up, 3 s spin-up) -- what it hits is measured like a bot's spinner (energy lost).
 *  - 8 legs are visual only: they step and plant their tips on the floor (2-bone IK).
 *  - pincers: grab a bot that gets in reach, hold it ~1 s, then throw it at the disc.
 *  - HP = cubes, by part: chassis, carapace, tail, left / right pincer, disc. A hit lands on the nearest part; the disc
 *    and the tail (it holds the disc) stop at 1 HP like the bots' unbreakable weapons; the chassis stops at 1 until the
 *    carapace and both pincers are gone. Damage a part can't take goes on to the next nearest part. Chassis 0 = KO.
 *  - phases by total HP: 1 (100-66%) chase + disc + pincers; 2 (66-33%) 25% faster + a slam every ~10 s (red ring
 *    warning 1 s, shoves bots in 4.5 m, small damage); 3 (<33%) disc faster, + spin sweeps, shorter cooldowns.
 *    Each phase change: roar + 1.5 s stagger (no drive, disc motor off) and a new wave of minis.
 *
 * Mini scorpions (no physics bodies -- arcade)
 *  - up to 3 / 5 / 8 alive by phase; crawl out of 4 burrows near the walls; a killed one comes back 4 s later.
 *  - one weapon hit (a live weapon touching it) or a bump at 2 m/s+ kills one: +5 points for the killer.
 *  - they latch onto a slow bot (max 3 per bot): -10% drive each, 1 damage a second. A hard turn, hitting a wall,
 *    or a teammate's weapon knocks them off.
 */
import {
  Color3, Mesh, MeshBuilder, Physics6DoFConstraint, PhysicsBody, PhysicsConstraintAxis, PhysicsConstraintMotorType,
  PhysicsMotionType, PhysicsShapeBox, PhysicsShapeContainer, PhysicsShapeCylinder, Quaternion, Scene, StandardMaterial,
  TransformNode, Vector3, type IPhysicsCollisionEvent, type PhysicsShape, type ShadowGenerator,
} from '@babylonjs/core';
import { HIT } from '../../src/core/state.js';
import { SURFACE_BIT, WALL_BIT } from './arena.js';
import { isChassis, weaponBodies, type Bot, type BotId } from './bot.js';
import { skinThing, type Skin } from './cubes.js';
import type { Combat, ExtTarget } from './combat.js';
import type { Fx } from './fx.js';

/** Tuning (first guesses -- playtest). */
export const BOSS = {
  seconds: 120,                 // 2:00 to kill it, or the boss wins
  mass: 1500,                   // kg (a bot is ~100-130)
  rest: 0.45,                   // body origin above the floor, m
  cube: 0.16,                   // cube edge for the boss (bots use 0.12 at 8-bit)
  paint: '#8a2be2', core: '#6dff2e',
  hp: { chassis: 330, carapace: 250, tail: 120, pincerL: 60, pincerR: 60, disc: 80 } as Record<PartId, number>,
  speed: [4, 5, 5.5],           // m/s top speed by phase (phase 2 = +25%)
  yaw: [1.5, 1.7, 2.0],         // rad/s turn rate by phase
  grip: 6,                      // 1/s: how fast the arcade base reaches the speed it wants
  stab: { damp: 10, pull: 40, freeDeg: 4 },   // roll / pitch held near level
  retargetMs: 2000,
  phaseAt: [0.66, 0.33],
  staggerMs: 1500,
  disc: { r: 0.75, thick: 0.12, mass: 140, omega: [30, 30, 38], spinUpS: 3, brake: 0.35, center: new Vector3(0, 0.4, 2.95),
    joulesPerDmg: 60, scale: 1, gapSteps: 3, maxHitMs: 200 },
  pincer: { reach: 1.05, holdMs: 1000, cooldownMs: [3500, 3500, 2500], dmg: 3, throwV: 6, throwUp: 2.5 },
  slam: { everyMs: [0, 10000, 7000], warnMs: 1000, r: 4.5, dv: 6, up: 3.5, dmg: 5 },
  sweep: { everyMs: 9000, ms: 2400, yaw: 3.2 },
  mini: { cap: [3, 5, 8], respawnMs: 4000, speed: 4, turn: 7, latchR: 0.95, maxPerBot: 3, slow: 0.1, nibbleMs: 1000, nibble: 1,
    killR: 0.85, bumpV: 2, bumpR: 0.95, shakeYaw: 2.6, shakeS: 0.35, wallDv: 3.5, stunMs: 800, riseMs: 500, cube: 0.07,
    paint: '#c45cff', pts: 5, avoidR: 2.6 },
  pts: { final: 50 },
};
export type PartId = 'chassis' | 'carapace' | 'tail' | 'pincerL' | 'pincerR' | 'disc';
const BOSS_BIT = 1 << 14;
const FLOORED: PartId[] = ['tail', 'disc'];          // stop at 1 HP (they hold / are the weapon)

export interface BossHooks {
  /** the team, still in play (not out) */
  team(): { id: BotId; bot: Bot }[];
  combat(): Combat;
  fx: Fx;
  sign(text: string, ms: number, color: string): void;
  isPlayer(id: BotId): boolean;
  /** points for a teammate: HP dealt to the boss / a mini kill / the final hit */
  onPoints(id: BotId, pts: number, why: 'boss' | 'mini' | 'final'): void;
  shadows?: ShadowGenerator;
}

interface Part { id: PartId; root: Mesh; skin: Skin | null; hp: number; max: number; init: number; shapes: PhysicsShape[]; boxes: { c: Vector3; h: Vector3 }[] }
interface Leg { hip: Vector3; home: Vector3; foot: Vector3; from: Vector3; to: Vector3; t: number; stepping: boolean; group: number; femur: Mesh; tibia: Mesh }
interface Mini {
  root: Mesh; skin: Skin | null; legs: Mesh[]; pos: Vector3; yaw: number; vy: number; vel: Vector3;
  state: 'rise' | 'walk' | 'latched' | 'stun'; t: number;
  on?: Bot; off?: Vector3; offYaw: number; shake: number; nibbleAt: number; prevSpeed: number;
}
type BossState = 'idle' | 'chase' | 'stagger' | 'slamWarn' | 'slamAir' | 'sweep' | 'dead';

const LEG = { L1: 0.85, L2: 1.1, stride: 0.55, stepS: 0.16, lift: 0.28, lead: 0.22 };

export class BossFight {
  readonly root: TransformNode;
  readonly body: PhysicsBody;
  readonly parts: Record<PartId, Part>;
  private disc: { hub: TransformNode; body: PhysicsBody; joint: Physics6DoFConstraint; inertia: number; torque: number };
  private legs: Leg[] = [];
  private legSkin: Skin | null = null;
  private minis: Mini[] = [];
  private miniSpawns: number[] = [];                   // performance.now() times a mini is due
  private burrows: Vector3[] = [];
  private mats: Record<string, StandardMaterial> = {};
  private meshes: Mesh[] = [];
  private ring: Mesh; private wave: Mesh;
  private aims = new Map<BotId, TransformNode>();
  readonly maxHp: number;
  state: BossState = 'idle';
  phase = 1;
  dead = false;
  deadAt = 0;
  private stateT = 0;
  private target?: Bot;
  private targetAt = 0;
  private slamAt = 0; private sweepAt = 0;
  private cmd = { speed: 0, yaw: 0 };
  private discOn = false;
  private discBoost = 1;
  private grab?: { bot: Bot; side: 'L' | 'R'; t: number };
  private pincerReady = { L: 0, R: 0 };
  private dc = { eB: 0, lost: 0, touching: false, active: false, idle: 0, start: 0, victim: undefined as Bot | undefined, point: Vector3.Zero() };
  private lastHitBy?: BotId;
  /** combat.ts: the bots' weapons can hurt it */
  readonly target3: ExtTarget;

  constructor(private scene: Scene, readonly center: Vector3, private half: number, private hooks: BossHooks) {
    const mat = (name: string, hex: string, emis = 0) => {
      const m = new StandardMaterial(name, scene);
      m.diffuseColor = Color3.FromHexString(hex);
      m.emissiveColor = Color3.FromHexString(hex).scale(emis);
      m.specularColor = new Color3(0.2, 0.2, 0.2);
      return (this.mats[name] = m);
    };
    // names: cubes.ts picks the cube colour by the material name (paint / dark / steel); eyes keep their own colour
    mat('paint_boss', BOSS.paint); mat('dark_boss', '#2a1838'); mat('steel_boss', '#9ec2f2'); mat('eye_boss', '#d8ff3a', 0.9);
    mat('paint_mini', BOSS.mini.paint); mat('dark_mini', '#2a1838'); mat('steel_mini', '#9ec2f2');
    const fx = mat('fx_ring', '#ff2e2e', 1); fx.disableLighting = true; fx.alpha = 0.35;
    const fw = mat('fx_wave', '#ffb0b0', 1); fw.disableLighting = true; fw.alpha = 0.6;
    const bur = mat('fx_burrow', '#140c1c'); bur.specularColor = Color3.Black();
    const burG = mat('fx_burrowglow', BOSS.core, 1); burG.disableLighting = true;

    this.root = new TransformNode('boss', scene);
    this.root.position = center.add(new Vector3(0, BOSS.rest, 0));
    this.root.rotationQuaternion = Quaternion.FromEulerAngles(0, Math.PI, 0);   // faces -z at the start (bots spawn all round)

    const partRoot = (id: PartId, parent: TransformNode = this.root): Mesh => { const m = new Mesh(`boss_${id}`, scene); m.parent = parent; return m; };
    const box = (parent: TransformNode, name: string, m: string, w: number, h: number, d: number, x: number, y: number, z: number, rot?: Vector3) => {
      const b = MeshBuilder.CreateBox(`boss_${name}`, { width: w, height: h, depth: d }, scene);
      b.material = this.mats[m]; b.parent = parent; b.position.set(x, y, z); b.isPickable = false;
      if (rot) b.rotation.copyFrom(rot);
      this.meshes.push(b); return b;
    };

    // ---- visuals (boss local: +z forward, floor at y = -rest) ----
    const chassis = partRoot('chassis');
    box(chassis, 'core', 'dark_boss', 2.0, 0.5, 3.6, 0, 0, -0.15);
    box(chassis, 'head', 'paint_boss', 1.4, 0.45, 0.6, 0, 0.04, 1.85);
    box(chassis, 'jaw', 'dark_boss', 1.0, 0.18, 0.3, 0, -0.18, 2.1);
    for (const x of [-0.35, 0.35]) box(chassis, 'eye', 'eye_boss', 0.22, 0.14, 0.12, x, 0.2, 2.12);
    for (const x of [-0.62, 0.62]) box(chassis, 'eye2', 'eye_boss', 0.12, 0.1, 0.1, x, 0.24, 1.98);
    const carapace = partRoot('carapace');
    const bands = [-1.9, -1.2, -0.5, 0.2, 0.9, 1.45];
    bands.forEach((z, i) => {
      const w = 2.4 - Math.abs(i - 2.5) * 0.14;
      box(carapace, `band${i}`, 'paint_boss', w, 0.2, 0.62, 0, 0.35, z);
      box(carapace, `seam${i}`, 'dark_boss', w + 0.06, 0.08, 0.08, 0, 0.28, z + 0.33);
    });
    box(carapace, 'ridge', 'steel_boss', 0.18, 0.1, 3.5, 0, 0.48, -0.25);
    // tail: segments over the back to a fork that holds the disc's axle
    const tail = partRoot('tail');
    const path = [[0, 0.35, -2.0], [0, 0.95, -2.45], [0, 1.65, -2.4], [0, 2.2, -1.9], [0, 2.55, -1.15], [0, 2.62, -0.3], [0, 2.45, 0.6], [0, 2.1, 1.45], [0, 1.65, 2.2]]
      .map(p => new Vector3(p[0], p[1], p[2]));
    for (let i = 0; i < path.length - 1; i++) {
      const a = path[i], b = path[i + 1], mid = a.add(b).scale(0.5), len = Vector3.Distance(a, b);
      const s = 0.62 - i * 0.04;
      const seg = box(tail, `tail${i}`, i % 2 ? 'dark_boss' : 'paint_boss', s, s * 0.8, len + 0.12, mid.x, mid.y, mid.z);
      seg.rotation.x = -Math.atan2(b.y - a.y, b.z - a.z);
    }
    const dc = BOSS.disc.center;
    for (const x of [-0.16, 0.16]) {   // the fork's two prongs down either side of the disc to its axle
      const a = new Vector3(x, 1.6, 2.3), b = new Vector3(x, dc.y, dc.z), mid = a.add(b).scale(0.5);
      const pr = box(tail, 'prong', 'steel_boss', 0.1, 0.14, Vector3.Distance(a, b), mid.x, mid.y, mid.z);
      pr.rotation.x = -Math.atan2(b.y - a.y, b.z - a.z);
    }
    // pincers: an arm forward + out from the head, a claw with a fixed outer jaw and a moving inner jaw
    const pincer = (side: -1 | 1): Mesh => {
      const r = partRoot(side < 0 ? 'pincerL' : 'pincerR');
      box(r, 'parm', 'paint_boss', 0.32, 0.26, 1.0, side * 1.15, 0.12, 2.15, new Vector3(0, side * -0.28, 0));
      box(r, 'pclaw', 'steel_boss', 0.18, 0.22, 0.55, side * 1.42, 0.12, 2.85);
      const jaw = box(r, 'pjaw', 'steel_boss', 0.12, 0.18, 0.5, side * 1.18, 0.12, 2.82);
      jaw.metadata = { jaw: true, side };
      return r;
    };
    const pL = pincer(-1), pR = pincer(1);
    // disc on its own physics hub (built below); legs
    const legsRoot = new Mesh('boss_legs', scene); legsRoot.parent = this.root;
    const zs = [1.25, 0.45, -0.4, -1.25];
    for (const side of [-1, 1]) zs.forEach((z, i) => {
      const hip = new Vector3(side * 0.95, 0.05, z);
      const home = new Vector3(side * 2.15, -BOSS.rest, z * 1.2 + (i === 0 ? 0.35 : 0));
      const femur = box(legsRoot, 'femur', 'dark_boss', 0.17, LEG.L1, 0.17, 0, 0, 0);
      const tibia = box(legsRoot, 'tibia', i % 2 ? 'dark_boss' : 'steel_boss', 0.13, LEG.L2, 0.13, 0, 0, 0);
      femur.rotationQuaternion = new Quaternion(); tibia.rotationQuaternion = new Quaternion();
      const w = this.toWorld(home);
      this.legs.push({ hip, home, foot: w.clone(), from: w.clone(), to: w.clone(), t: 0, stepping: false, group: (i + (side > 0 ? 1 : 0)) % 2, femur, tibia });
    });
    this.poseLegs();

    // ---- physics: one heavy body (arcade drive base) ----
    const shape = new PhysicsShapeContainer(scene);
    const add = (c: Vector3, e: Vector3, friction = 0.4): PhysicsShape => {
      const s = new PhysicsShapeBox(c, Quaternion.Identity(), e, scene);
      s.material = { friction, restitution: 0.15 };
      s.filterMembershipMask = BOSS_BIT; s.filterCollideMask = ~0;
      shape.addChild(s); return s;
    };
    const P = (id: PartId, r: Mesh, boxes: { c: Vector3; h: Vector3 }[], collide = true): Part => ({
      id, root: r, skin: null, hp: BOSS.hp[id], max: BOSS.hp[id], init: 0, boxes,
      shapes: collide ? boxes.map(b => add(b.c, b.h.scale(2))) : [] });
    const bx = (x: number, y: number, z: number, w: number, h: number, d: number) => ({ c: new Vector3(x, y, z), h: new Vector3(w / 2, h / 2, d / 2) });
    add(new Vector3(0, -0.36, -0.1), new Vector3(1.9, 0.18, 3.4), 0.02);   // skid: the hidden base glides on the floor
    this.parts = {
      chassis: P('chassis', chassis, [bx(0, 0, -0.15, 2.0, 0.5, 3.6), bx(0, 0.02, 1.85, 1.4, 0.5, 0.65)]),
      carapace: P('carapace', carapace, [bx(0, 0.36, -0.25, 2.4, 0.26, 3.75)]),
      tail: P('tail', tail, [bx(0, 1.3, -2.3, 0.6, 1.9, 0.6), bx(0, 2.45, -0.8, 0.55, 0.5, 2.6), bx(0, 1.9, 1.75, 0.5, 0.6, 1.0)]),
      pincerL: P('pincerL', pL, [bx(-1.28, 0.12, 2.5, 0.5, 0.32, 1.35)]),
      pincerR: P('pincerR', pR, [bx(1.28, 0.12, 2.5, 0.5, 0.32, 1.35)]),
      disc: P('disc', new Mesh('boss_disc', scene), [], false),
    };
    const body = new PhysicsBody(this.root, PhysicsMotionType.DYNAMIC, false, scene);
    body.shape = shape;
    body.setMassProperties({ mass: BOSS.mass, centerOfMass: new Vector3(0, -0.25, 0.3) });
    body.setLinearDamping(0.05); body.setAngularDamping(0.5);
    this.body = body;

    // ---- the disc: a real vertical spinner on a motor hinge ----
    const D = BOSS.disc;
    const hub = new TransformNode('boss_discHub', scene);
    hub.position = this.toWorld(D.center);
    hub.rotationQuaternion = this.root.rotationQuaternion!.clone();
    const discRoot = this.parts.disc.root; discRoot.parent = hub;
    const dm = MeshBuilder.CreateCylinder('boss_discPlate', { diameter: D.r * 2, height: D.thick, tessellation: 28 }, scene);
    dm.material = this.mats.steel_boss; dm.parent = discRoot; dm.rotation.z = Math.PI / 2; this.meshes.push(dm);
    const dh = MeshBuilder.CreateCylinder('boss_discHubMesh', { diameter: 0.4, height: D.thick + 0.12, tessellation: 14 }, scene);
    dh.material = this.mats.dark_boss; dh.parent = discRoot; dh.rotation.z = Math.PI / 2; this.meshes.push(dh);
    const dshape = new PhysicsShapeContainer(scene);
    const dput = (s: PhysicsShape, friction: number) => { s.material = { friction, restitution: 0.2 }; s.filterMembershipMask = BOSS_BIT; s.filterCollideMask = ~(SURFACE_BIT | WALL_BIT); dshape.addChild(s); };
    dput(new PhysicsShapeCylinder(new Vector3(-D.thick / 2, 0, 0), new Vector3(D.thick / 2, 0, 0), D.r, scene), 0.5);
    for (let k = 0; k < 4; k++) {
      const a = k * Math.PI / 2, y = Math.cos(a) * (D.r + 0.03), z = Math.sin(a) * (D.r + 0.03);
      dput(new PhysicsShapeBox(new Vector3(0, y, z), Quaternion.RotationAxis(Vector3.Right(), a), new Vector3(0.18, 0.16, 0.22), scene), 1.5);
      const t = MeshBuilder.CreateBox('boss_tooth', { width: 0.18, height: 0.16, depth: 0.22 }, scene);
      t.material = this.mats.steel_boss; t.parent = discRoot; t.position.set(0, y, z); t.rotation.x = a; this.meshes.push(t);
    }
    const dbody = new PhysicsBody(hub, PhysicsMotionType.DYNAMIC, false, scene);
    dbody.shape = dshape;
    dbody.setMassProperties({ mass: D.mass });
    dbody.setAngularDamping(0); dbody.setLinearDamping(0.05);
    dbody.setCollisionCallbackEnabled(true);
    const inertia = (dbody.getMassProperties().inertia?.x ?? 0.28) * D.mass;
    const X = new Vector3(1, 0, 0), Y = new Vector3(0, 1, 0);
    const lock = (axis: PhysicsConstraintAxis) => ({ axis, minLimit: 0, maxLimit: 0 });
    const joint = new Physics6DoFConstraint(
      { pivotA: D.center.clone(), pivotB: Vector3.Zero(), axisA: X, axisB: X, perpAxisA: Y, perpAxisB: Y, collision: false },
      [lock(PhysicsConstraintAxis.LINEAR_X), lock(PhysicsConstraintAxis.LINEAR_Y), lock(PhysicsConstraintAxis.LINEAR_Z),
        lock(PhysicsConstraintAxis.ANGULAR_Y), lock(PhysicsConstraintAxis.ANGULAR_Z)], scene);
    body.addConstraint(dbody, joint);
    joint.setAxisMotorType(PhysicsConstraintAxis.ANGULAR_X, PhysicsConstraintMotorType.VELOCITY);
    joint.setAxisMotorTarget(PhysicsConstraintAxis.ANGULAR_X, 0);
    const torque = inertia * D.omega[0] / D.spinUpS;
    joint.setAxisMotorMaxForce(PhysicsConstraintAxis.ANGULAR_X, torque * D.brake);
    this.disc = { hub, body: dbody, joint, inertia, torque };
    dbody.getCollisionObservable().add(ev => this.onDiscTouch(ev));

    // ---- cube skins (HP = cubes) ----
    for (const p of Object.values(this.parts)) {
      p.skin = skinThing(scene, p.root, BOSS.paint, { size: BOSS.cube, core: BOSS.core }, hooks.shadows);
      p.init = p.skin?.count ?? 0;
      if (p.skin) p.skin.hpPerCube = p.max / Math.max(1, p.init);   // loose boss cubes are worth their HP share
    }
    this.legSkin = skinThing(scene, legsRoot, BOSS.paint, { size: BOSS.cube * 0.8, core: BOSS.core }, hooks.shadows);
    if (this.legSkin) this.legSkin.hpPerCube = 0.5;
    if (hooks.shadows) for (const m of this.meshes) hooks.shadows.addShadowCaster(m);
    this.maxHp = Object.values(BOSS.hp).reduce((a, b) => a + b, 0);

    // ---- slam warning ring + shockwave, burrows ----
    this.ring = MeshBuilder.CreateDisc('boss_slamRing', { radius: BOSS.slam.r, tessellation: 48 }, scene);
    this.ring.rotation.x = Math.PI / 2; this.ring.material = fx; this.ring.isPickable = false; this.ring.setEnabled(false);
    this.wave = MeshBuilder.CreateTorus('boss_wave', { diameter: 2, thickness: 0.18, tessellation: 48 }, scene);
    this.wave.material = fw; this.wave.isPickable = false; this.wave.setEnabled(false);
    for (let k = 0; k < 4; k++) {
      const a = Math.PI / 4 + k * Math.PI / 2, r = half * 0.8;
      const p = center.add(new Vector3(Math.sin(a) * r, 0, Math.cos(a) * r));
      this.burrows.push(p);
      const hole = MeshBuilder.CreateDisc('boss_burrow', { radius: 0.75, tessellation: 20 }, scene);
      hole.rotation.x = Math.PI / 2; hole.position = p.add(new Vector3(0, 0.02, 0)); hole.material = bur; hole.isPickable = false;
      const rim = MeshBuilder.CreateTorus('boss_burrowRim', { diameter: 1.55, thickness: 0.12, tessellation: 20 }, scene);
      rim.position = p.add(new Vector3(0, 0.04, 0)); rim.material = burG; rim.isPickable = false;
      this.meshes.push(hole, rim);
    }

    this.target3 = {
      owns: b => b === this.body || b === this.disc.body,
      energy: () => {   // hinged weapons: what they gave it -- lift and vertical speed only (it drives itself around)
        if (this.dead) return 0;
        const vy = this.body.getLinearVelocity().y, h = Math.max(0, this.root.position.y - (this.center.y + BOSS.rest));
        return 0.5 * BOSS.mass * vy * vy + BOSS.mass * 9.81 * h;
      },
      hit: (a, raw, pt) => this.hit(a, raw, pt),
    };
  }

  // ------------------------------------------------------------------------------------------------- helpers
  private toWorld(local: Vector3): Vector3 { this.root.computeWorldMatrix(true); return Vector3.TransformCoordinates(local, this.root.getWorldMatrix()); }
  private toLocal(world: Vector3): Vector3 { this.root.computeWorldMatrix(true); return Vector3.TransformCoordinates(world, this.root.getWorldMatrix().clone().invert()); }
  get pos(): Vector3 { return this.root.position; }
  forward(): Vector3 { this.root.computeWorldMatrix(true); const f = Vector3.TransformNormal(Vector3.Forward(), this.root.getWorldMatrix()); f.y = 0; return f.normalize(); }
  /** HP left, all parts (the bar) */
  get hp(): number { return this.dead ? 0 : Object.values(this.parts).reduce((a, p) => a + Math.max(0, p.hp), 0); }
  get discLive(): boolean { return !this.dead && this.discOmega() > BOSS.disc.omega[0] * 0.3; }
  private discOmega(): number {
    const axis = Vector3.TransformNormal(Vector3.Right(), this.root.getWorldMatrix()).normalize();
    const rel = this.disc.body.getAngularVelocity().subtract(this.body.getAngularVelocity());
    return -Vector3.Dot(rel, axis);   // front edge up = positive
  }
  private discE(): number { const w = this.discOmega(); return 0.5 * this.disc.inertia * w * w; }
  /** where bots shouldn't (re)spawn */
  avoid(): Vector3[] { return this.dead ? [] : [this.pos.clone(), this.toWorld(new Vector3(0, 0, 2.6)), this.toWorld(new Vector3(0, 0, -2))]; }
  /** minis on this bot (drive slow-down = 1 - 10% each) */
  latchedOn(b: Bot): number { return this.minis.filter(m => m.state === 'latched' && m.on === b).length; }
  minisInfo(): { pos: Vector3; on: boolean }[] { return this.minis.map(m => ({ pos: m.pos, on: m.state === 'latched' })); }
  /** v0.58 AI ally aim: the point on the boss's hull nearest the bot (a stand-in "bot" for ai.ts: position, facing, weapon) */
  aimFor(id: BotId, from: Vector3): Bot {
    let n = this.aims.get(id);
    if (!n) { n = new TransformNode(`boss_aim_${id}`, this.scene); n.rotationQuaternion = new Quaternion(); this.aims.set(id, n); }
    const l = this.toLocal(from);
    const p = this.toWorld(new Vector3(Math.max(-1.2, Math.min(1.2, l.x)), 0, Math.max(-2.1, Math.min(3.2, l.z))));
    n.position.copyFrom(p); n.rotationQuaternion!.copyFrom(this.root.rotationQuaternion!);
    return { root: n, weapon: { power: () => (this.discLive ? 1 : 0) } } as unknown as Bot;
  }
  /** a free mini near `p` (AI allies go for the close ones), or a teammate with minis on it */
  /** v0.59 combo: every mini within r of p pops (no points -- the team gets none for these). Returns how many. */
  popMinisNear(p: Vector3, r: number): number {
    let n = 0;
    for (const m of [...this.minis]) if (m.state !== 'rise' && Math.hypot(m.pos.x - p.x, m.pos.z - p.z) <= r) { this.killMini(m, undefined); n++; }
    return n;
  }
  /** v0.59 combo stun: can't drive or attack for ms (the disc keeps spinning). Not while one is running (a bigger combo
   *  doesn't restart it) and not again until cooldownMs after one ends. true = it took. */
  private stunUntil = 0; private stunFree = 0;
  get stunned(): boolean { return !this.dead && performance.now() < this.stunUntil; }
  stun(ms: number, cooldownMs: number, now = performance.now()): boolean {
    if (this.dead || now < this.stunUntil || now < this.stunFree) return false;
    this.stunUntil = now + ms; this.stunFree = this.stunUntil + cooldownMs;
    if (this.grab) { this.pincerReady[this.grab.side] = this.stunUntil + 500; this.grab = undefined; }   // lets go (no throw)
    if (this.state === 'slamWarn' || this.state === 'slamAir' || this.state === 'sweep') { this.ring.setEnabled(false); this.setState('chase'); }
    this.slamAt = Math.max(this.slamAt, this.stunUntil + 1500); this.sweepAt = Math.max(this.sweepAt, this.stunUntil + 2000);
    this.hooks.fx.poof(this.pos.add(new Vector3(0, 2.2, 0)), '#36f1ff');
    this.hooks.fx.text(this.pos.add(new Vector3(0, 3, 0)), 'STUNNED!', '#36f1ff', ms / 1000);
    return true;
  }
  miniNear(p: Vector3, r: number): Vector3 | undefined {
    let best: Vector3 | undefined, bd = r * r;
    for (const m of this.minis) if (m.state === 'walk') { const d = Vector3.DistanceSquared(m.pos, p); if (d < bd) { bd = d; best = m.pos; } }
    return best;
  }

  // ------------------------------------------------------------------------------------------------- damage
  /** a real weapon hit from a teammate (combat.ts). HP = cubes: nearest part, overflow to the next nearest. */
  hit(attacker: Bot, raw: number, point: Vector3): number {
    if (this.dead) return 0;
    let left = Math.min(raw, HIT.maxDealt);
    const l = this.toLocal(point);
    const dist = (p: Part) => {
      if (p.id === 'disc') return Math.max(0, Vector3.Distance(point, this.disc.hub.position) - BOSS.disc.r);
      let d = Infinity;
      for (const b of p.boxes) {
        const dx = Math.max(0, Math.abs(l.x - b.c.x) - b.h.x), dy = Math.max(0, Math.abs(l.y - b.c.y) - b.h.y), dz = Math.max(0, Math.abs(l.z - b.c.z) - b.h.z);
        d = Math.min(d, Math.hypot(dx, dy, dz));
      }
      return d;
    };
    const order = Object.values(this.parts).filter(p => p.hp > this.floorOf(p)).sort((a, b) => dist(a) - dist(b));
    let dealt = 0;
    for (const p of order) {
      const room = p.hp - this.floorOf(p);
      if (room <= 0) continue;
      const take = Math.min(room, left);
      p.hp -= take; left -= take; dealt += take;
      this.syncCubes(p, point);
      if (left <= 0) break;
    }
    if (dealt <= 0) return 0;
    this.lastHitBy = attacker.id;
    this.hooks.onPoints(attacker.id, dealt, 'boss');
    this.hooks.fx.hitAt(point, dealt, 'boss', this.hooks.isPlayer(attacker.id));
    if (this.parts.chassis.hp <= 0) this.ko(attacker.id);
    return dealt;
  }
  private floorOf(p: Part): number {
    if (FLOORED.includes(p.id)) return 1;
    if (p.id === 'chassis') return this.parts.carapace.hp > 0 || this.parts.pincerL.hp > 0 || this.parts.pincerR.hp > 0 ? 1 : 0;
    return 0;
  }
  /** HP = cubes: the part keeps its share of cubes; at 0 HP it falls off (cubes = loot) and its collider goes */
  private syncCubes(p: Part, point: Vector3) {
    if (p.hp <= 0) {
      p.skin?.knockout(true);
      for (const s of p.shapes) { s.filterMembershipMask = 0; s.filterCollideMask = 0; }
      if (!p.skin) p.root.setEnabled(false);
      if (p.id === 'pincerL' || p.id === 'pincerR') {
        if (this.grab && this.grab.side === (p.id === 'pincerL' ? 'L' : 'R')) this.grab = undefined;
        this.hooks.sign(`PINCER OFF!`, 900, '#ffd23f');
      } else if (p.id === 'carapace') this.hooks.sign('SHELL CRACKED!', 1000, '#ffd23f');
      return;
    }
    if (!p.skin) return;
    const want = Math.max(1, Math.ceil(p.init * p.hp / p.max));
    const extra = p.skin.alive() - want;
    if (extra > 0) p.skin.chip(point, extra);
  }
  private ko(by: BotId) {
    if (this.dead) return;
    this.dead = true; this.deadAt = performance.now(); this.state = 'dead';
    for (const p of Object.values(this.parts)) { p.hp = 0; p.skin?.knockout(true); if (!p.skin) p.root.setEnabled(false); }
    this.legSkin?.knockout(true);
    if (!this.legSkin) for (const l of this.legs) { l.femur.setEnabled(false); l.tibia.setEnabled(false); }
    this.hooks.onPoints(by, BOSS.pts.final, 'final');
    const at = this.pos.clone();
    this.hooks.fx.poof(at.add(new Vector3(0, 1, 0)), '#ff5a1f');
    this.hooks.fx.poof(at.add(new Vector3(0, 1.5, 1.5)), BOSS.core);
    this.hooks.fx.kick(0.6);
    // the collider goes with it (nothing left to hit); the disc too
    this.disc.joint.dispose();
    this.disc.body.dispose(); this.body.dispose();
    this.ring.setEnabled(false);
    for (const m of this.minis) this.killMini(m, undefined);
    this.miniSpawns = [];
  }

  // ------------------------------------------------------------------------------------------------- the disc's hits
  private teamOwner(body: PhysicsBody | undefined): Bot | undefined {
    if (!body) return undefined;
    return this.hooks.team().map(t => t.bot).find(b => !b.eliminated && (isChassis(b, body) || weaponBodies(b).some(w => w.body === body)));
  }
  private onDiscTouch(ev: IPhysicsCollisionEvent) {
    if (this.dead) return;
    const v = this.teamOwner(ev.collidedAgainst);
    if (!v) return;
    this.dc.touching = true; this.dc.victim = v;
    this.dc.point = ev.point?.clone() ?? this.disc.hub.position.clone();
  }

  // ------------------------------------------------------------------------------------------------- physics sub-step
  beforePhysics(dt: number) {
    if (this.dead) return;
    // disc motor
    const D = BOSS.disc, A = PhysicsConstraintAxis.ANGULAR_X, omega = D.omega[this.phase - 1];
    if (this.discOn) { this.disc.joint.setAxisMotorTarget(A, -omega); this.disc.joint.setAxisMotorMaxForce(A, this.disc.torque * this.discBoost * omega / D.omega[0]); }
    else { this.disc.joint.setAxisMotorTarget(A, 0); this.disc.joint.setAxisMotorMaxForce(A, this.disc.torque * D.brake); }
    this.dc.eB = this.discE(); this.dc.touching = false;
    // arcade base: horizontal speed + yaw toward what the AI wants; roll / pitch held near level
    const v = this.body.getLinearVelocity(), w = this.body.getAngularVelocity();
    const f = this.forward(), k = Math.min(1, BOSS.grip * dt);
    const tv = f.scale(this.cmd.speed);
    v.x += (tv.x - v.x) * k; v.z += (tv.z - v.z) * k;
    const up = Vector3.TransformNormal(Vector3.Up(), this.root.getWorldMatrix()).normalize();
    const tilt = Math.acos(Math.max(-1, Math.min(1, up.y)));
    let wx = w.x * (1 - BOSS.stab.damp * dt), wz = w.z * (1 - BOSS.stab.damp * dt);
    const free = BOSS.stab.freeDeg * Math.PI / 180;
    if (tilt > free) { const ax = Vector3.Cross(up, Vector3.Up()), n = ax.length(); if (n > 1e-4) { const kk = BOSS.stab.pull * (tilt - free) * dt / n; wx += ax.x * kk; wz += ax.z * kk; } }
    const wy = w.y + (this.cmd.yaw - w.y) * Math.min(1, 10 * dt);
    this.body.setLinearVelocity(v);
    this.body.setAngularVelocity(new Vector3(wx, wy, wz));
    // pincer hold: the grabbed bot rides the claw
    const g = this.grab;
    if (g && !g.bot.eliminated) {
      const tip = this.toWorld(new Vector3(g.side === 'L' ? -1.3 : 1.3, 0.1, 3.0));
      const bp = g.bot.body.getObjectCenterWorld();
      g.bot.body.setLinearVelocity(tip.subtract(bp).scale(10).add(new Vector3(v.x, 0, v.z)));
    }
  }
  afterPhysics() {
    if (this.dead) return;
    const c = this.dc, now = performance.now(), D = BOSS.disc;
    if (c.touching) {
      if (!c.active) { c.active = true; c.lost = 0; c.start = now; }
      c.lost += Math.max(0, c.eB - this.discE()); c.idle = 0;
    } else if (c.active) c.idle++;
    if (c.active && (c.idle >= D.gapSteps || now - c.start >= D.maxHitMs)) {
      const raw = Math.round(c.lost / D.joulesPerDmg * D.scale);
      if (raw >= 1 && c.victim && !c.victim.eliminated) this.hooks.combat().environmentHit(c.victim, c.point, raw, BOSS.core);
      c.active = false; c.lost = 0;
    }
  }

  // ------------------------------------------------------------------------------------------------- per frame
  /** countdown: the disc spins up (extra torque so it's at speed by FIGHT!) */
  spinUp(boost: number) { this.discOn = true; this.discBoost = boost; }

  update(dt: number, now: number, go: boolean) {
    this.poseLegs(dt);
    this.updateMinis(dt, now, go);
    if (this.dead) { this.cmd.speed = 0; this.cmd.yaw = 0; return; }
    if (!go) { this.cmd.speed = 0; this.cmd.yaw = 0; return; }
    this.discBoost = 1;
    if (this.state === 'idle') { this.state = 'chase'; this.stateT = 0; this.discOn = true; this.slamAt = now + 4000; this.sweepAt = now + 5000; this.fillMinis(now); }
    // phase changes: roar, stagger, a new wave
    const frac = this.hp / this.maxHp;
    const want = frac > BOSS.phaseAt[0] ? 1 : frac > BOSS.phaseAt[1] ? 2 : 3;
    if (want > this.phase) {
      this.phase = want;
      this.setState('stagger');
      this.grab = undefined;
      this.hooks.sign(want === 2 ? 'STINGWHEEL IS ANGRY!' : 'STINGWHEEL ENRAGED!', 1600, '#ff2e4d');
      this.hooks.fx.kick(0.3);
      this.slamAt = now + BOSS.staggerMs + 2500; this.sweepAt = now + BOSS.staggerMs + 4000;
      this.fillMinis(now);
    }
    this.stateT += dt * 1000;
    const ph = this.phase - 1;
    const team = this.hooks.team().filter(t => !t.bot.eliminated);
    // target: the nearest teammate
    if (!this.target || this.target.eliminated || !team.some(t => t.bot === this.target) || now - this.targetAt > BOSS.retargetMs) {
      let best: Bot | undefined, bd = Infinity;
      for (const t of team) { const d = Vector3.DistanceSquared(t.bot.root.position, this.pos); if (d < bd) { bd = d; best = t.bot; } }
      this.target = best; this.targetAt = now;
    }
    if (now < this.stunUntil && this.state !== 'stagger') { this.cmd.speed = 0; this.cmd.yaw = 0; this.discOn = true; }   // v0.59 combo stun
    else switch (this.state) {
      case 'stagger':
        this.discOn = false; this.cmd.speed = 0; this.cmd.yaw = 0;
        if (this.stateT >= BOSS.staggerMs) { this.discOn = true; this.setState('chase'); }
        break;
      case 'slamWarn': {
        this.cmd.speed = 0; this.cmd.yaw = 0;
        this.ring.setEnabled(true);
        this.ring.position.set(this.pos.x, this.center.y + 0.03, this.pos.z);
        (this.ring.material as StandardMaterial).alpha = 0.2 + 0.25 * (0.5 + 0.5 * Math.sin(this.stateT / 60));
        if (this.stateT >= BOSS.slam.warnMs) {
          this.ring.setEnabled(false);
          const v = this.body.getLinearVelocity(); this.body.setLinearVelocity(new Vector3(v.x, 4, v.z));   // rear up ...
          this.setState('slamAir');
        }
        break;
      }
      case 'slamAir':
        this.cmd.speed = 0; this.cmd.yaw = 0;
        if (this.stateT >= 380) { this.slam(team); this.setState('chase'); this.slamAt = now + BOSS.slam.everyMs[ph]; }   // ... and slam down
        break;
      case 'sweep':
        this.cmd.speed = 0.8; this.cmd.yaw = BOSS.sweep.yaw;
        if (this.stateT >= BOSS.sweep.ms) { this.setState('chase'); this.sweepAt = now + BOSS.sweep.everyMs; }
        break;
      case 'chase': default: {
        if (ph >= 1 && now >= this.slamAt && !this.grab) { this.setState('slamWarn'); this.hooks.sign('SLAM!', 700, '#ff2e4d'); break; }
        if (ph >= 2 && now >= this.sweepAt && !this.grab) { this.setState('sweep'); break; }
        this.chase(ph);
        this.pincers(now, team, ph);
      }
    }
    // jaw animation
    for (const side of ['L', 'R'] as const) {
      const jaw = this.parts[side === 'L' ? 'pincerL' : 'pincerR'].root.getChildMeshes(true).find(m => m.metadata?.jaw) as Mesh | undefined;
      if (jaw) { const closed = this.grab?.side === side; jaw.rotation.y += ((closed ? 0 : (side === 'L' ? -0.35 : 0.35)) - jaw.rotation.y) * Math.min(1, dt * 12); }
    }
    // the wave ring
    if (this.wave.isEnabled()) {
      const t = (now - (this.wave.metadata?.t ?? 0)) / 400;
      if (t >= 1) this.wave.setEnabled(false);
      else { const s = 1 + t * BOSS.slam.r; this.wave.scaling.set(s, 1, s); (this.wave.material as StandardMaterial).alpha = 0.7 * (1 - t); }
    }
  }
  private setState(s: BossState) { this.state = s; this.stateT = 0; }

  private chase(ph: number) {
    const tgt = this.target;
    let aim = tgt ? tgt.root.position.clone() : this.center.clone();
    const f = this.forward();
    const look = this.pos.add(f.scale(4)).subtract(this.center); look.y = 0;
    if (look.length() > this.half - 3) aim = this.center.clone();          // nose heading into the wall: back to the middle
    const to = aim.subtract(this.pos); to.y = 0;
    if (to.lengthSquared() < 0.01) { this.cmd.speed = 0; this.cmd.yaw = 0; return; }
    to.normalize();
    const ang = Math.atan2(Vector3.Cross(f, to).y, Vector3.Dot(f, to));
    const ymax = BOSS.yaw[ph];
    this.cmd.yaw = Math.max(-ymax, Math.min(ymax, ang * 2.5));
    const c = Math.cos(ang);
    this.cmd.speed = BOSS.speed[ph] * (c > 0.6 ? 1 : c > 0.2 ? 0.5 : 0.15);
  }

  private pincers(now: number, team: { id: BotId; bot: Bot }[], ph: number) {
    const P = BOSS.pincer;
    const g = this.grab;
    if (g) {
      g.t += this.scene.getEngine().getDeltaTime();
      if (g.bot.eliminated || g.t >= P.holdMs) {   // throw it at the disc
        if (!g.bot.eliminated) {
          const at = this.disc.hub.position.subtract(g.bot.root.position); at.y = 0; at.normalize();
          g.bot.body.setLinearVelocity(at.scale(P.throwV).add(new Vector3(0, P.throwUp, 0)));
        }
        this.pincerReady[g.side] = now + P.cooldownMs[ph];
        this.grab = undefined;
      }
      return;
    }
    for (const side of ['L', 'R'] as const) {
      const part = this.parts[side === 'L' ? 'pincerL' : 'pincerR'];
      if (part.hp <= 0 || now < this.pincerReady[side]) continue;
      const tip = this.toWorld(new Vector3(side === 'L' ? -1.3 : 1.3, 0, 3.0));
      for (const t of team) {
        const p = t.bot.root.position;
        if (Math.hypot(p.x - tip.x, p.z - tip.z) > P.reach) continue;
        this.grab = { bot: t.bot, side, t: 0 };
        this.hooks.combat().environmentHit(t.bot, tip, P.dmg, BOSS.core);
        if (this.hooks.isPlayer(t.id)) this.hooks.sign('GRABBED!', 800, '#ff2e4d');
        return;
      }
    }
  }

  private slam(team: { id: BotId; bot: Bot }[]) {
    const S = BOSS.slam, c = this.pos;
    this.wave.setEnabled(true); this.wave.metadata = { t: performance.now() };
    this.wave.position.set(c.x, this.center.y + 0.1, c.z); this.wave.scaling.set(1, 1, 1);
    this.hooks.fx.poof(new Vector3(c.x, this.center.y + 0.2, c.z), '#ff8a8a');
    for (const t of team) {
      const p = t.bot.root.position, d = Math.hypot(p.x - c.x, p.z - c.z);
      if (d > S.r) continue;
      const out = new Vector3(p.x - c.x, 0, p.z - c.z); if (out.lengthSquared() < 1e-4) out.set(1, 0, 0); out.normalize();
      const m = t.bot.body.getMassProperties().mass ?? 100, v = t.bot.body.getLinearVelocity();
      t.bot.body.setLinearVelocity(v.add(out.scale(S.dv)).add(new Vector3(0, S.up, 0)));
      void m;
      this.hooks.combat().environmentHit(t.bot, p.add(new Vector3(0, -0.2, 0)), S.dmg, '#ff2e4d');
      if (this.hooks.isPlayer(t.id)) this.hooks.fx.kick(0.45);
    }
  }

  // ------------------------------------------------------------------------------------------------- legs
  private poseLegs(dt = 0) {
    if (!this.legs.length) return;
    const stepping = new Set(this.legs.filter(l => l.stepping).map(l => l.group));
    const vel = this.dead ? Vector3.Zero() : this.body?.getLinearVelocity() ?? Vector3.Zero();
    for (const l of this.legs) {
      const homeW = this.toWorld(l.home); homeW.y = this.center.y;
      if (l.stepping) {
        l.t += dt / LEG.stepS;
        if (l.t >= 1) { l.stepping = false; l.foot.copyFrom(l.to); }
        else { Vector3.LerpToRef(l.from, l.to, l.t, l.foot); l.foot.y = this.center.y + Math.sin(l.t * Math.PI) * LEG.lift; }
      } else if (!this.dead && Vector3.Distance(l.foot, homeW) > LEG.stride && !stepping.has(1 - l.group)) {
        l.stepping = true; l.t = 0; l.from.copyFrom(l.foot);
        l.to.copyFrom(homeW.add(new Vector3(vel.x, 0, vel.z).scale(LEG.lead)));
        stepping.add(l.group);
      }
      // 2-bone IK in boss local space, knee up
      const H = l.hip, F = this.toLocal(l.foot);
      const hf = F.subtract(H);
      const d = Math.max(Math.abs(LEG.L1 - LEG.L2) + 0.05, Math.min((LEG.L1 + LEG.L2) * 0.98, hf.length()));
      const dir = hf.normalize();
      const a = (LEG.L1 * LEG.L1 - LEG.L2 * LEG.L2 + d * d) / (2 * d), h = Math.sqrt(Math.max(0, LEG.L1 * LEG.L1 - a * a));
      const up = Vector3.Up(), perp = up.subtract(dir.scale(Vector3.Dot(up, dir))).normalize();
      const K = H.add(dir.scale(a)).add(perp.scale(h));
      const Fd = K.add(F.subtract(K).normalize().scale(LEG.L2));
      this.seg(l.femur, H, K); this.seg(l.tibia, K, Fd);
    }
  }
  private seg(m: Mesh, a: Vector3, b: Vector3) {
    m.position.copyFrom(a.add(b).scale(0.5));
    const d = b.subtract(a).normalize();
    Quaternion.FromUnitVectorsToRef(Vector3.Up(), d, m.rotationQuaternion!);
  }

  // ------------------------------------------------------------------------------------------------- mini scorpions
  private fillMinis(now: number) {
    const cap = BOSS.mini.cap[this.phase - 1];
    const have = this.minis.length + this.miniSpawns.length;
    for (let i = 0; i < cap - have; i++) this.miniSpawns.push(now + i * 300);
  }
  private spawnMini() {
    const b = this.burrows[Math.floor(Math.random() * this.burrows.length)];
    const root = new Mesh('mini', this.scene);
    const bx = (name: string, m: string, w: number, h: number, d: number, x: number, y: number, z: number, rx = 0) => {
      const k = MeshBuilder.CreateBox(`mini_${name}`, { width: w, height: h, depth: d }, this.scene);
      k.material = this.mats[m]; k.parent = root; k.position.set(x, y, z); k.rotation.x = rx; k.isPickable = false; return k;
    };
    bx('body', 'paint_mini', 0.34, 0.14, 0.42, 0, 0.12, 0);
    bx('head', 'dark_mini', 0.22, 0.1, 0.14, 0, 0.11, 0.26);
    bx('t1', 'paint_mini', 0.1, 0.1, 0.18, 0, 0.2, -0.26, -0.6);
    bx('t2', 'paint_mini', 0.09, 0.09, 0.16, 0, 0.33, -0.3, -1.4);
    bx('t3', 'steel_mini', 0.07, 0.07, 0.14, 0, 0.42, -0.2, -2.4);
    for (const s of [-1, 1]) bx('claw', 'steel_mini', 0.08, 0.07, 0.18, s * 0.16, 0.1, 0.38);
    const legs: Mesh[] = [];
    for (const s of [-1, 1]) for (const z of [-0.12, 0.02, 0.16]) { const l = bx('leg', 'dark_mini', 0.2, 0.04, 0.04, s * 0.24, 0.06, z); l.rotation.z = s * 0.5; legs.push(l); }
    root.position = b.add(new Vector3(0, -0.4, 0));
    const skin = skinThing(this.scene, root, BOSS.mini.paint, { size: BOSS.mini.cube, core: BOSS.core }, this.hooks.shadows);
    const to = this.center.subtract(b);
    this.minis.push({ root, skin, legs, pos: root.position.clone(), yaw: Math.atan2(to.x, to.z), vy: 0, vel: Vector3.Zero(),
      state: 'rise', t: 0, offYaw: 0, shake: 0, nibbleAt: 0, prevSpeed: 0 });
  }
  private killMini(m: Mini, by: BotId | undefined) {
    const at = m.pos.add(new Vector3(0, 0.2, 0));
    m.skin?.knockout(false);
    this.hooks.fx.poof(at, BOSS.mini.paint, by && this.hooks.isPlayer(by) ? `+${BOSS.mini.pts}` : undefined);
    if (by) this.hooks.onPoints(by, BOSS.mini.pts, 'mini');
    m.root.dispose();
    this.minis = this.minis.filter(x => x !== m);
    if (!this.dead) this.miniSpawns.push(performance.now() + BOSS.mini.respawnMs);
  }
  private updateMinis(dt: number, now: number, go: boolean) {
    const M = BOSS.mini;
    if (go && !this.dead) {
      const cap = M.cap[this.phase - 1];
      this.miniSpawns.sort((a, b) => a - b);
      while (this.miniSpawns.length && this.miniSpawns[0] <= now) { this.miniSpawns.shift(); if (this.minis.length < cap) this.spawnMini(); }
    }
    const team = this.hooks.team().filter(t => !t.bot.eliminated);
    for (const m of [...this.minis]) {
      m.t += dt * 1000;
      if (m.state === 'latched') {
        const b = m.on!;
        if (b.eliminated || !team.some(t => t.bot === b)) { this.dropMini(m); continue; }
        b.root.computeWorldMatrix(true);
        m.pos.copyFrom(Vector3.TransformCoordinates(m.off!, b.root.getWorldMatrix()));
        const v = b.body.getLinearVelocity(), sp = Math.hypot(v.x, v.z);
        const yawRate = Math.abs(b.body.getAngularVelocity().y);
        m.shake = yawRate > M.shakeYaw ? m.shake + dt : Math.max(0, m.shake - dt);
        if (m.shake > M.shakeS || m.prevSpeed - sp > M.wallDv) { this.dropMini(m); continue; }   // hard turn / hit a wall
        m.prevSpeed = sp;
        if (go && now >= m.nibbleAt) { m.nibbleAt = now + M.nibbleMs; this.hooks.combat().environmentHit(b, m.pos, M.nibble, M.paint); }
        const q = b.root.rotationQuaternion ?? Quaternion.Identity();
        m.root.position.copyFrom(m.pos);
        m.root.rotationQuaternion = q.multiply(Quaternion.FromEulerAngles(0, m.offYaw, 0));
      } else {
        if (m.state === 'rise') {
          m.pos.y = Math.min(this.center.y, this.center.y - 0.4 + 0.4 * m.t / M.riseMs);
          if (m.t >= M.riseMs) { m.state = 'walk'; m.t = 0; }
        } else if (m.state === 'stun') {
          m.vy -= 9.8 * dt; m.pos.addInPlace(m.vel.scale(dt)); m.pos.y = Math.max(this.center.y, m.pos.y + m.vy * dt);
          m.vel.scaleInPlace(Math.max(0, 1 - 3 * dt));
          if (m.t >= M.stunMs) { m.state = 'walk'; m.t = 0; m.pos.y = this.center.y; }
        } else if (go && !this.dead) {   // walk: go for the nearest teammate
          let best: Bot | undefined, bd = Infinity;
          for (const t of team) { const d = Vector3.DistanceSquared(t.bot.root.position, m.pos); if (d < bd) { bd = d; best = t.bot; } }
          if (best) {
            const to = best.root.position.subtract(m.pos); to.y = 0;
            const want = Math.atan2(to.x, to.z);
            let da = want - m.yaw; while (da > Math.PI) da -= 2 * Math.PI; while (da < -Math.PI) da += 2 * Math.PI;
            m.yaw += Math.max(-M.turn * dt, Math.min(M.turn * dt, da));
            const sp = M.speed * (this.phase === 3 ? 1.12 : 1);
            m.pos.x += Math.sin(m.yaw) * sp * dt; m.pos.z += Math.cos(m.yaw) * sp * dt;
            // latch onto a slow bot (a fast one just runs it over -- see the bump below)
            const v = best.body.getLinearVelocity();
            if (Math.sqrt(bd) < M.latchR && Math.hypot(v.x, v.z) < M.bumpV && this.latchedOn(best) < M.maxPerBot) this.latch(m, best);
          }
        }
        if ((m.state as Mini['state']) !== 'latched') {
          // stay out of the boss and inside the arena
          if (!this.dead) { const o = m.pos.subtract(this.pos); o.y = 0; const d = o.length(); if (d < M.avoidR && d > 1e-3) m.pos.addInPlace(o.scale((M.avoidR - d) / d)); }
          const c = m.pos.subtract(this.center); c.y = 0; const cr = c.length(), lim = this.half - 0.6;
          if (cr > lim) m.pos.subtractInPlace(c.scale((cr - lim) / cr));
          m.root.position.copyFrom(m.pos);
          m.root.rotationQuaternion = Quaternion.FromEulerAngles(0, m.yaw, 0);
          const wig = Math.sin(now / 45);
          m.legs.forEach((l, i) => { l.rotation.y = (i % 2 ? 1 : -1) * wig * 0.5; });
        }
      }
      // killed: a live weapon touching it, or a bump at 2 m/s+ (never by the bot it's riding)
      if (m.state === 'rise') continue;
      for (const t of team) {
        if (t.bot === m.on) continue;
        const b = t.bot;
        if (b.weapon.power() > 0 && weaponBodies(b).some(w => Vector3.Distance(w.body.getObjectCenterWorld(), m.pos) < M.killR)) { this.killMini(m, t.id); break; }
        if (m.state !== 'latched') {
          const v = b.body.getLinearVelocity(), p = b.root.position;
          if (Math.hypot(v.x, v.z) >= M.bumpV && Math.hypot(p.x - m.pos.x, p.z - m.pos.z) < M.bumpR) { this.killMini(m, t.id); break; }
        }
      }
    }
  }
  private latch(m: Mini, b: Bot) {
    m.state = 'latched'; m.on = b; m.t = 0; m.shake = 0;
    m.off = new Vector3((Math.random() - 0.5) * 0.9, 0.32, (Math.random() - 0.5) * 1.1);
    m.offYaw = Math.random() * Math.PI * 2; m.nibbleAt = performance.now() + 400;
    const v = b.body.getLinearVelocity(); m.prevSpeed = Math.hypot(v.x, v.z);
    const hb = this.hooks.team().find(t => t.bot === b);
    if (hb && this.hooks.isPlayer(hb.id)) this.hooks.sign('MINI ON YOU! TURN HARD', 900, BOSS.mini.paint);
  }
  private dropMini(m: Mini) {
    const b = m.on;
    m.state = 'stun'; m.t = 0; m.on = undefined;
    const out = b ? m.pos.subtract(b.root.position) : new Vector3(1, 0, 0); out.y = 0;
    if (out.lengthSquared() < 1e-4) out.set(1, 0, 0);
    m.vel = out.normalize().scale(3); m.vy = 2;
  }

  dispose() {
    try { this.disc.joint.dispose(); } catch { /* gone with the KO */ }
    if (!this.dead) { this.disc.body.dispose(); this.body.dispose(); }
    for (const m of this.minis) m.root.dispose();
    this.minis = [];
    for (const p of Object.values(this.parts)) p.root.dispose();
    for (const n of this.aims.values()) n.dispose();
    this.disc.hub.dispose();
    for (const m of this.meshes) if (!m.isDisposed()) m.dispose();
    this.ring.dispose(); this.wave.dispose();
    this.root.dispose();
    for (const m of Object.values(this.mats)) m.dispose();
  }
}
