/// <reference types="vite/client" />
import './settings.js';   // v0.30: FIRST -- clears old saved settings once, before any module reads them
import {
  type AbstractMesh, ArcRotateCamera, Color3, Color4, DirectionalLight, Engine, HavokPlugin, HemisphericLight, Quaternion, Scene, Vector3,
} from '@babylonjs/core';
import HavokPhysics from '@babylonjs/havok';
import type { BotBuild } from '../../src/core/types.js';
import { canAttack, isDestroyed, isImmobilized } from '../../src/core/state.js';
import { catalog } from './catalog.js';
import { buildArena, WALL_H, ARENA_SIZE, ARENA_COLOURS, FLOOR_GRIDS, type ArenaStyle } from './arena.js';
import { buildBot, forward, upVector, driveSpinner, spinOmega, applyGyro, disposeBot, freezeBot, snapSpinner, driveArm, armBefore, armAfter, applyMagnets, driveFlipper, driveControl, hingesBefore, driveWheels, wheelsBefore, carryWheels, botMeshes, dropBot, DRIVE, type Bot, type BotId } from './bot.js';
import { applyEnvironment, castShadows, makeShadows } from './look.js';
import { setupPerf } from './perf.js';   // v0.44 FPS / triangles / draw calls readout
import { readDrive, isDown, KEYS, type Drive, padConnected, onPadButton, onPadChange, pressKey } from './input.js';   // v0.43 controller
import { Combat } from './combat.js';
import { Hud } from './hud.js';
import { Fx } from './fx.js';
import { Lab } from './lab.js';
import { skinBot, cubeKnockout, cubeSkinOf, setDebrisFloors, LOOT, clearLoot } from './cubes.js';
import { reward, payWallet, walletCubes, newTally, signed, dmgScore, REWARD, CUBE_ICON, type Tally, type Reward } from './econ.js';   // v0.38 cube currency
import { CamControl } from './cam.js';
import { Builder, PRESETS } from './builder.js';
import { Course, STATIONS, COURSE_ORIGIN, COURSE, type StationId, type RunResult } from './course.js';
import { aiDrive, type Difficulty } from './ai.js';
import { MOBILE, MobileMenu, setupTouchControls, goFullscreen, TOUCH, tapKey } from './mobile.js';
import { CUBES } from './cubes.js';
import { Upgrades } from './upgrades.js';   // v0.40 race upgrades (SCRAP meter)
import { Race, RACE, TRACK_IDS, ordinal, fmtTime, flatRacePhysics, raceSpinGiveBack, autoFireAt, type Racer, type TrackId } from './race.js';

const MATCH_SECONDS = 180;
/** v0.37 tester version: the page opens straight into a race. Track + car are picked on the start card and on the
 *  results screen.
 *  v0.46 (user): the main link (and npm run dev) always opens that race with the pickers; nothing on screen mentions the
 *  lab or the arena, but B (desktop) still opens the lab. ?lab=1 still opens the lab straight away. A race started from
 *  the lab's RACE button is a lab race (lab settings, no pickers, B back to the lab). */
const QS0 = new URLSearchParams(location.search);
// v0.39 (user): phones get the race only too (race + track / car pickers, no menu, no arena) -- ?mobile=1 tries it on the PC
const TESTER = QS0.get('lab') !== '1' || MOBILE;   // v0.46: the picker race is the start page everywhere (was: built site only)
/** Fixed tester settings (the user's own race settings, 2026-10-19): drive boost x3, race speed x3, AI Normal,
 *  Cube Bots look, Neon Energy cubes, 8-bit (big). Not saved, so they never change the lab's own settings. */
const TESTER_SET = { boost: 3, raceSpeed: 3, ai: 'normal' as Difficulty, track: 'oval' as TrackId | 'random', car: 'Flip Side' };
/** v0.41 phone (user: x3 is too hard on a phone): drive boost x2, race speed x2. Par stretches with the race speed (parFor). */
const PHONE_SET = { boost: 2, raceSpeed: 2 };
/** v0.41 phone: the race camera sits this much further back, and a bit higher (CHASE), so more of the track shows. */
const PHONE_CAM = { zoom: 1.5, maxBeta: 1.05 };
const TESTER_KEY = 'bb.tester.v1';   // last track + car picked, remembered in this browser
const RACE_TEST = { autopilot: false };
/** v0.49 BIG ARENA (user, 2026-10-19): a second BattleBox twice as wide (32 m, the original stays 16 m) with the race
 *  settings -- race speed + drive boost, race handling, cube currency + SCRAP upgrades -- and 4 bots (you + 3 AI), every
 *  bot for itself. Out = destroyed, out of the arena, or unable to drive / stuck upside down for stuckMs; no respawn.
 *  Last bot standing wins; at the clock, the survivor that took the least damage. On the TRACK picker as "Big Arena".
 *  v0.50 (user, 2026-10-19): a race to BIG.koGoal KOs -- every bot respawns BIG.goneMs after it goes out (the practice
 *  delay) with BIG.protectMs of spawn protection; at the clock, most KOs wins (tie: least damage taken). KO = wrecked, or
 *  out of the arena with a rival's hit in the last RACE.koCreditMs; stuck / driving out on its own credits nobody.
 *  Semi-transparent KO podium at the top of the screen.
 *  v0.51 (user): POINTS decide it -- damage (cubes knocked off rivals) + 25 per KO + rival cubes vacuumed + 25 per SCRAP
 *  box. 2:00 clock, most points wins (tie: least damage taken); optional target points (T: off/150/300/500, first to it
 *  wins). KO credit window 1 s. The podium shows points. AI bots never pick the same preset as you or each other. */
const BIG = {
  size: 32,                                  // m inner width (the original: ARENA_SIZE = 16)
  origin: new Vector3(-250, 0, 0),           // far from the arena (0,0), the course (0,200) and the tracks (z <= -260)
  seconds: 120,                              // v0.51 (user) 2:00 (was MATCH_SECONDS, 3:00)
  stuckMs: 4000,                             // can't drive (drive parts dead) or upside down this long = out
  sideGrip: 10,                              // race arcade grip (RACE.sideGrip)
  retargetMs: 2500,                          // AI: picks the nearest rival again this often
  speedLook: 0.3,                            // AI: wall look-ahead, s of its own speed (race speed is fast)
  resultsMs: 1500,                           // results card this long after you're out / the battle ends
  goneMs: 500,                               // v0.49b an out bot is deleted this long after it went out (its cubes stay as loot)
  // v0.51 (user): points decide it, not KOs (too many KOs happen by themselves) -- see pointsOf
  pts: { dmg: 1, ko: 25, vacuum: 1, box: 25 },   // per cube knocked off a rival / KO / rival cube vacuumed / SCRAP box
  koCreditMs: 1000,                          // v0.51 a rival's hit this recent = its KO (races keep RACE.koCreditMs, 2 s)
  targets: [0, 150, 300, 500],               // v0.51 T cycles the target (0 = off, the default): first to it wins
  protectMs: 2000,                           // v0.50 after a respawn: no damage this long (the bot blinks)
};
/** v0.51 Big Arena target points (T, test aid): 0 = off -- most points at the clock wins */
let bigTarget = 0;
/** v0.50 KO tracker podium colours, by place: 1st green, 2nd blue, 3rd yellow, 4th red */
const POD_COL = ['#39ff14', '#36a2ff', '#ffd23f', '#ff4d4d'];
const BIG_ID = 'bigarena';
type TrackPick = TrackId | 'random' | typeof BIG_ID;
/** v0.21: the drive is real wheels now -- see DRIVE / driveWheels in bot.ts. */
const PHYS_STEP = 1 / 60;
/** v0.31: spinner motor torque x this during the 3-2-1 (spin-up is sized for 3 s; the countdown is 2.7 s). */
const PRESPIN_BOOST = 1.5;
/** v0.21 physics sub-steps: each frame's physics runs in fixed 1/240 s steps. The real wheels hang the chassis'
 *  weight on axle joints; at one 1/60 s step per frame Havok let them sag 5-13 cm (headless), at 1/240 they hold. */
const SUB_STEP_MS = 1000 / 240;
/** OUT of the arena (v0.5): a bot is out once its centre is past a wall plane AND has dropped
 *  below the floor. Out = loss for that bot; first out loses. */
const OUT = {
  wallMargin: 0.3,     // metres past the inner wall face before "outside" counts
  belowFloor: -0.6,    // centre y below this = fully under the floor plate (floor top is y=0)
  camHoldMs: 1800,     // camera stays on the launched/exploded bot this long after the last sighting
  camLerp: 0.16,       // faster camera pull when following a flyer (normal is 0.08)
};

/** Upside-down + self-right (built-in srimech). A bot is INVERTED once its up-vector points mostly down
 *  and it has settled near the floor: no drive, weapon suppressed (defenseless) for selfRightMs, then a
 *  scripted hop + roll and the chassis is snapped back onto its wheels. */
const INVERT = {
  upDot: -0.35,        // up-vector . world-up below this = upside down (past ~110 deg of tilt). A bot on its
                       // side/end never rests there: the low centre of mass (bot.ts) rolls it to wheels or back.
  restVy: 0.6,         // |vertical speed| below this = settled
  restY: 1.2,          // centre height below this = on (or near) the floor
  selfRightMs: 1000,   // helpless this long, then self-right (v0.7: 1 s, was 2)
  flipperSelfRightMs: 3000,   // v0.12: flippers self-right with their own flipper (SPACE); the built-in one is only a backup
  hopUp: 3.2,          // m/s hop
  roll: 8,             // rad/s roll about the chassis forward axis during the hop
  snapMs: 420,         // after this long in the hop, snap upright (yaw kept)
};

async function main() {
  const canvas = document.getElementById('c') as HTMLCanvasElement;
  const engine = new Engine(canvas, true);
  if (MOBILE) { engine.setHardwareScalingLevel(1.5); CUBES.size = 'big'; }   // v0.32 phone: lower resolution, big cubes (not saved)

  // ---- Match scene (arena + physics) ----
  const scene = new Scene(engine);
  scene.clearColor = new Color4(0, 0, 0, 1);           // v0.18: black all around
  setupPerf(engine, scene);                           // v0.44 SETTINGS > PERF READOUT (or ?perf=1)
  const havok = await HavokPhysics();
  const havokPlugin = new HavokPlugin(true, havok);
  scene.enablePhysics(new Vector3(0, -9.81, 0), havokPlugin);

  const hemi = new HemisphericLight('hemi', new Vector3(0, 1, 0), scene);
  hemi.intensity = 0.5;
  const sun = new DirectionalLight('sun', new Vector3(-0.4, -1, 0.3), scene);
  sun.intensity = 1.1;
  sun.position = new Vector3(8, 20, -6);            // v0.16: shadows need a light position (opposite the direction)
  applyEnvironment(scene, 0.7);                     // v0.16: what the bots' metal reflects
  const shadows = makeShadows(sun);

  // Low broadcast camera
  const cam = new ArcRotateCamera('cam', -Math.PI / 2, 1.42, 16, new Vector3(0, 0.5, 0), scene);
  cam.lowerRadiusLimit = 8; cam.upperRadiusLimit = 30;
  cam.lowerBetaLimit = 1.1; cam.upperBetaLimit = 1.5;
  cam.attachControl(canvas, true);

  const arena = buildArena(scene);
  scene.getMeshByName('floor')!.receiveShadows = true;
  const bigBox = arena.addBox(BIG.size, BIG.origin, 'big');   // v0.49 Big Arena (hidden until it's picked)
  setupArenaPicker(arena.setStyle, canvas);          // v0.18: neon colour + floor grid (in-match, top right)
  // v0.8: real spinners spin at up to ~70 rad/s -- make sure Havok's speed cap is well above that
  havokPlugin.setVelocityLimits(200, 400);
  scene.getPhysicsEngine()!.setSubTimeStep(SUB_STEP_MS);
  const hud = new Hud();
  const course = new Course(scene);                  // v0.23 test course (own floor, far from the arena)
  const SUN_OFFSET = sun.position.clone();
  const fx = new Fx(scene, document.getElementById('fxlayer')!);
  // v0.33 race track (own floor too, far from the arena and the course); v0.35 one per track, the race picks one
  const races = Object.fromEntries(TRACK_IDS.map(id => [id, new Race(scene, fx, id)])) as Record<TrackId, Race>;
  let race = races.gp;
  // v0.27 loose cubes land on the arena floor (walls bounce them) and on the test course floor
  setDebrisFloors([{ cx: 0, cz: 0, half: ARENA_SIZE / 2, wallH: WALL_H }, { cx: COURSE_ORIGIN.x, cz: COURSE_ORIGIN.z, half: COURSE.size / 2, wallH: 0 }, ...TRACK_IDS.map(id => races[id].debrisFloor), bigBox.debrisFloor]);

  // ---- Lab scene (builder preview, no physics) ----
  const lab = new Lab(engine, catalog);
  const builder = new Builder(catalog);
  // v0.32 phones: simple menu instead of the builder; no shadows, lighter glow
  const mmenu = MOBILE ? new MobileMenu(PRESETS, { player: 'Noisy Cricket', opponent: 'Hammer Time' }) : null;
  const modeEl = document.getElementById('modepick')!;   // v0.50 start screen: Battle Royal / Race Mode
  const inMenu = () => builder.visible || !!mmenu?.visible || modeEl.classList.contains('on');
  if (MOBILE) for (const sc of [scene, lab.scene]) {
    sc.shadowsEnabled = false;
    for (const l of sc.effectLayers) { const g = l as unknown as { blurKernelSize: number; intensity: number }; g.blurKernelSize = 16; g.intensity *= 0.8; }
  }
  if (MOBILE) { hud.details = false; }
  // v0.24 camera views: Q cycles, remembered in this browser (all modes)
  const camCtl = new CamControl(cam, lab.camera, canvas, () => inMenu() || bots.length === 0);
  setupTouchControls(() => camCtl.cycle());                       // v0.32 phone joystick / FIRE / CAM / RESTART / MENU
  // v0.24 lab weapon test button (SPACE works too)
  const wtBtn = document.getElementById('bb-wtest') as HTMLButtonElement;
  wtBtn.addEventListener('pointerdown', () => { lab.buttonHeld = true; });
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) wtBtn.addEventListener(ev, () => { lab.buttonHeld = false; });

  let bots: Bot[] = [];
  let combat: Combat;
  let timeLeft = MATCH_SECONDS;
  let over = false;
  let buildA: BotBuild | null = null;
  let buildB: BotBuild | null = null;
  let p2Human = false;                // debug: drive P2 with arrows instead of the AI
  let difficulty: Difficulty = 'normal';
  let breakableWeapons = false;      // v0.17 deploy-bar setting (applies to both bots)
  let camFocus: { pos: Vector3; until: number } | null = null;   // bot flying over the cage / exploding
  // v0.23 test course
  let mode: 'match' | 'course' | 'race' = 'match';   // v0.33 + race
  let courseBuild: BotBuild | null = null;          // the lab build that opened the course
  let courseStation: StationId | null = null;
  let courseReported = false;
  let courseCombat: Combat | undefined;
  const helpEl = document.getElementById('help')!;

  // v0.30 start screen: DEPLOY puts both bots in the arena, frozen, with the controls card; START (or Enter)
  // runs a 3-2-1-FIGHT! countdown, then the match. R comes back here. Nothing drives and the clock waits until FIGHT.
  let phase: 'ready' | 'countdown' | 'fight' = 'ready';
  let countdownAt = 0;                                       // performance.now() when the countdown began
  let readySeen = false;                                     // v0.31: the card shows before the first battle only (I brings it back)
  let rWas = false;                                          // v0.31: R restarts on the press, not every frame it's held
  const COUNT_MS = 900;                                      // per number (3, 2, 1), then FIGHT!
  const rd = {
    box: document.getElementById('ready')!, title: document.getElementById('rd-title')!,
    table: document.getElementById('rd-table')!, start: document.getElementById('rd-start') as HTMLButtonElement,
    count: document.getElementById('countdown')!, small: document.getElementById('rd-small')!,
  };
  /** info = true: opened with I during a countdown / fight (no START button, the match keeps going). */
  const showReady = (info = false) => {
    const [a, b] = bots;
    rd.title.innerHTML = `<span style="color:${a.build.cosmetics.paint}">${a.build.cosmetics.name}</span><span class="vs">VS</span>`
      + `<span style="color:${b.build.cosmetics.paint}">${b.build.cosmetics.name}</span>`;
    const rows: [string, string][] = MOBILE ? [
      ['DRIVE', 'Joystick (bottom left)'],
      ['WEAPON', a.weapon.hint('FIRE')],
      ['CAMERA', 'CAM changes the view · drag the screen to look around'],
      ['TO WIN', 'Destroy the other bot, or knock it out of the arena. At 3:00, whoever took less damage wins.'],
      ['BUTTONS', 'RESTART: new battle · MENU: pick bots'],
    ] : [
      ['DRIVE', 'W A S D (or gamepad left stick)'],
      ['WEAPON', a.weapon.hint('SPACE')],
      ['CAMERA', 'Q changes the view · drag to look around · mouse wheel zooms'],
      ['TO WIN', 'Destroy the other bot, or knock it out of the arena. At 3:00, whoever took less damage wins.'],
      ['KEYS', 'R: restart · B: lab · V: move the scoreboards · H: part details · I: show this card again'],
    ];
    if (p2Human) rows.splice(2, 0, ['PLAYER 2', `Arrows + Right SHIFT — ${b.weapon.hint('Right SHIFT')}`]);
    rd.table.innerHTML = rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('');
    rd.start.style.display = info ? 'none' : '';
    rd.small.textContent = MOBILE ? 'Tap START' : info ? 'I: close' : 'Enter or click START · B: back to the lab';
    rd.box.classList.add('on');
  };
  const beginCountdown = () => {
    if (phase !== 'ready' || !bots.length || inMenu() || mode === 'course') return;
    goCountdown();
  };
  /** v0.31: 3-2-1 starts; spinners switch on with the "3" so they're at top speed by FIGHT! */
  const goCountdown = () => {
    phase = 'countdown'; countdownAt = performance.now();
    if (mode === 'race') raceSeen = true; else readySeen = true;
    rd.box.classList.remove('on');
    for (const b of bots) if (b.weapon.mode === 'spinner' && !b.weapon.motorDead) b.weapon.spinning = true;
    canvas.focus();
  };
  rd.start.addEventListener('click', () => { if (mode === 'race') goFullscreen(); beginCountdown(); });   // v0.39 phone: full screen on START
  window.addEventListener('keydown', e => {
    if ((e.code === 'Enter' || e.code === 'NumpadEnter') && !e.repeat && phase === 'ready' && !inMenu() && mode !== 'course') { e.preventDefault(); beginCountdown(); }
    else if ((e.code === 'Enter' || e.code === 'NumpadEnter') && !e.repeat && mode === 'race' && rr.box.classList.contains('on')) { e.preventDefault(); startRace(true); }   // v0.37
  });
  /** Countdown display; returns true once FIGHT! is reached. */
  const tickCountdown = (now: number): boolean => {
    const t = now - countdownAt, n = 3 - Math.floor(t / COUNT_MS);
    if (n > 0) { rd.count.textContent = String(n); rd.count.className = 'on'; return false; }
    rd.count.textContent = mode === 'race' && !brawl ? 'GO!' : 'FIGHT!';   // v0.49 Big Arena: FIGHT! rd.count.className = 'on fight';
    setTimeout(() => { if (phase === 'fight') rd.count.className = ''; }, 800);
    return true;
  };

  const start = () => {
    if (!buildA || !buildB) return;
    leaveCourse();
    leaveRace();
    for (const b of bots) disposeBot(b);
    fx.clear();
    bots = [
      buildBot('A', buildA, catalog, scene, arena.spawnA, Math.PI / 4, { breakableWeapons }),
      buildBot('B', buildB, catalog, scene, arena.spawnB, Math.PI + Math.PI / 4, { breakableWeapons }),
    ];
    for (const b of bots) { castShadows(shadows, botMeshes(b)); skinBot(b, shadows); }   // v0.16; v0.27 Cube Bots look (if on)
    combat = new Combat(bots, fx);
    timeLeft = MATCH_SECONDS; over = false; camFocus = null;
    hud.hideWinner();
    phase = 'ready'; rd.count.className = '';
    if (!readySeen) showReady();                       // v0.30 start screen; v0.31: first battle only, after that straight to 3-2-1
    else goCountdown();
    canvas.focus();
  };

  const openLab = () => {
    rd.box.classList.remove('on'); rd.count.className = '';
    if (mmenu) {                                       // v0.32 phone menu: preset bots only, arena only
      if (mmenu.visible) return;
      mmenu.show(b => lab.setBuild(b), ({ player, opponent, difficulty: d }) => {
        buildA = player; buildB = opponent; difficulty = d; breakableWeapons = false; DRIVE.boost = 3; start();
      });
      return;
    }
    if (pickRace) { Object.assign(CUBES, LAB_CUBES); setPickRace(false); carOptions(); sync(); }   // v0.46 B from the picker race: the lab's own look + settings
    builder.show(
      b => { labBuild = b; lab.setBuild(b); },   // v0.48 "My lab build" in the race car picker
      ({ player, opponent, difficulty: d, breakableWeapons: bw, driveBoost }) => { buildA = player; buildB = opponent; difficulty = d; breakableWeapons = bw; DRIVE.boost = driveBoost; start(); },   // v0.22 test boost (both bots)
      ({ player, driveBoost }) => { courseBuild = player; DRIVE.boost = driveBoost; showCourseMenu(); },   // v0.23 test course
      ({ player, difficulty: d, driveBoost, raceSpeed, track }) => { raceBuild = player; raceDiff = d; DRIVE.boost = driveBoost; raceSpeedMul = raceSpeed; raceTrack = track; fromLab(player); startRace(); },   // v0.48 fromLab: pickers   // v0.33 race; v0.35 track
    );
  };

  // ---------------- v0.23 TEST COURSE ----------------
  const cm = {
    menu: document.getElementById('cmenu')!, bot: document.getElementById('cm-bot') as HTMLSelectElement,
    stations: document.getElementById('cm-stations')!, rec: document.getElementById('cm-rec') as HTMLInputElement,
    lab: document.getElementById('cm-lab') as HTMLButtonElement, hud: document.getElementById('chud')!,
    results: document.getElementById('cresults')!, rTitle: document.getElementById('cr-title')!,
    rTable: document.getElementById('cr-table')!, rSaved: document.getElementById('cr-saved')!,
  };
  for (const st of STATIONS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.innerHTML = `<b>${st.name}</b><span>${st.blurb}</span>`;
    b.onclick = () => startStation(st.id);
    cm.stations.appendChild(b);
  }
  cm.lab.onclick = () => { leaveCourse(); openLab(); };
  // v0.30 RECORDED RUN saves through the dev server (vite.config.ts) -- only offered there (npm run dev)
  if (!import.meta.env.DEV) { cm.rec.checked = false; document.getElementById('cm-recrow')!.style.display = 'none'; }

  const isArenaMesh = (name: string) => name === 'floor' || name.startsWith('wall') || name.startsWith('arena');
  const setArenaVisible = (on: boolean) => { for (const m of scene.meshes) if (isArenaMesh(m.name)) m.setEnabled(on); };
  const clearBots = () => { leaveRace(); for (const b of bots) disposeBot(b); bots = []; fx.clear(); courseCombat = undefined; };

  /** Course menu: pick the bot + station. */
  function showCourseMenu() {
    clearBots();
    mode = 'course';
    document.body.classList.add('incourse', 'inmenu');
    cm.results.classList.remove('on');
    cm.bot.innerHTML = '';
    cm.bot.add(new Option(`Lab build — ${courseBuild?.cosmetics.name ?? '?'}`, ''));
    for (const name of Object.keys(PRESETS)) cm.bot.add(new Option(name, name));
    cm.bot.value = '';
    cm.menu.classList.add('on');
  }
  let courseBotChoice = '';
  function startStation(id: StationId) {
    courseBotChoice = cm.bot.value;
    const build = courseBotChoice ? JSON.parse(JSON.stringify(PRESETS[courseBotChoice])) as BotBuild : courseBuild;
    if (!build) return;
    clearBots();
    mode = 'course';
    courseStation = id; courseReported = false;
    cm.menu.classList.remove('on'); cm.results.classList.remove('on');
    document.body.classList.add('incourse'); document.body.classList.remove('inmenu');
    setArenaVisible(false); course.setVisible(true);
    sun.position = COURSE_ORIGIN.add(SUN_OFFSET);
    const at = course.build(id);
    const player = buildBot('A', build, catalog, scene, at.spawn, at.facing, { breakableWeapons: false });
    bots = [player];
    if (at.dummy) {
      const dummy = buildBot('B', JSON.parse(JSON.stringify(PRESETS['Blue Lift'])), catalog, scene, at.dummy.pos, at.dummy.facing, { breakableWeapons: false });
      bots.push(dummy);
      courseCombat = new Combat(bots, fx);
    }
    for (const b of bots) { castShadows(shadows, botMeshes(b)); skinBot(b, shadows); }   // v0.27 Cube Bots look (if on)
    course.begin(player, bots[1], courseCombat);
    cam.target = player.root.position.clone(); cam.radius = camCtl.radius(11);   // v0.24: angle is the player's (Q / drag)
    hud.showControls([`<b>${STATIONS.find(s => s.id === id)!.name}</b>`, `WASD drive · ${player.weapon.hint('SPACE')}`, `R restart · C stations · B lab · Q camera`], 4000);
    canvas.focus();
  }
  function leaveCourse() {
    if (mode !== 'course') return;
    clearBots();
    mode = 'match';
    document.body.classList.remove('incourse', 'inmenu');
    cm.menu.classList.remove('on'); cm.results.classList.remove('on');
    course.setVisible(false); setArenaVisible(true);
    sun.position = SUN_OFFSET.clone();
    cam.target = new Vector3(0, 0.5, 0); cam.radius = camCtl.radius(16);   // back to the arena (v0.24: angle kept)
  }

  const RUN_HEADER = ['date', 'station', 'bot', 'chassis', 'build', 'drive_boost', 'time_s', 'penalty_s', 'final_s', 'splits',
    'top_speed_mps', 'max_tilt_deg', 'flipped', 'cones_hit', 'wrong_side', 'crate_kg', 'push_dist_m', 'block_dmg', 'dummy_dmg', 'total_dmg', 'hits', 'biggest_hit'];
  function runRow(r: RunResult, b: Bot): (string | number)[] {
    const d = new Date(), z = (n: number) => String(n).padStart(2, '0');
    const date = `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}:${z(d.getSeconds())}`;
    const build = Object.entries(b.build.sockets).filter(([, v]) => v).map(([k, v]) => `${k}=${catalog.parts[v!]?.name ?? v}`).join('; ');
    const f = (n: number, k = 2) => Number(n.toFixed(k));
    const weapon = r.station === 'weapon';
    return [date, STATIONS.find(s => s.id === r.station)!.name, b.build.cosmetics.name, catalog.bodies[b.build.bodyId]?.name ?? b.build.bodyId, build, DRIVE.boost,
      f(r.time), r.penalty, f(r.final), r.splits.map(s => `${s.label} ${s.t.toFixed(2)}`).join(' | '),
      f(r.topSpeed), Math.round(r.maxTilt), r.flipped ? 'yes' : 'no',
      r.station === 'slalom' ? r.coneHits : '', r.station === 'slalom' ? r.wrongSide : '',
      r.station === 'push' ? r.crateKg : '', r.station === 'push' ? f(r.pushDist) : '',
      weapon ? (r.blockDmg ?? 'n/a') : '', weapon ? r.dummyDmg : '', weapon ? (r.blockDmg ?? 0) + r.dummyDmg : '', weapon ? r.hits : '', weapon ? r.biggest : ''];
  }
  /** Recorded run finished: results screen + append to runs\runs.csv through the dev server. */
  function reportRun(r: RunResult, b: Bot) {
    const row = runRow(r, b);
    cm.rTitle.textContent = `RESULTS — ${STATIONS.find(s => s.id === r.station)!.name} — ${b.build.cosmetics.name}`;
    cm.rTable.innerHTML = RUN_HEADER.map((h, i) => [h, row[i]] as const).filter(([h, v]) => v !== '' && h !== 'date' && h !== 'build')
      .map(([h, v]) => `<tr><td>${h.replace(/_/g, ' ')}</td><td>${v}</td></tr>`).join('');
    cm.rSaved.className = 'saved'; cm.rSaved.textContent = 'Saving…';
    cm.results.classList.add('on');
    fetch('/__runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ header: RUN_HEADER, row }) })
      .then(res => res.json())
      .then(j => { if (j.ok) cm.rSaved.textContent = `✓ Saved to ${j.file} (run #${j.row})`; else throw new Error(j.error); })
      .catch(e => { cm.rSaved.className = 'saved bad'; cm.rSaved.textContent = `✗ Not saved: ${e?.message ?? e}`; });
  }

  /** One frame of the test course. */
  function courseFrame(dt: number, now: number) {
    const p = bots[0];
    const stopped = course.done;
    for (const b of bots) {
      if (b === p) runBot(b, stopped ? { throttle: 0, turn: 0, fire: false } : readDrive('A'), dt, now, stopped, false);
      else runBot(b, { throttle: 0, turn: 0, fire: false }, dt, now, true, true);    // the dummy: switched off, brakes on
    }
    if (course.done && !courseReported) {
      courseReported = true;
      if (cm.rec.checked) reportRun(course.result(), p);
      else hud.sign('FINISH', 900, '#39ff14');
    }
    const rec = cm.rec.checked;
    cm.hud.innerHTML = `<h4>${STATIONS.find(s => s.id === courseStation)!.name}<span class="tag ${rec ? 'rec' : 'prac'}">${rec ? 'RECORDED' : 'PRACTICE'}</span></h4>`
      + course.hudLines().map(l => `<div>${l}</div>`).join('') + (course.done ? `<div><b style="color:#39ff14">FINISHED</b></div>` : '');
    helpEl.innerHTML = `WASD drive &nbsp;·&nbsp; SPACE weapon &nbsp;·&nbsp; Q camera &nbsp;·&nbsp; R restart &nbsp;·&nbsp; C stations &nbsp;·&nbsp; B lab`;
    cam.target = Vector3.Lerp(cam.target, p.root.position, 0.1).add(fx.shakeOffset());
    camGuard(p.root.position, 'course');   // v0.34h
    cam.radius += (camCtl.radius(11) - cam.radius) * 0.05;
    camCtl.chase(p.root.rotationQuaternion, dt);
    fx.update(dt, cam);
  }
  // ---------------- v0.33 RACE ----------------
  let raceBuild: BotBuild | null = null;
  let raceDiff: Difficulty = 'normal';
  let raceSeen = false;                                    // controls card before the first race per page load only
  let raceShown = -1;                                      // results screen: when it was last drawn (-1 = not showing)
  let raceHudAt = 0;
  const rr = {
    hud: document.getElementById('rhud')!, map: document.getElementById('rmap') as HTMLCanvasElement,
    box: document.getElementById('rresults')!, table: document.getElementById('rr-table')!,
    again: document.getElementById('rr-again') as HTMLButtonElement, lab: document.getElementById('rr-lab') as HTMLButtonElement,
    cubes: document.getElementById('rr-cubes')!,   // v0.38
  };
  const rrTitle = rr.box.querySelector('h3') as HTMLElement;
  const podEl = document.getElementById('kopod')!;   // v0.50 Big Arena KO tracker   // v0.49 RACE RESULTS / BATTLE RESULTS
  rr.again.onclick = () => { goFullscreen(); startRace(true); };   // v0.48 every race: the pickers are on the results, so straight to 3-2-1   // v0.37 tester: the pickers are on the results screen, so straight to 3-2-1
  rr.lab.onclick = () => { leaveRace(); openLab(); };
  const RIVAL_IDS = ['B', 'C', 'D'] as const;
  let raceSpeedMul = 1;   // v0.34d lab RACE SPEED slider: x1 = the v0.34 race pace, up to x3
  let raceTrack: TrackPick = 'gp';   // v0.35 lab TRACK picker (Random = a new pick every race); v0.49 + the Big Arena

  // ---------------- v0.49 BIG ARENA brawl state (the rest is under startBrawl) ----------------
  interface Fighter {
    id: BotId; human: boolean; name: string; paint: string; bot: Bot;
    lapsDone: number; finished?: number;                          // for upgrades.ts (no laps here; never "finished")
    down?: { at: number; why: 'ko' | 'off' | 'stuck' };           // out (v0.50: respawns BIG.goneMs later)
    place?: number;                                               // v0.50 set at the end (by KOs)
    outT?: number;                                                // battle time when it last went out, s
    gone?: boolean;                                               // v0.49b its bot has been deleted (bodies and all)
    stuckSince?: number;
    target?: Fighter; targetAt: number;                           // AI: who it's going after
    build: BotBuild;                                              // v0.50 respawns with this
    taken: number;                                                // v0.50 damage taken by its earlier lives (this battle)
    protUntil?: number; blink?: AbstractMesh[];                   // v0.50 spawn protection after a respawn
  }
  interface Brawl { racers: Fighter[]; t: number; timeLeft: number; over: boolean; overAt: number; playerOutAt: number; spinPrev: Map<Bot, number>; standings(): Fighter[] }
  let brawl: Brawl | null = null;
  let bigPractice = false;   // v0.49b test aid (P in the Big Arena): you respawn, the battle never ends
  const brawlPlayer = () => brawl?.racers.find(f => f.human);
  const playerId = (): string | undefined => brawl ? brawlPlayer()?.id : race.player()?.id;

  // ---------------- v0.38 cube currency (races only) ----------------
  let tally: Record<string, Tally> = {};
  let paid: Reward | null = null;          // the player's race reward, once it's in the wallet
  let walletAfter = walletCubes();
  let cubePulse = 0;                       // HUD: the cube line lights up for a moment after a pickup
  // ---------------- v0.40 race upgrades: the SCRAP meter (upgrades.ts) ----------------
  const upg = new Upgrades(scene, fx, { sign: (t, ms, c) => hud.sign(t, ms, c), isPlayer: id => playerId() === id, shadows,
    onBox: id => { if (brawl && inRace(id)) boxesTaken[id] = (boxesTaken[id] ?? 0) + 1; } });   // v0.51 Big Arena points
  const inRace = (id: string) => {
    if (brawl) return phase === 'fight' && !brawl.over && brawl.racers.some(f => f.id === id);   // v0.49 Big Arena
    const r = race.racers.find(x => x.id === id); return !!r && r.finished === undefined && phase === 'fight';
  };
  // v0.49 Big Arena: no laps, so a bot's own knocked-off cubes are never its to vacuum (lap 1 vs lapOf 1) -- rivals' only
  LOOT.collectors = () => mode === 'race' && phase === 'fight'
    ? brawl ? (brawl.over ? [] : brawl.racers.filter(f => !f.down && !f.bot.eliminated).map(f => ({ id: f.id, bot: f.bot, lap: 1 })))
    : race.racers.filter(r => !r.down && !r.bot.eliminated && r.finished === undefined).map(r => ({ id: r.id, bot: r.bot, lap: r.lapsDone }))
    : [];
  LOOT.lapOf = id => brawl ? 1 : race.racers.find(r => r.id === id)?.lapsDone ?? 0;
  // v0.47 the race count: never below 0 (a crash resets it -- onCrash in startRace)
  LOOT.onLost = (id, v) => { if (!inRace(id)) return; const t = (tally[id] ??= newTally()); t.lost += v; t.count = Math.max(0, t.count - v); };
  // v0.47 damage = cubes knocked off rivals (credited by cubes.ts; hazards and KO explosions don't count)
  let knockFree = 0;   // test aid (__bb): damage cubes that came off upgrades
  LOOT.onKnocked = (by, victim, v, free) => { if (inRace(by) && by !== victim) { (tally[by] ??= newTally()).dmg += v; if (free) knockFree += v; } };
  LOOT.onCollect = (id, v, repaired) => {
    if (!inRace(id)) return;
    const t = (tally[id] ??= newTally());
    t.got += v; t.count += v; if (repaired) t.repaired++;
    upg.gain(id as Racer['id'], v);   // v0.40 every vacuumed cube is scrap too
    if (playerId() === id) cubePulse = performance.now();
  };
  /** par for this race: the track's par is at the tester race speed (x3); the lab's RACE SPEED slider scales it */
  const parFor = () => race.def.par * TESTER_SET.raceSpeed / Math.max(0.5, raceSpeedMul);
  const rewardOf = (r: Racer) => reward(race.standings().indexOf(r) + 1, r.finished, parFor(), tally[r.id] ?? newTally());
  const dmgOf = (r: { id: string }) => dmgScore(tally[r.id] ?? newTally());   // v0.47 damage score = cubes knocked off rivals + KO bonus
  let crashFlash = 0;   // v0.47 HUD: the cube count flashes red after your crash

  // ---------------- v0.37 TESTER pickers (track + car) ----------------
  const tp = {
    track: [document.getElementById('tp-track') as HTMLSelectElement, document.getElementById('tp-track2') as HTMLSelectElement],
    car: [document.getElementById('tp-car') as HTMLSelectElement, document.getElementById('tp-car2') as HTMLSelectElement],
  };
  let testerCar = TESTER_SET.car;   // a preset name, or LAB_CAR = the lab's own build
  const LAB_CAR = '';
  let labBuild: BotBuild | null = null;   // v0.48 the bot on the lab turntable ("My lab build" in the car picker)
  /** v0.46: the start-page race (tester settings, nothing about the lab on screen). false once the lab's RACE button is used.
   *  v0.48 (user): every race has the track + car pickers -- on the start card (first start and R) and on the results. */
  let pickRace = TESTER;
  const LAB_CUBES = { ...CUBES };   // v0.46 the lab's own saved cube look (the picker race forces Neon Energy, not saved)
  const rrKeys = rr.box.querySelector('.keys') as HTMLElement;
  rr.again.textContent = 'START ▶';
  const setPickRace = (on: boolean) => {
    pickRace = on;
    document.body.classList.toggle('tester', on);   // hides the results' ◀ LAB button
    rrKeys.textContent = MOBILE ? 'START: next race' : on ? 'Enter or START: next race · R: restart' : 'Enter or START: next race · R: restart · B: lab';
  };
  const carOptions = () => {
    const opts = Object.keys(PRESETS).map(n => `<option value="${n}">${PRESETS[n].cosmetics.name}</option>`).join('');
    for (const sel of tp.car) sel.innerHTML = opts + (labBuild && !pickRace ? `<option value="${LAB_CAR}">MY LAB BUILD</option>` : '');
  };
  const sync = () => { for (const sel of tp.track) sel.value = raceTrack; for (const sel of tp.car) sel.value = testerCar; };
  const buildFor = (car: string): BotBuild | null => car === LAB_CAR ? (labBuild ? JSON.parse(JSON.stringify(labBuild)) : null) : JSON.parse(JSON.stringify(PRESETS[car]));
  for (const sel of tp.track) sel.innerHTML = TRACK_IDS.map(id => `<option value="${id}">${races[id].def.name}</option>`).join('') + `<option value="${BIG_ID}">Big Arena</option>` + '<option value="random">Random</option>';   // v0.49 + Big Arena
  carOptions();
  const pick = (sel: HTMLSelectElement, rebuild: boolean) => {
    if (tp.track.includes(sel)) raceTrack = sel.value as TrackPick; else testerCar = sel.value;
    raceBuild = buildFor(testerCar) ?? raceBuild;
    sync();
    if (pickRace) try { localStorage.setItem(TESTER_KEY, JSON.stringify({ track: raceTrack, car: testerCar })); } catch { /* ignore */ }
    sel.blur(); canvas.focus();
    if (rebuild) startRace();   // start card: rebuild the grid behind it with the new pick, card stays up
  };
  for (const sel of [...tp.track, ...tp.car]) {
    sel.addEventListener('keydown', e => e.preventDefault());   // mouse only: R / Enter / WASD never change the pick by accident
    sel.addEventListener('change', () => pick(sel, sel === tp.track[0] || sel === tp.car[0]));
  }
  /** v0.48 a race from the lab's RACE button: lab settings, pickers start on what the lab picked */
  const fromLab = (player: BotBuild) => {
    setPickRace(false);
    const js = JSON.stringify(player);
    testerCar = Object.keys(PRESETS).find(n => JSON.stringify(PRESETS[n]) === js) ?? LAB_CAR;
    if (testerCar === LAB_CAR) labBuild = JSON.parse(js);
    carOptions(); sync();
  };
  if (TESTER) {
    let saved: { track?: string; car?: string } = {};
    try { saved = JSON.parse(localStorage.getItem(TESTER_KEY) ?? '{}'); } catch { /* ignore */ }
    raceTrack = saved.track === 'random' || saved.track === BIG_ID || TRACK_IDS.includes(saved.track as TrackId) ? saved.track as TrackPick : TESTER_SET.track;
    testerCar = saved.car && PRESETS[saved.car] ? saved.car : TESTER_SET.car;
    DRIVE.boost = MOBILE ? PHONE_SET.boost : TESTER_SET.boost; raceSpeedMul = MOBILE ? PHONE_SET.raceSpeed : TESTER_SET.raceSpeed; raceDiff = TESTER_SET.ai;   // v0.41 phone x2 / x2
    CUBES.on = true; CUBES.style = 'neonEnergy'; CUBES.size = 'big';
    raceBuild = buildFor(testerCar);
  }
  setPickRace(TESTER); sync();
  // ---------------- v0.43 controller (user): menus + buttons. A / Start = START, Y = camera, Back / View = restart,
  // LB / RB = track, D-pad left / right = car (start card + results). Phone: a controller hides the touch buttons.
  const cardUp = () => rd.box.classList.contains('on') || rr.box.classList.contains('on');
  function padPick(kind: 'track' | 'car', dir: number) {
    if (mode !== 'race' || !cardUp()) return;
    const sel = (kind === 'track' ? tp.track : tp.car)[rd.box.classList.contains('on') ? 0 : 1];
    const n = sel.options.length; if (!n) return;
    sel.selectedIndex = (sel.selectedIndex + dir + n) % n;
    sel.dispatchEvent(new Event('change'));
  }
  onPadButton(btn => {
    if (btn === 0 || btn === 9) { if (btn === 9 || cardUp()) pressKey('Enter'); }   // A only on a card (A is the weapon in a race)
    else if (btn === 3) pressKey('KeyQ');
    else if (btn === 8) tapKey('KeyR');
    else if (btn === 4 || btn === 5) padPick('track', btn === 5 ? 1 : -1);
    else if (btn === 14 || btn === 15) padPick('car', btn === 15 ? 1 : -1);
  });
  onPadChange(on => {
    document.body.classList.toggle('pad', on);
    if (mode === 'race' && rd.box.classList.contains('on')) showRaceReady();   // swap the card's controls text
  });

  /** v0.35 track look: sky (clear colour) + light levels while racing there; back to the arena's on the way out. */
  const ARENA_LIGHT = { clear: scene.clearColor.clone(), hemi: hemi.intensity, sun: sun.intensity };
  function applyTrackTheme(r: Race | null) {
    const th = r?.def.theme;
    scene.clearColor = th?.sky ? Color4.FromHexString(th.sky[1] + 'ff') : ARENA_LIGHT.clear.clone();
    hemi.intensity = th?.hemi ?? ARENA_LIGHT.hemi;
    sun.intensity = th?.sun ?? ARENA_LIGHT.sun;
    // v0.36 rain haze (Night City); off everywhere else
    if (th?.fog) { scene.fogMode = Scene.FOGMODE_EXP2; scene.fogDensity = th.fog.density; scene.fogColor = Color3.FromHexString(th.fog.color); }
    else scene.fogMode = Scene.FOGMODE_NONE;
  }

  // ---------------- v0.49 BIG ARENA: 32 m BattleBox, race settings, 4-bot free-for-all ----------------
  const NO_DRIVE: Drive = { throttle: 0, turn: 0, fire: false };
  /** SCRAP boxes: one on each axis, a third of the way in from the walls */
  const bigBoxSpots = () => [[0, -1], [0, 1], [-1, 0], [1, 0]].map(([x, z]) => BIG.origin.add(new Vector3(x * bigBox.half * 0.45, 0.6, z * bigBox.half * 0.45)));
  /** v0.51 (user) three AI presets, all different and none the bot you drive (lab build: any 3) */
  const rivalPresets = () => {
    const mine = raceBuild ? JSON.stringify(raceBuild) : '';
    const pool = Object.keys(PRESETS).filter(n => JSON.stringify(PRESETS[n]) !== mine && PRESETS[n].cosmetics.name !== raceBuild?.cosmetics.name);
    return pool.sort(() => Math.random() - 0.5).slice(0, 3);
  };
  /** v0.50 KOs so far (the KO credit is counted in the cube tally) */
  const kosOf = (f: Fighter) => tally[f.id]?.kos ?? 0;
  /** v0.51 SCRAP boxes taken this battle */
  let boxesTaken: Record<string, number> = {};
  /** v0.51 battle points: damage + KO bonus + rival cubes vacuumed + SCRAP boxes */
  const pointsOf = (f: Fighter) => {
    const t = tally[f.id] ?? newTally();
    return Math.round(t.dmg * BIG.pts.dmg + t.kos * BIG.pts.ko + t.got * BIG.pts.vacuum + (boxesTaken[f.id] ?? 0) * BIG.pts.box);
  };
  /** v0.50 damage taken this battle, every life (any source) */
  const takenOf = (f: Fighter) => f.taken + (f.down ? 0 : f.bot.state.totalDamageTaken);
  /** standings: v0.51 most points first, then least damage taken */
  function brawlStandings(this: Brawl): Fighter[] {
    return [...this.racers].sort((a, b) => pointsOf(b) - pointsOf(a) || takenOf(a) - takenOf(b));
  }
  /** tracker place: v0.51 tied points share a place */
  const koRank = (f: Fighter) => 1 + brawl!.racers.filter(o => pointsOf(o) > pointsOf(f)).length;
  const brawlReward = (f: Fighter) => reward(f.place ?? brawl!.standings().indexOf(f) + 1, undefined, 0, tally[f.id] ?? newTally());

  function startBrawl(skipCard = false) {
    if (!raceBuild) return;
    leaveCourse();
    if (mode === 'race') { endBrawl(); race.dispose(); bots = []; fx.clear(); } else clearBots();
    clearLoot(); LOOT.on = true; tally = {}; paid = null; cubePulse = 0; boxesTaken = {};
    race.setVisible(false);
    applyTrackTheme(null);   // the arena's black + neon
    mode = 'race';
    document.body.classList.add('inrace');
    rr.box.classList.remove('on'); raceShown = -1;
    hud.hideWinner(); hud.clearSign();
    setArenaVisible(false); course.setVisible(false); bigBox.setVisible(true);
    combat = new Combat([], fx);
    // the race settings (bots are built with them)
    DRIVE.raceSpeed = 2 * raceSpeedMul;
    DRIVE.raceWeaponsNeutral = true;
    DRIVE.raceSteer = true;
    DRIVE.raceArcade = true;
    rampT = 0; rampDir = 0;
    upg.resetAt(bigBoxSpots());   // fresh SCRAP meters + boxes (before the bots: attach puts upgrades on)
    const names = rivalPresets();   // v0.51 never your car, never twice
    const entries: { id: BotId; human: boolean; build: BotBuild }[] = [
      { id: 'A', human: true, build: raceBuild },
      ...names.map((n, i) => ({ id: RIVAL_IDS[i] as BotId, human: false, build: JSON.parse(JSON.stringify(PRESETS[n])) as BotBuild })),
    ];
    const spots = bigBox.spawns(entries.length);
    const racers = entries.map((e, i): Fighter => {
      const bot = buildBot(e.id, e.build, catalog, scene, spots[i].pos, spots[i].facing, { breakableWeapons: false });
      castShadows(shadows, botMeshes(bot)); skinBot(bot, shadows); upg.attach(bot);
      combat.replaceBot(undefined, bot);
      return { id: e.id, human: e.human, name: e.build.cosmetics.name, paint: e.build.cosmetics.paint ?? '#fff', bot, lapsDone: 0, targetAt: 0, build: e.build, taken: 0 };
    });
    brawl = { racers, t: 0, timeLeft: BIG.seconds, over: false, overAt: 0, playerOutAt: -1, spinPrev: new Map(), standings: brawlStandings };
    bots = racers.map(f => f.bot);
    over = false; camFocus = null;
    phase = 'ready'; rd.count.className = '';
    const p = racers[0].bot;
    cam.target = p.root.position.clone(); cam.radius = camCtl.radius(raceCamR());
    if (MOBILE && camCtl.view === 'chase') cam.beta = Math.min(cam.beta, PHONE_CAM.maxBeta);
    sun.position = p.root.position.add(SUN_OFFSET);
    drawRaceHud(performance.now(), true);
    if (!skipCard) showRaceReady();   // pickers before every START (as the races)
    else goCountdown();
    canvas.focus();
  }
  /** Leaving the Big Arena (another track, the lab): bots, upgrades and the box go. */
  function endBrawl() {
    if (!brawl) return;
    for (const f of brawl.racers) if (!f.gone) disposeBot(f.bot);
    brawl = null; bots = [];
    upg.clear();
    bigBox.setVisible(false);
    fx.focus = null;
    podEl.style.display = 'none';
  }

  /** One frame of the Big Arena. */
  function brawlFrame(dt: number, now: number) {
    const B = brawl!;
    helpEl.innerHTML = `WASD drive &nbsp;·&nbsp; SPACE weapon &nbsp;·&nbsp; Q camera &nbsp;·&nbsp; R restart` + (pickRace ? '' : ` &nbsp;·&nbsp; B lab`);
    if (phase === 'countdown' && tickCountdown(now)) phase = 'fight';
    const waiting = phase !== 'fight';
    scene.getPhysicsEngine()?.setTimeStep(PHYS_STEP);
    const live = B.racers.filter(f => !f.down && !f.bot.eliminated);
    for (const f of live) {
      const d: Drive = waiting || B.over ? NO_DRIVE
        : f.human && !RACE_TEST.autopilot ? (MOBILE ? brawlPhoneDrive(f, dt) : steerRamp(readDrive('A', true), dt))
        : brawlAi(f, live, dt, now);
      runBot(f.bot, d, dt, now, waiting || B.over, false, phase === 'countdown');
    }
    upg.update(dt, B, combat, !waiting && !B.over);   // scrap from damage + boxes, the ram, chipped upgrades

    // v0.49b an out bot is deleted 2 s later (as a race wreck is at its respawn). Frozen + hidden it still had a
    // working collider: an invisible wall where it died (user found it with the K probe: "botB STATIC HIDDEN").
    for (const f of B.racers) if (f.down && !f.gone && now - f.down.at >= BIG.goneMs) {
      combat.removeBot(f.bot); disposeBot(f.bot); f.gone = true;
    }
    // v0.50 everyone respawns (the practice delay: right after its bot is deleted)
    if (!B.over) for (const f of B.racers) if (f.down && f.gone) brawlRespawn(f, now);
    for (const f of B.racers) if (f.protUntil !== undefined) blinkFighter(f, now);

    // who's out, and is it over?
    if (!waiting && !B.over) {
      B.t += dt;
      if (!bigPractice) B.timeLeft = Math.max(0, B.timeLeft - dt);
      for (const f of live) {
        const b = f.bot;
        if (isDestroyed(b.state)) { brawlOut(f, now, 'ko'); continue; }
        if (isBigOut(b)) { brawlOut(f, now, 'off'); continue; }
        if (isImmobilized(b.state) || (b.inverted && !b.rightingUntil)) {
          f.stuckSince ??= now;
          if (now - f.stuckSince >= BIG.stuckMs) brawlOut(f, now, 'stuck');
        } else f.stuckSince = undefined;
      }
      // v0.51 most points at the clock (tie: least damage taken); with a target (T), first to it
      const top = B.standings()[0];
      if (bigPractice) { /* practice: never ends */ }
      else if (bigTarget > 0 && pointsOf(top) >= bigTarget) finishBrawl(now, `${top.name} WINS — ${bigTarget} POINTS!`, top.paint);
      else if (B.timeLeft <= 0) {
        const tie = B.racers.filter(f => f !== top && pointsOf(f) === pointsOf(top)).length > 0;
        finishBrawl(now, `TIME! ${top.name} WINS${tie ? ' ON DAMAGE' : ` WITH ${pointsOf(top)} POINTS`}`, top.paint);
      }
    }
    bots = B.racers.filter(f => !f.gone).map(f => f.bot);

    // camera: you; once you're out, a bot still fighting
    const pf = brawlPlayer()!;
    let target = pf.down ? (pf.bot.eliminated?.pos ?? pf.bot.root.position) : pf.bot.root.position;
    if (pf.down && now - pf.down.at > 2000) { const s = B.standings().find(f => !f.down); if (s) target = s.bot.root.position; }
    cam.target = Vector3.Lerp(cam.target, target, 0.1).add(fx.shakeOffset());
    camGuard(target, 'brawl');
    cam.radius += (camCtl.radius(raceCamR()) - cam.radius) * 0.05;
    if (!pf.down) camCtl.chase(pf.bot.root.rotationQuaternion, dt);
    sun.position = target.add(SUN_OFFSET);
    fx.focus = target;
    fx.update(dt, cam);
    drawRaceHud(now);

    // your cubes go into the wallet once your place is settled (out, or the end); then the results card
    if (pf.place !== undefined && !paid && !bigPractice) {
      paid = brawlReward(pf);
      walletAfter = payWallet(paid.total);
      if (!B.over) hud.sign(`${signed(paid.total)} CUBES`, 1800, paid.total >= 0 ? '#39ff14' : '#ff4d4d');
    }
    const doneAt = B.over ? B.overAt : -1;   // v0.50 results only at the end (you respawn)
    if (paid && doneAt > 0 && now - doneAt > BIG.resultsMs && (raceShown < 0 || now - raceShown > 500)) showRaceResults(now);
  }

  /** AI: go after the nearest rival (picked again every BIG.retargetMs, or when it's out), the arena AI does the rest. */
  function brawlAi(f: Fighter, live: Fighter[], dt: number, now: number): Drive {
    if (!f.target || f.target.down || now - f.targetAt > BIG.retargetMs) {
      const p = f.bot.root.position;
      let best: Fighter | undefined, bd = Infinity;
      for (const o of live) if (o !== f) { const d = Vector3.DistanceSquared(o.bot.root.position, p); if (d < bd) { bd = d; best = o; } }
      f.target = best; f.targetAt = now;
    }
    if (!f.target) return NO_DRIVE;
    return aiDrive(f.bot, f.target.bot, bigBox.half, dt, raceDiff, { center: bigBox.center, speedLook: BIG.speedLook });
  }
  /** v0.50 back in the fight (every bot; v0.49b was the practice respawn): a fresh bot at the spawn point furthest
   *  from the bots still in, SCRAP upgrades back on (lost ones wait in the rebuild queue, as a race wreck), spawn protection. */
  function brawlRespawn(f: Fighter, now: number) {
    const B = brawl!, live = B.racers.filter(o => !o.down);
    const spot = bigBox.spawns(4).map(s => ({ s, d: Math.min(99, ...live.map(o => Vector3.Distance(o.bot.root.position, s.pos))) })).sort((a, b) => b.d - a.d)[0].s;
    const bot = buildBot(f.id, f.build, catalog, scene, spot.pos, spot.facing, { breakableWeapons: false });
    castShadows(shadows, botMeshes(bot)); skinBot(bot, shadows); upg.attach(bot);
    combat.replaceBot(undefined, bot);
    if (bot.weapon.mode === 'spinner') bot.weapon.spinning = true;
    f.bot = bot; f.down = undefined; f.stuckSince = undefined; f.gone = false; f.target = undefined;
    // spawn protection: no damage for BIG.protectMs (wraps the upgrades' armour shield)
    f.protUntil = now + BIG.protectMs; f.blink = bot.root.getChildMeshes(false);
    const sh = bot.shield;
    bot.shield = (raw, point) => f.bot === bot && f.protUntil !== undefined && performance.now() < f.protUntil ? 0 : sh ? sh(raw, point) : raw;
    if (f.human) hud.sign('BACK IN!', 900, '#36f1ff');
  }
  /** v0.50 spawn protection: the bot blinks until it ends */
  function blinkFighter(f: Fighter, now: number) {
    const on = now < f.protUntil!;
    const vis = on && Math.floor(now / 120) % 2 === 0 ? 0.25 : 1;
    for (const m of f.blink ?? []) if (!m.isDisposed()) m.visibility = vis;
    if (!on) { f.protUntil = undefined; f.blink = undefined; }
  }
  /** phone: auto-gas + ◀ ▶ steer + auto-fire, as in the race */
  function brawlPhoneDrive(f: Fighter, dt: number): Drive {
    if (padConnected()) return steerRamp(readDrive('A', true), dt);
    const d = steerRamp(readDrive('A'), dt);
    return { throttle: TOUCH.brake ? -1 : 1, turn: d.turn, fire: d.fire || autoFireAt(f.bot, brawl!.racers) };
  }
  /** out of the Big Arena: past a wall plane and under the floor (or fallen off the world) */
  function isBigOut(b: Bot): boolean {
    const p = b.root.position, c = bigBox.center, lim = bigBox.half + OUT.wallMargin;
    return ((Math.abs(p.x - c.x) > lim || Math.abs(p.z - c.z) > lim) && p.y < c.y + OUT.belowFloor) || p.y < c.y - 12;
  }
  /** A bot is out: blown apart (Cube Bots: its cubes are loot for the others); v0.50 it respawns BIG.goneMs later. */
  function brawlOut(f: Fighter, now: number, why: 'ko' | 'off' | 'stuck') {
    const B = brawl!, b = f.bot;
    f.taken += b.state.totalDamageTaken;   // v0.50 (before it's marked down: takenOf adds the live bot's)
    f.down = { at: now, why }; f.stuckSince = undefined; f.outT = B.t;
    if (f.blink) { f.protUntil = Math.min(f.protUntil ?? 0, now); blinkFighter(f, now); }
    const pos = b.root.position.clone();
    // knocking a bot out of the arena counts as a KO too; v0.50 stuck = nobody's KO (self-out penalty: parked)
    const koBy = why === 'stuck' ? undefined : combat.lastAttacker(b, BIG.koCreditMs);   // v0.51 1 s
    const label = why === 'ko' ? 'WRECKED!' : why === 'off' ? 'OUT!' : 'IMMOBILIZED!';
    if (why !== 'off' && cubeSkinOf(b.root)) { cubeKnockout(b, true); dropBot(b); }
    else { fx.explode(b, pos, label); freezeBot(b); }
    if (!b.eliminated) b.eliminated = { t: now, pos, vel: Vector3.Zero(), reason: why === 'off' ? 'out' : 'ko' };
    // cubes: out = this battle's count back to 0 (a crash); the rival whose hit did it gets the KO bonus
    const t = (tally[f.id] ??= newTally()); t.count = 0; t.crashes++;
    if (koBy && koBy !== f.id) {
      (tally[koBy] ??= newTally()).kos++;
      if (playerId() === koBy) hud.sign(`KO! +${BIG.pts.ko} PTS`, 1300, '#00e5ff');
    }
    const what = why === 'ko' ? 'WRECKED' : why === 'off' ? 'OUT OF THE ARENA' : 'IMMOBILIZED';
    if (f.human) { crashFlash = now; hud.sign(`${what}!`, 1200, '#ff4d4d'); }
    else if (playerId() !== koBy) hud.sign(`${f.name.toUpperCase()} ${what}!`, 1100, f.paint);
  }
  function finishBrawl(now: number, text: string, color: string) {
    const B = brawl!;
    B.standings().forEach((f, i) => { f.place = i + 1; });   // v0.50 by KOs, tie = least damage taken
    B.over = true; B.overAt = now; over = true;
    hud.sign(text, 2600, color);
  }
  const clock = (t: number) => { const s = Math.ceil(t), m = Math.floor(s / 60); return `${m}:${String(s % 60).padStart(2, '0')}`; };

  function showBrawlReady() {
    const p = brawlPlayer()!.bot;
    const pad = padConnected();
    rd.title.innerHTML = `BIG ARENA <span class="vs">4 BOTS · ${bigTarget ? `FIRST TO ${bigTarget} POINTS` : `MOST POINTS IN ${clock(BIG.seconds)}`}</span>`;
    const rows: [string, string][] = [
      ['DRIVE', pad ? 'Controller: RT gas · LT brake, then reverse · left stick steers' : MOBILE ? 'It drives itself forward: ◀ ▶ steer (tap = small turn, hold = full turn) · BRAKE held = slow down, then reverse' : 'W A S D (or gamepad left stick)'],
      ['WEAPON', pad ? p.weapon.hint('A') : MOBILE ? 'Fires on its own when a bot is close in front of you' : p.weapon.hint('SPACE')],
      ['TO WIN', `Every bot for itself — ${bigTarget ? `first to ${bigTarget} points wins; at ${clock(BIG.seconds)}` : `at ${clock(BIG.seconds)}`}, most points wins (tie: least damage taken).`],
      ['POINTS', `+${BIG.pts.dmg} per cube you knock off a bot · +${BIG.pts.ko} per KO · +${BIG.pts.vacuum} per cube of theirs you vacuum up · +${BIG.pts.box} per gold SCRAP box.`],
      ['KO', `Wreck a bot, or knock it out of the arena (your hit in the last ${BIG.koCreditMs / 1000} s). Every bot respawns right away, safe for ${BIG.protectMs / 1000} s (it blinks). Stuck upside down / can't drive for ${BIG.stuckMs / 1000} s = respawn, nobody's KO.`],
      ['DAMAGE', `DMG = cubes you knock off the other bots (+${REWARD.koBonus} for each one you put out).`],
      ['CUBES', `Your bot's cubes are your money. This battle's count starts at 0: +1 for each loose cube from another bot you vacuum up (they repair you too), −1 for each one knocked off you, never below 0. Out = back to 0. You earn cubes for your place and your damage.`],
      ['UPGRADES', 'Vacuumed cubes, damage and the gold SCRAP boxes fill your SCRAP meter: 25 = MOTOR, 60 = ARMOR plating, 100 = WEAPON power, 150 = a spiked RAM on your back that punches the first bot to get close behind you (once). Upgrades are cubes: hits knock them off. 25 more scrap rebuilds a lost one.'],
      ['ARENA', `A ${BIG.size} m BattleBox — twice as wide as the arena — at race speed with the race handling.`],
      ['WALLET', `${CUBE_ICON}<b class="cubes">${walletCubes()}</b> cubes`],
      pad ? ['BUTTONS', 'Y: camera · Back / View: restart'] : MOBILE ? ['BUTTONS', 'CAM: change the view · RESTART: start over'] : ['KEYS', pickRace ? 'R: restart · Q: camera' : 'R: restart · B: lab · Q: camera'],
    ];
    const shown = MOBILE ? rows.filter(([k]) => (raceSeen ? ['WALLET'] : ['DRIVE', 'WEAPON', 'WALLET']).includes(k))
      : raceSeen ? rows.filter(([k]) => k === 'ARENA' || k === 'WALLET') : rows;
    rd.table.innerHTML = shown.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('');
    rd.start.style.display = '';
    rd.small.textContent = pad ? 'LB / RB: track · D-pad ◀ ▶: car · A or Start: START · Y: camera · Back: restart' : MOBILE ? 'Pick a track and a car · tap START' : pickRace ? 'Pick a track and a car · Enter or click START' : 'Pick a track and a car · Enter or click START · B: back to the lab';
    rd.box.classList.add('on');
  }

  function drawBrawlHud(now: number) {
    const B = brawl!, pf = brawlPlayer();
    if (!pf) return;
    const st = B.standings();
    const tag = (f: Fighter) => f.down ? ` <i class="x">${f.down.why === 'off' ? 'OUT' : f.down.why === 'ko' ? 'WRECK' : 'STUCK'}</i>`
      : B.over ? (f.place === 1 ? ' <i>WIN</i>' : '')
      : f.stuckSince !== undefined && now - f.stuckSince >= 1000 ? ` <i class="x">STUCK ${Math.max(1, Math.ceil((BIG.stuckMs - (now - f.stuckSince)) / 1000))}</i>` : '';
    if (MOBILE) {
      const t = tally[pf.id] ?? newTally(), net = Math.round(t.count);
      const lit = now - crashFlash < 900 ? ' crash' : now - cubePulse < 350 ? ' lit' : '';
      rr.hud.innerHTML = `<b class="mp">${pointsOf(pf)}<span>${bigTarget ? `/${bigTarget}` : ''} PTS</span></b> · <b>${clock(B.timeLeft)}</b> · <span class="mc${lit}">${CUBE_ICON}<b>${signed(net)}</b></span>`;
    } else
    rr.hud.innerHTML = `<div class="pos">${pointsOf(pf)}<span>${bigTarget ? ` / ${bigTarget}` : ''} PTS</span></div>`
      + `<div>KOs <b>${kosOf(pf)}</b>${bigTarget ? '' : ' &nbsp; <span style="color:#8fa3ad">no target (T)</span>'}</div>`
      + `<div>TIME <b>${clock(B.timeLeft)}</b> &nbsp; DMG <b>${dmgOf(pf)}</b>${bigPractice ? ' &nbsp; <b style="color:#36f1ff">PRACTICE</b>' : ''}</div>`
      + cubeLine(pf, now)
      + upg.hud(pf.id, now);
    drawPodium(st, now, tag);   // v0.50 the KO tracker (replaces the standings list)
    // minimap: the box + the bots
    const cv = rr.map, g = cv.getContext('2d');
    if (!g) return;
    const pad = 10, side = Math.min(cv.width, cv.height) - pad * 2, k = side / (bigBox.half * 2);
    const ox = (cv.width - side) / 2, oy = (cv.height - side) / 2;
    const X = (x: number) => ox + (x - bigBox.center.x + bigBox.half) * k, Y = (z: number) => oy + side - (z - bigBox.center.z + bigBox.half) * k;
    g.clearRect(0, 0, cv.width, cv.height);
    g.fillStyle = 'rgba(20,26,30,.85)'; g.fillRect(ox, oy, side, side);
    g.strokeStyle = 'rgba(0,229,255,.7)'; g.lineWidth = 1.5; g.strokeRect(ox, oy, side, side);
    for (const f of [...B.racers].sort((a, c) => Number(a.human) - Number(c.human))) {
      if (f.down) continue;
      const p = f.bot.root.position;
      g.fillStyle = f.paint; g.beginPath(); g.arc(X(p.x), Y(p.z), f.human ? 5 : 3.5, 0, Math.PI * 2); g.fill();
      if (f.human) { g.strokeStyle = '#fff'; g.lineWidth = 1.5; g.stroke(); }
    }
  }

  /** v0.50 KO tracker: a simple podium at the top (2nd 1st 3rd 4th), steps sized + coloured by place (tied KOs share
   *  a place); your name + count bold and twice as big. Testers' "name" is YOU (their car is a preset, a rival may share it). */
  function drawPodium(st: Fighter[], now: number, tag: (f: Fighter) => string) {
    podEl.style.display = 'flex';
    const order = [st[1], st[0], st[2], st[3]].filter(Boolean);
    podEl.innerHTML = order.map(f => {
      const r = koRank(f), c = POD_COL[r - 1] ?? POD_COL[3];
      const name = f.human ? (pickRace ? 'YOU' : f.name) : f.name;
      return `<div class="pd${f.human ? ' me' : ''}" style="--c:${c}">`
        + `<div class="pn">${name}${tag(f)}</div><div class="pk">${pointsOf(f)}</div>`
        + `<div class="ps" style="height:${[46, 34, 24, 15][r - 1] ?? 15}px">${ordinal(r)}</div></div>`;
    }).join('');
  }

  function showBrawlResults() {
    const B = brawl!;
    rrTitle.textContent = 'BATTLE RESULTS';
    const st = B.standings();
    rr.table.innerHTML = `<tr><th></th><th>BOT</th><th>POINTS</th><th>KOs</th><th>DAMAGE</th><th>CUBES</th></tr>` + st.map((f, i) => {
      const c = f.human && paid ? paid.total : brawlReward(f).total;
      return `<tr class="${f.human ? 'you' : ''}"><td>${ordinal(f.place ?? i + 1)}</td><td style="color:${f.paint}">${f.name}${f.human ? ' (YOU)' : ''}</td><td>${pointsOf(f)}${f.place === 1 ? ' · WINNER' : ''}</td><td>${kosOf(f)}</td><td>${dmgOf(f)}</td><td class="${c < 0 ? 'neg' : 'pos'}">${signed(c)}${f.place === undefined ? '…' : ''}</td></tr>`;
    }).join('');
    const p = paid;
    if (MOBILE && p) {
      rr.cubes.innerHTML = `<div class="rw-line">${CUBE_ICON}${ordinal(p.place)} ${signed(p.placeCubes)} · dmg ${signed(p.dmgCubes)} · kept ${signed(p.kept)} = <b>${signed(p.total)}</b> · wallet <b>${walletAfter}</b></div>`;
    } else rr.cubes.innerHTML = p ? `<div class="rw-h">${CUBE_ICON}YOUR CUBES</div><table class="rw">`
      + `<tr><td>PLACE</td><td>${ordinal(p.place)}</td><td>${signed(p.placeCubes)}</td></tr>`
      + `<tr><td>DAMAGE</td><td>${p.dmg} cubes knocked off${p.kos ? ` · ${p.kos} KO × ${REWARD.koBonus}` : ''}</td><td>${signed(p.dmgCubes)}</td></tr>`
      + `<tr><td>KEPT</td><td>+${p.got} vacuumed −${p.lost} knocked off${p.crashes ? ' · out = back to 0' : ''}</td><td>${signed(p.kept)}</td></tr>`
      + `<tr class="tot"><td>BATTLE</td><td></td><td>${signed(p.total)}</td></tr>`
      + `<tr class="tot"><td>WALLET</td><td></td><td>${walletAfter}</td></tr></table>` : '';
    rr.box.classList.add('on');
  }

  /** skipCard (v0.37 tester): started from the results screen's START -- straight to 3-2-1. */
  function startRace(skipCard = false) {
    if (!raceBuild) return;
    if (raceTrack === BIG_ID) { startBrawl(skipCard); return; }   // v0.49 Big Arena
    leaveCourse();
    if (brawl) { endBrawl(); fx.clear(); }
    if (mode === 'race') { race.dispose(); bots = []; fx.clear(); } else clearBots();
    clearLoot(); LOOT.on = true; tally = {}; paid = null; cubePulse = 0;   // v0.38
    race.setVisible(false);
    race = races[raceTrack === 'random' ? TRACK_IDS[Math.floor(Math.random() * TRACK_IDS.length)] : raceTrack as TrackId] ?? races.gp;   // v0.35
    mapOutline = race.outline();
    applyTrackTheme(race);
    mode = 'race';
    document.body.classList.add('inrace');
    rr.box.classList.remove('on'); raceShown = -1;
    hud.hideWinner(); hud.clearSign();   // v0.34i no leftover sign from the last race
    setArenaVisible(false); course.setVisible(false); race.setVisible(true);
    // three different AI rivals from the presets -- v0.51 (user) never the same bot as yours
    const names = rivalPresets();
    combat = new Combat([], fx);
    DRIVE.raceSpeed = 2 * raceSpeedMul;   // v0.34 race only: x2 speed (bots are built with it); v0.34d x race speed slider (1-3)
    DRIVE.raceWeaponsNeutral = true;   // v0.34 race only: weapons don't change the driving
    DRIVE.raceSteer = true;            // v0.34c race only: speed-sensitive steering + heading hold
    DRIVE.raceArcade = true;           // v0.34f race only: turn-rate steering + sideways grip (race.ts)
    rampT = 0; rampDir = 0;
    upg.reset(race);   // v0.40 fresh SCRAP meters + boxes
    race.begin([
      { id: 'A', human: true, build: raceBuild },
      ...names.map((n, i) => ({ id: RIVAL_IDS[i], human: false, build: JSON.parse(JSON.stringify(PRESETS[n])) as BotBuild })),
    ], catalog, combat, raceDiff, {
      onSpawn: b => { castShadows(shadows, botMeshes(b)); skinBot(b, shadows); upg.attach(b); },   // v0.40 upgrades back on
      sign: (t, ms, c) => hud.sign(t, ms, c),
      onCrash: (r, _why, koBy) => {   // v0.47 crash: this race's count goes back to 0; the rival whose hit wrecked it gets the KO bonus
        if (phase !== 'fight' || r.finished !== undefined) return;
        const t = (tally[r.id] ??= newTally()); t.count = 0; t.crashes++;
        if (koBy && koBy !== r.id && inRace(koBy)) {
          (tally[koBy] ??= newTally()).kos++;
          if (race.player()?.id === koBy) hud.sign(`KO! +${REWARD.koBonus}`, 1300, '#00e5ff');
        }
        if (r.human) crashFlash = performance.now();
      },
    });
    bots = race.bots();
    for (const b of bots) combat.replaceBot(undefined, b);
    over = false; camFocus = null;
    phase = 'ready'; rd.count.className = '';
    const p = race.player()!.bot;
    cam.target = p.root.position.clone(); cam.radius = camCtl.radius(raceCamR());
    if (MOBILE && camCtl.view === 'chase') cam.beta = Math.min(cam.beta, PHONE_CAM.maxBeta);   // v0.41 phone: a bit higher
    sun.position = p.root.position.add(SUN_OFFSET);
    drawRaceHud(performance.now(), true);
    if (!skipCard) showRaceReady();   // v0.37 track + car pickers before every START (first load, R); v0.48 every race
    else goCountdown();
    canvas.focus();
  }
  function leaveRace() {
    DRIVE.raceSpeed = 1;   // v0.34: arena / course / lab at normal speed
    DRIVE.raceWeaponsNeutral = false;
    DRIVE.raceSteer = false;
    DRIVE.raceArcade = false;
    if (mode !== 'race') return;
    endBrawl();   // v0.49
    race.dispose(); bots = []; fx.clear(); fx.focus = null; hud.clearSign();   // v0.34i
    upg.clear();   // v0.40
    clearLoot(); LOOT.on = false;   // v0.38
    mode = 'match';
    document.body.classList.remove('inrace');
    rr.box.classList.remove('on'); raceShown = -1;
    rd.box.classList.remove('on'); rd.count.className = '';
    race.setVisible(false); setArenaVisible(true);
    applyTrackTheme(null);   // v0.35
    sun.position = SUN_OFFSET.clone();
    cam.target = new Vector3(0, 0.5, 0); cam.radius = camCtl.radius(16);
  }
  function showRaceReady() {
    if (brawl) { showBrawlReady(); return; }   // v0.49
    const p = race.player()!.bot;
    const pad = padConnected();   // v0.43 controller connected: its layout on the card
    rd.title.innerHTML = `${race.def.name.toUpperCase()} <span class="vs">${RACE.laps} LAPS · 4 BOTS</span>`;   // v0.35 track name
    const rows: [string, string][] = [
      ['DRIVE', pad ? 'Controller: RT gas · LT brake, then reverse · left stick steers' : MOBILE ? 'It drives itself forward: ◀ ▶ steer (tap = small turn, hold = full turn) · BRAKE held = slow down, then reverse' : 'W A S D (or gamepad left stick)'],   // v0.39 phone; v0.41 ◀ ▶
      ['WEAPON', pad ? p.weapon.hint('A') + ' — weapons are on' : MOBILE ? 'Fires on its own when a bot is close in front of you' : p.weapon.hint('SPACE') + ' — weapons are on'],   // v0.41 phone auto-fire
      ['TO WIN', `First across the line after ${RACE.laps} laps. Hit, flip and wreck the others on the way.`],
      ['WRECKED', 'Destroyed, or off the track (into the pit, over a wall): back at the last checkpoint in 2 s, repaired.'],
      ['STUCK', 'Can\'t drive, or barely moving for 4 s (upside down, wedged, pinned): towed back to the last checkpoint, repaired.'],
      ['DAMAGE', `DMG = cubes you knock off the other bots (+${REWARD.koBonus} for each one your hits wreck). Hazards count for nobody.`],   // v0.47
      ['CUBES', `Your bot's cubes are your money. This race's count starts at 0: +1 for each loose cube you vacuum up (they repair you too), −1 for each one knocked off you, never below 0. Crash (wrecked, off the track, into the lava) = back to 0. At the line you keep your count and earn cubes for place, damage, time and a clean race (+${REWARD.clean}, no crashes).`],   // v0.38; v0.47
      ['UPGRADES', 'Vacuumed cubes, laps (more for the back of the pack), damage and the gold SCRAP boxes fill your SCRAP meter: 25 = MOTOR, 60 = ARMOR plating, 100 = WEAPON power, 150 = a spiked RAM on your back that punches the first bot to get close behind you (once). Upgrades are cubes: hits knock them off. 25 more scrap rebuilds a lost one. Wrecked = all lost.'],   // v0.40
      ['TRACK', race.def.desc],   // v0.35
      ['WALLET', `${CUBE_ICON}<b class="cubes">${walletCubes()}</b> cubes · par ${fmtTime(parFor())}`],   // v0.38
      pad ? ['BUTTONS', 'Y: camera · Back / View: restart'] : MOBILE ? ['BUTTONS', 'CAM: change the view · RESTART: start over'] : ['KEYS', pickRace ? 'R: restart · Q: camera' : 'R: restart · B: lab · Q: camera'],
    ];
    // v0.37 tester: full card on the first race; after that just the track line (the pickers are what matter)
    // v0.39 phone: a short card that fits a landscape phone (pickers, how to drive, wallet)
    const shown = MOBILE ? rows.filter(([k]) => (raceSeen ? ['WALLET'] : ['DRIVE', 'WEAPON', 'WALLET'])   /* v0.40: no room for UPGRADES on a phone card */.includes(k))
      : raceSeen ? rows.filter(([k]) => k === 'TRACK' || k === 'WALLET') : rows;
    rd.table.innerHTML = shown.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('');
    rd.start.style.display = '';
    rd.small.textContent = pad ? 'LB / RB: track · D-pad ◀ ▶: car · A or Start: START · Y: camera · Back: restart' : MOBILE ? 'Pick a track and a car · tap START' : pickRace ? 'Pick a track and a car · Enter or click START' : 'Pick a track and a car · Enter or click START · B: back to the lab';   // v0.48 pickers in every race
    rd.box.classList.add('on');
  }
  /** v0.41 phone race camera distance (11 = the desktop race camera). */
  function raceCamR() { return MOBILE ? 11 * PHONE_CAM.zoom : 11; }
  /** v0.39 phone race drive: auto-gas (BRAKE held = brake / reverse).
   *  v0.41 (user): ◀ ▶ buttons steer (with the keyboard steering ramp: tap = small turn, hold = full turn);
   *  no FIRE button -- the weapon fires on its own when a bot is close in front (race.autoFire). */
  function phoneDrive(r: Racer, dt: number): Drive {
    if (padConnected()) return steerRamp(readDrive('A', true), dt);   // v0.43 controller on a phone: no auto-gas / auto-fire
    const d = steerRamp(readDrive('A'), dt);
    return { throttle: TOUCH.brake ? -1 : 1, turn: d.turn, fire: d.fire || race.autoFire(r) };
  }

  /** v0.34c race only (user): keyboard steering ramp. A tap turns at RAMP.start, holding builds to full turn over
   *  RAMP.fullS; letting go (or switching side) resets it. A gamepad stick below the ramp is left as it is. */
  const RAMP = { start: 0.4, fullS: 0.3 };
  let rampT = 0, rampDir = 0;
  function steerRamp(d: Drive, dt: number): Drive {
    const dir = Math.sign(d.turn);
    if (dir === 0) { rampT = 0; rampDir = 0; return d; }
    if (dir !== rampDir) { rampT = 0; rampDir = dir; }
    rampT += dt;
    const cap = Math.min(1, RAMP.start + (1 - RAMP.start) * rampT / RAMP.fullS);
    return { ...d, turn: dir * Math.min(Math.abs(d.turn), cap) };
  }

  /** v0.34h safety net: a NaN camera target / angle / zoom never recovers on its own (black 3D view while the game runs).
   *  Snap back onto `aim` and report it once (yellow console warning). */
  let camWarned = false;
  function camGuard(aim: Vector3, where: string) {
    const t = cam.target, ok = (n: number) => Number.isFinite(n);
    if (ok(t.x) && ok(t.y) && ok(t.z) && ok(cam.alpha) && ok(cam.beta) && ok(cam.radius)) return;
    if (!camWarned) { camWarned = true; console.warn(`[v0.34h] camera had a bad number (${where}) -- reset`, { target: t.asArray(), alpha: cam.alpha, beta: cam.beta, radius: cam.radius, aim: aim.asArray() }); }
    cam.target = ok(aim.x) && ok(aim.y) && ok(aim.z) ? aim.clone() : new Vector3(0, 0.5, 0);
    if (!ok(cam.alpha)) cam.alpha = -Math.PI / 2;
    if (!ok(cam.beta)) cam.beta = 1.2;
    if (!ok(cam.radius)) cam.radius = 11;
  }

  /** One frame of the race. */
  function raceFrame(dt: number, now: number) {
    const rNow = isDown('KeyR'), rPress = rNow && !rWas; rWas = rNow;
    if (rPress) { startRace(); return; }
    if (!MOBILE && isDown('KeyB')) { leaveRace(); openLab(); return; }   // v0.46 B opens the lab from any race (not shown on the picker race)
    if (brawl) { brawlFrame(dt, now); return; }   // v0.49 Big Arena
    helpEl.innerHTML = `WASD drive &nbsp;·&nbsp; SPACE weapon &nbsp;·&nbsp; Q camera &nbsp;·&nbsp; R restart` + (pickRace ? '' : ` &nbsp;·&nbsp; B lab`);
    if (phase === 'countdown' && tickCountdown(now)) phase = 'fight';
    const waiting = phase !== 'fight';
    scene.getPhysicsEngine()?.setTimeStep(PHYS_STEP);
    for (const r of race.racers) {
      if (r.down || r.bot.eliminated) continue;
      const d: Drive = waiting ? { throttle: 0, turn: 0, fire: false } : r.human && !RACE_TEST.autopilot ? (MOBILE ? phoneDrive(r, dt) : steerRamp(readDrive('A', true), dt))   /* v0.43 race: RT gas / LT brake */ : race.aiDrive(r, dt);
      runBot(r.bot, d, dt, now, waiting, false, phase === 'countdown');
    }
    race.update(dt, now, !waiting);
    upg.update(dt, race, combat, !waiting);   // v0.40 scrap: laps, damage, boxes; wrecks; the ram
    if (race.def.theme.fog) { const f = race.flash; hemi.intensity = race.def.theme.hemi + f * 1.6; sun.intensity = race.def.theme.sun + f * 0.8; }   // v0.36 lightning
    bots = race.bots();
    const pr = race.player()!;
    const target = pr.down ? (pr.bot.eliminated?.pos ?? pr.bot.root.position) : pr.bot.root.position;
    cam.target = Vector3.Lerp(cam.target, target, 0.1).add(fx.shakeOffset());
    camGuard(target, 'race');   // v0.34h
    cam.radius += (camCtl.radius(raceCamR()) - cam.radius) * 0.05;
    if (!pr.down) camCtl.chase(pr.bot.root.rotationQuaternion, dt);
    sun.position = target.add(SUN_OFFSET);
    fx.focus = target;
    fx.update(dt, cam);
    drawRaceHud(now);
    // v0.38 the player's race reward goes into the wallet the moment they cross the line
    if (race.playerFinishedAt > 0 && !paid) {
      paid = rewardOf(pr);
      walletAfter = payWallet(paid.total);
      hud.sign(`${signed(paid.total)} CUBES`, 1800, paid.total >= 0 ? '#39ff14' : '#ff4d4d');
    }
    if (race.playerFinishedAt > 0 && now - race.playerFinishedAt > 1500 && (raceShown < 0 || now - raceShown > 500)) showRaceResults(now);
  }

  /** Race HUD (position, lap, times, order) + minimap. Redrawn ~10x a second. */
  let mapOutline = race.outline();   // v0.35 redone when the track changes (startRace)
  function drawRaceHud(now: number, force = false) {
    if (!force && now - raceHudAt < 90) return;
    raceHudAt = now;
    if (brawl) { drawBrawlHud(now); return; }   // v0.49
    const st = race.standings(), pr = race.player();
    if (!pr) return;
    const pos = st.indexOf(pr) + 1;
    const best = pr.lapTimes.length ? fmtTime(Math.min(...pr.lapTimes)) : '—';
    const last = pr.lapTimes.length ? fmtTime(pr.lapTimes[pr.lapTimes.length - 1]) : '—';
    const stuck = (r: Racer) => r.stuckSince !== undefined && now - r.stuckSince >= 1000 ? ` <i class="x">STUCK ${Math.max(1, Math.ceil((RACE.stuckMs - (now - r.stuckSince)) / 1000))}</i>` : '';
    const tag = (r: Racer) => r.finished !== undefined ? ' <i>FIN</i>' : r.down ? ` <i class="x">${r.down.why === 'stuck' ? 'TOWED' : 'WRECK'}</i>` : stuck(r);
    const dmg = dmgOf;   // v0.47 damage score in cubes (was v0.34 HP points)
    if (MOBILE) {   // v0.42 phone (user): one small line at the bottom between the buttons -- place, lap, time, this race's cubes
      const t = tally[pr.id] ?? newTally(), net = Math.round(t.count);   // v0.47 the race count
      const lit = now - crashFlash < 900 ? ' crash' : now - cubePulse < 350 ? ' lit' : '';
      rr.hud.innerHTML = `<b class="mp">${ordinal(pos)}<span>/${st.length}</span></b> · LAP <b>${pr.finished !== undefined ? RACE.laps : race.lap(pr)}/${RACE.laps}</b>`
        + ` · <b>${fmtTime(pr.finished ?? race.t)}</b> · <span class="mc${lit}">${CUBE_ICON}<b>${signed(net)}</b></span>`;
    } else
    rr.hud.innerHTML = `<div class="pos">${ordinal(pos)}<span> / ${st.length}</span></div>`
      + `<div>LAP <b>${pr.finished !== undefined ? RACE.laps : race.lap(pr)} / ${RACE.laps}</b> &nbsp; TIME <b>${fmtTime(pr.finished ?? race.t)}</b></div>`
      + `<div>LAST <b>${last}</b> &nbsp; BEST <b>${best}</b> &nbsp; DMG <b>${dmg(pr)}</b></div>`
      + cubeLine(pr, now)   // v0.38
      + upg.hud(pr.id, now)   // v0.40
      + (pr.draft !== undefined ? `<div class="draft">SLIPSTREAM ▲ BOOST</div>` : '')   // v0.35 oval
      + `<ol>${st.map(r => `<li style="color:${r.paint}">${r.name}${r.human ? ' <b>(YOU)</b>' : ''} <span class="dmg">${dmg(r)}</span>${tag(r)}</li>`).join('')}</ol>`;
    // minimap
    const cv = rr.map, g = cv.getContext('2d');
    if (!g) return;
    const b = race.bounds, pad = 8, sx = (cv.width - pad * 2) / (b.x1 - b.x0), sz = (cv.height - pad * 2) / (b.z1 - b.z0), k = Math.min(sx, sz);
    const X = (x: number) => pad + (x - b.x0) * k, Y = (z: number) => cv.height - pad - (z - b.z0) * k;
    g.clearRect(0, 0, cv.width, cv.height);
    g.lineWidth = race.width * k; g.lineJoin = 'round'; g.strokeStyle = 'rgba(60,72,82,.9)';
    g.beginPath(); mapOutline.forEach((p, i) => i ? g.lineTo(X(p.x), Y(p.z)) : g.moveTo(X(p.x), Y(p.z))); g.closePath(); g.stroke();
    g.lineWidth = 1; g.strokeStyle = 'rgba(0,229,255,.6)'; g.stroke();
    const f = race.samples[0];
    g.strokeStyle = '#fff'; g.lineWidth = 2; g.beginPath();
    g.moveTo(X(f.x - Math.sin(f.h) * 4), Y(f.z + Math.cos(f.h) * 4)); g.lineTo(X(f.x + Math.sin(f.h) * 4), Y(f.z - Math.cos(f.h) * 4)); g.stroke();
    for (const r of [...race.racers].sort((a, c) => Number(a.human) - Number(c.human))) {
      if (r.down) continue;
      const p = r.bot.root.position;
      g.fillStyle = r.paint; g.beginPath(); g.arc(X(p.x - race.origin.x), Y(p.z - race.origin.z), r.human ? 5 : 3.5, 0, Math.PI * 2); g.fill();
      if (r.human) { g.strokeStyle = '#fff'; g.lineWidth = 1.5; g.stroke(); }
    }
  }

  /** v0.38 HUD: this race's cubes so far (collected, lost, net) + the wallet. */
  function cubeLine(pr: { id: string }, now: number): string {
    // v0.47 the race count (never below 0, a crash = 0) + the totals in small
    const t = tally[pr.id] ?? newTally(), got = Math.round(t.got), lost = Math.round(t.lost), cnt = Math.round(t.count);
    const lit = now - crashFlash < 900 ? ' crash' : now - cubePulse < 350 ? ' lit' : '';
    return `<div class="cubeln${lit}">${CUBE_ICON}CUBES <b>${cnt}</b> <span class="wal"><b class="g">+${got}</b> <b class="l">−${lost}</b>${t.crashes ? ` · ${t.crashes} crash${t.crashes > 1 ? 'es' : ''}` : ''}</span> &nbsp; <span class="wal">WALLET ${paid ? walletAfter : walletCubes()}</span></div>`;
  }

  function showRaceResults(now: number) {
    raceShown = now;
    rrTitle.textContent = 'RACE RESULTS';
    const next = brawl ? 'battle' : 'race';   // v0.49 Big Arena: "next battle"
    rrKeys.textContent = MOBILE ? `START: next ${next}` : `Enter or START: next ${next} · R: restart` + (pickRace ? '' : ' · B: lab');
    if (brawl) { showBrawlResults(); return; }   // v0.49
    const st = race.standings();
    // v0.38 CUBES = each bot's race reward (still-racing bots: so far, no time bonus yet)
    rr.table.innerHTML = `<tr><th></th><th>BOT</th><th>TIME</th><th>BEST LAP</th><th>DAMAGE</th><th>CUBES</th></tr>` + st.map((r, i) => {
      const t = r.finished !== undefined ? fmtTime(r.finished) : `racing — lap ${race.lap(r)}`;
      const best = r.lapTimes.length ? fmtTime(Math.min(...r.lapTimes)) : '—';
      const c = r.human && paid ? paid.total : rewardOf(r).total;
      return `<tr class="${r.human ? 'you' : ''}"><td>${ordinal(i + 1)}</td><td style="color:${r.paint}">${r.name}${r.human ? ' (YOU)' : ''}</td><td>${t}</td><td>${best}</td><td>${dmgOf(r)}</td><td class="${c < 0 ? 'neg' : 'pos'}">${signed(c)}${r.finished === undefined ? '…' : ''}</td></tr>`;
    }).join('');
    // v0.38 your reward, line by line, and the wallet
    const p = paid;
    if (MOBILE && p) {   // v0.39 phone: one line so START fits on the screen
      rr.cubes.innerHTML = `<div class="rw-line">${CUBE_ICON}${ordinal(p.place)} ${signed(p.placeCubes)} · dmg ${signed(p.dmgCubes)} · time ${signed(p.timeCubes)} · clean ${signed(p.cleanCubes)} · kept ${signed(p.kept)} = <b>${signed(p.total)}</b> · wallet <b>${walletAfter}</b></div>`;
      rr.box.classList.add('on');
      return;
    }
    rr.cubes.innerHTML = p ? `<div class="rw-h">${CUBE_ICON}YOUR CUBES</div><table class="rw">`
      + `<tr><td>PLACE</td><td>${ordinal(p.place)}</td><td>${signed(p.placeCubes)}</td></tr>`
      + `<tr><td>DAMAGE</td><td>${p.dmg} cubes knocked off${p.kos ? ` · ${p.kos} KO × ${REWARD.koBonus}` : ''}</td><td>${signed(p.dmgCubes)}</td></tr>`   // v0.47
      + `<tr><td>TIME</td><td>${p.under > 0 ? `${p.under.toFixed(1)} s under par` : `par ${fmtTime(parFor())}`}</td><td>${signed(p.timeCubes)}</td></tr>`
      + `<tr><td>CLEAN RACE</td><td>${p.clean ? 'no crashes' : `${p.crashes} crash${p.crashes > 1 ? 'es' : ''}`}</td><td>${signed(p.cleanCubes)}</td></tr>`   // v0.47
      + `<tr><td>KEPT</td><td>+${p.got} vacuumed −${p.lost} knocked off${p.crashes ? ' · crash = back to 0' : ''}</td><td>${signed(p.kept)}</td></tr>`
      + `<tr class="tot"><td>RACE</td><td></td><td>${signed(p.total)}</td></tr>`
      + `<tr class="tot"><td>WALLET</td><td></td><td>${walletAfter}</td></tr></table>` : '';
    rr.box.classList.add('on');
  }

  // v0.50 (user) start screen: a chooser -- BATTLE ROYAL = the Big Arena, RACE MODE = the race start card (pickers)
  let modeSel = 0;
  const modeBtns = Array.from(modeEl.querySelectorAll('button')) as HTMLButtonElement[];
  const modeHi = () => modeBtns.forEach((b, i) => b.classList.toggle('hi', i === modeSel));
  function chooseMode(i: number) {
    modeEl.classList.remove('on'); document.body.classList.remove('choosing');
    const battle = i === 0, now = raceTrack === BIG_ID;
    if (battle !== now) {
      raceTrack = battle ? BIG_ID : TESTER_SET.track;
      sync();
      try { localStorage.setItem(TESTER_KEY, JSON.stringify({ track: raceTrack, car: testerCar })); } catch { /* ignore */ }
      startRace();
    } else showRaceReady();
    canvas.focus();
  }
  modeBtns.forEach((b, i) => { b.onclick = () => { goFullscreen(); chooseMode(i); }; b.onmouseenter = () => { modeSel = i; modeHi(); }; });
  window.addEventListener('keydown', e => {
    if (!modeEl.classList.contains('on') || e.repeat) return;
    if (['ArrowLeft', 'KeyA', 'Digit1'].includes(e.code)) { modeSel = 0; modeHi(); if (e.code === 'Digit1') chooseMode(0); }
    else if (['ArrowRight', 'KeyD', 'Digit2'].includes(e.code)) { modeSel = 1; modeHi(); if (e.code === 'Digit2') chooseMode(1); }
    else if (e.code === 'Enter' || e.code === 'NumpadEnter') { e.preventDefault(); chooseMode(modeSel); }
  });
  onPadButton(btn => {
    if (!modeEl.classList.contains('on')) return;
    if (btn === 14 || btn === 15) { modeSel = btn === 14 ? 0 : 1; modeHi(); }
    else if (btn === 0) chooseMode(modeSel);   // A (Start already presses Enter)
  });
  if (TESTER) {   // v0.37 tester version: the start card; v0.50 the chooser first (the last pick is built behind it)
    startRace();
    rd.box.classList.remove('on');
    modeSel = raceTrack === BIG_ID ? 0 : 1; modeHi();
    modeEl.classList.add('on'); document.body.classList.add('choosing');
  } else openLab();
  // v0.33 test aids (not advertised): ?race=<preset> jumps straight into a race with that bot; &autopilot=1 lets the AI
  // drive your bot too. window.__bb exposes the race for the sandbox test runs.
  const qs = new URLSearchParams(location.search);
  RACE_TEST.autopilot = qs.get('autopilot') === '1';
  if (qs.get('race') && PRESETS[qs.get('race')!]) {
    builder.hide(); modeEl.classList.remove('on'); document.body.classList.remove('choosing');
    raceBuild = JSON.parse(JSON.stringify(PRESETS[qs.get('race')!])); raceDiff = (qs.get('ai') as Difficulty) ?? 'normal'; DRIVE.boost = Number(qs.get('boost') ?? 3); raceSpeedMul = Number(qs.get('racespeed') ?? 1);
    const qt = qs.get('track') as TrackPick | null; if (qt && (qt === 'random' || qt === BIG_ID || TRACK_IDS.includes(qt as TrackId))) raceTrack = qt;   // v0.35 &track=oval; v0.49 &track=bigarena
    raceSeen = true; startRace();
  }
  (window as unknown as { __bb: unknown }).__bb = { get race() { return race; }, get phase() { return phase; }, scene, cam,
    get tally() { return tally; }, get brawl() { return brawl; }, bigBox, get knockFree() { return knockFree; }, get paid() { return paid; }, upg, skinCount: (id: string) => { const r = race.racers.find(x => x.id === id); return r ? cubeSkinOf(r.bot.root)?.count : undefined; } };   // v0.38   // v0.35b scene + cam for sandbox screenshots   // v0.35 race changes with the track

  // v0.8 real spinner damage: weapon energy measured around every physics step
  scene.onBeforePhysicsObservable.add(() => {
    if (mode === 'course') { courseCombat?.beforePhysics(); course.beforePhysics(); } else combat?.beforePhysics();
    const stepDt = SUB_STEP_MS / 1000;   // v0.21: observers run once per physics sub-step
    const racing = mode === 'race';   // v0.34 race: no gyro / magnets (weapons don't change the driving); stabilizer instead
    for (const b of bots) if (!b.eliminated) { if (!racing) applyGyro(b, stepDt); armBefore(b); if (!racing) applyMagnets(b, stepDt); hingesBefore(b); wheelsBefore(b, stepDt); }   // v0.8 gyro; v0.11 arm + magnets; v0.12 hinges; v0.21 drive motors
    // v0.31 countdown: the weapons spin up but the bots stay where they were put (a spinning-up shell would turn its chassis)
    if (racing) { if (brawl) flatRacePhysics(bots, stepDt, BIG.origin.y, BIG.sideGrip, brawl.spinPrev); else race.beforePhysics(stepDt); }   // v0.49 Big Arena: race handling on its floor
    if (mode !== 'course' && phase === 'countdown') for (const b of bots) if (!b.eliminated) {
      const w = b.body.getAngularVelocity(); b.body.setAngularVelocity(new Vector3(w.x, 0, w.z));
    }
  });
  scene.onAfterPhysicsObservable.add(() => {
    const stepDt = SUB_STEP_MS / 1000;
    if (mode === 'course') courseCombat?.afterPhysics(stepDt); else combat?.afterPhysics(stepDt);
    for (const b of bots) if (!b.eliminated) armAfter(b, stepDt);   // v0.11 reactionless hammer
    if (mode === 'race') { if (brawl) raceSpinGiveBack(brawl.spinPrev); else race.afterPhysics(); }   // v0.34 race: spinner spin-up doesn't twist the chassis
    if (mode === 'course' && bots.length) course.afterPhysics();     // v0.23: timing lines + readouts, every sub-step
  });

  // ---------------- v0.49b BARRIER PROBE (test aid, not advertised): K = what is my bot touching / near? ----------------
  // Every collision involving your bot is logged (other body's name, motion type, shown / hidden, where). K shows the
  // last ones plus a ring of rays round the bot, in a box on screen and in the console.
  const probeLog: { t: number; txt: string }[] = [];
  const bodyInfo = (b: { transformNode?: { name: string; isEnabled(): boolean } ; getMotionType(): number } | undefined) => {
    if (!b) return '?';
    const n = b.transformNode, mt = ['STATIC', 'ANIMATED', 'DYNAMIC'][b.getMotionType()] ?? b.getMotionType();
    return `${n?.name ?? '(no node)'} ${mt}${n && !n.isEnabled() ? ' HIDDEN' : ''}`;
  };
  const myBodies = () => {
    const pb = brawl ? brawlPlayer()?.bot : race.player()?.bot ?? bots[0];
    if (!pb) return new Set<unknown>();
    return new Set<unknown>([pb.body, ...(pb.wheels ?? []).map(w => w.body), ...[pb.spinner, pb.arm, pb.saw, ...(pb.hinges ?? [])].filter(Boolean).map(w => w!.body)]);
  };
  havokPlugin.onCollisionObservable.add(ev => {
    const mine = myBodies();
    const a = ev.collider, c = ev.collidedAgainst;
    const other = mine.has(a) ? c : mine.has(c) ? a : undefined;
    if (!other || mine.has(other)) return;
    const name = other.transformNode?.name ?? '';
    if (/^(big)?[fF]loor$/.test(name)) return;   // the floor is always touching
    const pt = ev.point ? `${ev.point.x.toFixed(1)},${ev.point.y.toFixed(2)},${ev.point.z.toFixed(1)}` : '';
    probeLog.push({ t: performance.now(), txt: `${bodyInfo(other)} @ ${pt}` });
    if (probeLog.length > 40) probeLog.shift();
  });
  let probeBox: HTMLDivElement | null = null;
  function runProbe() {
    const pb = brawl ? brawlPlayer()?.bot : race.player()?.bot ?? bots[0];
    const lines: string[] = [];
    const now = performance.now();
    if (pb) {
      const P = pb.root.position;
      lines.push(`BOT ${pb.build.cosmetics.name} at ${P.x.toFixed(1)}, ${P.y.toFixed(2)}, ${P.z.toFixed(1)}  mode=${brawl ? 'bigarena' : mode}`);
      lines.push('— last hits (newest first, last 5 s) —');
      const recent = probeLog.filter(l => now - l.t < 5000).reverse();
      const seen = new Set<string>();
      for (const l of recent) { const k = l.txt.replace(/ @ .*/, ''); if (seen.has(k)) continue; seen.add(k); lines.push(`${((now - l.t) / 1000).toFixed(1)}s ago: ${l.txt}`); if (seen.size >= 10) break; }
      if (!recent.length) lines.push('(none)');
      lines.push('— rays round the bot (3 m) —');
      const pe = scene.getPhysicsEngine()!, mine = myBodies();
      const found = new Map<string, number>();
      for (const y of [0.08, 0.25, 0.6]) for (let k = 0; k < 24; k++) {
        const a = k / 24 * Math.PI * 2, d = new Vector3(Math.sin(a), 0, Math.cos(a));
        const from = new Vector3(P.x, y, P.z).addInPlace(d.scale(0.9));
        const r = pe.raycast(from, from.add(d.scale(3)));
        if (!r.hasHit || mine.has(r.body)) continue;
        const key = bodyInfo(r.body), dist = Vector3.Distance(new Vector3(P.x, y, P.z), r.hitPointWorld);
        if (!found.has(key) || found.get(key)! > dist) found.set(key, dist);
      }
      for (const [k, d] of found) lines.push(`${k}  ${d.toFixed(1)} m away`);
      if (!found.size) lines.push('(nothing)');
    } else lines.push('no bot');
    const txt = lines.join('\n');
    console.warn('[probe]\n' + txt);
    if (!probeBox) {
      probeBox = document.createElement('div');
      Object.assign(probeBox.style, { position: 'absolute', left: '50%', bottom: '70px', transform: 'translateX(-50%)', background: 'rgba(10,14,17,.92)', color: '#ffd23f', font: '12px/1.4 ui-monospace, Consolas, monospace', padding: '10px 14px', border: '1px solid #ffd23f', borderRadius: '4px', whiteSpace: 'pre', zIndex: '50', pointerEvents: 'none', maxWidth: '90vw', overflow: 'hidden' });
      document.body.appendChild(probeBox);
    }
    probeBox.textContent = txt + '\n(K again to refresh · J to close)';
    probeBox.style.display = '';
  }
  window.addEventListener('keydown', e => {
    if (e.repeat || inMenu()) return;
    if (e.code === 'KeyK') runProbe();
    else if (e.code === 'KeyT' && brawl) {   // v0.51 target points (Big Arena test aid): off -> 150 -> 300 -> 500 -> off
      const T = BIG.targets; bigTarget = T[(T.indexOf(bigTarget) + 1) % T.length];
      hud.sign(bigTarget ? `TARGET: ${bigTarget} POINTS` : 'TARGET OFF — MOST POINTS AT THE CLOCK', 1400, '#36f1ff');
      if (rd.box.classList.contains('on')) showRaceReady();
    }
    else if (e.code === 'KeyP' && brawl) {   // v0.49b practice toggle (Big Arena)
      bigPractice = !bigPractice;
      hud.sign(bigPractice ? 'PRACTICE ON — you respawn, no end' : 'PRACTICE OFF', 1400, '#36f1ff');
    }
    else if (e.code === 'KeyJ' && probeBox) probeBox.style.display = 'none';
  });

  let lastToggle = 0;
  // v0.19 HUD: V cycles the layout (top / bottom / left), H shows the test numbers. One press = one step
  // (key events, not polling); ignored while typing in the lab.
  window.addEventListener('keydown', e => {
    if (e.repeat || inMenu()) return;
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    if (mode === 'course') {                       // v0.23: C = back to the station picker
      if (e.code === 'KeyC' && !cm.menu.classList.contains('on')) showCourseMenu();
      return;
    }
    if (e.code === 'KeyI' && !e.repeat && mode === 'match' && !inMenu() && bots.length && phase !== 'ready') {   // v0.31
      if (rd.box.classList.contains('on')) rd.box.classList.remove('on'); else showReady(true);
    }
    if (e.code === 'KeyV') hud.cycleView();
    else if (e.code === 'KeyH') hud.toggleDetails();
  });
  scene.onBeforeRenderObservable.add(() => {
    const dt = engine.getDeltaTime() / 1000;
    if (mode === 'race') { if (bots.length) raceFrame(dt, performance.now()); return; }   // v0.33
    if (mode === 'course') {
      if (!bots.length) return;
      if (isDown('KeyR') && courseStation) { startStation(courseStation); return; }
      if (isDown('KeyB')) { leaveCourse(); openLab(); return; }
      courseFrame(dt, performance.now());
      return;
    }
    const rNow = isDown('KeyR'), rPress = rNow && !rWas; rWas = rNow;
    if (rNow) { if (rPress && phase !== 'ready') start(); return; }   // v0.30 restart; v0.31: once per press (no card after the first battle)
    if (isDown('KeyB')) { openLab(); return; }
    // T: player 2 on the arrows instead of the AI (test aid, not advertised)
    if (isDown('KeyT') && performance.now() - lastToggle > 400) {
      p2Human = !p2Human; lastToggle = performance.now();
      hud.sign(p2Human ? 'PLAYER 2: ARROWS + RIGHT SHIFT' : 'PLAYER 2: AI', 1200);
      if (phase === 'ready') showReady();
    }
    helpEl.innerHTML = `WASD drive &nbsp;·&nbsp; SPACE weapon &nbsp;·&nbsp; Q camera &nbsp;·&nbsp; R restart &nbsp;·&nbsp; B lab &nbsp;·&nbsp; I controls`;

    const now = performance.now();
    // v0.30 start screen + countdown: bots sit still, weapons off, clock waits
    if (phase === 'countdown' && tickCountdown(now)) phase = 'fight';
    const waiting = phase !== 'fight';
    scene.getPhysicsEngine()?.setTimeStep(PHYS_STEP);

    // Drive + weapons
    for (const b of bots) {
      if (b.eliminated) continue;                                 // frozen + hidden, nothing to drive
      const d: Drive = waiting ? { throttle: 0, turn: 0, fire: false }
        : b.id === 'A' || p2Human
        ? readDrive(b.id as 'A' | 'B')
        : (over ? { throttle: 0, turn: 0, fire: false } : aiDrive(b, bots[0], arena.half, dt, difficulty));
      runBot(b, d, dt, now, over || waiting, false, phase === 'countdown');
    }

    // Camera follows the midpoint of the bots still in play (+ hit shake) — unless a bot has gone
    // over the top of the cage and broken outside the footprint: then it follows that bot (and its
    // explosion) until OUT.camHoldMs after the last sighting.
    const live = bots.filter(b => !b.eliminated);
    const mid = live.length ? live.reduce((a, b) => a.add(b.root.position), Vector3.Zero()).scale(1 / live.length) : Vector3.Zero();
    const flyer = live.find(b => b.root.position.y > WALL_H && (Math.abs(b.root.position.x) > arena.half || Math.abs(b.root.position.z) > arena.half));
    if (flyer) camFocus = { pos: flyer.root.position.clone(), until: now + OUT.camHoldMs };
    const focusing = camFocus && now < camFocus.until;
    const chaseBot = camCtl.view === 'chase' && !bots[0].eliminated ? bots[0] : null;   // v0.24 CHASE: behind P1
    cam.target = Vector3.Lerp(cam.target, focusing ? camFocus!.pos : chaseBot ? chaseBot.root.position : mid, focusing ? OUT.camLerp : chaseBot ? 0.1 : 0.08).add(fx.shakeOffset());
    camGuard(chaseBot ? chaseBot.root.position : mid, 'arena');   // v0.34h
    const dist = live.length === 2 ? Vector3.Distance(live[0].root.position, live[1].root.position) : 0;
    cam.radius += (camCtl.radius(chaseBot ? 11 : 10 + dist * 0.9) - cam.radius) * 0.05;
    if (!focusing) camCtl.chase(chaseBot?.root.rotationQuaternion, dt);

    // OUT of the arena: past a wall plane and under the floor -> eliminated (explodes).
    const justOut = bots.filter(b => !b.eliminated && isOut(b));
    for (const b of justOut) eliminate(b, now);
    if (!over && justOut.length) {
      const w = bots.find(b => !b.eliminated);
      end(w ? `${w.build.cosmetics.name} WINS — ${justOut[0].build.cosmetics.name} OUT OF THE ARENA` : 'DOUBLE OUT — DRAW', w?.build.cosmetics.paint ?? '#fff');
    }

    fx.update(dt, cam);

    // Clock + end conditions
    if (!over && !waiting) {
      timeLeft = Math.max(0, timeLeft - dt);
      const dead = bots.filter(b => isDestroyed(b.state) && !b.eliminated);
      if (dead.length) {
        const w = bots.find(b => !isDestroyed(b.state));
        end(w ? `${w.build.cosmetics.name} WINS BY KO` : 'DOUBLE KO', w?.build.cosmetics.paint ?? '#fff');
        // v0.28 Cube Bots look: a KO'd bot is blown apart and its collider goes with it (nothing left to hit)
        for (const d of dead) if (cubeSkinOf(d.root)) {
          cubeKnockout(d);
          dropBot(d);
          d.eliminated = { t: now, pos: d.root.position.clone(), vel: Vector3.Zero(), reason: 'ko' };
        }
      } else if (timeLeft <= 0) {
        // Time-out: whoever took more damage (from any source) loses. Nothing else counts.
        const [a, b] = bots;
        const w: Bot | undefined = a.state.totalDamageTaken < b.state.totalDamageTaken ? a : b.state.totalDamageTaken < a.state.totalDamageTaken ? b : undefined;
        end(w ? `${w.build.cosmetics.name} WINS ON DAMAGE` : 'DRAW', w?.build.cosmetics.paint ?? '#fff');
      }
    }
    hud.update(bots, timeLeft, combat.stats, combat);
  });

  /** Drive + weapons for one bot this frame (match and test course). stopped = match over / run finished;
   *  inert = the course dummy (no self-right). */
  /** preSpin (v0.31): countdown -- spinners / the arm saw run up (with extra torque) while nothing else moves. */
  function runBot(b: Bot, d: Drive, dt: number, now: number, stopped: boolean, inert: boolean, preSpin = false) {
    const over = stopped;

    // Upside down? -- helpless until the self-right fires (the course dummy just lies there)
    if (!inert) updateInverted(b, now);
    // v0.12: a flipper can still fire upside down -- that's how it self-rights
    const flipper = b.hinges?.some(h => h.role === 'flipper') ?? false;
    b.weapon.suppressed = (!!b.inverted && !flipper) || !!b.rightingUntil;
    b.weapon.update(dt, d.fire && !over, canAttack(b.state));
    const helpless = !!b.inverted || !!b.rightingUntil;

    // v0.8 real spinner: the weapon motor drives a real body; spin level is measured, not timed
    if (b.spinner) {
      const motorAlive = (b.state.parts['weapon_motor']?.hp ?? 0) > 0;
      b.weapon.motorDead = !motorAlive;
      driveSpinner(b, b.weapon.spinning && !b.weapon.suppressed && canAttack(b.state), motorAlive, b.spinner, preSpin ? PRESPIN_BOOST : 1);
      b.weapon.spinLevel = Math.min(1, Math.max(0, spinOmega(b) / b.spinner.omegaMax));
    }
    // v0.10 real overhead arm: tap = swing, hold = pin; the saw on the arm spins whenever it can
    if (b.arm) {
      const motorAlive = (b.state.parts['weapon_motor']?.hp ?? 0) > 0;
      const usable = !b.weapon.suppressed && canAttack(b.state);
      b.weapon.motorDead = !motorAlive;
      driveArm(b, b.weapon.fireHeld, b.weapon.pressed, usable, motorAlive, dt);
      b.weapon.armState = b.arm.state;
      if (b.saw) driveSpinner(b, usable && (!over || preSpin), motorAlive, b.saw, preSpin ? PRESPIN_BOOST : 1);
    }

    // v0.12 real flipper: tap = fire (upside down = self-right shot into the floor)
    if (flipper) {
      const motorAlive = (b.state.parts['weapon_motor']?.hp ?? 0) > 0;
      b.weapon.motorDead = !motorAlive;
      const press = b.weapon.pressed || (!!b.inverted && b.id !== 'A' && !p2Human && mode !== 'course');   // the AI self-rights at once (v0.33: race too)
      driveFlipper(b, press, !b.rightingUntil && canAttack(b.state) && !over, motorAlive, !!b.inverted, dt);
    } else if (b.hinges) {
      // v0.12 real control weapon: hold = lift / clamp / crush
      const motorAlive = (b.state.parts['weapon_motor']?.hp ?? 0) > 0;
      b.weapon.motorDead = !motorAlive;
      driveControl(b, b.weapon.held, !b.weapon.suppressed && canAttack(b.state) && !over, motorAlive, dt);
    }

    // v0.21 real wheels: tank-mixed stick into each wheel's drive motor (wheelsBefore); tyre friction does the rest
    driveWheels(b, d.throttle, d.turn, !over && !helpless);

    // Grey out dead parts
    for (const [sid, m] of Object.entries(b.partMeshes)) {
      const ps = b.state.parts[sid];
      if (ps && ps.hp <= 0) {
        m.visibility = 0.25; for (const c of m.getChildMeshes()) c.visibility = 0.25;
        if (sid === 'wheels') for (const w of b.wheels ?? []) for (const c of [w.tyre, ...w.tyre.getChildMeshes()]) c.visibility = 0.25;   // v0.21 tyres live on their own bodies
      }
    }
  }

  function end(text: string, color: string) { over = true; hud.showWinner(text + (MOBILE ? '' : '  —  R: play again · B: lab'), color); }

  /** Track upside-down / self-righting for one bot. */
  function updateInverted(b: Bot, now: number) {
    const upDot = Vector3.Dot(upVector(b), Vector3.Up());

    // Self-right in progress: at snap time put the chassis back on its wheels (yaw kept).
    if (b.rightingUntil) {
      if (now >= b.rightingUntil) {
        const fwd = forward(b);
        const yaw = Math.atan2(fwd.x, fwd.z);
        b.body.disablePreStep = false;                           // let the mesh transform drive the body at the next physics step
                                                                 // (v0.21: re-enabled after physics, not after render -- physics runs before render, so the snap never applied)
        b.root.rotationQuaternion = Quaternion.RotationAxis(Vector3.Up(), yaw);
        b.body.setAngularVelocity(Vector3.Zero());
        scene.onAfterPhysicsObservable.addOnce(() => { b.body.disablePreStep = true; });
        snapSpinner(b, scene);                                   // weapon follows the chassis, keeps its spin
        b.rightingUntil = undefined;
        b.inverted = undefined;
      }
      return;
    }

    const vel = b.body.getLinearVelocity();
    const resting = Math.abs(vel.y) < INVERT.restVy && b.root.position.y < INVERT.restY;
    const upsideDown = upDot < INVERT.upDot && resting;

    if (!b.inverted) {
      if (upsideDown) {
        b.inverted = { since: now };
        if (mode === 'course') courseCombat?.onFlipped(b);
        else if (!over) combat.onFlipped(b);           // v0.19 arcade score: FLIP bonus to whoever put it there
        const flip = b.hinges?.some(h => h.role === 'flipper');
        if (mode !== 'race' || b.id === 'A') hud.sign(flip ? 'UPSIDE DOWN — FIRE THE FLIPPER!' : 'UPSIDE DOWN', flip ? 1200 : 700, '#ff9f43');   // v0.33 race: yours only
      }
      return;
    }
    if (!upsideDown && upDot > 0.5) { b.inverted = undefined; return; }   // got knocked back over
    const backup = b.hinges?.some(h => h.role === 'flipper') ? INVERT.flipperSelfRightMs : INVERT.selfRightMs;
    if (now - b.inverted.since >= backup) {
      // Scripted self-right: hop + roll, then snap upright at snapMs
      const fwd = forward(b); fwd.y = 0; fwd.normalize();
      b.body.setLinearVelocity(new Vector3(vel.x, INVERT.hopUp, vel.z));
      b.body.setAngularVelocity(fwd.scale(INVERT.roll));
      carryWheels(b);                                    // v0.21: the wheels roll with it
      b.rightingUntil = now + INVERT.snapMs;
      if (mode !== 'race' || b.id === 'A') hud.sign('SELF-RIGHT!', 700, '#4dd2ff');
    }
  }

  function isOut(b: Bot): boolean {
    const p = b.root.position, lim = arena.half + OUT.wallMargin;
    return (Math.abs(p.x) > lim || Math.abs(p.z) > lim) && p.y < OUT.belowFloor;
  }

  /** Knocked out of the arena: record the moment (animation hook), explode, freeze and hide the bot. */
  function eliminate(b: Bot, t: number) {
    b.eliminated = { t, pos: b.root.position.clone(), vel: b.body.getLinearVelocity().clone(), reason: 'out' };
    fx.explode(b, b.eliminated.pos);
    freezeBot(b);                                       // static (stops falling forever) + hidden; debris clones are what you see now
    camFocus = { pos: b.eliminated.pos, until: t + OUT.camHoldMs };   // watch the explosion
    hud.sign('OUT OF THE ARENA!', 1500, '#ff4d4d');
  }

  engine.runRenderLoop(() => {
    if (inMenu() || bots.length === 0) lab.render();
    else scene.render();
  });
  window.addEventListener('resize', () => engine.resize());
}

/** v0.18 in-match arena picker: neon colour + floor squares. Applies live, remembered in this browser. */
function setupArenaPicker(setStyle: (s: Partial<ArenaStyle>) => ArenaStyle, canvas: HTMLCanvasElement) {
  const KEY = 'bb-arena-style';
  const colourSel = document.getElementById('ar-colour') as HTMLSelectElement;
  const gridSel = document.getElementById('ar-grid') as HTMLSelectElement;
  colourSel.innerHTML = ARENA_COLOURS.map(c => `<option value="${c.id}">${c.label}</option>`).join('');
  gridSel.innerHTML = FLOOR_GRIDS.map(n => `<option value="${n}">${n} × ${n}</option>`).join('');
  let saved: Partial<ArenaStyle> = {};
  try { saved = JSON.parse(localStorage.getItem(KEY) ?? '{}'); } catch { /* ignore */ }
  const apply = (s: Partial<ArenaStyle>) => {
    const cur = setStyle(s);
    colourSel.value = cur.colour; gridSel.value = String(cur.grid);
    try { localStorage.setItem(KEY, JSON.stringify(cur)); } catch { /* ignore */ }
  };
  apply(saved);
  for (const sel of [colourSel, gridSel]) {
    sel.addEventListener('keydown', e => e.preventDefault());   // mouse only: WASD/arrows keep driving the bot
    sel.addEventListener('change', () => { apply({ colour: colourSel.value, grid: Number(gridSel.value) }); sel.blur(); canvas.focus(); });
  }
}

main().catch(err => { console.error(err); document.body.insertAdjacentHTML('beforeend', `<pre style="color:#f66;padding:20px">${err}</pre>`); });
