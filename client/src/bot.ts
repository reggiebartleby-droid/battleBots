/**
 * Assembles a visual + physical bot from a BotBuild using placeholder primitives.
 * One rigid body per bot (the chassis); parts are child meshes.
 */
import {
  Color3, Mesh, MeshBuilder, PhysicsAggregate, PhysicsBody, PhysicsShapeType, Scene,
  StandardMaterial, Vector3, Quaternion,
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
  lowTractionUntil?: number;          // drive force is scaled by lowTractionScale until this time (combat.ts)
  lowTractionScale?: number;
  /** Set when the bot is knocked out of the arena (main.ts OUT block): the moment, where it was
   *  and how fast it was going. This is the hook for the elimination animation (fx.explode). */
  eliminated?: { t: number; pos: Vector3; vel: Vector3; reason: 'out' };
  /** v0.6: while now < tumbleUntil the per-frame "stay level" damping in main.ts is off,
   *  so a launch / recoil tumble actually happens. */
  tumbleUntil?: number;
  /** v0.6: set while the bot is resting upside down (main.ts). since = when it landed inverted. */
  inverted?: { since: number };
  /** v0.6: self-right in progress: at this time the chassis is snapped back onto its wheels. */
  rightingUntil?: number;
}

const CHASSIS = { w: 1.4, h: 0.35, d: 1.6 };
const COM_DROP = 0.12;   // centre of mass this far below the chassis centre (v0.6)

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
}

export function assembleBotMesh(id: string, build: BotBuild, catalog: Catalog, scene: Scene): BotMesh {
  const v = validateBuild(build, catalog);
  if (!v.ok) throw new Error(`Bot ${id} invalid: ${v.errors.join('; ')}`);
  const paint = build.cosmetics.paint ?? (id === 'A' ? '#e63946' : '#1d7cf2');

  const root = MeshBuilder.CreateBox(`bot${id}`, { width: CHASSIS.w, height: CHASSIS.h, depth: CHASSIS.d }, scene);
  root.material = mat(scene, `paint${id}`, paint);

  const partMeshes: Record<string, Mesh> = {};
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
    if (part.type === 'weapon') {
      weaponMesh = m;
      weaponKind = part.kind as WeaponKind;
      spinAxis = spinAxisFor(weaponKind);
    }
  }

  // Full-body spinners: hide the chassis inside the shell
  if (build.bodyId === 'full_body_spinner') root.visibility = 0.001;

  return { root, weaponMesh, weaponKind, spinAxis, partMeshes, totalWeight: v.totalWeight, weaponRestRotX: weaponMesh?.rotation.x ?? 0 };
}

export function buildBot(id: 'A' | 'B', build: BotBuild, catalog: Catalog, scene: Scene, pos: Vector3, facing: number): Bot {
  const mesh = assembleBotMesh(id, build, catalog, scene);
  const state = createBotState(build, catalog);
  const { root } = mesh;
  root.position.copyFrom(pos);
  root.rotationQuaternion = Quaternion.RotationAxis(Vector3.Up(), facing);

  const agg = new PhysicsAggregate(root, PhysicsShapeType.BOX, {
    mass: Math.max(20, mesh.totalWeight * 0.4), friction: 0.6, restitution: 0.6,   // bouncy bot-bot contacts (feel)
  }, scene);
  agg.body.setCollisionCallbackEnabled(true);
  // v0.6: bottom-heavy, like a real bot (wheels/batteries low). A bot can't rest on its side or
  // stand on end -- it rolls onto its wheels or its back by itself; only "on its back" is a state.
  const mp = agg.body.getMassProperties();
  agg.body.setMassProperties({ ...mp, centerOfMass: new Vector3(0, -COM_DROP, 0) });
  // keep bots upright-ish: heavy angular damping
  agg.body.setAngularDamping(3);
  agg.body.setLinearDamping(0.4);     // lower than v0.3 so knockback carries

  return { id, build, state, body: agg.body, weapon: new Weapon(mesh.weaponKind), ...mesh };
}

function spinAxisFor(kind: WeaponKind): Bot['spinAxis'] {
  if (['disc', 'bar', 'drum'].includes(kind)) return 'x';
  if (['h_bar', 'h_disc', 'undercutter', 'shell', 'cage'].includes(kind)) return 'y';
  return 'none';
}

type Mats = { dark: StandardMaterial; steel: StandardMaterial; rubber: StandardMaterial; paint: StandardMaterial };

function partMesh(scene: Scene, id: string, socketId: string, part: PartDef, mats: Mats): Mesh | undefined {
  const n = `${id}_${socketId}`;
  const front = CHASSIS.d / 2;
  switch (part.type) {
    case 'weapon': return weaponMesh(scene, n, part.kind as WeaponKind, mats);
    case 'front': {
      const m = MeshBuilder.CreateBox(n, { width: CHASSIS.w, height: 0.3, depth: 0.5 }, scene);
      m.position.set(0, -0.02, front + 0.25);
      m.rotation.x = part.kind === 'plow' ? 0.35 : 0.55;
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
        const w = MeshBuilder.CreateCylinder(`${n}_${x}_${z}`, { diameter: 0.5, height: 0.2 }, scene);
        w.rotation.z = Math.PI / 2;
        w.position.set(x * (CHASSIS.w / 2 + 0.12), -0.05, z);
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
