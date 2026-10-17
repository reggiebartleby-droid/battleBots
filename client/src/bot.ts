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
 *
 * v0.8 real vertical spinners: disc / bar / drum is its OWN rigid body (with teeth) on a hinge
 * (6DoF constraint, only the spin axis free) driven by a velocity motor. Spin-up, launches,
 * recoil, gyro effect and energy loss on a hit all come from Havok. See SPINNER.
 *
 * v0.9 real horizontal spinners: bar / disc / undercutter use the same machinery with the hinge
 * about the chassis y axis (Tombstone-style, mounted out front). Recoil is real: the hit's reaction
 * goes through the hinge into the chassis. Spin-up torque also yaws the chassis (real reaction).
 *
 * v0.10 real overhead weapons: the hammer / saw / hammer-saw ARM is its own body on a hinge at the
 * top rear of the chassis, driven by an electric (velocity) motor; the saw disc is a real spinner
 * hinged to the END OF THE ARM. Damage = arm / saw energy lost while touching the opponent.
 *
 * v0.11 reactionless hammer (real-robot solution, user-chosen): the arm motor drives against an internal
 * counter-rotating flywheel instead of the chassis, so a swing doesn't kick the chassis nose-up. The
 * flywheel is then braked into the chassis gently (ARM.flywheelBrake). Impacts are still real: whatever
 * the arm or saw hits pushes back through the hinge as before. Like the gyro, Havok can't do this on its
 * own, so armBefore/armAfter estimate the motor torque each step and route it to the flywheel.
 *
 * v0.11 floor magnets (Overhead only for now; real-robot solution used by Beta, Shatter, Magnetar): magnets
 * under the chassis pull it toward the steel floor, so the hammer's swing doesn't lift the bot. The pull
 * drops off fast with the air gap (a bot lifted by a wedge / flipper loses it), and the extra grip raises
 * the drive force limit (more pushing power). See MAGNET.
 *
 * v0.12 real flippers, control weapons and full-body spinners (the last three bodies):
 *  - Flipper: the plate is its own body on a hinge at the TOP REAR of the chassis (rear-hinged "true flipper",
 *    like Chaos 2 / Bronco); its front lip lies on the wedge. Pneumatic = huge torque, very fast, limited gas
 *    (FLIP gas shots per match, buffer refill between shots); electric = weaker, slower, unlimited. End-of-stroke
 *    cushion like a real ram. Upside down, firing the flipper into the floor self-rights the bot (real srimech).
 *  - Control: lifter = hinged fork lying on the wedge face, lifts the opponent so its wheels lose the floor;
 *    grappler = the same fork + a clamp jaw from above; crusher = fixed lower jaw + slow hydraulic beak that
 *    pierces (Razer-style). Rear weight bias + front axle forward so lifting doesn't tip the lifter (Razer).
 *  - Full-body spinner: the shell / cage is a real spinner on a vertical hinge around the chassis.
 *
 * v0.21 real wheels (user: real-life drive): every tyre is its own body on a powered axle (6DoF, only the axle
 * free, velocity motor), like the weapons. Grip is real tyre friction against whatever the tyre touches --
 * floor, walls, obstacles, other bots -- so a lifted wheel has no grip and a magnet's pull is extra tyre load.
 * Skid steer (tank mixing): the left and right wheels are driven separately. The layout (2WD + skids / 4WD /
 * 6WD) comes from the wheels part; the drive motor part sets the gearing (top speed vs wheel force). See DRIVE.
 * This replaced the v0.7 chassis-centre drive force, the yaw-rate steering, the sideways grip damping, the
 * chassis-height grounded check, the magnet grip multiplier and the v0.12 spin-up "tyre grip" torque.
 */
import {
  Color3, Matrix, Mesh, TransformNode, MeshBuilder, type Material, type Node, PhysicsBody, PhysicsMotionType, PhysicsShape, PhysicsShapeBox, PhysicsShapeContainer,
  PhysicsShapeConvexHull, PhysicsShapeCylinder, PhysicsShapeSphere, PhysicsMaterialCombineMode, Scene, Vector3, VertexData, Quaternion,
  Physics6DoFConstraint, PhysicsConstraintAxis, PhysicsConstraintMotorType, type AbstractMesh, StandardMaterial,
} from '@babylonjs/core';
import type { BotBuild, Catalog, PartDef, WeaponKind } from '../../src/core/types.js';
import { createBotState, currentSpeed, type BotState, type StateOptions } from '../../src/core/state.js';
import { validateBuild } from '../../src/core/validate.js';
import { partWeight } from '../../src/core/weight.js';
import { Weapon } from './weapon.js';
import { botMaterials, type BotMats } from './look.js';
import { SURFACE_BIT } from './arena.js';

const CHASSIS_H = 0.35;   // = CHASSIS.h (ARM below needs it before CHASSIS is declared)

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
  lastHit?: { socket: string; t: number };   // most recent damage taken (HUD flash)
  /** Set when the bot is knocked out of the arena (main.ts OUT block): the moment, where it was
   *  and how fast it was going. This is the hook for the elimination animation (fx.explode). */
  eliminated?: { t: number; pos: Vector3; vel: Vector3; reason: 'out' | 'ko' };   // v0.28 'ko' = Cube Bots KO (blown apart, collider gone)
  /** Set while the bot is resting upside down (main.ts). since = when it landed inverted. */
  inverted?: { since: number };
  /** Self-right in progress: at this time the chassis is snapped back onto its wheels. */
  rightingUntil?: number;
  /** v0.8 real spinner (vertical spinners): the weapon is its own body on a motorised hinge. */
  spinner?: RealSpinner;
  /** v0.10 real overhead arm (hammer / saw / hammer-saw). */
  arm?: RealArm;
  /** v0.10 saw disc spinning on the end of the arm (saw / hammer-saw). */
  saw?: RealSpinner;
  /** v0.11 floor magnets: current total pull toward the floor, N (0 when lifted / tipped). */
  magnetPull?: number;
  /** v0.12 hinged real weapons: flipper plate, lifter / grappler fork, grappler jaw, crusher beak. */
  hinges?: RealHinge[];
  /** v0.21 real wheels: one body per tyre on a powered axle. */
  wheels?: RealWheel[];
  /** v0.28 chassis collider pieces per part (front, side armour, skids, fixed jaw) -- so a part that falls off can lose its collider. */
  partShapes: Record<string, PhysicsShape[]>;
  /** v0.29 Cube Bots: a part just fell off and flies as its own body for a moment (combat.ts hooks its hits). */
  onPartOff?: (body: PhysicsBody, socketId: string) => void;
}

/** v0.21 one tyre on its powered axle. */
export interface RealWheel {
  hub: Mesh;                     // physics node at the axle centre (the tyre mesh is its child)
  body: PhysicsBody;
  joint: Physics6DoFConstraint;
  pivot: Vector3;                // axle centre in chassis space
  side: -1 | 1;                  // -1 = left (chassis -x), 1 = right
  torque: number;                // N m stall torque at this wheel (from the drive motor's gearing)
  mass: number;
  tyre: Mesh;
  cmd: number;                   // speed controller output -1..1 (set by driveWheels)
  omegaMax: number;              // rad/s no-load wheel speed (top speed / radius); 0 = drive dead
  drag: boolean;                 // drive dead: gearbox drag only
  tread: PhysicsShape;           // round tread (driving surfaces only)
  sideShape: PhysicsShape;       // the tyre cylinder (everything else)
  onTread: boolean;              // upright: the tread rolls on the floor; tipped: the cylinder does
  own: { chassis: number; weapon: number };   // this bot's filter bits
  gone?: boolean;                // v0.28 Cube Bots: the wheel fell off -- collides with nothing
  released?: boolean;            // v0.29: ... and its axle joint is gone too (body parked, mass moved onto the chassis)
}

/** v0.21 wheel tilt (axle's world-up component) past which the tyre cylinder, not the tread, meets the floor. */
const TREAD_TILT = 0.5;

/** Collision filters for one wheel: tread vs driving surfaces only; cylinder vs everything except its own bot
 *  (and except driving surfaces while the tread has them). */
function setTread(w: RealWheel, on: boolean) {
  w.onTread = on;
  if (w.gone) { for (const s of [w.tread, w.sideShape]) { s.filterMembershipMask = 0; s.filterCollideMask = 0; } return; }   // v0.28 fell off
  w.tread.filterMembershipMask = TREAD_BIT;
  w.tread.filterCollideMask = on ? SURFACE_BIT : 0;
  w.sideShape.filterMembershipMask = w.own.chassis;
  w.sideShape.filterCollideMask = ~(w.own.chassis | w.own.weapon | (on ? SURFACE_BIT : 0));
}

/** v0.21 drive (real-life). Gearing: every drive motor has the same power; a motor geared for more top speed
 *  gives less force at the wheels (stall force = power / top speed), shared over the driven wheels.
 *  Neutral stick = the speed controllers brake (velocity motor holding 0), so friction does the stopping. */
export const DRIVE = {
  /** v0.25 realistic re-gear (user: A). Real heavyweights run ~15-25 mph with ~10-15 kW of brushless drive, and are
   *  geared for ~2x the weight on each wheel in thrust (Ask Aaron). Was 0.6 / 6000 (tank 7 mph, standard 11, fast 16).
   *  Now tank 4.5 m/s (10 mph), standard 7.2 (16 mph), fast 10.8 (24 mph). */
  speedScale: 0.9,               // motor speed stat -> top speed, m/s
  power: 12000,                  // W, total drive power (same for every motor part; gearing decides the split)
  gearDrag: 0.1,                 // drive dead (motor or wheels destroyed): gearbox drag, fraction of stall torque
  tyre: { friction: 1.0, restitution: 0.05 },   // vs the 0.8 floor (geometric mean) = 0.9, rubber on steel
  skid: { friction: 0.1, restitution: 0.05, gap: 0.01, width: 0.3, depth: 0.12, z: 0.68 },   // 2WD: UHMW skids front + back, 1 cm off the floor
  sixMid: 0.5,                   // 6WD: centre axle halfway between the front and rear axles
  /** v0.22 arcade mixing (user): steering mix rate at full throttle (like a transmitter's mix rate). 1 = plain tank
   *  mix: full forward + full turn stops the inner wheels, and skid-steer scrub then barely lets the bot turn.
   *  1.5 = the inner wheels run slightly backward: it turns while keeping most of its speed. Standing still the
   *  turn is always 1 (spin on the spot). Headless (Blue Lift, 2 s of W+A): 1 -> 50 deg at 3.8 m/s; 1.5 -> 145 deg
   *  at 4.5 m/s; 0.5 -> 0 deg (couldn't break the tyre scrub). */
  arc: 1.5,
  /** v0.22 temporary test boost (lab slider): multiplies the drive power of both bots. */
  boost: 1,
  /** v0.25 heading-hold gyro (real RC gyro in the drive mix). With no steering input, the drive pushes back
   *  against any yaw (heading lock: it holds the heading you let go of the stick at). Shell spinners only: spinning the shell up
   *  twisted the base ~400 deg (reaction torque) because neutral only brakes lightly. */
  gyroGain: 1.5,                 // turn command per rad/s of yaw
  gyroSettleS: 0.3,              // s after the stick centres before the heading locks (no spring-back after a turn)
  gyroHeading: 3,                // heading lock: turn command per rad off the heading held when the stick was let go
  gyroBodies: ['full_body_spinner'] as string[],
  /** v0.22 drop centre (real 6WD trick): the centre axle sits this much lower, so the bot rocks onto 4 wheels
   *  and scrubs less when it turns. Bodies listed in dropCentreBodies only. */
  dropCentre: 0.01,
  dropCentreBodies: ['overhead'] as string[],   // headless: Hammer on 6WD + drop turns while driving, but can tip on a swing mid-turn
};
/** Constraint-angle sign that drives a wheel FORWARD (checked headless). */
const WHEEL_SIGN = 1;

export type HingeRole = 'flipper' | 'fork' | 'jaw' | 'beak';
export type HingeState = 'ready' | 'fire' | 'lower' | 'hold';

/** A weapon part on a motorised hinge about the chassis x axis. "Raise" angle = how far the part's
 *  forward axis has tipped UP from its build pose (radians, chassis space). */
export interface RealHinge {
  role: HingeRole;
  hub: Mesh;
  body: PhysicsBody;
  joint: Physics6DoFConstraint;
  pivot: Vector3;                // chassis space
  mass: number;
  minRaise: number;              // hinge limits in raise units (rest = 0)
  maxRaise: number;
  torque: number;                // N m full motor torque
  state: HingeState;
  t: number;
  touched: boolean;              // touched anything external this physics step
}

/** Constraint-angle sign that RAISES a hinged part (checked headless). */
const HINGE_SIGN = -1;

/** v0.12 flippers. Real refs: rear-hinged flippers (Chaos 2, Bronco) are the most powerful kind, run on limited
 *  gas (HPA / nitrogen), use the flipper to self-right (Apollo self-rights at lower power), and cushion the ram
 *  at the end of its stroke. Electric flippers have no gas limit but much less power. */
export const FLIP = {
  hinge: new Vector3(0, CHASSIS_H / 2 + 0.025, -0.62),   // top rear of the chassis (plate centre line)
  thick: 0.04,
  width: 1.26,
  lipLen: 0.88,                  // front lip lies on the 30 deg wedge face, down to near the floor
  lipDeg: 30,
  massShare: 0.25,               // plate + lip move; ram, valves and tanks stay in the chassis
  pneumatic_flipper: { torque: 7000, omega: 11, stroke: 1.15, refillS: 1.0, gas: 20 },
  electric_flipper:  { torque: 3200, omega: 6,  stroke: 1.0,  refillS: 0.5, gas: Infinity },
  cushionRad: 0.3,               // last part of the stroke: the ram is cushioned (speed eases to ~0)
  lowerOmega: 3,
  lowerTorque: 0.08,
  idleTorque: 0.05,              // holds the plate down on its rest stop
  bearing: 0.01,                 // actuator destroyed: plate is limp
  selfRightPower: 0.3,           // self-righting shot uses this much power and half the gas (Apollo)
  selfRightGas: 0.5,
  fireMaxS: 0.35,
};

/** v0.12 control weapons. Real refs: lifters geared for ~2x the opponent's weight at the fork (Ask Aaron),
 *  wide forks hold better than narrow; Razer: fixed lower scoop + hydraulic piercing beak, rear weight bias. */
export const CONTROL = {
  fork:  { len: 0.88, deg: 30, width: 1.0, thick: 0.04, liftRad: 1.1 },
  jaw:   { hinge: new Vector3(0, CHASSIS_H / 2 + 0.1, 0.25), len: 1.25, openRad: 0.9, closeRad: 0.15, width: 0.25 },   // closed: tooth meets the fork
  beak:  { hinge: new Vector3(0, CHASSIS_H / 2 + 0.14, -0.15), len: 1.5, spike: 0.3, openRad: 0.8, closeRad: 0.05, width: 0.16 },   // closed: spike ~13 cm above the lower jaw
  lifter:   { fork: { share: 0.5, torque: 3200, omega: 4.5 } },   // v0.13: 2x torque, faster lift (was 1600 / 2.6)
  grappler: { fork: { share: 0.3, torque: 1300, omega: 2.2 }, jaw: { share: 0.3, torque: 900, omega: 4 }, forkDelayS: 0.25 },
  crusher:  { beak: { share: 0.5, torque: 4500, omega: 1.6 }, pierceW: 1800, hitMs: 1000 },   // pierce power while the beak presses on them; reported once a second (armor takes its cut per report)
  lowerTorque: 0.4,
  idleTorque: 0.1,
  bearing: 0.02,
  rearBias: -0.15,               // centre of mass shifted back (z, m) so a loaded fork doesn't tip the bot forward
};

/** v0.11 floor magnets (user: Overhead only for now; yes to extra pushing power). Magnetar ran 4 x 50 kg
 *  pull magnets (~2 kN). Pull falls off with the square of the air gap ratio (simple magnet model).
 *  v0.21: the extra pushing power is real now -- the pull is extra load on the tyres, so more friction. */
export const MAGNET = {
  bodies: ['overhead'] as string[],
  pull: 2000,                    // N total with the wheels on the floor (5 mm air gap)
  gap0: 0.005,                   // m air gap at rest
  points: [0.5, -0.3],           // chassis z of the two magnet blocks (front / rear of centre), half the pull each
  minUp: 0.5,                    // bot tipped past ~60 deg (or upside down): magnets face away from the floor
  arenaHalf: 8,                  // only over the steel floor
};

export type ArmState = 'ready' | 'swing' | 'pin' | 'retract';

export interface RealArm {
  hub: Mesh;                     // physics node at the hinge (weaponMesh is its child)
  body: PhysicsBody;
  joint: Physics6DoFConstraint;
  pivot: Vector3;                // hinge position in chassis space
  inertia: number;               // kg m^2 about the hinge
  mass: number;
  torque: number;                // N m swing torque
  omegaSwing: number;            // rad/s swing speed target
  state: ArmState;
  t: number;                     // seconds in the current state
  maxAngle: number;              // highest angle reached this swing (rad from straight up)
  // v0.11 reactionless drive
  flywheelL: number;             // angular momentum stored in the internal flywheel (swing-axis units, N m s)
  omegaPrev: number;             // arm ABSOLUTE angular speed about the hinge axis before the physics step
  touched: boolean;              // arm or saw touched anything during the step (impacts are real, not compensated)
  comDist: number;               // hinge -> centre of mass of arm + head + saw, m
  swingMass: number;             // arm + head + saw, kg
}

/** v0.10 overhead arm (user: all defaults). Angles are measured from straight UP toward the FRONT. */
export const ARM = {
  // User choice after the headless test (2026-10-15): full weapon mass on a 1.6 m arm tipped the bot over
  // backward just driving (~14 kJ swings); half the mass on a 1.6 m arm flipped itself in fights.
  len: 1.2,                      // hinge -> head centre, m
  massShare: 0.5,                // share of the weapon part's mass in the moving arm + head + saw (rest is in the chassis)
  // hinge on top, mid-chassis: with the 1.2 m arm the head comes down ~0.35 m ahead of the nose
  // (at z -0.45 it landed inside the bot's own nose and could only reach an opponent on top of it)
  pivot: new Vector3(0, CHASSIS_H / 2 + 0.1, 0.0),
  restDeg: -10,                  // at rest: up and slightly back
  limitDeg: 125,                 // hinge stop (the floor normally stops the head first, ~105-115 deg)
  swingS: 0.25,                  // electric motor sized to cover the swing in this long
  swingRad: 2.0,                 // ~115 deg: rest -> about where the head meets the floor (~111 deg)
  retractS: 0.6,                 // back to rest in this long
  armFrac: 0.3,                  // share of the weapon mass in the arm itself (rest is the head)
  sawFrac: { saw: 0.7, hammer_saw: 0.3 } as Record<string, number>,   // share in the spinning saw disc
  retractTorque: 0.5,            // fraction of swing torque used to pull the arm back
  idleTorque: 0.15,              // holds the arm against its rest stop
  pinTorque: 0.5,                // SPACE held after a swing: press down on whatever is under the head
  bearing: 0.02,                 // weapon motor destroyed: arm is limp
  stallRad: 1.0,                 // swing ends when the arm slows below this (rad/s) after stallAfterS ...
  stallAfterS: 0.12,
  maxSwingS: 0.6,                // ... or after this long
  sign: 1,                       // constraint-angle sign that swings the arm FORWARD (checked headless)
  omegaSign: 1,                  // sign of world angular velocity about chassis +x for a FORWARD swing (checked headless)
  reactionless: true,            // v0.11: motor drives against an internal flywheel, not the chassis
  flywheelBrake: 120,            // N m: max torque bleeding the flywheel into the chassis (headless: 400 tipped the bot
                                 // over once the magnets lost grip; 120 kept it within ~10 deg)
  retractEase: 4,                // return speed (rad/s) per rad left to rest: eases the arm onto its rest stop
}

export interface RealSpinner {
  parentNode: TransformNode;     // what the hinge is attached to: the chassis root, or the arm hub (saw)
  parentBody: PhysicsBody;
  axis: Vector3;                 // spin axis in chassis space (x = vertical spinner, y = horizontal)
  dir: number;                   // spin sign about that axis (see SPINNER.dir)
  hub: Mesh;                     // physics node of the weapon (weaponMesh + teeth are its children)
  body: PhysicsBody;
  joint: Physics6DoFConstraint;
  pivot: Vector3;                // hinge position in chassis space
  inertia: number;               // kg m^2 about the spin axis (from Havok)
  omegaMax: number;              // rad/s top speed
  torque: number;                // N m motor torque (inertia * omegaMax / spinUpS)
  mass: number;
}

/** Real spinners. v0.8 vertical: spin-up 3 s to top speed for all three; disc stores the most
 *  energy, bar bites deepest, drum is low/compact; gyro effect kept.
 *  v0.9 horizontal (user: defaults, clockwise from above, 3 s spin-up): bar 1.6 m / disc 1.0 m
 *  mounted out front at mid-chassis height; undercutter blade ~8 cm off the floor. */
export const SPINNER = {
  spinUpS: 3,                    // seconds from 0 to top speed (motor torque is sized per weapon to hit this)
  omega: { disc: 50, bar: 45, drum: 70, h_bar: 45, h_disc: 50, undercutter: 55, saw: 150, hammer_saw: 150, shell: 30, cage: 34 } as Record<string, number>,   // rad/s top speed (saw = disc on an overhead arm)
  /** v0.12: big shells / cages take longer to spin up (real shells are slow to start; also keeps the start-up
   *  reaction torque within what the tyres can hold). */
  spinUpByKind: { shell: 4, cage: 4 } as Record<string, number>,
  /** Spin sign about the chassis axis. x: -1 = front edge moves UP (launches).
   *  y: +1 = clockwise seen from above: the front edge sweeps left -> right, throwing opponents to
   *  the bot's right (checked headless). */
  dir: { x: -1, y: 1 } as Record<'x' | 'y', number>,
  brake: 0.35,                   // motor switched off: braking torque as a fraction of drive torque (coasts ~8 s)
  bearing: 0.03,                 // weapon motor destroyed: only bearing drag (coasts a long time)
  toothFriction: 1.5,            // hardened teeth dig in: high friction, MAX-combined (the tooth's grip wins).
                                 // Headless test: 0.3 -> Hammer Time / Shell Shock barely lift; 1.5 -> they get thrown.
  gyro: 1,                       // 1 = full gyroscopic reaction (Havok doesn't model it; applied in applyGyro)
};

export const CHASSIS = { w: 1.4, h: 0.35, d: 1.6 };
/** v0.22 shell spinner (user, option 1): a still inner drive base on 2 wheels under the spinning shell. The base
 *  has to fit inside the shell (the old 1.4 x 1.6 m chassis poked its corners out through the 12-sided shell). */
export const FBS_BASE = { w: 1.2, d: 1.2, skidZ: 0.45 };
export function chassisFor(bodyId: string) { return bodyId === 'full_body_spinner' ? { w: FBS_BASE.w, h: CHASSIS.h, d: FBS_BASE.d } : CHASSIS; }
/** Wheel layout on this body: shell spinners always run 2WD on their inner base (real shell spinners). */
export function layoutFor(bodyId: string, part: PartDef): string { return bodyId === 'full_body_spinner' ? '2wd' : (part.layout ?? '4wd'); }
export const WHEEL = { r: 0.25, w: 0.2, y: -0.05, x: CHASSIS.w / 2 + 0.12 };
/** v0.22 wider stance (real vertical spinners need a wide base: turning while spun up rolls them over through
 *  the gyro effect). Extra track per side, m: the wheels sit out on short axle outriggers. */
export const STANCE: Record<string, number> = { vertical_spinner: 0.2 };
/** Chassis centre height when the wheels sit on the floor (floor top is y = 0). */
export const REST_Y = WHEEL.r - WHEEL.y;          // 0.30

/** v0.15 built-in rear wheelie bar (spring steel), Overhead only: stops the bot rocking back / nosing up on a swing.
 *  Runs from the bottom rear edge of the chassis back `len` m, tip `gap` m off the floor (doesn't touch at rest).
 *  Low bounce (spring steel flexes instead of bouncing). No weight cost for now, like the magnets. */
export const WHEELIE = { bodies: ['overhead'] as string[], len: 0.6, gap: 0.03, width: 0.3, thick: 0.04, friction: 0.2, restitution: 0.1 };
function wheelieGeom() {
  const z0 = -CHASSIS.d / 2, y0 = -CHASSIS.h / 2, tipZ = z0 - WHEELIE.len, tipY = -REST_Y + WHEELIE.gap + WHEELIE.thick / 2;   // underside of the tip is `gap` off the floor
  return {
    centre: new Vector3(0, (y0 + tipY) / 2, (z0 + tipZ) / 2),
    len: Math.hypot(WHEELIE.len, y0 - tipY),
    rotX: -Math.atan2(y0 - tipY, WHEELIE.len),   // tilts the bar so its tip is lower than where it meets the chassis
  };
}

/** Physics tuning for the body (v0.7). */
export const BODY = {
  massScale: 0.4,          // bot weight stat -> kg
  minMass: 20,
  comDrop: 0.12,           // centre of mass this far below the chassis centre (bottom-heavy)
  angularDamping: 0.5,     // low: tumbles are real now
  linearDamping: 0.1,
  // per-part materials (friction combines by geometric mean with whatever it touches)
  chassis: { friction: 0.5, restitution: 0.35 },
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


/** v0.22 weapon slot through a vertical spinner's nose (visual only: a weapon never collides with its own chassis).
 *  half = slot half-width, back = how far back (chassis z) the slot runs. */
const VS_SLOT: Partial<Record<WeaponKind, { half: number; back: number }>> = {
  disc: { half: 0.09, back: 0.32 },   // disc + teeth reach 0.54 m from the axle (z 0.9)
  bar:  { half: 0.08, back: 0.31 },   // 1.1 m bar: 0.55 m from the axle
  drum: { half: 0.66, back: 0.6 },    // 1.2 m drum: the slot is most of the nose
};

function slotChassis(scene: Scene, root: Mesh, mats: Mats, parts: Record<string, Mesh>, slot: { half: number; back: number }) {
  const { w, h, d } = CHASSIS, D = d / 2;
  root.isVisible = false;                                         // the collider keeps the full box
  const piece = (nm: string, x: number, z: number, bw: number, bd: number) => {
    const m = MeshBuilder.CreateBox(`${root.name}_${nm}${DECO}`, { width: bw, height: h, depth: bd }, scene);
    m.material = mats.paint; m.parent = root; m.position.set(x, 0, z);
  };
  piece('rear', 0, (slot.back - D) / 2, w, slot.back + D);
  const sw = w / 2 - slot.half;
  if (sw > 0.01) for (const sx of [-1, 1]) piece(`cheek${sx}`, sx * (slot.half + sw / 2), (slot.back + D) / 2, sw, D - slot.back);
  // front ramp: two wedgelets either side of the weapon (the hidden full ramp still gives the collider)
  const f = parts['front'];
  if (f) {
    f.isVisible = false;
    if (sw > 0.01) for (const sx of [-1, 1]) {
      const c = f.clone(`${f.name}_side${sx}${DECO}`, f, true) as Mesh;
      c.isVisible = true; c.scaling.x = sw / w; c.position.set(sx * (slot.half + sw / 2), 0, 0);
    }
  }
  // top armor stops short of the slot
  const a = parts['armor'];
  if (a) {
    const full = CHASSIS.d * 0.9, front = Math.min(full / 2, slot.back - 0.02), back = -full / 2;
    a.scaling.z = (front - back) / full; a.position.z = (front + back) / 2;
  }
}

/** Visual-only assembly (no physics). Used by the lab preview and by buildBot(). */
export interface BotMesh {
  root: Mesh;
  weaponMesh?: Mesh;
  weaponKind?: WeaponKind;
  spinAxis: Bot['spinAxis'];
  partMeshes: Record<string, Mesh>;
  totalWeight: number;
  partKinds: Record<string, PartDef>;   // socketId -> part (for the collider pass)
}

export function assembleBotMesh(id: string, build: BotBuild, catalog: Catalog, scene: Scene): BotMesh {
  const v = validateBuild(build, catalog);
  if (!v.ok) throw new Error(`Bot ${id} invalid: ${v.errors.join('; ')}`);
  const paint = build.cosmetics.paint ?? (id === 'A' ? '#e63946' : '#1d7cf2');

  const ch = chassisFor(build.bodyId);
  const root = MeshBuilder.CreateBox(`bot${id}`, { width: ch.w, height: ch.h, depth: ch.d }, scene);
  const mats = botMaterials(scene, id, paint);   // v0.16 battle-worn PBR set (look.ts)
  root.material = mats.paint;

  const partMeshes: Record<string, Mesh> = {};
  const partKinds: Record<string, PartDef> = {};
  let weaponMesh: Mesh | undefined;
  let weaponKind: WeaponKind | undefined;
  let spinAxis: Bot['spinAxis'] = 'none';

  for (const [socketId, part] of Object.entries(v.resolved)) {
    const m = partMesh(scene, id, socketId, part, mats, build.bodyId);
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
  // v0.22 vertical spinners: the weapon runs in a slot through the nose (real bots), not through the chassis
  const vsSlot = weaponKind ? VS_SLOT[weaponKind] : undefined;
  if (vsSlot) slotChassis(scene, root, mats, partMeshes, vsSlot);
  // v0.22 flippers: the plate IS the top surface -- the top armor sits flush under it, not through it
  if (build.bodyId === 'flipper' && partMeshes['armor']) partMeshes['armor'].position.y = CHASSIS.h / 2 - 0.03;

  // v0.15 wheelie bar (visual; the collider is added in buildBot)
  if (WHEELIE.bodies.includes(build.bodyId)) {
    const g = wheelieGeom();
    const wb = MeshBuilder.CreateBox(`bot${id}_wheelie`, { width: WHEELIE.width, height: WHEELIE.thick, depth: g.len }, scene);
    wb.material = mats.steel; wb.parent = root; wb.position.copyFrom(g.centre); wb.rotation.x = g.rotX;
  }

  addDetails(scene, root, build.bodyId, partMeshes, partKinds, mats);   // v0.16 visual-only detail
  if (build.bodyId === 'full_body_spinner') addShellAids(scene, root, id);   // v0.25 where the nose is

  return { root, weaponMesh, weaponKind, spinAxis, partMeshes, partKinds, totalWeight: v.totalWeight };
}

/** v0.25 shell spinners hide their nose under the spinning shell. Two aids, each switched in the lab (remembered):
 *  cap   (D) = a still cap on a post bolted to the inner base, through the shell's bearing, with an arrow on it
 *  arrow (E) = a glowing arrow on the floor ahead of the nose (game aid, not a real part)
 *  Visual only ("_deco": no colliders, no mass). */
export const SHELL_AIDS = { cap: true, arrow: false };
const AIDS_KEY = 'bb.shellAids.v1';
try { Object.assign(SHELL_AIDS, JSON.parse(localStorage.getItem(AIDS_KEY) ?? '{}')); } catch { /* defaults */ }
export function saveShellAids() { try { localStorage.setItem(AIDS_KEY, JSON.stringify(SHELL_AIDS)); } catch { /* no storage */ } }

function addShellAids(scene: Scene, root: Mesh, id: string) {
  const glow = new StandardMaterial(`bot${id}_aid_deco_mat`, scene);
  glow.diffuseColor = Color3.FromHexString('#ffd23f');
  glow.emissiveColor = Color3.FromHexString('#ffb000');
  glow.specularColor = Color3.Black();
  /** Flat arrow pointing +z (chassis forward): a shaft + a triangular head, centred on `at`. */
  const arrow = (name: string, at: Vector3, len: number, w: number, head: number, thick: number) => {
    const shaft = MeshBuilder.CreateBox(`${name}_s`, { width: w, height: thick, depth: len - head * 0.75 }, scene);
    shaft.position.set(0, 0, -head * 0.375);
    const tip = MeshBuilder.CreateCylinder(`${name}_h`, { diameter: head * 2, height: thick, tessellation: 3 }, scene);
    tip.rotation.y = -Math.PI / 2;                      // one corner of the triangle points forward
    tip.position.set(0, 0, len / 2 - head);
    const m = Mesh.MergeMeshes([shaft, tip], true)!;
    m.name = name; m.parent = root; m.position.copyFrom(at); m.material = glow; m.isPickable = false;
    return m;
  };
  const top = FBS.shell.y + FBS.shell.h / 2;
  if (SHELL_AIDS.cap) {
    const cap = MeshBuilder.CreateCylinder(`bot${id}_cap${DECO}`, { diameter: 0.5, height: 0.05, tessellation: 24 }, scene);
    cap.parent = root; cap.position.set(0, top + 0.06, 0); cap.isPickable = false;
    const capMat = new StandardMaterial(`bot${id}_capmat${DECO}`, scene);
    capMat.diffuseColor = Color3.FromHexString('#1a1d21'); capMat.specularColor = new Color3(0.2, 0.2, 0.2);
    cap.material = capMat;
    const post = MeshBuilder.CreateCylinder(`bot${id}_post${DECO}`, { diameter: 0.12, height: 0.08 }, scene);
    post.parent = root; post.position.set(0, top + 0.01, 0); post.material = capMat; post.isPickable = false;
    arrow(`bot${id}_caparrow${DECO}`, new Vector3(0, top + 0.095, 0), 0.42, 0.1, 0.13, 0.02);
  }
  if (SHELL_AIDS.arrow) {
    const len = 0.9;
    arrow(`bot${id}_floorarrow${DECO}`, new Vector3(0, -REST_Y + 0.035, FBS.shell.r + 0.1 + len / 2), len, 0.26, 0.34, 0.005);
  }
}

export function buildBot(id: 'A' | 'B', build: BotBuild, catalog: Catalog, scene: Scene, pos: Vector3, facing: number, opts: StateOptions = {}): Bot {
  const mesh = assembleBotMesh(id, build, catalog, scene);
  const state = createBotState(build, catalog, opts);
  const { root } = mesh;
  root.position.copyFrom(pos);
  root.rotationQuaternion = Quaternion.RotationAxis(Vector3.Up(), facing);
  root.computeWorldMatrix(true);

  // ---- Compound collision shape ----
  const shape = new PhysicsShapeContainer(scene);
  const partShapes: Record<string, PhysicsShape[]> = {};
  let curSocket: string | null = null;   // v0.28: which part the next collider piece belongs to
  const own = (s: PhysicsShape) => { if (curSocket) (partShapes[curSocket] ??= []).push(s); };
  const add = (s: PhysicsShape, m: PhysicsMaterialLike, child?: Mesh) => {
    own(s);
    s.material = { ...m, frictionCombine: PhysicsMaterialCombineMode.GEOMETRIC_MEAN, restitutionCombine: PhysicsMaterialCombineMode.GEOMETRIC_MEAN };
    if (child) { child.computeWorldMatrix(true); shape.addChildFromParent(root, s, child); }
    else shape.addChild(s);
    track(shape, s);
  };

  // chassis
  const ch = chassisFor(build.bodyId);
  add(new PhysicsShapeBox(Vector3.Zero(), Quaternion.Identity(), new Vector3(ch.w, ch.h, ch.d), scene), BODY.chassis);

  // v0.21: the tyres are their own bodies (buildWheels below); only the 2WD skids are part of the chassis
  for (const [socketId, m] of Object.entries(mesh.partMeshes)) {
    const part = mesh.partKinds[socketId];
    curSocket = socketId;
    switch (part.type) {
      case 'wheels':
        for (const sk of m.getChildMeshes(true)) if (sk.name.includes('_skid_')) {
          const g = skidGeom(sk.position.z);
          const s = new PhysicsShapeBox(g.centre, Quaternion.Identity(), new Vector3(DRIVE.skid.width, g.h, DRIVE.skid.depth), scene);
          s.density = 0.001;   // massless like the wheelie bar (new collider shapes skew the mass otherwise)
          add(s, DRIVE.skid);
        }
        break;
      case 'front':
        add(new PhysicsShapeConvexHull(m, scene), BODY.front, m);
        break;
      case 'weapon': {
        const kind = part.kind as WeaponKind;
        // Real spinners (vertical + horizontal): the weapon is its own body (buildSpinner below)
        if (REAL_SPIN.has(kind) || REAL_ARM.has(kind)) {
          break;
        } else if (REAL_HINGE.has(kind)) {               // v0.12: moving parts are own bodies; fixed parts (crusher's lower jaw) are chassis
          for (const c of m.getChildMeshes(true) as Mesh[]) if (c.name.endsWith('_fixed')) {
            c.computeWorldMatrix(true);
            const ext = c.getBoundingInfo().boundingBox.extendSize.scale(2);
            const s = new PhysicsShapeBox(Vector3.Zero(), Quaternion.Identity(), ext, scene);
            s.material = { ...BODY.front, frictionCombine: PhysicsMaterialCombineMode.GEOMETRIC_MEAN, restitutionCombine: PhysicsMaterialCombineMode.GEOMETRIC_MEAN };
            shape.addChildFromParent(root, s, c); track(shape, s); own(s);
          }
          break;
        } else if (mesh.spinAxis === 'y') {           // full-body shell / cage: still a fixed sweep collider
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

  curSocket = null;
  // v0.15 wheelie bar collider (Overhead): part of the chassis shape
  if (WHEELIE.bodies.includes(build.bodyId)) {
    const g = wheelieGeom();
    const bar = new PhysicsShapeBox(g.centre, Quaternion.RotationAxis(new Vector3(1, 0, 0), g.rotX), new Vector3(WHEELIE.width, WHEELIE.thick, g.len), scene);
    bar.material = { friction: WHEELIE.friction, restitution: WHEELIE.restitution, frictionCombine: PhysicsMaterialCombineMode.GEOMETRIC_MEAN, restitutionCombine: PhysicsMaterialCombineMode.GEOMETRIC_MEAN };
    bar.density = 0.001;   // massless (no weight cost): at default density it skewed the chassis mass and tipped Overhead bots 2 deg nose-up at rest (headless)
    shape.addChild(bar); track(shape, bar);
  }
  const body = new PhysicsBody(root, PhysicsMotionType.DYNAMIC, false, scene);
  setFilter(shape, FILTER[id].chassis, ~FILTER[id].weapon);  // never touches its own real weapons
  body.shape = shape;
  body.setCollisionCallbackEnabled(true);

  // Mass from the weight stat. Havok keeps the inertia it computed from the compound shape
  // (stored per unit mass, so it stays consistent when the mass is overridden -- verified in
  // a headless test); centre of mass dropped so the bot is bottom-heavy like a real one.
  // A real spinner's weight lives in its own body, so the chassis gets the rest.
  const weaponPart = mesh.partKinds['weapon'];
  const realSpinner = !!mesh.weaponKind && REAL_SPIN.has(mesh.weaponKind) && !!mesh.weaponMesh && !!weaponPart;
  const realArm = !!mesh.weaponKind && REAL_ARM.has(mesh.weaponKind) && !!mesh.weaponMesh && !!weaponPart;
  const realHinge = !!mesh.weaponKind && REAL_HINGE.has(mesh.weaponKind) && !!mesh.weaponMesh && !!weaponPart;
  const fullWeapon = weaponPart ? partWeight(weaponPart, catalog.balance) * BODY.massScale : 0;
  const hingeShares = realHinge ? hingeShareFor(mesh.weaponKind!) : {};
  const hingeMass = Object.values(hingeShares).reduce((a, s) => a + s * fullWeapon, 0);
  const weaponMass = realSpinner || realArm ? fullWeapon * (realArm ? ARM.massShare : 1) : 0;
  const wheelsPart = Object.values(mesh.partKinds).find(p => p.type === 'wheels');
  const wheelsMass = wheelsPart ? partWeight(wheelsPart, catalog.balance) * BODY.massScale : 0;   // v0.21: lives in the tyres
  const mp = body.getMassProperties();
  const mass = Math.max(BODY.minMass, mesh.totalWeight * BODY.massScale - weaponMass - hingeMass - wheelsMass);
  const com = (mp.centerOfMass ?? Vector3.Zero()).add(new Vector3(0, -BODY.comDrop, build.bodyId === 'control' ? CONTROL.rearBias : 0));
  body.setMassProperties({ mass, centerOfMass: com });
  body.setAngularDamping(BODY.angularDamping);
  body.setLinearDamping(BODY.linearDamping);

  const weapon = new Weapon(mesh.weaponKind);
  const bot: Bot = { id, build, state, body, weapon, partShapes, ...mesh };
  const ownWeapons = (b: PhysicsBody) => setFilter(b.shape!, FILTER[id].weapon, ~(FILTER[id].chassis | FILTER[id].weapon));
  if (realSpinner) {
    bot.spinner = buildSpinner(scene, root, body, mesh.weaponMesh!, mesh.weaponKind!, weaponMass);
    weapon.realSpin = true;
  }
  if (realArm) {
    const kind = mesh.weaponKind!;
    const sawMass = weaponMass * (ARM.sawFrac[kind] ?? 0);
    bot.arm = buildArm(scene, root, body, mesh.weaponMesh!, kind, weaponMass - sawMass, sawMass);
    weapon.realArm = true;
    const disc = mesh.weaponMesh!.getChildMeshes(true).find(c => c.name.endsWith('_saw')) as Mesh | undefined;
    if (disc && sawMass > 0) {
      bot.saw = buildSpinner(scene, bot.arm.hub, bot.arm.body, disc, 'saw', sawMass);
      const arm = bot.arm;
      bot.saw.body.getCollisionObservable().add(() => { arm.touched = true; });   // saw contacts push the arm too
    }
  }
  if (realHinge) {
    bot.hinges = buildHinges(scene, root, body, mesh.weaponMesh!, mesh.weaponKind!, fullWeapon);
    weapon.realHinge = true;
    if (mesh.weaponKind === 'pneumatic_flipper' || mesh.weaponKind === 'electric_flipper') weapon.gas = FLIP[mesh.weaponKind].gas;
  }
  for (const w of [bot.spinner, bot.arm, bot.saw, ...(bot.hinges ?? [])]) if (w) ownWeapons(w.body);
  // v0.21 real wheels: same filter group as the chassis (a hit on a tyre is a hit on the bot), but never touch own chassis / weapons
  const tyres: Mesh[] = [];
  for (const [sid, m] of Object.entries(mesh.partMeshes)) if (mesh.partKinds[sid].type === 'wheels') tyres.push(...(m.getChildMeshes(true) as Mesh[]).filter(t => !t.name.includes('_skid_') && !isDeco(t)));
  if (tyres.length) {
    const vTop = Math.max(0.1, currentSpeed(state) * DRIVE.speedScale);
    const torque = (DRIVE.power * DRIVE.boost / vTop) * WHEEL.r / tyres.length;   // v0.22: x lab test boost   // gearing: stall force = power / top speed
    bot.wheels = buildWheels(scene, root, body, tyres, Math.max(1, wheelsMass / tyres.length), torque, FILTER[id]);
    for (const w of bot.wheels) setTread(w, true);
  }
  return bot;
}

/** v0.21 turn each tyre mesh into its own body on a powered axle (6DoF: only rotation about chassis x free). */
function buildWheels(scene: Scene, root: Mesh, chassis: PhysicsBody, tyres: Mesh[], mass: number, torque: number, own: { chassis: number; weapon: number }): RealWheel[] {
  const out: RealWheel[] = [];
  root.computeWorldMatrix(true);
  const inv = Matrix.Invert(root.getWorldMatrix());
  tyres.forEach((tyre, i) => {
    tyre.computeWorldMatrix(true);
    const world = tyre.getAbsolutePosition().clone();
    const pivot = Vector3.TransformCoordinates(world, inv);
    const hub = new Mesh(`${root.name}_wheel${i}`, scene);
    hub.position = world;
    hub.rotationQuaternion = root.absoluteRotationQuaternion.clone();
    tyre.parent = hub;
    tyre.position.setAll(0);                                     // keeps its rotation (cylinder axis on chassis x)
    hub.computeWorldMatrix(true);
    // Tread: a sphere of the tyre's radius that only touches driving surfaces (round contact = smooth rolling; Havok's
    // flat-sided cylinder hopped and slipped on the floor in the headless test). Sides: the real tyre cylinder for
    // everything else (walls, bots, weapons). Tipped past TREAD_TILT the cylinder takes over on the floor too.
    const mat = { ...DRIVE.tyre, frictionCombine: PhysicsMaterialCombineMode.GEOMETRIC_MEAN, restitutionCombine: PhysicsMaterialCombineMode.GEOMETRIC_MEAN };
    const tread = new PhysicsShapeSphere(Vector3.Zero(), WHEEL.r, scene);
    const sideShape = new PhysicsShapeCylinder(new Vector3(-WHEEL.w / 2, 0, 0), new Vector3(WHEEL.w / 2, 0, 0), WHEEL.r, scene);
    tread.material = mat; sideShape.material = mat;
    const shape = new PhysicsShapeContainer(scene);
    shape.addChild(tread); shape.addChild(sideShape);
    const body = new PhysicsBody(hub, PhysicsMotionType.DYNAMIC, false, scene);
    body.shape = shape;
    body.setCollisionCallbackEnabled(true);                      // landings on the wheels (combat slam damage)
    body.setMassProperties({ mass });
    body.setAngularDamping(0);
    body.setLinearDamping(BODY.linearDamping);
    const X = new Vector3(1, 0, 0), Y = new Vector3(0, 1, 0);
    const lock = (axis: PhysicsConstraintAxis) => ({ axis, minLimit: 0, maxLimit: 0 });
    const joint = new Physics6DoFConstraint(
      { pivotA: pivot, pivotB: Vector3.Zero(), axisA: X, axisB: X, perpAxisA: Y, perpAxisB: Y, collision: false },
      [lock(PhysicsConstraintAxis.LINEAR_X), lock(PhysicsConstraintAxis.LINEAR_Y), lock(PhysicsConstraintAxis.LINEAR_Z),
       lock(PhysicsConstraintAxis.ANGULAR_Y), lock(PhysicsConstraintAxis.ANGULAR_Z)],
      scene);
    chassis.addConstraint(body, joint);                          // axle free: the drive motor's torque is applied in wheelsBefore
    out.push({ hub, body, joint, pivot, side: pivot.x < 0 ? -1 : 1, torque, mass, tyre, cmd: 0, omegaMax: 0, drag: false, tread, sideShape, onTread: true, own });
  });
  return out;
}

/** v0.21 skid-steer drive: left = throttle + turn, right = throttle - turn (v0.22: arcade mix, see DRIVE.arc). Sets each wheel's speed controller output; wheelsBefore turns it into motor torque.
 *  `on` false = neutral (the controllers brake). Drive dead (motor / wheels destroyed) = only gearbox drag. */
export function driveWheels(bot: Bot, throttle: number, turn: number, on: boolean) {
  const vTop = currentSpeed(bot.state) * DRIVE.speedScale;
  // v0.25 heading hold: not steering -> the gyro steers against yaw, updated every physics sub-step (wheelsBefore)
  const holding = on && vTop > 0 && Math.abs(turn) < 0.05 && DRIVE.gyroBodies.includes(bot.build.bodyId);
  // heading lock: remember the heading when the stick is let go, then hold it
  const was = gyroHold.get(bot);
  gyroHold.set(bot, holding ? { throttle, heading: was?.heading ?? headingOf(bot), age: was?.age ?? 0 } : null);
  mixWheels(bot, throttle, turn, on, vTop);
}
/** v0.25: throttle held while the heading-hold gyro is steering (null = gyro off this frame). */
const gyroHold = new WeakMap<Bot, { throttle: number; heading: number; age: number } | null>();
function headingOf(bot: Bot): number {
  const f = Vector3.Forward().applyRotationQuaternion(bot.root.rotationQuaternion ?? Quaternion.Identity());
  return Math.atan2(f.x, f.z);                          // + = turned clockwise from above (right)
}
function mixWheels(bot: Bot, throttle: number, turn: number, on: boolean, vTop: number) {
  // v0.22 arcade mix: the turn shrinks toward DRIVE.arc as throttle rises (full turn when standing still)
  const a = Math.min(1, Math.abs(throttle));
  const tm = turn * (1 - a + a * DRIVE.arc);
  let l = throttle + tm, r = throttle - tm;
  const k = Math.max(1, Math.abs(l), Math.abs(r)); l /= k; r /= k;
  for (const w of bot.wheels ?? []) {
    w.cmd = on && vTop > 0 ? (w.side < 0 ? l : r) : 0;
    w.drag = vTop <= 0;
    if (vTop > 0) w.omegaMax = vTop / WHEEL.r;
  }
}

/** v0.21 per physics step: brushed DC drive motor through its gearbox. Torque = stall x (output - speed / no-load
 *  speed): full torque from a standstill, none at top speed, and at neutral it brakes (shorted windings / ESC
 *  brake) in proportion to the speed. The motor's reaction goes into the chassis. Tyre friction decides how much
 *  of it reaches the floor (or wall, or opponent). */
export function wheelsBefore(bot: Bot, dt: number) {
  if (!bot.wheels?.length) return;
  // quaternions, not world matrices: those are only refreshed once per frame and this runs every sub-step
  const X = new Vector3(1, 0, 0);
  const axis = X.applyRotationQuaternion(bot.root.rotationQuaternion ?? Quaternion.Identity());
  const wc = Vector3.Dot(bot.body.getAngularVelocity(), axis);
  const hold = gyroHold.get(bot);
  if (hold != null) {                                   // v0.25 heading hold: yaw rate about the bot's own up axis
    const up = new Vector3(0, 1, 0).applyRotationQuaternion(bot.root.rotationQuaternion ?? Quaternion.Identity());
    // + yaw = clockwise from above = a right turn, so steer the other way
    // first moments after the stick centres: rate damping only (stops the turn where it is), then lock that heading
    hold.age += dt;
    if (hold.age < DRIVE.gyroSettleS) hold.heading = headingOf(bot);
    let err = headingOf(bot) - hold.heading;
    err = Math.atan2(Math.sin(err), Math.cos(err));
    const steer = -(Vector3.Dot(bot.body.getAngularVelocity(), up) * DRIVE.gyroGain + err * DRIVE.gyroHeading);
    if (up.y > 0.5) mixWheels(bot, hold.throttle, Math.max(-1, Math.min(1, steer)), true, bot.wheels[0].omegaMax * WHEEL.r);
  }
  for (const w of bot.wheels) {
    if (w.released) continue;                           // v0.29 fell off: nothing to drive
    const tipped = Math.abs(X.applyRotationQuaternion(w.hub.rotationQuaternion ?? Quaternion.Identity()).y) > TREAD_TILT;
    if (tipped === w.onTread) setTread(w, !tipped);
    if (w.omegaMax <= 0) continue;
    const rel = (Vector3.Dot(w.body.getAngularVelocity(), axis) - wc) * WHEEL_SIGN;   // wheel speed on its axle, + = forward
    const t = w.drag
      ? -Math.max(-1, Math.min(1, rel / w.omegaMax)) * w.torque * DRIVE.gearDrag
      : Math.max(-1, Math.min(1, w.cmd - rel / w.omegaMax)) * w.torque;
    const imp = axis.scale(t * WHEEL_SIGN * dt);
    w.body.applyAngularImpulse(imp);
    bot.body.applyAngularImpulse(imp.negate());
  }
}

/** v0.21: give the wheels the chassis' motion (v + w x r) after a script sets the chassis velocity directly
 *  (self-right hop). Without it the wheels' own inertia soaks up half the scripted roll. */
export function carryWheels(bot: Bot) {
  const v = bot.body.getLinearVelocity(), w = bot.body.getAngularVelocity();
  for (const wh of bot.wheels ?? []) {
    if (wh.released) continue;
    wh.body.setLinearVelocity(v.add(Vector3.Cross(w, wh.hub.position.subtract(bot.root.position))));
    wh.body.setAngularVelocity(w.clone());
  }
}

/** The bot's chassis plus its wheels: anything touching these touched the bot itself (not its weapon). */
export function chassisBodies(bot: Bot): PhysicsBody[] { return [bot.body, ...(bot.wheels ?? []).map(w => w.body)]; }
export function isChassis(bot: Bot, body: PhysicsBody | undefined): boolean { return !!body && (body === bot.body || !!bot.wheels?.some(w => w.body === body)); }

/** v0.12 hinged weapon kinds (flippers + control). */
const REAL_HINGE = new Set<WeaponKind>(['pneumatic_flipper', 'electric_flipper', 'lifter', 'grappler', 'crusher']);

/** Share of the weapon part's mass in each moving hinged piece (named child nodes of the weapon mesh). */
function hingeShareFor(kind: WeaponKind): Partial<Record<HingeRole, number>> {
  switch (kind) {
    case 'pneumatic_flipper': case 'electric_flipper': return { flipper: FLIP.massShare };
    case 'lifter': return { fork: CONTROL.lifter.fork.share };
    case 'grappler': return { fork: CONTROL.grappler.fork.share, jaw: CONTROL.grappler.jaw.share };
    case 'crusher': return { beak: CONTROL.crusher.beak.share };
    default: return {};
  }
}

function hingeTorque(kind: WeaponKind, role: HingeRole): number {
  if (role === 'flipper') return FLIP[kind as 'pneumatic_flipper'].torque;
  if (kind === 'lifter') return CONTROL.lifter.fork.torque;
  if (kind === 'grappler') return role === 'jaw' ? CONTROL.grappler.jaw.torque : CONTROL.grappler.fork.torque;
  return CONTROL.crusher.beak.torque;
}

/** Turn each moving piece of a flipper / control weapon (child node named `<n>_<role>` at its hinge) into
 *  its own body on a hinge about the chassis x axis. Raise limits come from the role. */
function buildHinges(scene: Scene, root: Mesh, chassis: PhysicsBody, wm: Mesh, kind: WeaponKind, weaponMass: number): RealHinge[] {
  const out: RealHinge[] = [];
  const shares = hingeShareFor(kind);
  for (const node of wm.getChildMeshes(true) as Mesh[]) {
    const role = (['flipper', 'fork', 'jaw', 'beak'] as HingeRole[]).find(r => node.name.endsWith('_' + r));
    if (!role) continue;
    root.computeWorldMatrix(true); node.computeWorldMatrix(true);
    const pivot = Vector3.TransformCoordinates(node.getAbsolutePosition(), Matrix.Invert(root.getWorldMatrix()));
    const hub = new Mesh(`${root.name}_${role}Hub`, scene);
    hub.position = node.getAbsolutePosition().clone();
    hub.rotationQuaternion = root.absoluteRotationQuaternion.clone();
    node.parent = hub;
    node.position.setAll(0);                                   // keeps its rotation (rest pose)
    hub.computeWorldMatrix(true);

    const shape = new PhysicsShapeContainer(scene);
    const mat = { ...BODY.weapon, frictionCombine: PhysicsMaterialCombineMode.GEOMETRIC_MEAN, restitutionCombine: PhysicsMaterialCombineMode.GEOMETRIC_MEAN };
    // fork / flipper lip faces are slick like a wedge so things slide onto them; jaw / beak tips bite
    const slick = { ...BODY.front, frictionCombine: PhysicsMaterialCombineMode.GEOMETRIC_MEAN, restitutionCombine: PhysicsMaterialCombineMode.GEOMETRIC_MEAN };
    const bite = { friction: SPINNER.toothFriction, restitution: 0.2, frictionCombine: PhysicsMaterialCombineMode.MAXIMUM, restitutionCombine: PhysicsMaterialCombineMode.GEOMETRIC_MEAN };
    for (const c of node.getChildMeshes(false) as Mesh[]) {
      if (isDeco(c)) continue;                                 // v0.16 visual detail: no collider
      c.computeWorldMatrix(true);
      const ext = c.getBoundingInfo().boundingBox.extendSize.scale(2);
      const s = new PhysicsShapeBox(Vector3.Zero(), Quaternion.Identity(), ext, scene);
      s.material = c.name.endsWith('_tooth') ? bite : role === 'flipper' || role === 'fork' ? slick : mat;
      shape.addChildFromParent(hub, s, c);
      track(shape, s);
    }
    const body = new PhysicsBody(hub, PhysicsMotionType.DYNAMIC, false, scene);
    body.shape = shape;
    body.setCollisionCallbackEnabled(true);
    const mass = Math.max(2, (shares[role] ?? 0.3) * weaponMass);
    body.setMassProperties({ mass });
    body.setAngularDamping(0);
    body.setLinearDamping(BODY.linearDamping);

    // raise limits (rest = 0): flipper / fork go UP; jaw / beak close DOWN from their open rest pose
    let minRaise = 0, maxRaise = 0;
    if (role === 'flipper') maxRaise = FLIP[kind as 'pneumatic_flipper'].stroke + 0.05;
    else if (role === 'fork') maxRaise = CONTROL.fork.liftRad;
    else if (role === 'jaw') minRaise = -(CONTROL.jaw.openRad + CONTROL.jaw.closeRad);
    else minRaise = -(CONTROL.beak.openRad + CONTROL.beak.closeRad);
    const X = new Vector3(1, 0, 0), Y = new Vector3(0, 1, 0);
    const lock = (axis: PhysicsConstraintAxis) => ({ axis, minLimit: 0, maxLimit: 0 });
    const lo = HINGE_SIGN > 0 ? minRaise : -maxRaise, hi = HINGE_SIGN > 0 ? maxRaise : -minRaise;
    const joint = new Physics6DoFConstraint(
      { pivotA: pivot, pivotB: Vector3.Zero(), axisA: X, axisB: X, perpAxisA: Y, perpAxisB: Y, collision: false },
      [lock(PhysicsConstraintAxis.LINEAR_X), lock(PhysicsConstraintAxis.LINEAR_Y), lock(PhysicsConstraintAxis.LINEAR_Z),
       lock(PhysicsConstraintAxis.ANGULAR_Y), lock(PhysicsConstraintAxis.ANGULAR_Z),
       { axis: PhysicsConstraintAxis.ANGULAR_X, minLimit: lo, maxLimit: hi }],
      scene);
    chassis.addConstraint(body, joint);
    joint.setAxisMotorType(PhysicsConstraintAxis.ANGULAR_X, PhysicsConstraintMotorType.VELOCITY);
    const torque = hingeTorque(kind, role);
    const h: RealHinge = { role, hub, body, joint, pivot, mass, minRaise, maxRaise, torque, state: 'ready', t: 0, touched: false };
    setHinge(h, role === 'jaw' || role === 'beak' ? 1 : -1, torque * CONTROL.idleTorque);
    body.getCollisionObservable().add(() => { h.touched = true; });   // own chassis is filtered out
    out.push(h);
  }
  return out;
}

/** Point a hinge motor: raise speed (rad/s, + = up) with this much torque. */
function setHinge(h: RealHinge, raiseOmega: number, torque: number) {
  h.joint.setAxisMotorTarget(PhysicsConstraintAxis.ANGULAR_X, HINGE_SIGN * raiseOmega);
  h.joint.setAxisMotorMaxForce(PhysicsConstraintAxis.ANGULAR_X, torque);
}

/** How far the hinged part is raised from its rest pose, rad (chassis space). */
export function hingeRaise(bot: Bot, h: RealHinge): number {
  const inv = Matrix.Invert(bot.root.getWorldMatrix());
  const dWorld = Vector3.TransformNormal(new Vector3(0, 0, 1), h.hub.getWorldMatrix());
  const d = Vector3.TransformNormal(dWorld, inv);
  return Math.atan2(d.y, d.z);
}

/** Per frame (v0.12 flippers): tap = fire. Pneumatic uses gas and needs its buffer refilled; electric doesn't.
 *  selfRight = the bot is upside down: the shot goes into the floor at reduced power (srimech). */
export function driveFlipper(bot: Bot, pressed: boolean, usable: boolean, motorAlive: boolean, selfRight: boolean, dt: number) {
  const h = bot.hinges?.find(x => x.role === 'flipper');
  if (!h) return;
  const cfg = FLIP[bot.weaponKind as 'pneumatic_flipper'];
  const w = bot.weapon;
  const raise = hingeRaise(bot, h);
  h.t += dt; w.refill = Math.max(0, w.refill - dt);
  if (!motorAlive) { h.state = 'ready'; setHinge(h, 0, h.torque * FLIP.bearing); return; }
  const go = (s: HingeState) => { h.state = s; h.t = 0; };
  switch (h.state) {
    case 'ready':
      if (pressed && usable && w.refill <= 0 && w.gas >= (selfRight ? FLIP.selfRightGas : 1)) {
        w.gas -= selfRight ? FLIP.selfRightGas : 1;
        w.refill = cfg.refillS;
        w.firePower = selfRight ? FLIP.selfRightPower : 1;
        go('fire');
      }
      break;
    case 'fire': if (raise >= cfg.stroke - 0.04 || h.t > FLIP.fireMaxS) go('lower'); break;
    case 'lower': if (raise <= 0.04 || h.t > 2) go('ready'); break;
  }
  switch (h.state) {
    case 'ready': setHinge(h, -1, h.torque * FLIP.idleTorque); break;
    case 'fire': {
      // end-of-stroke cushion: the ram slows the plate over the last cushionRad of travel
      const left = Math.max(0, cfg.stroke - raise);
      const omega = Math.max(0.5, cfg.omega * Math.min(1, left / FLIP.cushionRad));
      setHinge(h, omega, h.torque * w.firePower);
      break;
    }
    case 'lower': setHinge(h, -FLIP.lowerOmega * Math.min(1, raise / 0.3 + 0.2), h.torque * FLIP.lowerTorque); break;
  }
  w.armState = h.state === 'fire' ? 'swing' : h.state === 'lower' ? 'retract' : 'ready';
}

/** Per frame (v0.12 control weapons): hold = lift (lifter), clamp + lift (grappler), crush (crusher). */
export function driveControl(bot: Bot, held: boolean, usable: boolean, motorAlive: boolean, dt: number) {
  const hs = bot.hinges;
  if (!hs) return;
  const kind = bot.weaponKind;
  const on = held && usable && motorAlive;
  bot.weapon.holdT = on ? bot.weapon.holdT + dt : 0;
  for (const h of hs) {
    h.t += dt;
    if (!motorAlive) { setHinge(h, 0, h.torque * CONTROL.bearing); continue; }
    const raise = hingeRaise(bot, h);
    if (h.role === 'fork') {
      const omega = kind === 'grappler' ? CONTROL.grappler.fork.omega : CONTROL.lifter.fork.omega;
      const lift = on && (kind !== 'grappler' || bot.weapon.holdT > CONTROL.grappler.forkDelayS);
      if (lift) { h.state = 'hold'; setHinge(h, omega, h.torque); }
      else if (raise > 0.05) { h.state = 'lower'; setHinge(h, -omega, h.torque * CONTROL.lowerTorque); }
      else { h.state = 'ready'; setHinge(h, -1, h.torque * CONTROL.idleTorque); }
    } else {
      // jaw / beak: rest = open (raise 0); closing = negative raise
      const omega = h.role === 'jaw' ? CONTROL.grappler.jaw.omega : CONTROL.crusher.beak.omega;
      if (on) { h.state = 'hold'; setHinge(h, -omega, h.torque); }
      else if (raise < -0.05) { h.state = 'lower'; setHinge(h, omega * 1.5, h.torque * CONTROL.lowerTorque); }
      else { h.state = 'ready'; setHinge(h, 1, h.torque * CONTROL.idleTorque); }
    }
  }
}

/** onBeforePhysics: clear the hinges' contact flags. */
export function hingesBefore(bot: Bot) { for (const h of bot.hinges ?? []) h.touched = false; }

/** Collision filter bits: a bot's real weapon bodies never collide with its own chassis or with each
 *  other (the saw on the arm used to hit its own chassis), but hit everything else. */
const FILTER = { A: { chassis: 1 << 1, weapon: 1 << 2 }, B: { chassis: 1 << 3, weapon: 1 << 4 } } as const;
/** v0.21 wheel treads (round, see buildWheels): they only ever touch driving surfaces (arena SURFACE_BIT). */
const TREAD_BIT = 1 << 8;
/** Havok applies filters per child shape (a container's own filter isn't inherited), so remember children. */
const kids = new WeakMap<PhysicsShape, PhysicsShape[]>();
function track(container: PhysicsShape, child: PhysicsShape) { const k = kids.get(container) ?? []; k.push(child); kids.set(container, k); }
function setFilter(shape: PhysicsShape, member: number, collide: number) {
  for (const s of [shape, ...(kids.get(shape) ?? [])]) { s.filterMembershipMask = member; s.filterCollideMask = collide; }
}

/** v0.29 Cube Bots: a part that fell off flies as its own body for a moment. It always hits the arena and other
 *  loose parts; bots listed in `exclude` it passes through (cubes.ts switches each bot on once the part is clear of
 *  it -- spawning inside a bot made Havok fling that bot 3.6 m up, headless). */
export const LOOSE_BIT = 1 << 9;
export function loosePartFilter(exclude: ('A' | 'B')[]): { member: number; collide: number } {
  let ex = TREAD_BIT;
  for (const id of exclude) ex |= FILTER[id].chassis | FILTER[id].weapon;
  return { member: LOOSE_BIT, collide: ~ex };
}

/** Overhead weapon kinds whose arm is a real body. */
const REAL_ARM = new Set<WeaponKind>(['hammer', 'saw', 'hammer_saw']);

/** Turn the overhead arm (weaponMesh = empty node at the hinge, arm + head as children) into its own
 *  rigid body on a hinge about the chassis x axis. Constraint angle 0 = the rest pose. */
function buildArm(scene: Scene, root: Mesh, chassis: PhysicsBody, wm: Mesh, kind: WeaponKind, mass: number, sawMass: number): RealArm {
  const pivot = wm.position.clone();
  const hub = new Mesh(`${root.name}_armHub`, scene);
  hub.position = Vector3.TransformCoordinates(pivot, root.getWorldMatrix());
  hub.rotationQuaternion = (root.rotationQuaternion ?? Quaternion.Identity()).clone();
  wm.parent = hub;
  wm.position.setAll(0);                                      // keeps rotation.x = rest angle
  hub.computeWorldMatrix(true);

  // Colliders from the visual pieces (arm bar + head; the saw disc is its own body)
  const shape = new PhysicsShapeContainer(scene);
  const mat = { ...BODY.weapon, frictionCombine: PhysicsMaterialCombineMode.GEOMETRIC_MEAN, restitutionCombine: PhysicsMaterialCombineMode.GEOMETRIC_MEAN };
  for (const c of wm.getChildMeshes(true) as Mesh[]) {
    if (c.name.endsWith('_saw') || isDeco(c)) continue;
    c.computeWorldMatrix(true);
    const ext = c.getBoundingInfo().boundingBox.extendSize.scale(2);
    const s = new PhysicsShapeBox(Vector3.Zero(), Quaternion.Identity(), ext, scene);
    s.material = mat;
    shape.addChildFromParent(hub, s, c);
    track(shape, s);
  }
  const body = new PhysicsBody(hub, PhysicsMotionType.DYNAMIC, false, scene);
  body.shape = shape;
  body.setCollisionCallbackEnabled(true);
  // mass: arm bar (uniform rod from the hinge) + head at the end of the arm
  // arm bar = armFrac of the WHOLE weapon; the rest of this body is the hammer head (none on a plain saw)
  const armM = (mass + sawMass) * ARM.armFrac, headM = mass - armM;
  const restRad = (ARM.restDeg * Math.PI) / 180;
  const dir = new Vector3(0, Math.cos(restRad), Math.sin(restRad));
  const com = dir.scale((armM * ARM.len / 2 + headM * ARM.len) / mass);
  body.setMassProperties({ mass, centerOfMass: com });
  body.setAngularDamping(0);
  body.setLinearDamping(BODY.linearDamping);
  // about the hinge; the saw disc rides on the end of the arm, so its mass counts too
  const inertia = armM * ARM.len * ARM.len / 3 + (headM + sawMass) * ARM.len * ARM.len;

  const X = new Vector3(1, 0, 0), Y = new Vector3(0, 1, 0);
  const lock = (axis: PhysicsConstraintAxis) => ({ axis, minLimit: 0, maxLimit: 0 });
  const lim = (ARM.limitDeg - ARM.restDeg) * Math.PI / 180;
  const joint = new Physics6DoFConstraint(
    { pivotA: pivot, pivotB: Vector3.Zero(), axisA: X, axisB: X, perpAxisA: Y, perpAxisB: Y, collision: false },
    [lock(PhysicsConstraintAxis.LINEAR_X), lock(PhysicsConstraintAxis.LINEAR_Y), lock(PhysicsConstraintAxis.LINEAR_Z),
     lock(PhysicsConstraintAxis.ANGULAR_Y), lock(PhysicsConstraintAxis.ANGULAR_Z),
     { axis: PhysicsConstraintAxis.ANGULAR_X, minLimit: ARM.sign > 0 ? 0 : -lim, maxLimit: ARM.sign > 0 ? lim : 0 }],
    scene);
  chassis.addConstraint(body, joint);
  joint.setAxisMotorType(PhysicsConstraintAxis.ANGULAR_X, PhysicsConstraintMotorType.VELOCITY);
  const omegaSwing = 2 * ARM.swingRad / ARM.swingS;                        // constant-torque swing from rest
  const torque = inertia * omegaSwing / ARM.swingS;
  joint.setAxisMotorTarget(PhysicsConstraintAxis.ANGULAR_X, -ARM.sign);
  joint.setAxisMotorMaxForce(PhysicsConstraintAxis.ANGULAR_X, torque * ARM.idleTorque);
  const comDist = (armM * ARM.len / 2 + (headM + sawMass) * ARM.len) / (mass + sawMass);
  const arm: RealArm = { hub, body, joint, pivot, inertia, mass, torque, omegaSwing, state: 'ready', t: 0, maxAngle: restRad,
    flywheelL: 0, omegaPrev: 0, touched: false, comDist, swingMass: mass + sawMass };
  body.getCollisionObservable().add(() => { arm.touched = true; });   // own chassis is filtered out: any contact is external
  return arm;
}

/** onBeforePhysics: remember the arm speed so armAfter can measure what the motor did. */
export function armBefore(bot: Bot) {
  const a = bot.arm;
  if (!a) return;
  a.omegaPrev = armOmegaAbs(bot);
  a.touched = false;
}

/** Arm angular speed about the hinge axis in the WORLD frame (not relative to the chassis). Using the
 *  relative speed made the correction feed back on itself once the chassis moved (headless test). */
function armOmegaAbs(bot: Bot): number {
  const axis = Vector3.TransformNormal(Vector3.Right(), bot.root.getWorldMatrix()).normalize();
  return Vector3.Dot(bot.arm!.body.getAngularVelocity(), axis) * ARM.omegaSign;
}

/**
 * onAfterPhysics (v0.11 reactionless hammer): during a free swing / retract, the motor torque the arm felt
 * (I x dw/dt minus gravity) is handed back to the chassis -- it went into the internal flywheel instead --
 * and the flywheel's stored momentum is bled into the chassis at no more than ARM.flywheelBrake.
 */
export function armAfter(bot: Bot, dt: number) {
  const a = bot.arm;
  if (!a || !ARM.reactionless || dt <= 0) return;
  const axisW = Vector3.TransformNormal(Vector3.Right(), bot.root.getWorldMatrix()).normalize().scale(ARM.omegaSign);
  if ((a.state === 'swing' || a.state === 'retract') && !a.touched) {
    // gravity torque on arm + head + saw about the hinge (in swing direction)
    const restRad = (ARM.restDeg * Math.PI) / 180;
    const dirW = Vector3.TransformNormal(new Vector3(0, Math.cos(restRad), Math.sin(restRad)), a.hub.getWorldMatrix()).normalize();
    const tauG = Vector3.Dot(Vector3.Cross(dirW.scale(a.comDist), new Vector3(0, -9.81 * a.swingMass, 0)), axisW);
    const motor = Math.max(-a.torque * 1.05, Math.min(a.torque * 1.05, a.inertia * (armOmegaAbs(bot) - a.omegaPrev) / dt - tauG));
    bot.body.applyAngularImpulse(axisW.scale(motor * dt));   // undo the chassis reaction ...
    a.flywheelL -= motor * dt;                               // ... the flywheel took it
  }
  const dL = Math.max(-ARM.flywheelBrake * dt, Math.min(ARM.flywheelBrake * dt, a.flywheelL));
  if (dL !== 0) { a.flywheelL -= dL; bot.body.applyAngularImpulse(axisW.scale(dL)); }
}

/** Arm angle in chassis space, radians from straight up toward the front. */
export function armAngle(bot: Bot): number {
  const a = bot.arm;
  if (!a) return 0;
  const restRad = (ARM.restDeg * Math.PI) / 180;
  const dHub = new Vector3(0, Math.cos(restRad), Math.sin(restRad));
  const dWorld = Vector3.TransformNormal(dHub, a.hub.getWorldMatrix());
  const inv = Matrix.Invert(bot.root.getWorldMatrix());
  const d = Vector3.TransformNormal(dWorld, inv);
  return Math.atan2(d.z, d.y);
}

/** Arm swing speed relative to the chassis, rad/s (positive = swinging forward/down). */
export function armOmega(bot: Bot): number {
  const a = bot.arm;
  if (!a) return 0;
  const axis = Vector3.TransformNormal(Vector3.Right(), bot.root.getWorldMatrix()).normalize();
  return Vector3.Dot(a.body.getAngularVelocity().subtract(bot.body.getAngularVelocity()), axis) * ARM.omegaSign;
}

/** Kinetic energy of the swinging arm relative to the chassis, J. */
export function armEnergy(bot: Bot): number {
  const a = bot.arm;
  if (!a) return 0;
  const w = armOmega(bot);
  return 0.5 * a.inertia * w * w;
}

/** Per frame: run the arm. Tap fire = swing (returns on its own); fire still held when the swing
 *  ends = pin (press down). Motor dead = limp. */
export function driveArm(bot: Bot, fire: boolean, pressed: boolean, usable: boolean, motorAlive: boolean, dt: number) {
  const a = bot.arm;
  if (!a) return;
  const A = PhysicsConstraintAxis.ANGULAR_X;
  const ang = armAngle(bot), w = armOmega(bot);
  a.t += dt;
  const go = (s: ArmState) => { a.state = s; a.t = 0; if (s === 'swing') a.maxAngle = ang; };
  if (!motorAlive || !usable) {
    if (a.state !== 'ready') go('ready');
    a.joint.setAxisMotorTarget(A, 0);
    a.joint.setAxisMotorMaxForce(A, motorAlive ? a.torque * ARM.idleTorque : a.torque * ARM.bearing);
    return;
  }
  const restRad = (ARM.restDeg * Math.PI) / 180;
  switch (a.state) {
    case 'ready': if (pressed) go('swing'); break;
    case 'swing': {
      a.maxAngle = Math.max(a.maxAngle, ang);
      const reachedEnd = ang - restRad >= ARM.swingRad - 0.05;
      const stalled = a.t > ARM.stallAfterS && w < ARM.stallRad;
      if (reachedEnd || stalled || a.t > ARM.maxSwingS) go(fire ? 'pin' : 'retract');
      break;
    }
    case 'pin': if (!fire) go('retract'); break;
    case 'retract': if (ang <= restRad + 0.06 || a.t > 2) go('ready'); break;
  }
  const S = ARM.sign;
  switch (a.state) {
    case 'ready':   a.joint.setAxisMotorTarget(A, -S * 1);  a.joint.setAxisMotorMaxForce(A, a.torque * ARM.idleTorque); break;
    case 'swing':   a.joint.setAxisMotorTarget(A, S * a.omegaSwing); a.joint.setAxisMotorMaxForce(A, a.torque); break;
    case 'pin':     a.joint.setAxisMotorTarget(A, S * 2);   a.joint.setAxisMotorMaxForce(A, a.torque * ARM.pinTorque); break;
    case 'retract': {
      // v0.11: ease into the rest stop (slamming into it at full return speed kicked the nose up)
      const speed = Math.min(1.5 * ARM.swingRad / ARM.retractS, ARM.retractEase * Math.max(0, ang - restRad) + 0.3);
      a.joint.setAxisMotorTarget(A, -S * speed); a.joint.setAxisMotorMaxForce(A, a.torque * ARM.retractTorque); break;
    }
  }
}

/** Weapon kinds that are real bodies on a motorised hinge. */
const REAL_SPIN = new Set<WeaponKind>(['disc', 'bar', 'drum', 'h_bar', 'h_disc', 'undercutter', 'shell', 'cage']);

/** Turn a spinner's weapon mesh into its own rigid body on a motorised hinge, attached to `root`
 *  (the chassis, or the overhead arm hub for a saw). The spin axis is root-space x or y. */
function buildSpinner(scene: Scene, root: Mesh, chassis: PhysicsBody, wm: Mesh, kind: WeaponKind, mass: number): RealSpinner {
  const vertical = spinAxisFor(kind) === 'x';
  root.computeWorldMatrix(true); wm.computeWorldMatrix(true);
  const pivotWorld = wm.getAbsolutePosition().clone();
  const pivot = Vector3.TransformCoordinates(pivotWorld, Matrix.Invert(root.getWorldMatrix()));   // root-space hinge point
  const hub = new Mesh(`${root.name}_${kind === 'saw' ? 'saw' : 'weapon'}Hub`, scene);
  hub.position = pivotWorld;
  hub.rotationQuaternion = root.absoluteRotationQuaternion.clone();
  const keepRot = wm.rotation.clone();
  wm.parent = hub;
  wm.position.setAll(0);
  wm.rotationQuaternion = null;
  wm.rotation.copyFrom(kind === 'saw' ? new Vector3(0, 0, Math.PI / 2) : keepRot);

  // Collider in hub space (spin axis = x for vertical, y for horizontal). Teeth make it bite; a smooth disc would only rub.
  const shape = new PhysicsShapeContainer(scene);
  const mat = { ...BODY.weapon, frictionCombine: PhysicsMaterialCombineMode.GEOMETRIC_MEAN, restitutionCombine: PhysicsMaterialCombineMode.GEOMETRIC_MEAN };
  const toothMat = { friction: SPINNER.toothFriction, restitution: BODY.weapon.restitution,
    frictionCombine: PhysicsMaterialCombineMode.MAXIMUM, restitutionCombine: PhysicsMaterialCombineMode.GEOMETRIC_MEAN };
  const put = (s: PhysicsShape, m: typeof mat = mat) => { s.material = m; shape.addChild(s); track(shape, s); };
  const box = (c: Vector3, size: Vector3) => put(new PhysicsShapeBox(c, Quaternion.Identity(), size, scene), toothMat);
  const teeth = (r: number, size: Vector3) => {
    for (const z of [r, -r]) {
      box(new Vector3(0, 0, z), size);
      // visual tooth (weaponMesh is rotated 90 deg about z: its local y is the spin axis)
      const t = MeshBuilder.CreateBox(`${wm.name}_tooth`, { width: size.y, height: size.x, depth: size.z }, scene);
      t.material = wm.material; t.parent = wm; t.position.set(0, 0, z);
    }
  };
  if (kind === 'disc') {
    put(new PhysicsShapeCylinder(new Vector3(-0.04, 0, 0), new Vector3(0.04, 0, 0), 0.45, scene));
    teeth(0.47, new Vector3(0.1, 0.1, 0.14));
  } else if (kind === 'drum') {
    put(new PhysicsShapeCylinder(new Vector3(-0.6, 0, 0), new Vector3(0.6, 0, 0), 0.275, scene));
    teeth(0.3, new Vector3(1.1, 0.08, 0.1));
  } else if (kind === 'saw') {                                // saw disc on an overhead arm
    put(new PhysicsShapeCylinder(new Vector3(-0.03, 0, 0), new Vector3(0.03, 0, 0), ARM_SAW_R, scene));
    teeth(ARM_SAW_R + 0.01, new Vector3(0.07, 0.06, 0.08));
  } else if (kind === 'bar') {                                // bar: the bar ends ARE the teeth
    box(Vector3.Zero(), new Vector3(0.08, 1.1, 0.18));
  } else if (kind === 'h_bar') {                              // horizontal bar: ends are the teeth
    box(Vector3.Zero(), new Vector3(H_SPIN.h_bar.len, H_SPIN.h_bar.thick, H_SPIN.h_bar.width));
  } else if (kind === 'shell' || kind === 'cage') {           // v0.12 full-body spinner: ring / shell + two teeth on the rim
    const g = FBS[kind];
    put(new PhysicsShapeCylinder(new Vector3(0, -g.h / 2, 0), new Vector3(0, g.h / 2, 0), g.r, scene));
    for (const x of [g.r + 0.03, -(g.r + 0.03)]) {
      box(new Vector3(x, 0, 0), new Vector3(0.12, Math.min(0.16, g.h), 0.14));
      const tm = MeshBuilder.CreateBox(`${wm.name}_tooth`, { width: 0.12, height: Math.min(0.16, g.h), depth: 0.14 }, scene);
      tm.material = wm.material; tm.parent = wm; tm.position.set(x, 0, 0);
    }
  } else if (kind === 'undercutter') {                        // low blade: ends are the teeth
    box(Vector3.Zero(), new Vector3(H_SPIN.undercutter.len, H_SPIN.undercutter.thick, H_SPIN.undercutter.width));
  } else {                                                    // h_disc: plate + two teeth on the rim
    const r = H_SPIN.h_disc.d / 2, t = H_SPIN.h_disc.thick;
    put(new PhysicsShapeCylinder(new Vector3(0, -t / 2, 0), new Vector3(0, t / 2, 0), r, scene));
    for (const x of [r + 0.02, -(r + 0.02)]) {
      box(new Vector3(x, 0, 0), new Vector3(0.14, 0.1, 0.1));
      const tm = MeshBuilder.CreateBox(`${wm.name}_tooth`, { width: 0.14, height: 0.1, depth: 0.1 }, scene);
      tm.material = wm.material; tm.parent = wm; tm.position.set(x, 0, 0);
    }
  }

  const body = new PhysicsBody(hub, PhysicsMotionType.DYNAMIC, false, scene);
  body.shape = shape;
  body.setCollisionCallbackEnabled(true);
  body.setMassProperties({ mass });
  body.setAngularDamping(0);                                  // no air drag on the weapon: the motor/brake decide
  body.setLinearDamping(BODY.linearDamping);
  // Havok reports inertia per unit mass about the body's principal axes (verified headless)
  const iAxis = vertical ? body.getMassProperties().inertia?.x : body.getMassProperties().inertia?.y;
  const inertia = (iAxis ?? 0.1) * mass;

  // Hinge: every axis locked except rotation about the spin axis (the constraint frame's x axis).
  // Weapon never collides with its own chassis.
  const axis = vertical ? new Vector3(1, 0, 0) : new Vector3(0, 1, 0);
  const X = axis, Y = vertical ? new Vector3(0, 1, 0) : new Vector3(0, 0, 1);
  const lock = (axis: PhysicsConstraintAxis) => ({ axis, minLimit: 0, maxLimit: 0 });
  const joint = new Physics6DoFConstraint(
    { pivotA: pivot, pivotB: Vector3.Zero(), axisA: X, axisB: X, perpAxisA: Y, perpAxisB: Y, collision: false },
    [lock(PhysicsConstraintAxis.LINEAR_X), lock(PhysicsConstraintAxis.LINEAR_Y), lock(PhysicsConstraintAxis.LINEAR_Z),
     lock(PhysicsConstraintAxis.ANGULAR_Y), lock(PhysicsConstraintAxis.ANGULAR_Z)],
    scene);
  chassis.addConstraint(body, joint);
  joint.setAxisMotorType(PhysicsConstraintAxis.ANGULAR_X, PhysicsConstraintMotorType.VELOCITY);
  joint.setAxisMotorTarget(PhysicsConstraintAxis.ANGULAR_X, 0);

  const omegaMax = SPINNER.omega[kind] ?? 50;
  const torque = (inertia * omegaMax) / (SPINNER.spinUpByKind[kind] ?? SPINNER.spinUpS);
  joint.setAxisMotorMaxForce(PhysicsConstraintAxis.ANGULAR_X, torque * SPINNER.brake);
  const sp: RealSpinner = { parentNode: root, parentBody: chassis, axis, dir: SPINNER.dir[vertical ? 'x' : 'y'], hub, body, joint, pivot, inertia, omegaMax, torque, mass };
  return sp;
}

/** Spin speed of a real spinner relative to what it's hinged to, rad/s (signed along the spin direction). */
export function omegaOf(s: RealSpinner): number {
  const axis = Vector3.TransformNormal(s.axis, s.parentNode.getWorldMatrix()).normalize();
  const rel = s.body.getAngularVelocity().subtract(s.parentBody.getAngularVelocity());
  return Vector3.Dot(rel, axis) * s.dir;
}
export function energyOf(s: RealSpinner): number { const w = omegaOf(s); return 0.5 * s.inertia * w * w; }

/** Spin speed of the bot's main spinner (vertical / horizontal), rad/s. */
export function spinOmega(bot: Bot): number { return bot.spinner ? omegaOf(bot.spinner) : 0; }

/** Rotational energy stored in the weapon, J. */
export function spinEnergy(bot: Bot): number { return bot.spinner ? energyOf(bot.spinner) : 0; }

/** Per frame: point the weapon motor at full speed (on), braking (off) or bearing drag only (motor dead). */
export function driveSpinner(bot: Bot, on: boolean, motorAlive: boolean, s: RealSpinner | undefined = bot.spinner, boost = 1) {
  if (!s) return;
  const A = PhysicsConstraintAxis.ANGULAR_X;
  if (on && motorAlive) {
    s.joint.setAxisMotorTarget(A, s.dir * s.omegaMax);
    s.joint.setAxisMotorMaxForce(A, s.torque * boost);   // v0.31: boost > 1 during the countdown (top speed by FIGHT!)
  } else {
    s.joint.setAxisMotorTarget(A, 0);
    s.joint.setAxisMotorMaxForce(A, s.torque * (motorAlive ? SPINNER.brake : SPINNER.bearing));
  }
}

/**
 * Gyroscopic reaction (real physics Havok leaves out): turning the chassis at rate W while the weapon
 * holds angular momentum L pushes back on the chassis with torque -(W x L). For a vertical spinner a
 * hard turn rolls the bot toward one wheel; for a horizontal spinner turning does nothing (parallel
 * axes) but being lifted / tilted makes it precess. Call once per physics step with that step's dt.
 */
export function applyGyro(bot: Bot, dt: number) {
  const s = bot.spinner;
  if (!s || SPINNER.gyro <= 0) return;
  const axis = Vector3.TransformNormal(s.axis, bot.root.getWorldMatrix()).normalize();
  const L = axis.scale(s.inertia * omegaOf(s) * s.dir);
  const W = bot.body.getAngularVelocity();
  const tau = Vector3.Cross(W, L).scale(-SPINNER.gyro);
  if (s.axis.y === 0) { bot.body.applyAngularImpulse(tau.scale(dt)); return; }   // vertical spinners: unchanged since v0.8
  // v0.12 horizontal-axis spinners (big shells especially): the gyro torque never does work, it only turns the
  // chassis' tumble. Applied explicitly with a heavy shell on a light chassis it blew up (headless: a flipped shell
  // flew 13 m), so apply it as a rotation of the chassis' angular velocity that keeps its size.
  const ip = bot.body.getMassProperties().inertia ?? new Vector3(1, 1, 1);
  const m = bot.body.getMassProperties().mass ?? 50;
  const iT = ((ip.x + ip.z) / 2) * m + s.inertia / 2;            // tilt inertia: chassis + the shell tilting with it
  const Wn = W.add(tau.scale(dt / iT));
  const len = W.length(), lenN = Wn.length();
  if (lenN > 1e-6) bot.body.setAngularVelocity(Wn.scale(len / lenN));
}

/** Per physics step: pull the chassis toward the floor at each magnet block. Returns the total pull (N). */
export function applyMagnets(bot: Bot, dt: number): number {
  if (!MAGNET.bodies.includes(bot.build.bodyId)) return 0;
  const up = Vector3.TransformNormal(Vector3.Up(), bot.root.getWorldMatrix()).normalize();
  let total = 0;
  if (up.y > MAGNET.minUp) {
    const restBottom = REST_Y - CHASSIS.h / 2;                 // chassis underside height with the wheels down
    for (const z of MAGNET.points) {
      const p = Vector3.TransformCoordinates(new Vector3(0, -CHASSIS.h / 2, z), bot.root.getWorldMatrix());
      if (Math.abs(p.x) > MAGNET.arenaHalf || Math.abs(p.z) > MAGNET.arenaHalf || p.y < -0.05) continue;
      const extra = Math.max(0, p.y - restBottom);
      const f = (MAGNET.pull / MAGNET.points.length) * Math.pow(MAGNET.gap0 / (MAGNET.gap0 + extra), 2) * up.y;
      bot.body.applyImpulse(new Vector3(0, -f * dt, 0), p);
      total += f;
    }
  }
  bot.magnetPull = total;
  return total;
}

/** Every real weapon body of the bot (main spinner, overhead arm, saw on the arm). */
export function weaponBodies(bot: Bot): { body: PhysicsBody; hub: Mesh; joint: Physics6DoFConstraint; mass: number }[] {
  return [bot.spinner, bot.arm, bot.saw, ...(bot.hinges ?? [])].filter(<T>(x: T | undefined): x is T => !!x);
}

/** Every visible mesh of the bot, including real weapons (which are not under root). */
export function botMeshes(bot: Bot): AbstractMesh[] {
  const out: AbstractMesh[] = [bot.root, ...bot.root.getChildMeshes()];
  for (const w of weaponBodies(bot)) out.push(...w.hub.getChildMeshes().filter(m => !out.includes(m)));   // all descendants (arm bar + head, teeth)
  for (const w of bot.wheels ?? []) out.push(...w.hub.getChildMeshes());   // v0.21 tyres + hub detail
  return out;
}

/** Remove the bot from the scene (restart). Children (saw) before parents (arm). */
export function disposeBot(bot: Bot) {
  for (const w of weaponBodies(bot).reverse()) {
    w.joint.dispose();
    w.body.dispose();
    w.hub.dispose(false, true);
  }
  for (const w of bot.wheels ?? []) { if (!w.released) w.joint.dispose(); w.body.dispose(); w.hub.dispose(false, true); }   // v0.21 (v0.29: a released wheel's joint is already gone)
  bot.body.dispose();
  bot.root.dispose(false, true);
}

/** v0.28 Cube Bots: a part at 0 HP falls off for real -- its collider pieces stop colliding (mass is left as it was).
 *  wheels = every tyre (the part is all four) + 2WD skids; weapon = its real body/bodies (breakable weapons only). */
export function dropPart(bot: Bot, socketId: string) {
  for (const s of bot.partShapes[socketId] ?? []) { s.filterMembershipMask = 0; s.filterCollideMask = 0; }
  if (bot.state.parts[socketId]?.socketType === 'wheels') releaseWheels(bot);
  if (socketId === 'weapon') for (const w of weaponBodies(bot)) setFilter(w.body.shape!, 0, 0);
}

/** v0.29: wheels that fell off leave for real -- axle joints removed, tyre bodies parked (static, hidden, colliding
 *  with nothing), drive stops. Headless: tyres left hanging on their joints with no collisions could blow the solver
 *  up on a hard hit (a bellied Flip Side shot 230 m into the air). Their mass moves onto the chassis, so the bot's
 *  weight is unchanged (v0.28 rule). */
function releaseWheels(bot: Bot) {
  let extra = 0;
  for (const w of bot.wheels ?? []) {
    if (w.released) continue;
    w.gone = true; setTread(w, false);
    w.released = true;
    w.cmd = 0;
    w.joint.dispose();
    w.body.setLinearVelocity(Vector3.Zero());
    w.body.setAngularVelocity(Vector3.Zero());
    w.body.setMotionType(PhysicsMotionType.STATIC);
    w.hub.setEnabled(false);
    extra += w.mass;
  }
  if (extra <= 0) return;
  const mp = bot.body.getMassProperties();
  const m0 = mp.mass ?? 50, m1 = m0 + extra;
  bot.body.setMassProperties({ mass: m1, centerOfMass: mp.centerOfMass, inertia: mp.inertia?.scale(m1 / m0), inertiaOrientation: mp.inertiaOrientation });
}

/** v0.28 Cube Bots KO: the bot is blown apart -- freeze + hide it and switch every collider off (nothing left to hit). */
export function dropBot(bot: Bot) {
  freezeBot(bot);
  for (const b of [...chassisBodies(bot), ...weaponBodies(bot).map(w => w.body)]) if (b.shape) setFilter(b.shape, 0, 0);
  for (const w of bot.wheels ?? []) { w.gone = true; setTread(w, false); }
}

/** Freeze + hide (knocked out of the arena). */
export function freezeBot(bot: Bot) {
  for (const b of [...chassisBodies(bot), ...weaponBodies(bot).map(w => w.body)]) {
    b.setLinearVelocity(Vector3.Zero());
    b.setAngularVelocity(Vector3.Zero());
    b.setMotionType(PhysicsMotionType.STATIC);
  }
  bot.root.setEnabled(false);
  for (const w of [...weaponBodies(bot), ...(bot.wheels ?? [])]) w.hub.setEnabled(false);
}

/** Put a real spinner back on its hinge after its parent was teleported, keeping its spin. */
function snapOne(s: RealSpinner, scene: Scene) {
  const w = omegaOf(s);
  s.parentNode.computeWorldMatrix(true);
  s.hub.position = Vector3.TransformCoordinates(s.pivot, s.parentNode.getWorldMatrix());
  s.hub.rotationQuaternion = s.parentNode.absoluteRotationQuaternion.clone();
  s.hub.computeWorldMatrix(true);
  s.body.disablePreStep = false;
  const axis = Vector3.TransformNormal(s.axis, s.parentNode.getWorldMatrix()).normalize();
  s.body.setAngularVelocity(axis.scale(w * s.dir).add(s.parentBody.getAngularVelocity()));
  s.body.setLinearVelocity(s.parentBody.getLinearVelocity());
  scene.onAfterPhysicsObservable.addOnce(() => { s.body.disablePreStep = true; });
}

/** After the chassis is teleported (self-right snap), put real weapons back on their hinges.
 *  Spinners keep their spin; the overhead arm goes back to its rest pose (saw follows it). */
export function snapSpinner(bot: Bot, scene: Scene) {
  bot.root.computeWorldMatrix(true);
  if (bot.spinner) snapOne(bot.spinner, scene);
  const a = bot.arm;
  if (a) {
    a.hub.position = Vector3.TransformCoordinates(a.pivot, bot.root.getWorldMatrix());
    a.hub.rotationQuaternion = (bot.root.rotationQuaternion ?? Quaternion.Identity()).clone();
    a.hub.computeWorldMatrix(true);
    a.body.disablePreStep = false;
    a.body.setAngularVelocity(bot.body.getAngularVelocity());
    a.body.setLinearVelocity(bot.body.getLinearVelocity());
    a.state = 'ready'; a.t = 0;
    scene.onAfterPhysicsObservable.addOnce(() => { a.body.disablePreStep = true; });
  }
  if (bot.saw) snapOne(bot.saw, scene);
  for (const h of bot.hinges ?? []) {                          // v0.12: flipper plate / forks / jaws back to rest
    h.hub.position = Vector3.TransformCoordinates(h.pivot, bot.root.getWorldMatrix());
    h.hub.rotationQuaternion = (bot.root.rotationQuaternion ?? Quaternion.Identity()).clone();
    h.hub.computeWorldMatrix(true);
    h.body.disablePreStep = false;
    h.body.setAngularVelocity(bot.body.getAngularVelocity());
    h.body.setLinearVelocity(bot.body.getLinearVelocity());
    h.state = 'ready'; h.t = 0;
    scene.onAfterPhysicsObservable.addOnce(() => { h.body.disablePreStep = true; });
  }
  for (const w of bot.wheels ?? []) {                          // v0.21: tyres back on their axles
    w.hub.position = Vector3.TransformCoordinates(w.pivot, bot.root.getWorldMatrix());
    w.hub.rotationQuaternion = (bot.root.rotationQuaternion ?? Quaternion.Identity()).clone();
    w.hub.computeWorldMatrix(true);
    w.body.disablePreStep = false;
    w.body.setAngularVelocity(bot.body.getAngularVelocity());
    w.body.setLinearVelocity(bot.body.getLinearVelocity());
    scene.onAfterPhysicsObservable.addOnce(() => { w.body.disablePreStep = true; });
  }
}

type PhysicsMaterialLike = { friction: number; restitution: number };

function spinAxisFor(kind: WeaponKind): Bot['spinAxis'] {
  if (['disc', 'bar', 'drum'].includes(kind)) return 'x';
  if (['h_bar', 'h_disc', 'undercutter', 'shell', 'cage'].includes(kind)) return 'y';
  return 'none';
}

type Mats = BotMats;

/** A triangular wedge prism in chassis-local coordinates: back face flush with the chassis front, tip out front. */
function wedgePrism(scene: Scene, name: string, kind: string): Mesh {
  const f = FRONT[kind] ?? FRONT.wedge;
  const z0 = CHASSIS.d / 2;
  const len = (f.topY - f.tipY) / Math.tan((f.angleDeg * Math.PI) / 180);
  const hw = CHASSIS.w / 2;
  // triangle (z, y): back-bottom, back-top, tip   -- extruded along x
  const tri = [[z0, f.tipY], [z0, f.topY], [z0 + len, f.tipY]] as const;
  const L = tri.map(([z, y]) => [-hw, y, z]), R = tri.map(([z, y]) => [hw, y, z]);
  // v0.16: flat-shaded faces with their own UVs (the worn-steel texture needs UVs; same vertex positions,
  // so the convex-hull collider is unchanged)
  const positions: number[] = [], uvs: number[] = [], indices: number[] = [];
  const tri3 = (a: number[], b: number[], c: number[], ua: number[], ub: number[], uc: number[]) => {
    const i = positions.length / 3;
    positions.push(...a, ...b, ...c); uvs.push(...ua, ...ub, ...uc); indices.push(i, i + 1, i + 2);
  };
  const side = (p: number[]) => [(p[2] - z0) / len, (p[1] - f.tipY) / (f.topY - f.tipY)];
  tri3(L[0], L[1], L[2], side(L[0]), side(L[1]), side(L[2]));                          // left
  tri3(R[0], R[2], R[1], side(R[0]), side(R[2]), side(R[1]));                          // right
  const quad = (La: number[], Lb: number[], Ra: number[], Rb: number[]) => {           // a-edge v=0, b-edge v=1
    tri3(La, Rb, Lb, [0, 0], [1, 1], [0, 1]);
    tri3(La, Ra, Rb, [0, 0], [1, 0], [1, 1]);
  };
  quad(L[0], L[1], R[0], R[1]);                                                       // back
  quad(L[1], L[2], R[1], R[2]);                                                       // slope
  quad(L[2], L[0], R[2], R[0]);                                                       // bottom
  const vd = new VertexData();
  vd.positions = positions; vd.indices = indices; vd.uvs = uvs;
  const normals: number[] = [];
  VertexData.ComputeNormals(positions, indices, normals);
  vd.normals = normals;
  const m = new Mesh(name, scene);
  vd.applyToMesh(m);
  return m;
}

/** v0.21 axle positions (chassis z) for a wheel layout. 2WD: one axle at the centre, skids carry the ends. */
function axleZs(layout: string, bodyId: string): number[] {
  const front = FRONT_AXLE[bodyId] ?? 0.5, rear = REAR_AXLE[bodyId] ?? -0.5;
  if (layout === '2wd') return [0];
  if (layout === '6wd') return [front, rear + (front - rear) * DRIVE.sixMid, rear];
  return [front, rear];
}

/** v0.21 2WD skid block: from the chassis underside down to `gap` above the floor. */
function skidGeom(z: number) {
  const top = -CHASSIS.h / 2, bottom = -REST_Y + DRIVE.skid.gap;
  return { centre: new Vector3(0, (top + bottom) / 2, z), h: top - bottom };
}

/** Front axle position (chassis z). Vertical spinners carry a heavy weapon out front, so their front
 *  wheels sit further forward -- otherwise the bot tips onto its nose (found in the v0.8 headless test). */
const ARM_SAW_R = 0.25;   // saw disc radius on an overhead arm (0.5 m disc)

export const REAR_AXLE: Record<string, number> = {};   // v0.22 per-body rear axle z (default -0.5)
export const FRONT_AXLE: Record<string, number> = { vertical_spinner: 0.68, horizontal_spinner: 0.68, control: 0.68 };   // v0.12: control too (load on the fork)

/** v0.9 horizontal spinner geometry (chassis space; floor is y = -REST_Y = -0.30).
 *  Bar / disc sit at mid-chassis height so they meet the opponent's chassis (world y ~0.35);
 *  the undercutter blade's centre is ~8 cm off the floor. All hinge just ahead of the chassis front. */
/** v0.12 full-body spinner geometry: shell = 2 m 12-sided shell, cage = 2 m ring (chassis space, centre y 0.1).
 *  v0.13: shell lowered to centre y 0.0 so its edge sits 5 cm off the floor (was 15 cm) -- real shells keep the rim
 *  low so wedges / forks / flipper lips can't get under. Headless: flips per fight 0.69 -> 0.17. */
export const FBS = {
  shell: { r: 1.0, h: 0.5, y: 0.0 },
  cage:  { r: 1.0, h: 0.15, y: 0.1 },
};

export const H_SPIN = {
  h_bar:       { len: 1.2,   // v0.31 tester balance (was 1.6: the long bar kept everyone away)
                thick: 0.08, width: 0.2, y: 0.05, z: CHASSIS.d / 2 + 0.1 },
  h_disc:      { d: 1.0, thick: 0.08, y: 0.05, z: CHASSIS.d / 2 + 0.1 },
  // 1.4 m: at 8 cm the blade passes under a chassis (12.5 cm clearance), so it has to reach the wheels.
  // Headless: 1.2 m whiffed vs Hammer Time; 1.4 m hits every preset and stores ~ the bar's energy.
  undercutter: { len: 1.4, thick: 0.05, width: 0.18, y: -REST_Y + 0.08, z: CHASSIS.d / 2 + 0.1 },
};

function partMesh(scene: Scene, id: string, socketId: string, part: PartDef, mats: Mats, bodyId: string): Mesh | undefined {
  const n = `${id}_${socketId}`;
  const front = CHASSIS.d / 2;
  const fbs = bodyId === 'full_body_spinner';
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
      m.material = socketId === 'armor' ? mats.paint : mats.dark;   // v0.16: top plate carries the paint job
      return m;
    }
    case 'wheels': {
      const m = new Mesh(n, scene);
      const layout = layoutFor(bodyId, part), skidZ = bodyId === 'full_body_spinner' ? FBS_BASE.skidZ : DRIVE.skid.z;
      const zs = axleZs(layout, bodyId);
      if (layout === '2wd') for (const z of [skidZ, -skidZ]) {   // v0.21 skids (collider in buildBot)
        const g = skidGeom(z);
        const sk = MeshBuilder.CreateBox(`${n}_skid_${z}`, { width: DRIVE.skid.width, height: g.h, depth: DRIVE.skid.depth }, scene);
        sk.position.copyFrom(g.centre);
        sk.material = mats.dark;
        sk.parent = m;
      }
      const drop = layout === '6wd' && DRIVE.dropCentreBodies.includes(bodyId) ? DRIVE.dropCentre : 0;
      const wx = chassisFor(bodyId).w / 2 + 0.12 + (STANCE[bodyId] ?? 0);
      for (const [i, z] of zs.entries()) for (const x of [-1, 1]) {
        const w = MeshBuilder.CreateCylinder(`${n}_${x}_${z}`, { diameter: WHEEL.r * 2, height: WHEEL.w }, scene);
        w.rotation.z = Math.PI / 2;
        w.position.set(x * wx, WHEEL.y - (i === 1 ? drop : 0), z);   // v0.22: 6WD centre axle = zs[1]
        w.material = mats.rubber;
        w.parent = m;
      }
      return m;
    }
    case 'weapon_motor': {
      const m = MeshBuilder.CreateBox(n, { width: 0.35, height: 0.18, depth: 0.3 }, scene);
      m.position.set(-0.35, CHASSIS.h / 2 + 0.09, front - 0.35);
      if (fbs) m.position.set(-0.3, -0.03, 0.25);    // v0.22: inside the shell (its top is at y 0.25), not on show
      m.material = mats.dark;
      return m;
    }
    case 'motor': {
      const m = MeshBuilder.CreateBox(n, { width: 0.5, height: 0.2, depth: 0.5 }, scene);
      m.position.set(0, CHASSIS.h / 2 + 0.1, -0.4);
      if (fbs) m.position.set(0.1, -0.02, -0.25);    // v0.22: inside the shell
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
    case 'drum': m = MeshBuilder.CreateCylinder(n, { diameter: 0.55, height: 1.2 }, scene); m.rotation.z = Math.PI / 2; m.position.set(0, 0.25, front + 0.2); break;   // v0.8: teeth clear the floor (lower = grinds the floor)
    case 'h_bar': { const g = H_SPIN.h_bar; m = MeshBuilder.CreateBox(n, { width: g.len, height: g.thick, depth: g.width }, scene); m.position.set(0, g.y, g.z); break; }
    case 'h_disc': { const g = H_SPIN.h_disc; m = MeshBuilder.CreateCylinder(n, { diameter: g.d, height: g.thick }, scene); m.position.set(0, g.y, g.z); break; }
    case 'undercutter': { const g = H_SPIN.undercutter; m = MeshBuilder.CreateBox(n, { width: g.len, height: g.thick, depth: g.width }, scene); m.position.set(0, g.y, g.z); break; }
    case 'hammer': case 'saw': case 'hammer_saw': {
      // v0.10: empty node AT THE HINGE, rotated to the rest angle; arm runs along its local +y,
      // head at the end; the striking side is local +z (faces down when the arm comes over the front).
      m = new Mesh(n, scene);
      m.position.copyFrom(ARM.pivot);
      m.rotation.x = (ARM.restDeg * Math.PI) / 180;
      const bar = MeshBuilder.CreateBox(`${n}_arm`, { width: 0.1, height: ARM.len, depth: 0.1 }, scene);
      bar.position.set(0, ARM.len / 2, 0); bar.parent = m; bar.material = mats.steel;
      if (kind !== 'saw') {
        const head = MeshBuilder.CreateBox(`${n}_head`, kind === 'hammer' ? { width: 0.35, height: 0.3, depth: 0.3 } : { width: 0.25, height: 0.22, depth: 0.22 }, scene);
        head.position.set(0, ARM.len, 0); head.parent = m; head.material = mats.steel;
      }
      if (kind !== 'hammer') {
        const saw = MeshBuilder.CreateCylinder(`${n}_saw`, { diameter: ARM_SAW_R * 2, height: 0.06 }, scene);
        saw.rotation.z = Math.PI / 2;
        saw.position.set(0, ARM.len, kind === 'saw' ? 0 : 0.2); saw.parent = m; saw.material = mats.steel;
      }
      break;
    }
    case 'pneumatic_flipper': case 'electric_flipper': {
      // v0.12: empty node; the plate is a child node AT ITS HINGE (top rear) with a flat top + a front lip
      // lying on the 30 deg wedge face (rear-hinged true flipper).
      m = new Mesh(n, scene);
      const plate = new Mesh(`${n}_flipper`, scene);
      plate.parent = m; plate.position.copyFrom(FLIP.hinge);
      const flatLen = front - FLIP.hinge.z;
      const flat = MeshBuilder.CreateBox(`${n}_flat`, { width: FLIP.width, height: FLIP.thick, depth: flatLen }, scene);
      flat.parent = plate; flat.position.set(0, 0, flatLen / 2); flat.material = mats.steel;
      slopePiece(scene, `${n}_lip`, plate, FLIP.hinge, FLIP.lipLen, FLIP.lipDeg, FLIP.width, FLIP.thick, mats.steel);
      break;
    }
    case 'lifter': case 'grappler': case 'crusher': {
      // v0.12: fork lying on the wedge face, hinged at the chassis front-top edge (lifter / grappler); the
      // crusher's lower jaw is the same piece but FIXED. Jaw / beak hinge on top and rest OPEN.
      m = new Mesh(n, scene);
      const F = CONTROL.fork;
      const forkHinge = new Vector3(0, CHASSIS.h / 2 + F.thick / 2 + 0.005, front);
      if (kind === 'crusher') {
        slopePiece(scene, `${n}_fixed`, m, Vector3.Zero(), F.len, F.deg, F.width, F.thick, mats.steel, forkHinge);
      } else {
        const fork = new Mesh(`${n}_fork`, scene); fork.parent = m; fork.position.copyFrom(forkHinge);
        slopePiece(scene, `${n}_forkplate`, fork, forkHinge, F.len, F.deg, F.width, F.thick, mats.steel, forkHinge);
      }
      if (kind !== 'lifter') {
        const J = kind === 'grappler' ? CONTROL.jaw : CONTROL.beak;
        const role = kind === 'grappler' ? 'jaw' : 'beak';
        const jaw = new Mesh(`${n}_${role}`, scene); jaw.parent = m; jaw.position.copyFrom(J.hinge);
        jaw.rotation.x = -J.openRad;                                  // open (tipped up) at rest
        const arm = MeshBuilder.CreateBox(`${n}_${role}arm`, { width: J.width, height: 0.08, depth: J.len }, scene);
        arm.parent = jaw; arm.position.set(0, 0, J.len / 2); arm.material = mats.steel;
        const tipH = kind === 'crusher' ? CONTROL.beak.spike : 0.22;
        const tooth = MeshBuilder.CreateBox(`${n}_${role}_tooth`, { width: kind === 'crusher' ? 0.12 : J.width, height: tipH, depth: 0.1 }, scene);
        tooth.parent = jaw; tooth.position.set(0, -tipH / 2, J.len - 0.05); tooth.material = mats.steel;
      }
      break;
    }
    case 'shell':
      m = MeshBuilder.CreateCylinder(n, { diameter: FBS.shell.r * 2, height: FBS.shell.h, tessellation: 12 }, scene); m.position.set(0, FBS.shell.y, 0); break;
    case 'cage':
      m = MeshBuilder.CreateTorus(n, { diameter: FBS.cage.r * 2 - FBS.cage.h, thickness: FBS.cage.h, tessellation: 10 }, scene); m.position.set(0, FBS.cage.y, 0); break;
  }
  if (m.getTotalVertices() > 0) m.material = kind === 'shell' || kind === 'cage' ? mats.paint : mats.steel;
  return m;
}

/** A plate sloping DOWN-forward at deg from its top edge `top` (chassis space), lying just above a wedge face
 *  of the same angle. Parent is a node positioned at `origin` (chassis space). */
function slopePiece(scene: Scene, name: string, parent: Mesh, origin: Vector3, len: number, deg: number, width: number, thick: number, material: Material, topIn?: Vector3) {
  const a = (deg * Math.PI) / 180;
  const top = topIn ?? new Vector3(0, origin.y, CHASSIS.d / 2);
  const dir = new Vector3(0, -Math.sin(a), Math.cos(a)), nrm = new Vector3(0, Math.cos(a), Math.sin(a));
  const centre = top.add(dir.scale(len / 2)).add(nrm.scale(0.005)).subtract(origin);
  const p = MeshBuilder.CreateBox(name, { width, height: thick, depth: len }, scene);
  p.parent = parent; p.position.copyFrom(centre); p.rotation.x = a; p.material = material;
  return p;
}

/** Forward direction in world space (bot faces +Z locally). */
export function forward(bot: Bot): Vector3 {
  return Vector3.TransformNormal(Vector3.Forward(), bot.root.getWorldMatrix()).normalize();
}

/** Bot's up vector in world space. */
export function upVector(bot: Bot): Vector3 {
  return Vector3.TransformNormal(Vector3.Up(), bot.root.getWorldMatrix()).normalize();
}

// =====================================================================================================
// v0.16 visual detail (looks only). Detail meshes carry DECO in their name so no collider pass picks them
// up, ram anchors are TransformNodes (never meshes), and pieces sharing a parent + material are merged
// into one mesh to keep draw calls down. Nothing here changes mass, colliders or balance.
// =====================================================================================================
const DECO = '_deco';
export function isDeco(m: { name: string }) { return m.name.includes(DECO); }

class DecoBin {
  private groups = new Map<string, { parent: Node; mat: Material; meshes: Mesh[] }>();
  constructor(readonly scene: Scene) {}
  /** `m` is built unparented, in `parent`'s local space. */
  add(parent: Node, mat: Material, m: Mesh): Mesh {
    const key = `${parent.uniqueId}:${mat.uniqueId}`;
    let g = this.groups.get(key);
    if (!g) { g = { parent, mat, meshes: [] }; this.groups.set(key, g); }
    g.meshes.push(m);
    return m;
  }
  flush() {
    for (const g of this.groups.values()) {
      const merged = g.meshes.length === 1 ? g.meshes[0] : Mesh.MergeMeshes(g.meshes, true, true);
      if (!merged) continue;
      merged.name = `${g.parent.name}${DECO}_${g.mat.name}`;
      merged.parent = g.parent;
      merged.material = g.mat;
      merged.isPickable = false;
    }
    this.groups.clear();
  }
}

const V = (x: number, y: number, z: number) => new Vector3(x, y, z);
type Axis = 'x' | 'y' | 'z';
const BOLT_H = 0.016, B = BOLT_H / 2;

function cyl(bin: DecoBin, parent: Node, mat: Material, at: Vector3, axis: Axis, d: number, h: number, tess = 16): Mesh {
  const m = MeshBuilder.CreateCylinder('deco', { diameter: d, height: h, tessellation: tess }, bin.scene);
  m.position.copyFrom(at);
  if (axis === 'x') m.rotation.z = Math.PI / 2; else if (axis === 'z') m.rotation.x = Math.PI / 2;
  return bin.add(parent, mat, m);
}
function box(bin: DecoBin, parent: Node, mat: Material, at: Vector3, w: number, h: number, d: number): Mesh {
  const m = MeshBuilder.CreateBox('deco', { width: w, height: h, depth: d }, bin.scene);
  m.position.copyFrom(at);
  return bin.add(parent, mat, m);
}
/** A box from a to b (its depth runs along the segment); w = width across, h = height. */
function beam(bin: DecoBin, parent: Node, mat: Material, a: Vector3, b: Vector3, w: number, h: number): Mesh {
  const d = b.subtract(a), L = d.length();
  const m = MeshBuilder.CreateBox('deco', { width: w, height: h, depth: L }, bin.scene);
  m.position.copyFrom(a.add(b).scale(0.5));
  m.rotation.y = Math.atan2(d.x, d.z);
  m.rotation.x = -Math.atan2(d.y, Math.hypot(d.x, d.z));
  return bin.add(parent, mat, m);
}
/** Hex bolt head; `at` is the bolt centre (surface + B along the axis). */
function bolt(bin: DecoBin, parent: Node, mat: Material, at: Vector3, axis: Axis): Mesh {
  return cyl(bin, parent, mat, at, axis, 0.034, BOLT_H, 6);
}
function boltLine(bin: DecoBin, parent: Node, mat: Material, a: Vector3, b: Vector3, spacing: number, axis: Axis, skipEnds = false) {
  const n = Math.max(2, Math.round(Vector3.Distance(a, b) / spacing) + 1);
  for (let i = skipEnds ? 1 : 0; i < (skipEnds ? n - 1 : n); i++) bolt(bin, parent, mat, Vector3.Lerp(a, b, i / (n - 1)), axis);
}
/** Bolts round the edge of a face: c = face centre (already lifted by B), u / v = half extents along the face. */
function boltFrame(bin: DecoBin, parent: Node, mat: Material, c: Vector3, u: Vector3, v: Vector3, axis: Axis, inset: number, spacing: number) {
  const ui = u.normalizeToNew().scale(u.length() - inset), vi = v.normalizeToNew().scale(v.length() - inset);
  const k = [c.add(ui).add(vi), c.subtract(ui).add(vi), c.subtract(ui).subtract(vi), c.add(ui).subtract(vi)];
  for (let i = 0; i < 4; i++) boltLine(bin, parent, mat, k[i], k[(i + 1) % 4], spacing, axis, i % 2 === 1);
}
/** Ring of bolts round an axis. */
function boltRing(bin: DecoBin, parent: Node, mat: Material, c: Vector3, axis: Axis, r: number, n: number) {
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2, a = Math.cos(t) * r, b = Math.sin(t) * r;
    bolt(bin, parent, mat, axis === 'y' ? c.add(V(a, 0, b)) : axis === 'x' ? c.add(V(0, a, b)) : c.add(V(a, b, 0)), axis);
  }
}

// ---- hydraulic rams: barrel on the chassis, rod on the moving part, re-aimed every frame ----
interface Ram { a: Vector3; b: TransformNode; barrel: Mesh; rod: Mesh; len: number }
function addRam(scene: Scene, root: Mesh, mats: Mats, rams: Ram[], a: Vector3, parent: Node, bLocal: Vector3, r = 0.04, len = 0.3) {
  const tn = new TransformNode(`${root.name}${DECO}_ramB`, scene);
  tn.parent = parent; tn.position.copyFrom(bLocal);
  const barrel = MeshBuilder.CreateCylinder(`${root.name}${DECO}_ram`, { diameter: r * 2, height: 1, tessellation: 14 }, scene);
  const rod = MeshBuilder.CreateCylinder(`${root.name}${DECO}_rod`, { diameter: r, height: 1, tessellation: 10 }, scene);
  barrel.material = mats.dark; rod.material = mats.chrome;
  for (const m of [barrel, rod]) { m.parent = root; m.rotationQuaternion = new Quaternion(); m.isPickable = false; }
  rams.push({ a, b: tn, barrel, rod, len });
}
function updateRams(root: Mesh, rams: Ram[]) {
  root.computeWorldMatrix(true);
  const inv = Matrix.Invert(root.getWorldMatrix());
  for (const r of rams) {
    r.b.computeWorldMatrix(true);
    const b = Vector3.TransformCoordinates(r.b.getAbsolutePosition(), inv);
    const d = b.subtract(r.a), L = Math.max(d.length(), 1e-4);
    d.scaleInPlace(1 / L);
    const lb = Math.min(r.len, L * 0.8);                    // barrel from the chassis end
    r.barrel.position.copyFrom(r.a).addInPlace(d.scale(lb / 2)); r.barrel.scaling.y = lb;
    const lr = Math.max(L - lb * 0.25, 0.01);                // rod from the moving end, sliding into the barrel
    r.rod.position.copyFrom(b).subtractInPlace(d.scale(lr / 2)); r.rod.scaling.y = lr;
    Quaternion.FromUnitVectorsToRef(Vector3.UpReadOnly, d, r.barrel.rotationQuaternion!);
    r.rod.rotationQuaternion!.copyFrom(r.barrel.rotationQuaternion!);
  }
}

/** Belt between two pulleys whose axes are parallel to `axis` ('x' or 'y'); centres in `parent` space. */
function belt(bin: DecoBin, parent: Node, mat: Material, p1: Vector3, r1: number, p2: Vector3, r2: number, axis: 'x' | 'y') {
  const d = p2.subtract(p1).normalize();
  const n = axis === 'x' ? V(0, d.z, -d.y) : V(d.z, 0, -d.x);   // in the belt plane, perpendicular to the run
  for (const s of [1, -1]) {
    const a = p1.add(n.scale(s * r1)), b = p2.add(n.scale(s * r2));
    if (axis === 'x') beam(bin, parent, mat, a, b, 0.03, 0.012);
    else beam(bin, parent, mat, a, b, 0.012, 0.03);
  }
}

function addDetails(scene: Scene, root: Mesh, bodyId: string, parts: Record<string, Mesh>, kinds: Record<string, PartDef>, mats: Mats) {
  const bin = new DecoBin(scene);
  const rams: Ram[] = [];
  const H = CHASSIS.h / 2, W = CHASSIS.w / 2, D = CHASSIS.d / 2;
  const fbs = bodyId === 'full_body_spinner';
  const topBusy = bodyId === 'flipper' || bodyId === 'control';   // plates / forks lie on the top and the wedge
  const slotted = !!VS_SLOT[(kinds['weapon']?.kind ?? '') as WeaponKind];   // v0.22: nothing across the weapon slot

  // ---- chassis: angle-iron rails on the top edges, bolted panels ----
  if (!fbs) {
    for (const sx of [-1, 1]) {
      box(bin, root, mats.dark, V(sx * (W - 0.03), H + 0.015, 0), 0.06, 0.03, CHASSIS.d);
      boltLine(bin, root, mats.bolt, V(sx * (W - 0.03), H + 0.03 + B, -D + 0.08), V(sx * (W - 0.03), H + 0.03 + B, D - 0.08), 0.2, 'y');
      boltLine(bin, root, mats.bolt, V(sx * (W + B), 0.07, -D + 0.1), V(sx * (W + B), 0.07, D - 0.1), 0.22, 'x');
    }
    for (const sz of topBusy || slotted ? [-1] : [-1, 1]) {
      box(bin, root, mats.dark, V(0, H + 0.015, sz * (D - 0.03)), CHASSIS.w - 0.12, 0.03, 0.06);
      boltLine(bin, root, mats.bolt, V(-W + 0.14, H + 0.03 + B, sz * (D - 0.03)), V(W - 0.14, H + 0.03 + B, sz * (D - 0.03)), 0.2, 'y');
    }
    boltFrame(bin, root, mats.bolt, V(0, 0, -D - B), V(W, 0, 0), V(0, H, 0), 'z', 0.06, 0.2);
  }

  const wmm = parts['weapon_motor'];
  for (const [sid, m] of Object.entries(parts)) {
    const k = kinds[sid];
    switch (k.type) {
      case 'armor':
        if (sid === 'armor') { if (!topBusy && bodyId !== 'flipper') boltFrame(bin, m, mats.bolt, V(0, 0.03 + B, 0), V(CHASSIS.w * 0.45, 0, 0), V(0, 0, CHASSIS.d * 0.45), 'y', 0.05, 0.22); }
        else { const sx = sid.endsWith('1') ? -1 : 1; boltFrame(bin, m, mats.bolt, V(sx * (0.04 + B), 0, 0), V(0, 0.15, 0), V(0, 0, CHASSIS.d * 0.45), 'x', 0.04, 0.24); }
        break;
      case 'front': {
        if (topBusy) break;                                     // a flipper lip / fork lies on the wedge face
        const f = FRONT[k.kind ?? 'wedge'] ?? FRONT.wedge, a = (f.angleDeg * Math.PI) / 180;
        const p0 = V(0, f.topY, D).add(V(0, -Math.sin(a), Math.cos(a)).scale(0.07)).add(V(0, Math.cos(a), Math.sin(a)).scale(B));
        const gap = VS_SLOT[(kinds['weapon']?.kind ?? '') as WeaponKind]?.half ?? 0;   // v0.22: no bolts in the weapon slot
        for (let i = 0; i < 7; i++) { const x = -W + 0.1 + (i * (2 * W - 0.2)) / 6; if (gap && Math.abs(x) < gap + 0.03) continue; bolt(bin, m, mats.bolt, p0.add(V(x, 0, 0)), 'y').rotation.x = a; }
        break;
      }
      case 'wheels':
        if ((STANCE[bodyId] ?? 0) > 0) for (const w of (m.getChildMeshes(true) as Mesh[]).filter(t => !t.name.includes('_skid_'))) {   // v0.22 axle outriggers
          const sx = Math.sign(w.position.x), inner = Math.abs(w.position.x) - WHEEL.w / 2;
          box(bin, root, mats.dark, V(sx * (W + inner) / 2, w.position.y + 0.06, w.position.z), inner - W, 0.08, 0.14);
          cyl(bin, root, mats.chrome, V(sx * (W + inner) / 2, w.position.y, w.position.z), 'x', 0.05, inner - W, 12);
        }
        for (const w of (m.getChildMeshes(true) as Mesh[]).filter(t => !t.name.includes('_skid_'))) {      // tyre: local y is the axle (rotated onto world x)
          const out = -(Math.sign(w.position.x) || 1), y0 = out * WHEEL.w / 2;
          cyl(bin, w, mats.bolt, V(0, y0 + out * 0.012, 0), 'y', WHEEL.r * 1.15, 0.024, 20);   // hub
          boltRing(bin, w, mats.chrome, V(0, y0 + out * (0.024 + B), 0), 'y', 0.075, 5);         // wheel nuts
          cyl(bin, w, mats.dark, V(0, y0 + out * 0.03, 0), 'y', 0.07, 0.03, 12);                  // centre cap
          cyl(bin, w, mats.bolt, V(0, -y0 - out * 0.01, 0), 'y', WHEEL.r * 0.9, 0.02, 16);       // inner hub
        }
        break;
      case 'weapon_motor': {
        const hSpin = ['h_bar', 'h_disc', 'undercutter'].includes(kinds.weapon?.kind ?? '');
        if (hSpin) cyl(bin, m, mats.can, V(0, 0.09 + 0.025, 0), 'y', 0.18, 0.05, 20);           // pancake outrunner
        else {
          cyl(bin, m, mats.can, V(0, 0.09 + 0.08, 0), 'x', 0.16, 0.3, 16);                       // motor can
          for (const sx of [-1, 1]) cyl(bin, m, mats.bolt, V(sx * 0.16, 0.17, 0), 'x', 0.13, 0.02, 16);   // end bells
        }
        boltFrame(bin, m, mats.bolt, V(0, 0.09 + B, 0), V(0.175, 0, 0), V(0, 0, 0.15), 'y', 0.03, 0.4);
        break;
      }
      case 'motor':
        for (const sz of [-1, 1]) {                                                               // two drive motors
          cyl(bin, m, mats.can, V(0, 0.1 + 0.07, sz * 0.12), 'x', 0.14, 0.42, 16);
          for (const sx of [-1, 1]) cyl(bin, m, mats.bolt, V(sx * 0.215, 0.17, sz * 0.12), 'x', 0.11, 0.02, 16);
        }
        boltFrame(bin, m, mats.bolt, V(0, 0.1 + B, 0), V(0.25, 0, 0), V(0, 0, 0.25), 'y', 0.04, 0.45);
        break;
      case 'weapon':
        weaponDetail(scene, bin, rams, root, m, k.kind as WeaponKind, mats, wmm);
        break;
    }
  }
  bin.flush();
  if (rams.length) {
    updateRams(root, rams);
    const obs = scene.onBeforeRenderObservable.add(() => updateRams(root, rams));
    root.onDisposeObservable.add(() => scene.onBeforeRenderObservable.remove(obs));
  }
}

function weaponDetail(scene: Scene, bin: DecoBin, rams: Ram[], root: Mesh, wm: Mesh, kind: WeaponKind, mats: Mats, wmm?: Mesh) {
  const H = CHASSIS.h / 2;
  const child = (suffix: string) => (wm.getChildMeshes(false) as Mesh[]).find(c => c.name.endsWith(suffix));
  const P = wm.position.clone();
  switch (kind) {
    case 'disc': case 'bar': case 'drum': {
      // spinning: hub boss + bolts (weapon local: disc / drum y = spin axis, bar x = spin axis)
      if (kind === 'disc') {
        cyl(bin, wm, mats.bolt, Vector3.Zero(), 'y', 0.2, 0.14, 20);
        for (const s of [-1, 1]) boltRing(bin, wm, mats.chrome, V(0, s * (0.07 + B), 0), 'y', 0.065, 6);
      } else if (kind === 'drum') {
        for (const s of [-1, 1]) { cyl(bin, wm, mats.dark, V(0, s * 0.6, 0), 'y', 0.45, 0.04, 20); boltRing(bin, wm, mats.bolt, V(0, s * (0.62 + B), 0), 'y', 0.15, 6); }
      } else {
        cyl(bin, wm, mats.bolt, Vector3.Zero(), 'x', 0.22, 0.16, 20);
        for (const s of [-1, 1]) boltRing(bin, wm, mats.chrome, V(s * (0.08 + B), 0, 0), 'x', 0.07, 6);
      }
      // chassis: weapon uprights + axle, belt from the weapon motor
      const halfW = kind === 'drum' ? 0.6 : 0.06;
      for (const sx of [-1, 1]) beam(bin, root, mats.dark, V(sx * (halfW + 0.04), H - 0.02, P.z - 0.32), V(sx * (halfW + 0.04), P.y, P.z), 0.03, 0.12);
      cyl(bin, root, mats.chrome, P, 'x', 0.05, 2 * (halfW + 0.07), 12);
      if (wmm) {
        const xb = -(halfW + 0.1), o = wmm.position;
        const p1 = V(xb, o.y + 0.17, o.z), p2 = V(xb, P.y, P.z);
        const canEnd = xb > o.x ? o.x + 0.15 : o.x - 0.15;
        const rel = (p: Vector3) => p.subtract(o);
        cyl(bin, wmm, mats.chrome, rel(V((canEnd + xb) / 2, p1.y, p1.z)), 'x', 0.025, Math.abs(xb - canEnd) + 0.03, 8);   // shaft
        cyl(bin, wmm, mats.bolt, rel(p1), 'x', 0.09, 0.035, 16);                               // motor pulley
        cyl(bin, wmm, mats.bolt, rel(p2), 'x', 0.15, 0.035, 20);                               // weapon pulley
        belt(bin, wmm, mats.rubber, rel(p1), 0.045, rel(p2), 0.075, 'x');
      }
      break;
    }
    case 'h_bar': case 'h_disc': case 'undercutter': {
      const g = H_SPIN[kind];
      cyl(bin, wm, mats.bolt, Vector3.Zero(), 'y', 0.2, g.thick + 0.06, 20);
      boltRing(bin, wm, mats.chrome, V(0, g.thick / 2 + 0.03 + B, 0), 'y', 0.065, 6);
      const yb = H + 0.235;                                                                       // belt plane, level with the pancake motor's pulley
      cyl(bin, root, mats.chrome, V(0, (P.y + yb + 0.02) / 2, P.z), 'y', 0.05, yb + 0.02 - P.y, 12);   // weapon shaft
      beam(bin, root, mats.dark, V(0, yb - 0.075, P.z - 0.38), V(0, yb - 0.075, P.z + 0.05), 0.16, 0.05);   // top bearing arm
      if (wmm) {
        const o = wmm.position, rel = (p: Vector3) => p.subtract(o);
        const p1 = V(o.x, yb, o.z), p2 = V(P.x, yb, P.z);
        cyl(bin, wmm, mats.bolt, rel(p1), 'y', 0.09, 0.035, 16);
        cyl(bin, wmm, mats.bolt, rel(p2), 'y', 0.14, 0.035, 20);
        belt(bin, wmm, mats.rubber, rel(p1), 0.045, rel(p2), 0.07, 'y');
      }
      break;
    }
    case 'shell':
      cyl(bin, wm, mats.bolt, V(0, FBS.shell.h / 2 + 0.015, 0), 'y', 0.4, 0.03, 24);
      boltRing(bin, wm, mats.chrome, V(0, FBS.shell.h / 2 + 0.03 + B, 0), 'y', 0.15, 8);
      boltRing(bin, wm, mats.bolt, V(0, FBS.shell.h / 2 + B, 0), 'y', 0.86, 16);
      break;
    case 'cage':
      cyl(bin, wm, mats.bolt, Vector3.Zero(), 'y', 0.3, 0.08, 20);
      for (let i = 0; i < 3; i++) { const t = (i / 3) * Math.PI * 2; beam(bin, wm, mats.dark, Vector3.Zero(), V(Math.cos(t) * 0.88, 0, Math.sin(t) * 0.88), 0.06, 0.05); }
      break;
    case 'hammer': case 'saw': case 'hammer_saw': {
      const pv = ARM.pivot;
      for (const sx of [-1, 1]) box(bin, root, mats.dark, V(sx * 0.085, (H + pv.y) / 2 + 0.02, 0), 0.03, pv.y - H + 0.1, 0.18);   // pivot cheeks
      cyl(bin, root, mats.chrome, pv, 'x', 0.05, 0.22, 12);                                       // pivot axle
      const bar = child('_arm'), head = child('_head'), saw = child('_saw');
      if (bar) cyl(bin, bar, mats.chrome, V(0, 0.45 - ARM.len / 2, 0), 'x', 0.03, 0.32, 10);   // ram pin
      if (head) {
        const hw = kind === 'hammer' ? 0.175 : 0.125, hh = kind === 'hammer' ? 0.15 : 0.11;
        for (const sx of [-1, 1]) boltFrame(bin, head, mats.bolt, V(sx * (hw + B), 0, 0), V(0, hh, 0), V(0, 0, hh), 'x', 0.045, 0.5);
      }
      if (saw) { cyl(bin, saw, mats.bolt, Vector3.Zero(), 'y', 0.12, 0.1, 16); for (const s of [-1, 1]) boltRing(bin, saw, mats.chrome, V(0, s * (0.05 + B), 0), 'y', 0.04, 5); }
      for (const sx of [-1, 1]) addRam(scene, root, mats, rams, V(sx * 0.13, H + 0.02, 0.45), wm, V(sx * 0.13, 0.45, 0));
      break;
    }
    case 'pneumatic_flipper': case 'electric_flipper': {
      const plate = child('_flipper'), flat = child('_flat'), lip = child('_lip');
      for (const x of [-0.45, 0, 0.45]) cyl(bin, root, mats.chrome, V(x, FLIP.hinge.y, FLIP.hinge.z - 0.03), 'x', 0.06, 0.2, 12);   // hinge knuckles
      if (flat) { const fl = CHASSIS.d / 2 - FLIP.hinge.z; boltLine(bin, flat, mats.bolt, V(-FLIP.width / 2 + 0.08, FLIP.thick / 2 + B, -fl / 2 + 0.1), V(FLIP.width / 2 - 0.08, FLIP.thick / 2 + B, -fl / 2 + 0.1), 0.2, 'y'); }
      if (lip) boltLine(bin, lip, mats.bolt, V(-FLIP.width / 2 + 0.08, FLIP.thick / 2 + B, -FLIP.lipLen / 2 + 0.06), V(FLIP.width / 2 - 0.08, FLIP.thick / 2 + B, -FLIP.lipLen / 2 + 0.06), 0.2, 'y');
      if (plate) for (const sx of [-0.35, 0.35]) addRam(scene, root, mats, rams, V(sx, -0.05, -0.3), plate, V(sx, -0.03, 0.5), 0.05, 0.32);
      break;
    }
    case 'lifter': case 'grappler': case 'crusher': {
      const F = CONTROL.fork;
      const fork = child('_fork'), plate = child(kind === 'crusher' ? '_fixed' : '_forkplate');
      if (plate) boltLine(bin, plate, mats.bolt, V(-F.width / 2 + 0.08, F.thick / 2 + B, -F.len / 2 + 0.06), V(F.width / 2 - 0.08, F.thick / 2 + B, -F.len / 2 + 0.06), 0.2, 'y');
      if (fork) for (const sx of [-0.3, 0.3]) addRam(scene, root, mats, rams, V(sx, -0.05, 0.45), fork, V(sx, -0.18, 0.26));
      if (kind !== 'lifter') {
        const J = kind === 'grappler' ? CONTROL.jaw : CONTROL.beak, role = kind === 'grappler' ? 'jaw' : 'beak';
        const jaw = child(`_${role}`), arm = child(`_${role}arm`);
        const xr = kind === 'grappler' ? 0.17 : 0.13, zA = kind === 'grappler' ? 0.62 : 0.35, zB = kind === 'grappler' ? 0.5 : 0.55;
        cyl(bin, root, mats.chrome, J.hinge, 'x', 0.06, J.width + 0.1, 12);                     // hinge pin
        if (arm) cyl(bin, arm, mats.chrome, V(0, 0, zB - J.len / 2), 'x', 0.03, 2 * xr + 0.06, 10);   // ram pin
        if (jaw) for (const s of [-1, 1]) addRam(scene, root, mats, rams, V(s * xr, H + 0.02, zA), jaw, V(s * xr, 0, zB));
      }
      break;
    }
  }
}
