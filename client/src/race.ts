/**
 * v0.33 RACE MODE (user): a go-kart style track for the bots. 4 bots (you + 3 AI), 3 laps, weapons on -- the
 * finish line decides the race. Wrecked (KO) or off the track = back at the last checkpoint after RACE.respawnMs,
 * fully repaired.
 *
 * The track is its own floor far from the arena (RACE_ORIGIN), same driving-surface physics as the arena
 * (floor friction 0.8, SURFACE_BIT so the wheel treads roll on it). One circuit, ~160 m a lap:
 *   1 start / finish straight (walled)        4 S-bends
 *   2 banked 180 turn (smooth mesh surface)   5 hazard alley: kill saws + arena hammer (scripted hazards)
 *   3 ramp + jump over a pit                  6 hairpin, back onto the straight
 *
 * Coordinates: the centre line is built "turtle" style in local (x, z) from segments, sampled every SAMPLE m.
 * heading h: direction (cos h, sin h) in (x, z); +turns increase h. u = sideways offset, + = left (n(h)).
 * Track distance s is measured from the finish line. A racer's progress (prog) is unwrapped: lap = prog / length.
 */
import {
  Color3, Constants, GlowLayer, Mesh, MeshBuilder, PhysicsAggregate, PhysicsBody, PhysicsMotionType, PhysicsShapeBox, PhysicsShapeContainer,
  PhysicsShapeType, Quaternion, Scene, StandardMaterial, TransformNode, Vector3,
} from '@babylonjs/core';
import type { BotBuild, Catalog } from '../../src/core/types.js';
import { isDestroyed, isImmobilized } from '../../src/core/state.js';
import { SURFACE_BIT, WALL_BIT } from './arena.js';
import { buildBot, disposeBot, dropBot, forward, freezeBot, upVector, raceTurn, DRIVE, REST_Y, type Bot, type BotId } from './bot.js';
import { cubeKnockout, cubeSkinOf } from './cubes.js';
import { DIFFICULTY, type Difficulty } from './ai.js';
import { Raceway } from './raceway.js';
import { NightCity } from './city.js';
import type { Drive } from './input.js';
import type { Combat } from './combat.js';
import type { Fx } from './fx.js';

export const RACE_ORIGIN = new Vector3(0, 0, -260);   // Grand Prix (v0.35: each track has its own origin, TRACKS below)
export const RACE = {
  laps: 3,
  width: 7,              // road width, m
  wallH: 1.0,            // wall height above the road (v0.33b: 0.8 -> 1.0, fewer bots knocked over it)
  respawnMs: 2000,       // wrecked / off the track -> back at the last checkpoint after this
  stuckMs: 4000,         // v0.34 immobilized (drive destroyed) or barely moving this long -> back at the last checkpoint, repaired
  stuckSpeed: 0.5,       // m/s: slower than this (flat speed) counts as barely moving
  stuckRespawnMs: 500,   // stuck: short pause after the poof before the fresh bot appears
  // v0.34 stabilizer (race only): roll / pitch damping, plus an upright pull once tilted past freeDeg (more than the
  // 15 deg bank and the ~10 deg ramps, so it never fights the track). Big hits can still flip a bot.
  stabDamp: 4,           // 1/s: roll / pitch rate damping (yaw untouched: turning feels the same)
  stabPull: 25,          // rad/s^2 per rad of tilt past freeDeg
  stabFreeDeg: 20,
  // v0.34f arcade handling (race only, user OK'd non-realistic fixes). Only while the wheels are on the road.
  turnRate: 3.2,         // rad/s turn at full stick (already scaled down with speed in driveWheels)
  turnResp: 14,          // 1/s: how fast the turn rate follows the stick (and stops when it's let go)
  sideGrip: 10,          // 1/s: sideways sliding removed (karts go where they point; hits still shove for a moment)
  groundGap: 0.25,       // m: chassis this close to its rest height above the road = wheels down
  offTrackMs: 500,       // this long off the road (or over a wall) = off the track
  offTrackU: 0.6,        // m past the road edge (centre of the bot) before it counts as off -- i.e. beyond the wall (v0.33b: was 1.4, a bot
                         // knocked into the gap between the start straight and the hazard alley stayed there)
  fallY: -1.5,           // centre below this = fell into the pit / off the world
  look: 4,               // AI: look-ahead on the centre line, m (+ speed x lookPerMps)
  lookPerMps: 0.55,
};
const SAMPLE = 0.5;      // centre-line sample spacing, m

/** Jump straight (distances into the segment, m): ramp up, deck, GAP (pit), landing deck, ramp down. */
const JUMP = { up0: 3, up1: 9, top: 1.0, deck1: 10, gap1: 11.4, land: 0.6, down0: 13, down1: 18 };
/** Hazard alley (distances into the segment, m; u = sideways). */
const HAZ = {
  sawRows: [{ q: 3, phase: 0 }, { q: 10.5, phase: 1.2 }],
  sawU: [-2.2, 0, 2.2],
  sawPeriod: 2.4, sawUp: 1.0, sawWarn: 0.4,      // s: cycle, time up, warning glow before it rises
  sawR: 0.55, sawHitR: 0.95, sawDmg: 7, sawKick: 3.2, sawCooldown: 0.45,
  hammerQ: 6.8, hammerPivotU: -4.4, hammerTargetU: -1.1, hammerPeriod: 3.4, hammerWarn: 0.7, hammerSlam: 0.14,
  hammerHitR: 1.7, hammerDmg: 16, hammerShove: 2.6,
};

type Tag = 'start' | 'bank' | 'jump' | 'sbend' | 'hazard' | 'hairpin' | 'straight';
interface Seg { tag: Tag; len?: number; r?: number; deg?: number; sign?: 1 | -1 }
export interface Sample { x: number; z: number; h: number; s: number; tag: Tag; q: number; bank: number; arcR: number; arcSign: number }

const XE = 30;                                            // x where the start straight ends (bank begins)
// v0.33c S-bends: +th then -th shifts the road 2r(1 - cos th) = 10 m sideways (v0.33 used +th, -2th, +th: a chicane with
// NO sideways shift, so the loop didn't close -- the hairpin came out 10 m off the start straight and left a dead-end channel)
const SB = { r: 7, theta: Math.acos(1 - 10 / 14) };
const START_LEN = 20 + 2 * SB.r * Math.sin(SB.theta) + 14;   // closes the loop

/** v0.35 race tracks. Each one is its own floor far from the others (origin), built once at load; the race picks one. */
export type TrackId = 'gp' | 'oval';
export interface TrackTheme {
  sky: [string, string] | null;   // sky dome colours (top, horizon); null = the black night of the arena
  hemi: number; sun: number;      // light intensities while racing here
  fog?: { color: string; density: number };   // v0.36 exp2 fog (rain haze)
}
/** v0.36 wet track (Night City): rain everywhere except the dry stretches, wetter patches. Traction (accelerating,
 *  braking) is never touched -- only sideways grip, so a bot slides wide but launches like on the dry. */
export interface WetDef {
  rainGrip: number; patchGrip: number;     // x the track's sideGrip
  rainSlide: number; patchSlide: number;   // 1/s: how fast a sideways slide dies out (lower = longer slide)
  dry: [number, number][];                 // track s ranges under cover (the tunnel)
  patches: { s0: number; s1: number; u: number; w: number }[];   // wet patches: s range, centre offset, width
}
export type WetKind = 'dry' | 'rain' | 'patch';
export interface TrackDef {
  id: TrackId; name: string; desc: string;
  origin: Vector3;
  width: number;                  // road width, m
  bankDeg: number;                // banked turns: full bank angle
  segs: Seg[];
  startX: number;                 // local x where the first segment starts (z = 0, heading +x)
  finishS: number;                // distance into the first segment of the finish line
  friction: number;               // road friction
  sideGrip: number;               // arcade sideways grip, 1/s (RACE.sideGrip on the Grand Prix)
  draft: boolean;                 // slipstream boost behind another bot
  aiCorner: number;               // AI throttle cap going into a corner
  theme: TrackTheme;
  look: 'neon' | 'raceway' | 'city';   // walls / edges / ground style (v0.36 city = Night City)
  wet?: WetDef;                   // v0.36
  par: number;                    // v0.38 cube currency: par race time (3 laps), s, at the tester settings (drive boost x3, race speed x3)
}
const OVAL = { straight: 44, r: 16 };
// v0.38 par times (3 laps, tester settings): estimates from sandbox autopilot laps (Flip Side ~10 m/s round the Grand Prix,
// ~12.5 m/s round the Oval; 146.5 m / 188.5 m a lap). The sandbox only manages ~3 fps, so tune these after a real playtest.
const PAR_GP = 45, PAR_OVAL = 45;
/** v0.36 Night City tunnel over the start straight (local x range; dry inside, roof collider). */
export const CITY_TUNNEL = { x0: 7, x1: 25, roof: 4.6, halfW: 4.4 };
export const TRACKS: Record<TrackId, TrackDef> = {
  gp: {
    // v0.36 (user): Night City theme -- rain, night, neon, streetlights, a dry tunnel, slippery wet patches
    id: 'gp', name: 'Night City Grand Prix', desc: 'Rain + wet patches (you slide wide) · dry tunnel · banked turn · ramp jump over a pit · kill saws · hammer · hairpin',
    origin: RACE_ORIGIN, width: 7, bankDeg: 15,
    segs: [
      { tag: 'start', len: START_LEN },
      { tag: 'bank', r: 10, deg: 180, sign: 1 },
      { tag: 'jump', len: 20 },
      { tag: 'sbend', r: SB.r, deg: SB.theta * 180 / Math.PI, sign: 1 },
      { tag: 'sbend', r: SB.r, deg: SB.theta * 180 / Math.PI, sign: -1 },
      { tag: 'hazard', len: 14 },
      { tag: 'hairpin', r: 5, deg: 180, sign: 1 },
    ],
    startX: XE - START_LEN, finishS: START_LEN - XE,
    friction: 0.8, sideGrip: 10, draft: false, aiCorner: 0.6, par: PAR_GP,
    theme: { sky: ['#05030c', '#2b1636'], hemi: 0.3, sun: 0.5, fog: { color: '#1a1226', density: 0.0055 } }, look: 'city',
    wet: {
      rainGrip: 0.6, patchGrip: 0.05, rainSlide: 5, patchSlide: 0.6,
      dry: [[CITY_TUNNEL.x0, CITY_TUNNEL.x1]],   // start straight: track s = x
      patches: [
        { s0: 26.5, s1: 29.5, u: 1.4, w: 3.6 },    // tunnel exit, into the banked turn
        { s0: 41, s1: 50, u: 0, w: 4 },            // middle of the banked turn
        { s0: 86, s1: 94, u: 0, w: 4.4 },          // S-bends
        { s0: 114, s1: 120, u: -1.4, w: 3.6 },     // hairpin, outside line (take the inside to miss it)
      ],
    },
  },
  // v0.35 (user): wide banked oval, raceway look (asphalt, kerbs, grandstands, pit wall, checkered gantry), daytime;
  // high grip + slipstream boost. Props in the Neon Energy cube look.
  oval: {
    id: 'oval', name: 'Oval Speedway', desc: 'Wide banked oval · high grip · tuck in behind a bot for a slipstream boost',
    origin: new Vector3(260, 0, -260), width: 10, bankDeg: 18,
    segs: [
      { tag: 'start', len: OVAL.straight },
      { tag: 'bank', r: OVAL.r, deg: 180, sign: 1 },
      { tag: 'straight', len: OVAL.straight },
      { tag: 'bank', r: OVAL.r, deg: 180, sign: 1 },
    ],
    startX: -OVAL.straight / 2, finishS: OVAL.straight / 2,
    friction: 1.0, sideGrip: 16, draft: true, aiCorner: 0.85, par: PAR_OVAL,
    theme: { sky: ['#0b2a4a', '#6f9cc4'], hemi: 0.85, sun: 1.5 }, look: 'raceway',
  },
};
export const TRACK_IDS = Object.keys(TRACKS) as TrackId[];
/** v0.35 slipstream: right behind another bot (in its wake) = extra push forward, up to a bit faster than it. */
const DRAFT = { min: 1.2, range: 9, side: 1.1, minSpeed: 3, accel: 4.5, over: 1.3, overAdd: 1.5 };

const nrm = (h: number) => ({ x: -Math.sin(h), z: Math.cos(h) });   // left normal

/** Bank angle along a banked turn (rad): eases in over the first 40 deg, out over the last 40. */
function bankAt(phiDeg: number, totalDeg: number, bankDeg: number) {
  const ease = (t: number) => t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
  const k = Math.min(ease(phiDeg / 40), ease((totalDeg - phiDeg) / 40));
  return k * bankDeg * Math.PI / 180;
}

/** Build the sampled centre line. */
function buildLine(def: TrackDef): { samples: Sample[]; length: number } {
  const out: Sample[] = [];
  let x = def.startX, z = 0, h = 0, s = 0;
  for (const g of def.segs) {
    if (g.len !== undefined) {
      const n = Math.round(g.len / SAMPLE);
      for (let i = 0; i < n; i++) {
        const q = i * g.len / n;
        out.push({ x: x + Math.cos(h) * q, z: z + Math.sin(h) * q, h, s: s + q, tag: g.tag, q, bank: 0, arcR: 0, arcSign: 0 });
      }
      x += Math.cos(h) * g.len; z += Math.sin(h) * g.len; s += g.len;
    } else {
      const r = g.r!, sg = g.sign!, tot = g.deg! * Math.PI / 180, len = r * tot;
      const n0 = nrm(h), cx = x + sg * r * n0.x, cz = z + sg * r * n0.z;
      const n = Math.round(len / SAMPLE);
      for (let i = 0; i < n; i++) {
        const phi = i * tot / n, hh = h + sg * phi, nn = nrm(hh);
        out.push({ x: cx - sg * r * nn.x, z: cz - sg * r * nn.z, h: hh, s: s + phi * r, tag: g.tag, q: phi * r,
          bank: g.tag === 'bank' ? bankAt(phi * 180 / Math.PI, g.deg!, def.bankDeg) : 0, arcR: r, arcSign: sg });
      }
      h += sg * tot; const ne = nrm(h);
      x = cx - sg * r * ne.x; z = cz - sg * r * ne.z; s += len;
    }
  }
  if (Math.hypot(x - def.startX, z) > 0.05) throw new Error(`race track ${def.id} does not close (${x.toFixed(2)}, ${z.toFixed(2)})`);
  for (const p of out) p.s = (p.s - def.finishS + s) % s;
  // re-order so sample 0 is at the finish line
  out.sort((a, b) => a.s - b.s);
  return { samples: out, length: s };
}

export interface Racer {
  slot: number;
  id: BotId;
  human: boolean;
  build: BotBuild;
  name: string;
  paint: string;
  bot: Bot;
  prog: number;          // unwrapped track distance, m (laps x length + s)
  idx: number;           // nearest centre-line sample
  u: number;             // sideways offset from the centre line, m
  lapStart: number;      // race time this lap began
  lapsDone: number;      // laps counted (driving back over the line and forward again doesn't count twice)
  lapTimes: number[];
  finished?: number;     // race time at the line (laps done)
  down?: { at: number; why: 'ko' | 'off' | 'stuck' };   // wrecked: respawns RACE.respawnMs after `at` (stuck: RACE.stuckRespawnMs)
  offSince?: number;
  stuckSince?: number;   // v0.34 immobilized / barely moving since
  draft?: number;        // v0.35 in a slipstream: the flat speed of the bot ahead (undefined = not drafting)
  wet?: WetKind;         // v0.36 what's under it (Night City): dry / rain / a wet patch
  wrecks: { ko: number; off: number; stuck: number };
  ai: { stuckT: number; escapeT: number; escapeTurn: number; nextThink: number; last: Drive; brawler: boolean };   // v0.34 brawler: leans into rivals
}

export interface RaceHooks {
  /** a racer's bot was (re)built: shadows + Cube Bots skin */
  onSpawn: (b: Bot) => void;
  sign: (text: string, ms: number, color: string) => void;
}

interface Saw { mesh: Mesh; slot: Mesh; pos: Vector3; row: number; up: boolean; last: Map<Bot, number> }

export class Race {
  readonly samples: Sample[];
  readonly length: number;
  private meshes: Mesh[] = [];
  private aggs: PhysicsAggregate[] = [];
  private wallBody: PhysicsBody | null = null;
  private wallNode: TransformNode;
  private mats: Record<string, StandardMaterial> = {};
  private saws: Saw[] = [];
  private hammer!: { pivot: TransformNode; ring: Mesh; target: Vector3; struck: boolean };
  private checkpoints: number[] = [];     // safe respawn distances (track s)
  readonly bounds: { x0: number; x1: number; z0: number; z1: number };

  racers: Racer[] = [];
  t = 0;                                  // race clock, s (runs from GO)
  running = false;
  private combat: Combat | null = null;
  private difficulty: Difficulty = 'normal';
  private catalog!: Catalog;
  private hooks!: RaceHooks;
  playerFinishedAt = -1;

  readonly def: TrackDef;
  private raceway: Raceway | null = null;
  private city: NightCity | null = null;
  /** v0.36 lightning flash 0..1 (main.ts adds it to the light) */
  get flash() { return this.city?.flash ?? 0; }
  get laps() { return RACE.laps; }
  readonly origin: Vector3;
  readonly width: number;
  private has = (tag: Tag) => this.samples.some(p => p.tag === tag);

  constructor(private scene: Scene, private fx: Fx, track: TrackId = 'gp') {
    this.def = TRACKS[track]; this.origin = this.def.origin; this.width = this.def.width;
    const line = buildLine(this.def);
    this.samples = line.samples; this.length = line.length;
    const xs = this.samples.map(p => p.x), zs = this.samples.map(p => p.z);
    const pad = this.width / 2 + (this.def.look === 'raceway' ? 16 : this.def.look === 'city' ? 9 : 5);   // v0.35 oval: room round the track for stands + pit lane
    this.bounds = { x0: Math.min(...xs) - pad, x1: Math.max(...xs) + pad, z0: Math.min(...zs) - pad, z1: Math.max(...zs) + pad };
    this.wallNode = new TransformNode('race_walls_' + track, scene);
    this.makeMats();
    this.buildFloor();
    this.buildRoad();
    this.buildBank();
    if (this.has('jump')) this.buildJump();
    this.buildWalls();
    this.buildMarkings();
    if (this.has('hazard')) this.buildHazards();
    if (track === 'gp') this.buildIsland();
    if (this.def.look === 'raceway') this.raceway = new Raceway(scene, this);   // v0.35b detailed scenery (raceway.ts)
    if (this.def.look === 'city') { this.buildTunnelRoof(); this.city = new NightCity(scene, this); }   // v0.36 (city.ts)
    this.pickCheckpoints();
    this.setVisible(false);
  }

  /** Debris floor for loose cubes (cubes.ts): the track's square footprint. */
  get debrisFloor() {
    const b = this.bounds, half = Math.max(b.x1 - b.x0, b.z1 - b.z0) / 2;
    return { cx: this.origin.x + (b.x0 + b.x1) / 2, cz: this.origin.z + (b.z0 + b.z1) / 2, half, wallH: 0 };
  }

  setVisible(on: boolean) {
    for (const m of this.meshes) m.setEnabled(on);
    this.hammer?.pivot.setEnabled(on);
    this.raceway?.setVisible(on);
    this.city?.setVisible(on);
  }

  // ------------------------------------------------------------------------------------------------- geometry
  private w(x: number, y: number, z: number) { return new Vector3(this.origin.x + x, this.origin.y + y, this.origin.z + z); }
  /** world point at sample p, sideways u, height y */
  private at(p: Sample, u: number, y = 0) { const n = nrm(p.h); return this.w(p.x + n.x * u, y, p.z + n.z * u); }
  private dir(h: number) { return new Vector3(Math.cos(h), 0, Math.sin(h)); }

  private makeMats() {
    const m = (name: string, hex: string, emissive: boolean, alpha = 1) => {
      const mat = new StandardMaterial('race_' + name, this.scene);
      const c = Color3.FromHexString(hex);
      if (emissive) { mat.disableLighting = true; mat.emissiveColor = c; }
      else { mat.diffuseColor = c; mat.specularColor = new Color3(0.18, 0.18, 0.2); }
      if (alpha < 1) { mat.alpha = alpha; }
      this.mats[name] = mat;
      return mat;
    };
    m('ground', '#050607', false); m('road', '#2a3036', false).backFaceCulling = false; m('bank', '#323a42', false).backFaceCulling = false; m('ramp', '#3b4650', false);
    m('edge', '#00e5ff', true); m('white', '#f2f2f2', true); m('black', '#0a0a0a', false); m('kerbR', '#d92b2b', false); m('kerbW', '#e8e8e8', false);
    m('yellow', '#ffc400', true); m('red', '#ff2a2a', true); m('pit', '#3a0000', true); m('steel', '#8d969e', false); m('slot', '#120404', false);
    m('hammer', '#5c6670', false); m('warn', '#ff3b1f', true); m('grid', '#0b3a44', true);
    // v0.35 raceway look (Oval Speedway): grass, asphalt, concrete, dark stands with Neon Energy cube trim + crowd
    m('grass', '#1d3a1b', false); m('asphalt', '#33373d', false).backFaceCulling = false; m('bankAsphalt', '#3a3f46', false).backFaceCulling = false;
    m('concrete', '#aeb4ba', false); m('stand', '#141a26', false); m('pitlane', '#2a2d33', false); m('garage', '#1b2130', false);
    m('cyan', '#4dd2ff', true); m('pink', '#ff2bd6', true); m('lime', '#39ff14', true); m('violet', '#b88cff', true); m('orange', '#ff9f1c', true);
    if (this.def.look === 'city') {   // v0.36 wet night asphalt: dark, glossy
      for (const k of ['road', 'bank', 'ramp', 'ground']) {
        const mm = this.mats[k];
        mm.diffuseColor = Color3.FromHexString(k === 'ground' ? '#16181d' : k === 'ramp' ? '#2b2f36' : '#1c1f25');
        mm.specularColor = new Color3(0.6, 0.58, 0.7); mm.specularPower = 120;   // tight wet highlights
      }
      this.mats.black.diffuseColor = Color3.FromHexString('#4a4e56');   // island = a concrete median
    }
    const glass = new StandardMaterial('race_glass', this.scene);
    glass.disableLighting = true; glass.alpha = 0.45; glass.alphaMode = Constants.ALPHA_ADD; glass.backFaceCulling = false;
    glass.emissiveColor = Color3.FromHexString('#00e5ff').scale(0.07);
    this.mats.glass = glass;
  }

  private keep(m: Mesh, mat?: string) { if (mat) m.material = this.mats[mat]; m.isPickable = false; this.meshes.push(m); return m; }

  /** Static box: surface = treads roll on it (floor-like), else a wall. */
  private slab(name: string, center: Vector3, x: Vector3, y: Vector3, z: Vector3, size: { w: number; h: number; d: number }, mat: string, surface: boolean, friction = 0.8) {
    const box = MeshBuilder.CreateBox('race_' + name, { width: size.w, height: size.h, depth: size.d }, this.scene);
    box.position = center;
    box.rotationQuaternion = Quaternion.RotationQuaternionFromAxis(x, y, z);
    box.receiveShadows = true;
    this.keep(box, mat);
    const agg = new PhysicsAggregate(box, PhysicsShapeType.BOX, { mass: 0, friction, restitution: 0.1 }, this.scene);
    agg.shape.filterMembershipMask = surface ? SURFACE_BIT : WALL_BIT;
    this.aggs.push(agg);
    return box;
  }

  /** Floor under everything, with the pit cut out under the jump gap. */
  private buildFloor() {
    const b = this.bounds, T = 0.5;
    const ground = this.def.look === 'raceway' ? 'grass' : 'ground';
    if (!this.has('jump')) {   // v0.35 no pit to cut out: one slab (v0.35b hidden: raceway.ts draws the ground)
      this.slab('floor', this.w((b.x0 + b.x1) / 2, -T / 2, (b.z0 + b.z1) / 2), Vector3.Right(), Vector3.Up(), Vector3.Forward(), { w: b.x1 - b.x0, h: T, d: b.z1 - b.z0 }, ground, true, this.def.friction).isVisible = this.def.look !== 'raceway';
      return;
    }
    const js = this.samples.filter(p => p.tag === 'jump');
    const g0 = js.find(p => p.q >= JUMP.deck1)!, g1 = js.find(p => p.q >= JUMP.gap1)!;
    // jump straight runs along -x at constant z (heading pi)
    const hx0 = Math.min(g0.x, g1.x), hx1 = Math.max(g0.x, g1.x), hz = g0.z, hw = this.width / 2 + 0.4;
    const rects = [
      [b.x0, hx0, b.z0, b.z1], [hx1, b.x1, b.z0, b.z1],
      [hx0, hx1, b.z0, hz - hw], [hx0, hx1, hz + hw, b.z1],
    ];
    for (const [x0, x1, z0, z1] of rects) {
      if (x1 - x0 < 0.01 || z1 - z0 < 0.01) continue;
      this.slab('floor', this.w((x0 + x1) / 2, -T / 2, (z0 + z1) / 2), Vector3.Right(), Vector3.Up(), Vector3.Forward(), { w: x1 - x0, h: T, d: z1 - z0 }, 'ground', true).receiveShadows = true;
    }
    // the pit: a glowing hole
    const pit = MeshBuilder.CreateBox('race_pit', { width: hx1 - hx0, height: 0.1, depth: hw * 2 }, this.scene);
    pit.position = this.w((hx0 + hx1) / 2, -4, hz);
    this.keep(pit, 'pit');
    if (this.def.look === 'city') return;   // v0.36 city: streets instead of the grid (city.ts)
    // faint floor grid round the track (visual)
    const lines: Mesh[] = [];
    for (let x = Math.ceil(b.x0 / 4) * 4; x <= b.x1; x += 4) lines.push(this.bar(this.w(x, 0.002, b.z0), this.w(x, 0.002, b.z1), 0.03));
    for (let z = Math.ceil(b.z0 / 4) * 4; z <= b.z1; z += 4) lines.push(this.bar(this.w(b.x0, 0.002, z), this.w(b.x1, 0.002, z), 0.03));
    this.merge(lines, 'race_floorgrid', 'grid');
  }

  /** Thin flat visual bar between two world points. */
  private bar(a: Vector3, b: Vector3, t: number, hgt = 0.01): Mesh {
    const box = MeshBuilder.CreateBox('race_bar', { width: t, height: hgt, depth: Math.max(0.01, Vector3.Distance(a, b)) }, this.scene);
    box.position = a.add(b).scale(0.5);
    box.lookAt(b);
    return box;
  }
  private merge(list: Mesh[], name: string, mat: string) {
    if (!list.length) return;
    const m = Mesh.MergeMeshes(list, true, true, undefined, false, false)!;
    m.name = name;
    this.keep(m, mat);
    return m;
  }

  /** Road surface (visual ribbon) everywhere except the bank and the jump structures (they're their own surface). */
  private buildRoad() {
    const runs: Sample[][] = [];
    let cur: Sample[] = [];
    const skip = (p: Sample) => p.tag === 'bank' || (p.tag === 'jump' && p.q > JUMP.up0 - 0.5 && p.q < JUMP.down1 + 0.5);
    for (const p of [...this.samples, this.samples[0]]) {
      if (skip(p)) { if (cur.length > 1) runs.push(cur); cur = []; } else cur.push(p);
    }
    if (cur.length > 1) runs.push(cur);
    const half = this.width / 2;
    for (const run of runs) {
      const L = run.map(p => this.at(p, half, 0.006)), R = run.map(p => this.at(p, -half, 0.006));
      // v0.35 raceway: paths the other way round so the surface faces up (lit asphalt); the Grand Prix keeps its dark road
      const rib = MeshBuilder.CreateRibbon('race_road', { pathArray: this.def.look === 'raceway' ? [L, R] : [R, L] }, this.scene);
      rib.receiveShadows = true;
      this.keep(rib, this.def.look === 'raceway' ? 'asphalt' : 'road');
    }
  }

  /** Banked turn: a smooth triangle-mesh surface (visual + collider), inner edge on the floor, outer edge up. */
  private buildBank() {
    for (const bs of this.runs('bank')) this.buildBankRun(bs);
  }
  /** v0.35 runs of consecutive samples with this tag (the oval has two banked turns). */
  private runs(tag: Tag): Sample[][] {
    const n = this.samples.length, out: Sample[][] = [];
    let i0 = this.samples.findIndex(p => p.tag !== tag);
    if (i0 < 0) return [this.samples];
    let cur: Sample[] = [];
    for (let k = 1; k <= n; k++) {
      const p = this.samples[(i0 + k) % n];
      if (p.tag === tag) cur.push(p); else if (cur.length) { out.push(cur); cur = []; }
    }
    if (cur.length) out.push(cur);
    return out;
  }
  private buildBankRun(bs: Sample[]) {
    const n = this.samples.length;
    const prev = this.samples[(this.samples.indexOf(bs[0]) - 1 + n) % n], next = this.samples[(this.samples.indexOf(bs[bs.length - 1]) + 1) % n];
    const rows = [prev, ...bs, next];
    const half = this.width / 2, cols = 7;
    const paths: Vector3[][] = [];
    for (let j = 0; j < cols; j++) {
      // u from the inner edge (+half: the bank turns left, so inside = +u) to the outer edge (-half) and a bit past
      const u = half + 0.4 - (j / (cols - 1)) * (this.width + 0.8);
      paths.push(rows.map(p => {
        const hgt = Math.max(0, half - u) * Math.tan(p.bank);
        return this.at(p, u, hgt + 0.006);
      }));
    }
    const rib = MeshBuilder.CreateRibbon('race_bank', { pathArray: paths }, this.scene);
    rib.receiveShadows = true;
    this.keep(rib, this.def.look === 'raceway' ? 'bankAsphalt' : 'bank');
    const agg = new PhysicsAggregate(rib, PhysicsShapeType.MESH, { mass: 0, friction: this.def.friction, restitution: 0.1 }, this.scene);
    agg.shape.filterMembershipMask = SURFACE_BIT;
    this.aggs.push(agg);
    // banking stripes (visual): lines along the turn every metre of width
    const lines: Mesh[] = [];
    const stripes = this.def.look === 'raceway' ? [] : this.def.look === 'city' ? [0] : [-1.75, 0, 1.75];   // v0.36 city: one centre line   // v0.35 raceway: plain asphalt (kerbs + lines in buildMarkings)
    for (const u of stripes) for (let i = 0; i < rows.length - 1; i += 2) {
      const a = rows[i], b = rows[Math.min(i + 2, rows.length - 1)];
      const ya = Math.max(0, half - u) * Math.tan(a.bank), yb = Math.max(0, half - u) * Math.tan(b.bank);
      lines.push(this.bar(this.at(a, u, ya + 0.02), this.at(b, u, yb + 0.02), 0.05));
    }
    this.merge(lines, 'race_banklines', 'grid');
  }

  /** Bank surface height at a sample and sideways offset (0 off the bank). */
  surfaceY(p: Sample, u: number) {
    if (p.tag === 'bank') return Math.max(0, this.width / 2 - u) * Math.tan(p.bank);
    if (p.tag === 'jump') {
      const q = p.q;
      if (q >= JUMP.up0 && q <= JUMP.up1) return JUMP.top * (q - JUMP.up0) / (JUMP.up1 - JUMP.up0);
      if (q > JUMP.up1 && q <= JUMP.deck1) return JUMP.top;
      if (q >= JUMP.gap1 && q <= JUMP.down0) return JUMP.land;
      if (q > JUMP.down0 && q <= JUMP.down1) return JUMP.land * (1 - (q - JUMP.down0) / (JUMP.down1 - JUMP.down0));
    }
    return 0;
  }

  /** Ramp up, take-off deck, pit gap, landing deck, ramp down. */
  private buildJump() {
    const js = this.samples.filter(p => p.tag === 'jump');
    const p0 = js[0];
    const t = this.dir(p0.h), n3 = (() => { const n = nrm(p0.h); return new Vector3(n.x, 0, n.z); })();
    const pt = (q: number, y: number) => this.w(p0.x + Math.cos(p0.h) * q, y, p0.z + Math.sin(p0.h) * q);
    const W = this.width + 0.2, T = 0.3;
    const ramp = (name: string, qa: number, ya: number, qb: number, yb: number) => {
      const A = pt(qa, ya), B = pt(qb, yb);
      const z = B.subtract(A).normalize();
      const y = Vector3.Up().subtract(z.scale(Vector3.Dot(Vector3.Up(), z))).normalize();
      const x = Vector3.Cross(y, z);
      const c = A.add(B).scale(0.5).subtract(y.scale(T / 2));
      this.slab(name, c, x, y, z, { w: W, h: T, d: Vector3.Distance(A, B) + 0.05 }, 'ramp', true);
    };
    const block = (name: string, qa: number, qb: number, hgt: number) => {
      const c = pt((qa + qb) / 2, hgt / 2);
      this.slab(name, c, Vector3.Cross(Vector3.Up(), t), Vector3.Up(), t, { w: W, h: hgt, d: qb - qa }, 'ramp', true);
    };
    ramp('rampup', JUMP.up0, 0, JUMP.up1, JUMP.top);
    block('deck', JUMP.up1, JUMP.deck1, JUMP.top);
    block('landing', JUMP.gap1, JUMP.down0, JUMP.land);
    ramp('rampdown', JUMP.down0, JUMP.land, JUMP.down1, 0);
    // hazard-yellow lips at the edge of the gap + chevrons on the ramp
    const lips: Mesh[] = [];
    const across = (q: number, y: number, th: number) => lips.push(this.bar(pt(q, y).add(n3.scale(W / 2)), pt(q, y).subtract(n3.scale(W / 2)), th, 0.02));
    across(JUMP.deck1 - 0.08, JUMP.top + 0.005, 0.16);
    across(JUMP.gap1 + 0.08, JUMP.land + 0.005, 0.16);
    for (let q = JUMP.up0 + 1; q < JUMP.up1; q += 1.5) across(q, JUMP.top * (q - JUMP.up0) / (JUMP.up1 - JUMP.up0) + 0.01, 0.08);
    this.merge(lips, 'race_lips', 'yellow');
    void T;
  }

  /** Glass walls both sides (one static body, many box children), neon strip on top. */
  private buildWalls() {
    const half = this.width / 2, th = 0.3;
    const shape = new PhysicsShapeContainer(this.scene);
    const vis: Mesh[] = [], tops: Mesh[] = [];
    const topAt = (p: Sample, side: number) => {
      let y = RACE.wallH;
      if (p.tag === 'bank' && side < 0) y += this.width * Math.tan(p.bank);           // outer wall of the bank: above the high edge
      if (p.tag === 'jump' && p.q > JUMP.up0 - 1 && p.q < JUMP.down1 + 1) y += JUMP.top;   // along the jump: above the decks
      return y;
    };
    for (const side of [1, -1]) {
      const step = 2;   // every 2 samples = 1 m
      for (let i = 0; i < this.samples.length; i += step) {
        const a = this.samples[i], b = this.samples[(i + step) % this.samples.length];
        const A = this.at(a, side * (half + th / 2)), B = this.at(b, side * (half + th / 2));
        const len = Vector3.Distance(A, B);
        if (len < 1e-3) continue;
        const hgt = Math.max(topAt(a, side), topAt(b, side));
        const z = B.subtract(A).normalize(), y = Vector3.Up(), x = Vector3.Cross(y, z);
        const c = A.add(B).scale(0.5); c.y = hgt / 2;
        const q = Quaternion.RotationQuaternionFromAxis(x, y, z);
        const ext = new Vector3(th, hgt, len + 0.25);
        const child = new PhysicsShapeBox(c.subtract(this.origin), q, ext, this.scene);
        child.filterMembershipMask = WALL_BIT;
        child.material = { friction: 0.3, restitution: 0.4 };
        shape.addChild(child);
        const box = MeshBuilder.CreateBox('race_wallv', { width: th, height: hgt, depth: len + 0.02 }, this.scene);
        box.position = c; box.rotationQuaternion = q;
        vis.push(box);
        tops.push(this.bar(new Vector3(A.x, hgt + 0.01, A.z), new Vector3(B.x, hgt + 0.01, B.z), 0.06, 0.03));
      }
    }
    shape.filterMembershipMask = WALL_BIT;
    this.wallNode.position = this.origin.clone();
    const body = new PhysicsBody(this.wallNode, PhysicsMotionType.STATIC, false, this.scene);
    body.shape = shape;
    this.wallBody = body;
    const raceway = this.def.look === 'raceway';   // v0.35 raceway: concrete barriers, yellow top strip
    this.merge(vis, 'race_walls_glass', raceway ? 'concrete' : 'glass');
    this.merge(tops, 'race_walls_top', raceway ? 'yellow' : 'edge');
  }

  /** Finish line, start grid boxes, kerbs on the inside of the turns, road edge lines. */
  private buildMarkings() {
    const half = this.width / 2;
    const f = this.samples[0];
    const t = this.dir(f.h);
    // checkered finish line
    const blacks: Mesh[] = [], whites: Mesh[] = [];
    const nChk = Math.round(this.width / 0.5);   // v0.35 any road width
    for (let row = 0; row < 2; row++) for (let i = 0; i < nChk; i++) {
      const u0 = -half + i * 0.5, c = this.at(f, u0 + 0.25, 0.012).add(t.scale((row - 0.5) * 0.5));
      const sq = MeshBuilder.CreateBox('race_chk', { width: 0.5, height: 0.01, depth: 0.5 }, this.scene);
      sq.position = c; sq.rotation.y = Math.atan2(t.x, t.z);
      ((i + row) % 2 ? whites : blacks).push(sq);
    }
    this.merge(blacks, 'race_chk_b', 'black'); this.merge(whites, 'race_chk_w', 'white');
    // start grid boxes
    const grid: Mesh[] = [];
    for (const g of this.gridSpots()) {
      const n = new Vector3(-Math.sin(g.h), 0, Math.cos(g.h)), d = this.dir(g.h);
      const c = g.pos.clone(); c.y = 0.012;
      const corners = [c.add(n.scale(0.8)).add(d.scale(0.9)), c.subtract(n.scale(0.8)).add(d.scale(0.9)), c.subtract(n.scale(0.8)).subtract(d.scale(0.9))];
      grid.push(this.bar(corners[0], corners[1], 0.07), this.bar(corners[1], corners[2], 0.07));
      const other = c.add(n.scale(0.8)).subtract(d.scale(0.9));
      grid.push(this.bar(corners[0], other, 0.07));
    }
    this.merge(grid, 'race_grid', 'white');
    // road edge lines + kerbs (inside of turns)
    const edges: Mesh[] = [], kr: Mesh[] = [], kw: Mesh[] = [];
    // v0.35 raceway: white edge lines + kerbs on the banked turns too (laid on the bank surface)
    const raceway = this.def.look === 'raceway';
    const skipEdge = (p: Sample) => (p.tag === 'bank' && !raceway) || (p.tag === 'jump' && p.q > JUMP.up0 - 0.5 && p.q < JUMP.down1 + 0.5);
    const on = (p: Sample, u: number, y: number) => this.at(p, u, this.surfaceY(p, u) + y);
    for (let i = 0; i < this.samples.length; i += 2) {
      const a = this.samples[i], b = this.samples[(i + 2) % this.samples.length];
      for (const side of [1, -1]) {
        if (skipEdge(a) || skipEdge(b)) continue;
        edges.push(this.bar(on(a, side * (half - 0.15), 0.011), on(b, side * (half - 0.15), 0.011), 0.08));
      }
      if (a.arcSign && b.arcSign && (a.tag !== 'bank' || raceway)) {
        const inside = a.arcSign;   // +turn: inside is +u
        const k = this.bar(on(a, inside * (half - 0.45), 0.014), on(b, inside * (half - 0.45), 0.014), 0.5, 0.03);
        (Math.floor(i / 2) % 2 ? kr : kw).push(k);
      }
    }
    this.merge(edges, 'race_edges', raceway ? 'white' : 'edge');
    this.merge(kr, 'race_kerb_r', 'kerbR'); this.merge(kw, 'race_kerb_w', 'kerbW');
  }

  /** v0.33b: fill the narrow gap between the start straight and the hazard alley (it looked like a lane). */
  private buildIsland() {
    const al = this.samples.filter(p => p.tag === 'hazard'), st = this.samples.filter(p => p.tag === 'start');
    const x0 = Math.min(...st.map(p => p.x)), x1 = Math.max(...al.map(p => p.x));          // hairpin end -> end of the alley
    const zLo = st[0].z + this.width / 2 + 0.3, zHi = al[0].z - this.width / 2 - 0.3;      // between the two walls
    if (zHi - zLo < 0.2) return;
    const hgt = RACE.wallH;
    this.slab('island', this.w((x0 + x1) / 2, hgt / 2, (zLo + zHi) / 2), Vector3.Right(), Vector3.Up(), Vector3.Forward(), { w: x1 - x0, h: hgt, d: zHi - zLo }, 'black', false, 0.3);
    const top: Mesh[] = [];
    for (const z of [zLo + 0.05, zHi - 0.05]) top.push(this.bar(this.w(x0, hgt + 0.01, z), this.w(x1, hgt + 0.01, z), 0.05, 0.02));
    this.merge(top, 'race_island_top', 'grid');
  }

  /** Kill saws (pop up from floor slots) + an arena hammer that slams a marked circle. */
  private buildHazards() {
    const hs = this.samples.filter(p => p.tag === 'hazard');
    const at = (q: number) => hs.reduce((a, b) => Math.abs(b.q - q) < Math.abs(a.q - q) ? b : a);
    HAZ.sawRows.forEach((row, ri) => {
      const p = at(row.q);
      for (const u of HAZ.sawU) {
        const pos = this.at(p, u, 0);
        const slot = MeshBuilder.CreateBox('race_sawslot', { width: 0.16, height: 0.012, depth: HAZ.sawR * 2 + 0.3 }, this.scene);
        slot.position = pos.add(new Vector3(0, 0.013, 0)); slot.rotation.y = Math.atan2(Math.cos(p.h), Math.sin(p.h));
        this.keep(slot, 'slot');
        const saw = MeshBuilder.CreateCylinder('race_saw', { diameter: HAZ.sawR * 2, height: 0.05, tessellation: 18 }, this.scene);
        const ax = new Vector3(-Math.sin(p.h), 0, Math.cos(p.h)), tx = this.dir(p.h);   // disc axis sideways: the blade runs along the track
        saw.rotationQuaternion = Quaternion.RotationQuaternionFromAxis(tx, ax, Vector3.Cross(tx, ax));
        saw.position = pos.add(new Vector3(0, -HAZ.sawR - 0.2, 0));
        this.keep(saw, 'steel');
        this.saws.push({ mesh: saw, slot, pos, row: ri, up: false, last: new Map() });
      }
    });
    // hammer: pivot outside the wall, swings down onto the ring
    const p = at(HAZ.hammerQ);
    const pivotPos = this.at(p, HAZ.hammerPivotU, 1.2), target = this.at(p, HAZ.hammerTargetU, 0);
    const pivot = new TransformNode('race_hammer_pivot', this.scene);
    pivot.position = pivotPos;
    // local frame: z = along the track, x = from the pivot toward the target (sideways)
    const toT = target.subtract(pivotPos); toT.y = 0;
    const len = toT.length(); toT.normalize();
    pivot.rotationQuaternion = Quaternion.RotationQuaternionFromAxis(toT, Vector3.Up(), Vector3.Cross(toT, Vector3.Up()));
    const arm = MeshBuilder.CreateBox('race_hammer_arm', { width: len, height: 0.18, depth: 0.18 }, this.scene);
    arm.parent = pivot; arm.position.set(len / 2, 0, 0);
    this.keep(arm, 'hammer');
    const head = MeshBuilder.CreateBox('race_hammer_head', { width: 1.0, height: 0.7, depth: 1.0 }, this.scene);
    head.parent = pivot; head.position.set(len, -0.85, 0);
    this.keep(head, 'steel');
    const post = MeshBuilder.CreateCylinder('race_hammer_post', { diameter: 0.35, height: 1.2 }, this.scene);
    post.position = pivotPos.subtract(new Vector3(0, 0.6, 0));
    this.keep(post, 'hammer');
    const ring = MeshBuilder.CreateTorus('race_hammer_ring', { diameter: HAZ.hammerHitR * 2, thickness: 0.07, tessellation: 40 }, this.scene);
    ring.position = target.add(new Vector3(0, 0.02, 0));
    this.keep(ring, 'yellow');
    this.hammer = { pivot, ring, target, struck: false };
  }

  /** v0.36 Night City: the tunnel roof is solid (a bot launched up bounces off it). The rest of the tunnel is in city.ts. */
  private buildTunnelRoof() {
    const T = CITY_TUNNEL;
    this.slab('tunnelroof', this.w((T.x0 + T.x1) / 2, T.roof + 0.3, 0), Vector3.Right(), Vector3.Up(), Vector3.Forward(), { w: T.x1 - T.x0, h: 0.6, d: T.halfW * 2 }, 'ground', false, 0.3).isVisible = false;
  }

  /** v0.36 what's under a racer: dry (tunnel / no rain), rain, or a wet patch. */
  wetAt(s: number, u: number): WetKind {
    const W = this.def.wet;
    if (!W) return 'dry';
    for (const [a, b] of W.dry) if (s >= a && s <= b) return 'dry';
    for (const p of W.patches) if (s >= p.s0 && s <= p.s1 && Math.abs(u - p.u) <= p.w / 2) return 'patch';
    return 'rain';
  }

  private pickCheckpoints() {
    const L = this.length;
    if (this.def.id !== 'gp') {   // v0.35 no hazards: a checkpoint every ~10 m on the flat (never on a banked turn)
      const flat = this.samples.filter(p => p.tag !== 'bank');
      const cps: number[] = [];
      for (const p of flat) if (!cps.length || p.s - cps[cps.length - 1] >= 10) cps.push(p.s);
      this.checkpoints = cps.sort((a, b) => a - b);
      return;
    }
    const sOf = (tag: Tag, q: number) => this.samples.filter(p => p.tag === tag).reduce((a, b) => Math.abs(b.q - q) < Math.abs(a.q - q) ? b : a).s;
    this.checkpoints = [
      2, 14, XE - 3,                     // start straight (the finish line is at x = 0, the straight ends at x = XE)
      sOf('jump', 1), sOf('jump', 19.5),
      sOf('sbend', 0.5), sOf('hazard', 0.5), sOf('hazard', 13.5), sOf('hairpin', 0.5),
    ].map(s => ((s % L) + L) % L).sort((a, b) => a - b);
  }

  /** The four grid spots behind the line: 2 x 2. Slot 0-1 front row, 2-3 back row. */
  gridSpots(): { pos: Vector3; h: number }[] {
    const n = this.samples.length;
    const spot = (back: number, u: number) => {
      const p = this.samples[(n - Math.round(back / SAMPLE)) % n];
      return { pos: this.at(p, u, 0.6), h: p.h };
    };
    return [spot(3, 1.6), spot(3, -1.6), spot(7.5, 1.6), spot(7.5, -1.6)];
  }

  // ------------------------------------------------------------------------------------------------- race
  /** Build the four racers on the grid. Slot order: the player starts at the back. */
  begin(entries: { id: BotId; human: boolean; build: BotBuild }[], catalog: Catalog, combat: Combat, difficulty: Difficulty, hooks: RaceHooks, build: (r: Racer) => void = () => {}) {
    this.dispose();
    this.catalog = catalog; this.difficulty = difficulty; this.hooks = hooks; this.combat = combat;
    this.t = 0; this.running = false; this.playerFinishedAt = -1;
    const spots = this.gridSpots();
    const order = [...entries].sort((a, b) => Number(a.human) - Number(b.human));   // AI in front, player at the back
    this.racers = order.map((e, slot) => {
      const sp = slot === 3 ? spots[3] : spots[slot];
      const bot = buildBot(e.id, e.build, catalog, this.scene, sp.pos, Math.atan2(Math.cos(sp.h), Math.sin(sp.h)), { breakableWeapons: false });
      hooks.onSpawn(bot);
      const r: Racer = {
        slot, id: e.id, human: e.human, build: e.build, name: e.build.cosmetics.name, paint: e.build.cosmetics.paint ?? '#fff', bot,
        prog: -(slot < 2 ? 3 : 7.5), idx: 0, u: 0, lapStart: 0, lapsDone: 0, lapTimes: [], wrecks: { ko: 0, off: 0, stuck: 0 },
        ai: { stuckT: 0, escapeT: 0, escapeTurn: 1, nextThink: 0, last: { throttle: 0, turn: 0, fire: false }, brawler: false },
      };
      r.idx = this.nearestIdx(bot.root.position, -1);
      build(r);
      return r;
    });
    // v0.34 (user): two AI race first, one (random) leans into rivals like v0.33 did
    const ai = this.racers.filter(r => !r.human);
    if (ai.length) ai[Math.floor(Math.random() * ai.length)].ai.brawler = true;
  }

  bots(): Bot[] { return this.racers.map(r => r.bot); }
  player(): Racer | undefined { return this.racers.find(r => r.human); }

  dispose() {
    for (const r of this.racers) disposeBot(r.bot);
    this.racers = [];
  }

  /** Nearest centre-line sample: around `hint` (+-24 m) or everywhere (hint < 0). */
  private nearestIdx(pos: Vector3, hint: number): number {
    const n = this.samples.length, lx = pos.x - this.origin.x, lz = pos.z - this.origin.z;
    let best = 0, bd = Infinity;
    const span = hint < 0 ? n : Math.round(24 / SAMPLE);
    for (let k = -span; k <= span; k++) {
      const i = hint < 0 ? k + span : ((hint + k) % n + n) % n;
      if (i < 0 || i >= n) continue;
      const p = this.samples[i], d = (p.x - lx) ** 2 + (p.z - lz) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }

  /** Sample at track distance s (wrapped). */
  sampleAt(s: number): Sample {
    const n = this.samples.length, i = Math.round((((s % this.length) + this.length) % this.length) / this.length * n) % n;
    return this.samples[i];
  }

  /** Position of every racer, best first: finished (by time), then by progress. */
  standings(): Racer[] {
    return [...this.racers].sort((a, b) => {
      if (a.finished !== undefined || b.finished !== undefined) return (a.finished ?? Infinity) - (b.finished ?? Infinity);
      return b.prog - a.prog;
    });
  }
  lap(r: Racer) { return Math.min(RACE.laps, Math.max(1, Math.floor(r.prog / this.length) + 1)); }

  /** Every frame: progress + laps, off-track / KO -> respawn, hazards. go = racing (after GO!). */
  update(dt: number, now: number, go: boolean) {
    if (go) { if (!this.running) { this.running = true; for (const r of this.racers) r.lapStart = 0; } this.t += dt; }
    const L = this.length;
    for (const r of this.racers) {
      const b = r.bot;
      if (r.down) {
        if (now - r.down.at >= (r.down.why === 'stuck' ? RACE.stuckRespawnMs : RACE.respawnMs)) this.respawn(r);
        continue;
      }
      // progress along the centre line (window search round the last sample: no shortcuts across walls)
      const idx = this.nearestIdx(b.root.position, r.idx);
      const s0 = this.samples[r.idx].s, s1 = this.samples[idx].s;
      let ds = s1 - s0; if (ds > L / 2) ds -= L; if (ds < -L / 2) ds += L;
      r.idx = idx;
      r.prog += ds;
      const p = this.samples[idx], n = nrm(p.h);
      r.u = (b.root.position.x - this.origin.x - p.x) * n.x + (b.root.position.z - this.origin.z - p.z) * n.z;
      r.wet = this.wetAt(p.s, r.u);   // v0.36
      // lap line
      if (go && r.finished === undefined) {
        const lapsNow = Math.floor(r.prog / L);
        if (lapsNow > r.lapsDone && lapsNow >= 1) {
          r.lapsDone = lapsNow;
          r.lapTimes.push(this.t - r.lapStart); r.lapStart = this.t;
          if (lapsNow >= RACE.laps) {
            r.finished = this.t;
            if (r.human) this.playerFinishedAt = now;
            const pos = this.standings().indexOf(r) + 1;
            if (r.human) this.hooks.sign(`FINISHED — ${ordinal(pos)}!`, 2500, '#39ff14');
          } else if (r.human) this.hooks.sign(lapsNow === RACE.laps - 1 ? 'FINAL LAP!' : `LAP ${lapsNow + 1}`, 1300, '#ffc400');
        }
      }
      // KO (every part gone): wrecked
      if (isDestroyed(b.state)) { this.wreck(r, now, 'ko'); continue; }
      // off the track: fell (pit / over the edge) or knocked over a wall
      const off = b.root.position.y < RACE.fallY || Math.abs(r.u) > this.width / 2 + RACE.offTrackU;
      if (off) { r.offSince ??= now; if (now - r.offSince >= RACE.offTrackMs || b.root.position.y < RACE.fallY - 3) this.wreck(r, now, 'off'); }
      else r.offSince = undefined;
      // v0.34 immobilized (drive destroyed) or barely moving (upside down, wedged, pinned) for RACE.stuckMs: recovered
      if (go && r.finished === undefined) {
        const v = b.body.getLinearVelocity();
        if (isImmobilized(b.state) || Math.hypot(v.x, v.z) < RACE.stuckSpeed) {
          r.stuckSince ??= now;
          if (now - r.stuckSince >= RACE.stuckMs) this.wreck(r, now, 'stuck');
        } else r.stuckSince = undefined;
      } else r.stuckSince = undefined;
    }
    if (go) this.hazards(dt, now);
    else this.idleHazards(dt);
    this.findDrafts(go);
    this.raceway?.update(dt, go);   // v0.35b crowd, flags, blimp, start lights, jumbotron
    this.city?.update(dt, go);      // v0.36 rain, traffic, crowd, lightning, neon
  }

  /** v0.35 slipstream (tracks with draft on): who is right behind whom. The push itself is in beforePhysics. */
  private findDrafts(go: boolean) {
    for (const r of this.racers) r.draft = undefined;
    if (!this.def.draft || !go) return;
    for (const r of this.racers) {
      if (r.down || r.bot.eliminated || r.finished !== undefined) continue;
      const pos = r.bot.root.position, v = r.bot.body.getLinearVelocity();
      const fwd = forward(r.bot); fwd.y = 0;
      if (fwd.lengthSquared() < 1e-4) continue;
      fwd.normalize();
      if (Vector3.Dot(v, fwd) < DRAFT.minSpeed) continue;
      const right = Vector3.Cross(Vector3.Up(), fwd);
      for (const o of this.racers) {
        if (o === r || o.down || o.bot.eliminated) continue;
        const to = o.bot.root.position.subtract(pos); to.y = 0;
        const ahead = Vector3.Dot(fwd, to), side = Math.abs(Vector3.Dot(right, to));
        if (ahead < DRAFT.min || ahead > DRAFT.range || side > DRAFT.side) continue;
        const ov = o.bot.body.getLinearVelocity(), os = Math.hypot(ov.x, ov.z);
        if (os < DRAFT.minSpeed) continue;
        r.draft = Math.max(r.draft ?? 0, os);
      }
    }
  }

  /** Wrecked: blow it up, hide it, respawn later. */
  private wreck(r: Racer, now: number, why: 'ko' | 'off' | 'stuck') {
    const b = r.bot;
    r.down = { at: now, why }; r.offSince = undefined; r.stuckSince = undefined; r.wrecks[why]++;
    const pos = b.root.position.clone();
    if (cubeSkinOf(b.root)) { cubeKnockout(b, why === 'ko'); dropBot(b); }   // v0.38 towed / off: a poof, no cubes lost
    else { this.fx.explode(b, pos, why === 'ko' ? 'WRECKED!' : why === 'off' ? 'OFF!' : 'TOWED!'); freezeBot(b); }
    if (!b.eliminated) b.eliminated = { t: now, pos, vel: Vector3.Zero(), reason: why === 'off' ? 'out' : 'ko' };
    if (r.human) this.hooks.sign(why === 'ko' ? 'WRECKED! — BACK TO THE CHECKPOINT' : why === 'off' ? 'OFF THE TRACK!' : 'IMMOBILIZED — BACK TO THE CHECKPOINT', 1500, '#ff4d4d');
  }

  /** Back at the last checkpoint passed, a fresh bot (fully repaired). */
  private respawn(r: Racer) {
    const L = this.length;
    const lapBase = Math.floor(r.prog / L) * L, sNow = ((r.prog % L) + L) % L;
    let cp = [...this.checkpoints].reverse().find(c => c <= sNow);
    let prog: number;
    if (cp === undefined) { cp = this.checkpoints[this.checkpoints.length - 1]; prog = lapBase - L + cp; } else prog = lapBase + cp;
    if (r.prog < 0) { cp = 0; prog = -0.01; }
    const p = this.sampleAt(cp);
    // spread racers sideways so two respawns don't land on each other
    let u = (r.slot - 1.5) * 1.3;
    const pos = this.at(p, u, this.surfaceY(p, u) + 0.7);   // v0.35 on the road surface (banks / ramps), not the floor
    for (const o of this.racers) if (o !== r && !o.down && Vector3.Distance(o.bot.root.position, pos) < 1.6) { u = -u; break; }
    const old = r.bot;
    disposeBot(old);
    const bot = buildBot(r.id, r.build, this.catalog, this.scene, this.at(p, u, this.surfaceY(p, u) + 0.7), Math.atan2(Math.cos(p.h), Math.sin(p.h)), { breakableWeapons: false });
    this.hooks.onSpawn(bot);
    this.combat?.replaceBot(old, bot);
    if (bot.weapon.mode === 'spinner') bot.weapon.spinning = true;
    r.bot = bot; r.prog = prog; r.idx = this.nearestIdx(bot.root.position, -1); r.down = undefined; r.offSince = undefined; r.stuckSince = undefined;
    r.ai.stuckT = 0; r.ai.escapeT = 0;
  }

  // ------------------------------------------------------------------------------------------------- v0.34 race physics
  private spinPrev = new Map<Bot, number>();
  private latPrev = new Map<Bot, number>();   // v0.36 wet slide
  /** Every physics sub-step, before the step: stabilizer + note each spinner's speed. */
  beforePhysics(dt: number) {
    const free = Math.max(RACE.stabFreeDeg, this.def.bankDeg + 6) * Math.PI / 180;   // v0.35 never fights a steeper bank
    for (const r of this.racers) {
      const b = r.bot;
      if (r.down || b.eliminated) continue;
      if (b.spinner && b.spinner.parentBody === b.body) this.spinPrev.set(b, worldSpin(b.spinner));   // v0.34g
      if (b.inverted || b.rightingUntil) continue;            // upside down: the self-right handles it
      const up = upVector(b), tilt = Math.acos(Math.max(-1, Math.min(1, up.y)));
      if (tilt > Math.PI / 2) continue;
      const w = b.body.getAngularVelocity();
      let yaw = w.y;
      let wx = w.x * (1 - RACE.stabDamp * dt), wz = w.z * (1 - RACE.stabDamp * dt);
      if (tilt > free) {
        const ax = Vector3.Cross(up, Vector3.Up()); const n = ax.length();
        if (n > 1e-4) { const k = RACE.stabPull * (tilt - free) * dt / n; wx += ax.x * k; wz += ax.z * k; }
      }
      // v0.34f arcade handling: wheels on the road -> the stick sets the turn rate, sideways sliding is soaked up
      const arcade = DRIVE.raceArcade;
      const p = this.samples[r.idx];
      const grounded = arcade && up.y > 0.6 && b.root.position.y - this.origin.y - this.surfaceY(p, r.u) < REST_Y + RACE.groundGap;
      if (!grounded) this.latPrev.delete(b);   // v0.36 airborne / tipped: no slide carried over
      if (grounded) {
        const target = (raceTurn.get(b) ?? 0) * RACE.turnRate;
        yaw += (target - yaw) * Math.min(1, RACE.turnResp * dt);
        const q = b.root.rotationQuaternion ?? Quaternion.Identity();
        const right = new Vector3(1, 0, 0).applyRotationQuaternion(q); right.y = 0;
        if (right.lengthSquared() > 1e-4) {
          right.normalize();
          const v = b.body.getLinearVelocity();
          // v0.36 wet (Night City): less sideways grip, and a sideways slide carries on (the wheels' own friction would
          // stop it at once) -- dying out at rainSlide / patchSlide per second. Forward grip is never touched.
          const W = this.def.wet, wk = r.wet ?? 'dry';
          const lat = Vector3.Dot(v, right);
          let latOut = lat * (1 - Math.min(1, this.def.sideGrip * (W && wk !== 'dry' ? (wk === 'patch' ? W.patchGrip : W.rainGrip) : 1) * dt));
          const prev = this.latPrev.get(b);
          if (W && wk !== 'dry' && prev !== undefined && prev * lat >= 0) {
            const keep = prev * Math.exp(-(wk === 'patch' ? W.patchSlide : W.rainSlide) * dt);
            if (Math.abs(keep) > Math.abs(latOut)) latOut = keep;
          }
          // the sideways speed we leave it with (the wheels' friction eats it during the step; next step restores
          // what's left of the slide)
          if (W && wk !== 'dry') this.latPrev.set(b, latOut); else this.latPrev.delete(b);
          const dv = right.scale(lat - latOut);
          // v0.35 slipstream: a push forward while tucked in behind a bot, up to a bit faster than it
          if (r.draft !== undefined) {
            const f = Vector3.Cross(right, Vector3.Up());   // forward, flat
            if (Math.hypot(v.x, v.z) < r.draft * DRAFT.over + DRAFT.overAdd) dv.subtractInPlace(f.scale(DRAFT.accel * dt));
          }
          b.body.setLinearVelocity(v.subtract(dv));
          for (const wh of b.wheels ?? []) if (!wh.released) wh.body.setLinearVelocity(wh.body.getLinearVelocity().subtract(dv));
        }
      }
      b.body.setAngularVelocity(new Vector3(wx, yaw, wz));
    }
  }
  /** v0.34g: the spinner's own spin in the world about its axis (NOT relative to the chassis). Measuring it relative to
   *  the chassis counted every change to the chassis's yaw (countdown yaw lock, arcade steering) as spin-up, so the
   *  give-back below fed on itself: x ~6 per step with Shell Shock's heavy shell -> base at 400 rad/s, bot launched. */
  /** After the step: a spinner speeding up twists its chassis the other way (motor reaction); give that back
   *  (like a counter-rotating flywheel). Speed lost in a hit is not given back, so hits still push. */
  afterPhysics() {
    for (const r of this.racers) {
      const b = r.bot, s = b.spinner, prev = this.spinPrev.get(b);
      if (!s || prev === undefined || r.down || b.eliminated || s.parentBody !== b.body) continue;
      const w = worldSpin(s), dw = w - prev;
      if (dw <= 0 || w <= 0) continue;
      const axis = Vector3.TransformNormal(s.axis, s.parentNode.getWorldMatrix()).normalize();
      b.body.applyAngularImpulse(axis.scale(s.inertia * dw * s.dir));
    }
    this.spinPrev.clear();
  }

  // ------------------------------------------------------------------------------------------------- hazards
  private sawHeight(row: number): { y: number; warn: boolean; up: boolean } {
    const ph = ((this.t + HAZ.sawRows[row].phase) % HAZ.sawPeriod + HAZ.sawPeriod) % HAZ.sawPeriod;
    const rise = 0.12;
    let k = 0;
    if (ph < rise) k = ph / rise;
    else if (ph < HAZ.sawUp) k = 1;
    else if (ph < HAZ.sawUp + rise) k = 1 - (ph - HAZ.sawUp) / rise;
    const warn = ph > HAZ.sawPeriod - HAZ.sawWarn;
    return { y: -HAZ.sawR - 0.2 + k * (HAZ.sawR + 0.45), warn, up: k > 0.6 };
  }
  private idleHazards(dt: number) {
    for (const s of this.saws) { s.mesh.position.y = this.origin.y - HAZ.sawR - 0.2; s.slot.material = this.mats.slot; }
    if (this.hammer) this.setHammer(-1.75, false);
    void dt;
  }
  /** angle: 0 = head on the floor, more negative = raised. */
  private setHammer(angle: number, warn: boolean) {
    const h = this.hammer;
    h.pivot.rotationQuaternion = Quaternion.RotationQuaternionFromAxis(...this.hammerAxes()).multiply(Quaternion.RotationAxis(new Vector3(0, 0, 1), -angle));
    h.ring.material = warn ? this.mats.warn : this.mats.yellow;
  }
  private hammerAxes(): [Vector3, Vector3, Vector3] {
    const h = this.hammer, toT = h.target.subtract(h.pivot.position); toT.y = 0; toT.normalize();
    return [toT, Vector3.Up(), Vector3.Cross(toT, Vector3.Up())];
  }

  private hazards(dt: number, now: number) {
    const live = this.racers.filter(r => !r.down).map(r => r.bot);
    // kill saws
    for (const s of this.saws) {
      const st = this.sawHeight(s.row);
      s.mesh.position.y = this.origin.y + st.y;
      s.mesh.addRotation(0, 40 * dt, 0);
      s.slot.material = st.warn || st.up ? this.mats.warn : this.mats.slot;
      if (!st.up) continue;
      for (const b of live) {
        const p = b.root.position;
        if (Math.hypot(p.x - s.pos.x, p.z - s.pos.z) > HAZ.sawHitR || p.y > 1.2) continue;
        if (now - (s.last.get(b) ?? -1e9) < HAZ.sawCooldown * 1000) continue;
        s.last.set(b, now);
        this.combat?.environmentHit(b, new Vector3(s.pos.x, 0.25, s.pos.z), HAZ.sawDmg, '#ff7a1a');
        const m = b.body.getMassProperties().mass ?? 100;
        const side = new Vector3(Math.random() - 0.5, 0, Math.random() - 0.5).normalize().scale(1.2);
        b.body.applyImpulse(new Vector3(side.x, HAZ.sawKick, side.z).scale(m), b.body.getObjectCenterWorld().add(new Vector3(0.15, 0, 0.1)));
      }
    }
    if (!this.hammer) return;   // v0.35 tracks without the hammer
    // hammer: wind up, warn, slam, recover
    const ph = this.t % HAZ.hammerPeriod;
    const slamAt = HAZ.hammerPeriod - HAZ.hammerSlam - 0.5;
    let angle: number;
    if (ph < slamAt - HAZ.hammerWarn) angle = -1.75 + 0.2 * Math.min(1, ph / 0.8);   // slowly cocks back
    else if (ph < slamAt) angle = -1.55 - 0.25 * ((ph - (slamAt - HAZ.hammerWarn)) / HAZ.hammerWarn);
    else if (ph < slamAt + HAZ.hammerSlam) angle = -1.8 * (1 - (ph - slamAt) / HAZ.hammerSlam);
    else angle = -1.8 * Math.min(1, (ph - slamAt - HAZ.hammerSlam) / 0.5) * 0.97;
    const warn = ph >= slamAt - HAZ.hammerWarn && ph < slamAt + HAZ.hammerSlam;
    this.setHammer(angle, warn);
    if (ph >= slamAt + HAZ.hammerSlam * 0.85 && ph < slamAt + HAZ.hammerSlam + 0.3) {
      if (!this.hammer.struck) {
        this.hammer.struck = true;
        const T = this.hammer.target;
        for (const b of live) {
          const p = b.root.position;
          if (Math.hypot(p.x - T.x, p.z - T.z) > HAZ.hammerHitR || p.y > 1.6) continue;
          this.combat?.environmentHit(b, new Vector3(p.x, p.y + 0.3, p.z), HAZ.hammerDmg, '#ffc400');
          const m = b.body.getMassProperties().mass ?? 100;
          const away = p.subtract(this.hammer.pivot.position); away.y = 0; away.normalize();
          b.body.applyImpulse(new Vector3(away.x * HAZ.hammerShove, 1.6, away.z * HAZ.hammerShove).scale(m), b.body.getObjectCenterWorld().add(away.scale(0.3)));
          if (this.racers.find(r => r.bot === b)?.human) this.hooks.sign('HAMMERED!', 900, '#ffc400');
        }
        this.fx.bump(T);
      }
    } else this.hammer.struck = false;
  }

  // ------------------------------------------------------------------------------------------------- AI
  /** AI racer: follows the racing line (each racer its own lane), attacks anyone close in front, never forgets the line. */
  aiDrive(r: Racer, dt: number): Drive {
    const D = DIFFICULTY[this.difficulty], m = r.ai, self = r.bot;
    const now = performance.now();
    if (D.reactMs > 0 && now < m.nextThink) return m.last;
    m.nextThink = now + Math.min(D.reactMs, 120);
    const decide = (d: Drive): Drive => {
      const done = r.finished !== undefined;
      const out = { throttle: d.throttle * D.throttle * (done ? 0.5 : 1), turn: d.turn * D.turn, fire: d.fire && !done };
      m.last = out; return out;
    };
    const pos = self.root.position, v = self.body.getLinearVelocity(), speed = Math.hypot(v.x, v.z);
    const fwd = forward(self); fwd.y = 0; fwd.normalize();
    const w = self.weapon;

    // weapon: spinners stay on; others fire at a rival close in front
    let fire = false;
    let rival: Bot | undefined, rd = Infinity;
    let blocker: { bot: Bot; side: number; helpless: boolean } | undefined, bd = Infinity;
    const right = Vector3.Cross(Vector3.Up(), fwd);
    for (const o of this.racers) {
      if (o === r || o.down) continue;
      const to = o.bot.root.position.subtract(pos); to.y = 0;
      const d = to.length();
      if (d < 0.01) continue;
      if (d < rd && Vector3.Dot(fwd, to.scale(1 / d)) > 0.55) { rd = d; rival = o.bot; }
      // v0.33b racing first: a bot in our path just ahead is something to get past, not to chase
      const ahead = Vector3.Dot(fwd, to), side = Vector3.Dot(right, to);
      if (ahead > 0 && ahead < 3.5 && Math.abs(side) < 1.4 && d < bd) {
        const ov = o.bot.body.getLinearVelocity();
        bd = d; blocker = { bot: o.bot, side, helpless: !!o.bot.inverted || !!o.bot.rightingUntil || Math.hypot(ov.x, ov.z) < 0.4 };
      }
    }
    switch (w.mode) {
      case 'spinner': fire = !w.spinning; break;
      case 'strike': case 'flipper': {
        const onPlate = self.hinges?.some(h => h.touched) ?? false;
        fire = w.phase === 'ready' && w.refill <= 0 && (onPlate || rd < (w.mode === 'strike' ? 2.8 : 2.2)) && Math.random() >= D.whiff;
        break;
      }
      case 'hold': fire = rd < 2.0; break;
    }
    if (m.escapeT > 0) { m.escapeT -= Math.max(dt, D.reactMs / 1000); return decide({ throttle: -1, turn: m.escapeTurn, fire }); }

    // aim: centre line ahead, in this racer's lane (lanes narrow in the tight bits)
    const look = RACE.look + speed * RACE.lookPerMps;
    const ahead = this.sampleAt(r.prog + look);
    const tight = ahead.tag === 'hairpin' || ahead.tag === 'sbend' || ahead.tag === 'jump';
    let lane = (r.slot - 1.5) * (tight ? 0.4 : 1.1) * this.width / 7;   // v0.35 wider road = wider lanes
    // v0.33b racing first: steer round a bot in the way (the weapon fires anyway if it's in reach); only a helpless bot
    // (upside down / stopped) right in front gets rammed -- knocking it out of the race is worth a place.
    // NOTE (user, 2026-10-18): the v0.33 "lean into any rival" may come back -- it was funny. It was:
    //   if (rival && rd < 3.5 && w.mode !== 'none') aim = Vector3.Lerp(aim, rival.root.position, 0.4);
    let aim: Vector3;
    if (m.brawler) {   // v0.34: the brawler -- the v0.33 line: lean into any rival close in front
      aim = this.at(ahead, lane);
      if (rival && rd < 3.5 && w.mode !== 'none') aim = Vector3.Lerp(aim, rival.root.position, 0.4);
    } else if (blocker && blocker.helpless && w.mode !== 'none' && bd < 2.5) aim = blocker.bot.root.position.clone();
    else {
      const edge = this.width / 2 - 1.2;
      if (blocker) lane = Math.max(-edge, Math.min(edge, lane + (blocker.side >= 0 ? 2.0 : -2.0)));   // it's on our right -> pass on the left (+u = left)
      aim = this.at(ahead, lane);
    }
    const dir = aim.subtract(pos); dir.y = 0; dir.normalize();
    const angle = Math.atan2(Vector3.Cross(fwd, dir).y, Vector3.Dot(fwd, dir));
    const turn = Math.abs(angle) < 0.06 ? 0 : Math.sign(angle) * Math.min(1, Math.abs(angle) * 2.2 + 0.15);
    // slow for the corner coming up
    const far = this.sampleAt(r.prog + look + 6);
    let dh = far.h - this.sampleAt(r.prog).h; dh = Math.atan2(Math.sin(dh), Math.cos(dh));
    let throttle = Math.abs(angle) > 1.3 ? 0.15 : Math.abs(angle) > 0.7 ? 0.55 : 1;
    if (Math.abs(dh) > 1.0 && speed > 5) throttle = Math.min(throttle, this.def.aiCorner);   // v0.35 per track (oval: high grip)
    // the jump: straight and fast
    if (ahead.tag === 'jump' && Math.abs(angle) < 0.3) throttle = 1;

    // stuck: back off and turn
    if (throttle > 0.5 && speed < 0.35 && this.running) m.stuckT += Math.max(dt, D.reactMs / 1000); else m.stuckT = 0;
    if (m.stuckT > 0.9) { m.stuckT = 0; m.escapeT = 0.7; m.escapeTurn = Math.random() < 0.5 ? -1 : 1; }
    return decide({ throttle, turn, fire });
  }

  /** For the minimap: local (x, z) of the centre line. */
  outline(): { x: number; z: number }[] { return this.samples.filter((_, i) => i % 4 === 0).map(p => ({ x: p.x, z: p.z })); }
}

export function ordinal(n: number) { return n + (n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th'); }
export function fmtTime(t: number) {
  const m = Math.floor(t / 60), s = t - m * 60;
  return `${m}:${s < 10 ? '0' : ''}${s.toFixed(2)}`;
}
/** v0.34g: a spinner's spin about its own axis in the world, rad/s (see Race.afterPhysics). */
function worldSpin(s: NonNullable<Bot['spinner']>): number {
  const axis = Vector3.TransformNormal(s.axis, s.parentNode.getWorldMatrix()).normalize();
  return Vector3.Dot(s.body.getAngularVelocity(), axis) * s.dir;
}
