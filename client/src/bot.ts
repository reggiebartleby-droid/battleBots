/**
 * Assembles a visual + physical bot from a BotBuild using placeholder primitives.
 *
 * v0.7 "plain physics": one rigid body per bot, but its collision shape is a COMPOUND of
 * real part colliders (PhysicsShapeContainer):
 *   - chassis box
 *   - four wheel cylinders (so the chassis has real ground clearance -- a lower ramp can get under it)
 *   - the front part as a real sloped wedge prism (plow / wedge / wedgelet differ in angle and tip height)
 *   - the weapon's shape (hull of its mesh, or a sweep cylinder for spinners)
 *   - side armor plates
 * Lifting / stacking / tipping now come from geometry and mass, not scripted impulses.
 */
import {
  Color3, Mesh, MeshBuilder, PhysicsBody, PhysicsMotionType, PhysicsShape, PhysicsShapeBox, PhysicsShapeContainer,
  PhysicsShapeConvexHull, PhysicsShapeCylinder, PhysicsMaterialCombineMode, Scene, StandardMaterial, Vector3, VertexData, Quaternion,
} from '@babylonjs/core';
import type { BotBuild, Catalog, PartDef, WeaponKind } from '../../src/core/types.js';
import { createBotState, type BotState } from '../../src/core/state.js';
import { validateBuild } from '../../src/core/validate.js';
import { Weapon } from './weapon.js';

export interface Bot {
  id: 'A' | 'B';
  build: BotBuild;
  state: BotState;
  root: Mesh;
  body: PhysicsBody;
  weaponMesh?: Mesh;
  weaponKind?: WeaponKind;
  spinAxis: 'x' | 'y' | 'none';
  partMeshes: Record<string, Mesh>;   // socketId -> mesh
  totalWeight: number;
  weapon: Weapon;                     // activation state (spin level, swing phase, grip)
  weaponRestRotX: number;             // weaponMesh.rotation.x at rest, for swing/flip animation
  lastHit?: { socket: string; t: number };   // most recent damage taken (HUD flash)
  /** Set when the bot is knocked out of the arena (main.ts OUT block): the moment, where it was
   *  and how fast it was going. This is the hook for the elimination animation (fx.explode). */
  eliminated?: { t: number; pos: Vector3; vel: Vector3; reason: 'out' };
  /** Set while the bot is resting upside down (main.ts). since = when it landed inverted. */
  inverted?: { since: number };
  /** Self-right in progress: at this time the chassis is snapped back onto its wheels. */
  rightingUntil?: number;
}

export const CHASSIS = { w: 1.4, h: 0.35, d: 1.6 };
export const WHEEL = { r: 0.25, w: 0.2, y: -0.05, x: CHASSIS.w / 2 + 0.12 };
/** Chassis centre height when the wheels sit on the floor (floor top is y = 0). */
export const REST_Y = WHEEL.r - WHEEL.y;          // 0.30

/** Physics tuning for the body (v0.7). */
export const BODY = {
  massScale: 0.4,          // bot weight stat -> kg
  minMass: 20,
  comDrop: 0.12,           // centre of mass this far below the chassis centre (bottom-heavy)
  angularDamping: 0.5,     // low: tumbles are real now
  linearDamping: 0.1,
  // per-part materials (friction combines by geometric mean with whatever it touches)
  chassis: { friction: 0.5, restitution: 0.35 },
  wheel:   { friction: 0.15, restitution: 0.1 },   // low: the drive model supplies grip; wheels mostly roll
  front:   { friction: 0.12, restitution: 0.2 },   // slick ramp so things slide up it
  weapon:  { friction: 0.4, restitution: 0.4 },
  armor:   { friction: 0.5, restitution: 0.35 },
};

/** Front ramps: slope angle, how high the tip sits (floor contact is y = -REST_Y) and where the top meets the chassis. */
const FRONT: Record<string, { angleDeg: number; tipY: number; topY: number }> = {
  plow:     { angleDeg: 20, tipY: -REST_Y + 0.010, topY: 0.05 },             // lowest, longest, heavy
  wedge:    { angleDeg: 30, tipY: -REST_Y + 0.025, topY: CHASSIS.h / 2 },
  wedgelet: { angleDeg: 35, tipY: -REST_Y + 0.040, topY: CHASSIS.h / 2 },    // hinged in real life: sits a touch higher
};

function mat(scene: Scene, name: string, hex: string, alpha = 1) {
  const m = new StandardMaterial(name, scene);
  m.diffuseColor = Color3.FromHexString(hex);
  m.alpha = alpha;
  return m;
}

/** Visual-only assembly (no physics). Used by the lab preview and by buildBot(). */
export interface BotMesh {
  root: Mesh;
  weaponMesh?: Mesh;
  weaponKind?: WeaponKind;
  spinAxis: Bot['spinAxis'];
  partMeshes: Record<string, Mesh>;
  totalWeight: number;
  weaponRestRotX: number;
  partKinds: Record<string, PartDef>;   // socketId -> part (for the collider pass)
}

export function assembleBotMesh(id: string, build: BotBuild, catalog: Catalog, scene: Scene): BotMesh {
  const v = validateBuild(build, catalog);
  if (!v.ok) throw new Error(`Bot ${id} invalid: ${v.errors.join('; ')}`);
  const paint = build.cosmetics.paint ?? (id === 'A' ? '#e63946' : '#1d7cf2');

  const root = MeshBuilder.CreateBox(`bot${id}`, { width: CHASSIS.w, height: CHASSIS.h, depth: CHASSIS.d }, scene);
  root.material = mat(scene, `paint${id}`, paint);

  const partMeshes: Record<string, Mesh> = {};
  const partKinds: Record<string, PartDef> = {};
  let weaponMesh: Mesh | undefined;
  let weaponKind: WeaponKind | undefined;
  let spinAxis: Bot['spinAxis'] = 'none';
  const dark = mat(scene, `dark${id}`, '#3a3d44');
  const steel = mat(scene, `steel${id}`, '#9aa3ad');
  const rubber = mat(scene, `rubber${id}`, '#15171a');

  for (const [socketId, part] of Object.entries(v.resolved)) {
    const m = partMesh(scene, id, socketId, part, { dark, steel, rubber, paint: root.material as StandardMaterial });
    if (!m) continue;
    m.parent = root;
    partMeshes[socketId] = m;
    partKinds[socketId] = part;
    if (part.type === 'weapon') {
      weaponMesh = m;
      weaponKind = part.kind as WeaponKind;
      spinAxis = spinAxisFor(weaponKind);
    }
  }

  // Full-body spinners: hide the chassis inside the shell
  if (build.bodyId === 'full_body_spinner') root.visibility = 0.001;

  return { root, weaponMesh, weaponKind, spinAxis, partMeshes, partKinds, totalWeight: v.totalWeight, weaponRestRotX: weaponMesh?.rotation.x ?? 0 };
}

export function buildBot(id: 'A' | 'B', build: BotBuild, catalog: Catalog, scene: Scene, pos: Vector3, facing: number): Bot {
  const mesh = assembleBotMesh(id, build, catalog, scene);
  const state = createBotState(build, catalog);
  const { root } = mesh;
  root.position.copyFrom(pos);
  root.rotationQuaternion = Quaternion.RotationAxis(Vector3.Up(), facing);
  root.computeWorldMatrix(true);

  // ---- Compound collision shape ----
  const shape = new PhysicsShapeContainer(scene);
  const add = (s: PhysicsShape, m: PhysicsMaterialLike, child?: Mesh) => {
    s.material = { ...m, frictionCombine: PhysicsMaterialCombineMode.GEOMETRIC_MEAN, restitutionCombine: PhysicsMaterialCombineMode.GEOMETRIC_MEAN };
    if (child) { child.computeWorldMatrix(true); shape.addChildFromParent(root, s, child); }
    else shape.addChild(s);
  };

  // chassis
  add(new PhysicsShapeBox(Vector3.Zero(), Quaternion.Identity(), new Vector3(CHASSIS.w, CHASSIS.h, CHASSIS.d), scene), BODY.chassis);

  // wheels: cylinders along x at each wheel position (the visual wheels are children of the wheels mesh)
  for (const [socketId, m] of Object.entries(mesh.partMeshes)) {
    const part = mesh.partKinds[socketId];
    switch (part.type) {
      case 'wheels':
        for (const w of m.getChildMeshes()) {
          const p = (w as Mesh).position;   // local to the wheels group, which sits at the chassis origin
          add(new PhysicsShapeCylinder(new Vector3(p.x - WHEEL.w / 2, p.y, p.z), new Vector3(p.x + WHEEL.w / 2, p.y, p.z), WHEEL.r, scene), BODY.wheel);
        }
        break;
      case 'front':
        add(new PhysicsShapeConvexHull(m, scene), BODY.front, m);
        break;
      case 'weapon': {
        const kind = part.kind as WeaponKind;
        // Spinners: a sweep cylinder matching the spinning visual (the collider doesn't rotate; Phase 2 makes it a real body)
        if (mesh.spinAxis === 'x') {
          const r = kind === 'drum' ? 0.275 : kind === 'bar' ? 0.55 : 0.45;
          const half = kind === 'drum' ? 0.6 : kind === 'bar' ? 0.09 : 0.04;
          const c = m.position;
          add(new PhysicsShapeCylinder(new Vector3(c.x - half, c.y, c.z), new Vector3(c.x + half, c.y, c.z), r, scene), BODY.weapon);
        } else if (mesh.spinAxis === 'y') {
          const r = kind === 'shell' || kind === 'cage' ? 1.0 : kind === 'h_bar' ? 1.0 : kind === 'h_disc' ? 0.8 : 0.9;
          const half = kind === 'shell' ? 0.25 : kind === 'cage' ? 0.075 : 0.04;
          const c = m.position;
          add(new PhysicsShapeCylinder(new Vector3(c.x, c.y - half, c.z), new Vector3(c.x, c.y + half, c.z), r, scene), BODY.weapon);
        } else {
          add(new PhysicsShapeConvexHull(m, scene), BODY.weapon, m);   // arm / plate at its rest pose
        }
        break;
      }
      case 'armor':
        if (socketId !== 'armor') add(new PhysicsShapeConvexHull(m, scene), BODY.armor, m);   // side plates stick out; top plate is inside the hull anyway
        break;
    }
  }

  const body = new PhysicsBody(root, PhysicsMotionType.DYNAMIC, false, scene);
  body.shape = shape;
  body.setCollisionCallbackEnabled(true);

  // Mass from the weight stat. Havok keeps the inertia it computed from the compound shape
  // (stored per unit mass, so it stays consistent when the mass is overridden -- verified in
  // a headless test); centre of mass dropped so the bot is bottom-heavy like a real one.
  const mp = body.getMassProperties();
  const mass = Math.max(BODY.minMass, mesh.totalWeight * BODY.massScale);
  const com = (mp.centerOfMass ?? Vector3.Zero()).add(new Vector3(0, -BODY.comDrop, 0));
  body.setMassProperties({ mass, centerOfMass: com });
  body.setAngularDamping(BODY.angularDamping);
  body.setLinearDamping(BODY.linearDamping);

  return { id, build, state, body, weapon: new Weapon(mesh.weaponKind), ...mesh };
}

type PhysicsMaterialLike = { friction: number; restitution: number };

function spinAxisFor(kind: WeaponKind): Bot['spinAxis'] {
  if (['disc', 'bar', 'drum'].includes(kind)) return 'x';
  if (['h_bar', 'h_disc', 'undercutter', 'shell', 'cage'].includes(kind)) return 'y';
  return 'none';
}

type Mats = { dark: StandardMaterial; steel: StandardMaterial; rubber: StandardMaterial; paint: StandardMaterial };

/** A triangular wedge prism in chassis-local coordinates: back face flush with the chassis front, tip out front. */
function wedgePrism(scene: Scene, name: string, kind: string): Mesh {
  const f = FRONT[kind] ?? FRONT.wedge;
  const z0 = CHASSIS.d / 2;
  const len = (f.topY - f.tipY) / Math.tan((f.angleDeg * Math.PI) / 180);
  const hw = CHASSIS.w / 2;
  // triangle (z, y): back-bottom, back-top, tip   -- extruded along x
  const tri = [[z0, f.tipY], [z0, f.topY], [z0 + len, f.tipY]] as const;
  const positions: number[] = [];
  for (const x of [-hw, hw]) for (const [z, y] of tri) positions.push(x, y, z);
  // indices: left tri (0,1,2), right tri (3,4,5), and 3 quads between them
  const indices = [
    0, 1, 2,  3, 5, 4,      // left / right triangles
    0, 4, 1,  0, 3, 4,      // back face
    1, 5, 2,  1, 4, 5,      // slope
    2, 3, 0,  2, 5, 3,      // bottom
  ];
  const vd = new VertexData();
  vd.positions = positions; vd.indices = indices;
  const normals: number[] = [];
  VertexData.ComputeNormals(positions, indices, normals);
  vd.normals = normals;
  const m = new Mesh(name, scene);
  vd.applyToMesh(m);
  return m;
}

function partMesh(scene: Scene, id: string, socketId: string, part: PartDef, mats: Mats): Mesh | undefined {
  const n = `${id}_${socketId}`;
  const front = CHASSIS.d / 2;
  switch (part.type) {
    case 'weapon': return weaponMesh(scene, n, part.kind as WeaponKind, mats);
    case 'front': {
      const m = wedgePrism(scene, n, part.kind ?? "wedge");
      m.material = mats.steel;
      return m;
    }
    case 'armor': {
      // armor_1 / armor_2 -> left / right side plates; plain "armor" -> top plate
      const m = MeshBuilder.CreateBox(n, { width: socketId.endsWith('2') || socketId.endsWith('1') ? 0.08 : CHASSIS.w * 0.9, height: socketId === 'armor' ? 0.06 : 0.3, depth: CHASSIS.d * 0.9 }, scene);
      if (socketId === 'armor') m.position.set(0, CHASSIS.h / 2 + 0.03, 0);
      else m.position.set((socketId.endsWith('1') ? -1 : 1) * (CHASSIS.w / 2 + 0.04), 0, 0);
      m.material = mats.dark;
      return m;
    }
    case 'wheels': {
      const m = new Mesh(n, scene);
      const zOff = socketId === 'wheels_1' ? 0.45 : socketId === 'wheels_2' ? -0.45 : 0;
      const zs = zOff ? [zOff] : [0.5, -0.5];
      for (const z of zs) for (const x of [-1, 1]) {
        const w = MeshBuilder.CreateCylinder(`${n}_${x}_${z}`, { diameter: WHEEL.r * 2, height: WHEEL.w }, scene);
        w.rotation.z = Math.PI / 2;
        w.position.set(x * WHEEL.x, WHEEL.y, z);
        w.material = mats.rubber;
        w.parent = m;
      }
      return m;
    }
    case 'motor': {
      const m = MeshBuilder.CreateBox(n, { width: 0.5, height: 0.2, depth: 0.5 }, scene);
      m.position.set(0, CHASSIS.h / 2 + 0.1, -0.4);
      m.material = mats.dark;
      return m;
    }
    case 'secondary': {
      const m = MeshBuilder.CreateCylinder(n, { diameter: 0.12, height: 0.7 }, scene);
      m.rotation.x = Math.PI / 2;
      m.position.set(0.45, CHASSIS.h / 2 + 0.1, front - 0.1);
      m.material = mats.steel;
      return m;
    }
  }
}

function weaponMesh(scene: Scene, n: string, kind: WeaponKind, mats: Mats): Mesh {
  const front = CHASSIS.d / 2;
  let m: Mesh;
  switch (kind) {
    case 'disc': m = MeshBuilder.CreateCylinder(n, { diameter: 0.9, height: 0.08 }, scene); m.rotation.z = Math.PI / 2; m.position.set(0, 0.35, front + 0.1); break;
    case 'bar':  m = MeshBuilder.CreateBox(n, { width: 0.08, height: 1.1, depth: 0.18 }, scene); m.position.set(0, 0.35, front + 0.1); break;
    case 'drum': m = MeshBuilder.CreateCylinder(n, { diameter: 0.55, height: 1.2 }, scene); m.rotation.z = Math.PI / 2; m.position.set(0, 0.2, front + 0.2); break;
    case 'h_bar': m = MeshBuilder.CreateBox(n, { width: 2.0, height: 0.08, depth: 0.2 }, scene); m.position.set(0, 0.32, front - 0.1); break;
    case 'h_disc': m = MeshBuilder.CreateCylinder(n, { diameter: 1.6, height: 0.08 }, scene); m.position.set(0, 0.32, front - 0.1); break;
    case 'undercutter': m = MeshBuilder.CreateCylinder(n, { diameter: 1.8, height: 0.05 }, scene); m.position.set(0, -0.12, front - 0.2); break;
    case 'hammer': case 'saw': case 'hammer_saw': {
      m = MeshBuilder.CreateBox(n, { width: 0.1, height: 0.1, depth: 1.6 }, scene);
      m.position.set(0, 0.6, 0.2); m.rotation.x = -0.6;
      const head = kind === 'hammer'
        ? MeshBuilder.CreateBox(`${n}_head`, { width: 0.35, height: 0.3, depth: 0.3 }, scene)
        : MeshBuilder.CreateCylinder(`${n}_head`, { diameter: 0.5, height: 0.06 }, scene);
      if (kind !== 'hammer') head.rotation.z = Math.PI / 2;
      head.position.set(0, 0, 0.8); head.parent = m; head.material = mats.steel;
      m.setPivotPoint(new Vector3(0, 0, -0.8));          // hinge at the rear of the arm
      break;
    }
    case 'pneumatic_flipper': case 'electric_flipper':
      m = MeshBuilder.CreateBox(n, { width: CHASSIS.w * 0.9, height: 0.06, depth: 0.9 }, scene);
      m.position.set(0, CHASSIS.h / 2 + 0.05, front - 0.3); m.rotation.x = 0.12;
      m.setPivotPoint(new Vector3(0, 0, -0.45));         // hinge at the rear edge of the plate
      break;
    case 'lifter': case 'grappler': case 'crusher':
      m = MeshBuilder.CreateBox(n, { width: 0.6, height: 0.08, depth: 1.0 }, scene);
      m.position.set(0, CHASSIS.h / 2 + 0.05, front - 0.2); m.rotation.x = kind === 'lifter' ? 0.15 : -0.25;
      m.setPivotPoint(new Vector3(0, 0, -0.5));
      break;
    case 'shell':
      m = MeshBuilder.CreateCylinder(n, { diameter: 2.0, height: 0.5, tessellation: 12 }, scene); m.position.set(0, 0.1, 0); break;
    case 'cage':
      m = MeshBuilder.CreateTorus(n, { diameter: 2.0, thickness: 0.15, tessellation: 10 }, scene); m.position.set(0, 0.1, 0); break;
  }
  m.material = kind === 'shell' || kind === 'cage' ? mats.paint : mats.steel;
  return m;
}

/** Forward direction in world space (bot faces +Z locally). */
export function forward(bot: Bot): Vector3 {
  return Vector3.TransformNormal(Vector3.Forward(), bot.root.getWorldMatrix()).normalize();
}

/** Bot's up vector in world space. */
export function upVector(bot: Bot): Vector3 {
  return Vector3.TransformNormal(Vector3.Up(), bot.root.getWorldMatrix()).normalize();
}
