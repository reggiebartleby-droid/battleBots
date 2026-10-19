/// <reference types="vite/client" />
import './settings.js';   // v0.30: FIRST -- clears old saved settings once, before any module reads them
import {
  ArcRotateCamera, Color4, DirectionalLight, Engine, HavokPlugin, HemisphericLight, Quaternion, Scene, Vector3,
} from '@babylonjs/core';
import HavokPhysics from '@babylonjs/havok';
import type { BotBuild } from '../../src/core/types.js';
import { canAttack, isDestroyed } from '../../src/core/state.js';
import { catalog } from './catalog.js';
import { buildArena, WALL_H, ARENA_SIZE, ARENA_COLOURS, FLOOR_GRIDS, type ArenaStyle } from './arena.js';
import { buildBot, forward, upVector, driveSpinner, spinOmega, applyGyro, disposeBot, freezeBot, snapSpinner, driveArm, armBefore, armAfter, applyMagnets, driveFlipper, driveControl, hingesBefore, driveWheels, wheelsBefore, carryWheels, botMeshes, dropBot, DRIVE, type Bot } from './bot.js';
import { applyEnvironment, castShadows, makeShadows } from './look.js';
import { readDrive, isDown, KEYS, type Drive } from './input.js';
import { Combat } from './combat.js';
import { Hud } from './hud.js';
import { Fx } from './fx.js';
import { Lab } from './lab.js';
import { skinBot, cubeKnockout, cubeSkinOf, setDebrisFloors } from './cubes.js';
import { CamControl } from './cam.js';
import { Builder, PRESETS } from './builder.js';
import { Course, STATIONS, COURSE_ORIGIN, COURSE, type StationId, type RunResult } from './course.js';
import { aiDrive, type Difficulty } from './ai.js';
import { MOBILE, MobileMenu, setupTouchControls } from './mobile.js';
import { CUBES } from './cubes.js';
import { Race, RACE, RACE_ORIGIN, ordinal, fmtTime, type Racer } from './race.js';

const MATCH_SECONDS = 180;
const RACE_TEST = { autopilot: false };
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
  const havok = await HavokPhysics();
  const havokPlugin = new HavokPlugin(true, havok);
  scene.enablePhysics(new Vector3(0, -9.81, 0), havokPlugin);

  new HemisphericLight('hemi', new Vector3(0, 1, 0), scene).intensity = 0.5;
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
  setupArenaPicker(arena.setStyle, canvas);          // v0.18: neon colour + floor grid (in-match, top right)
  // v0.8: real spinners spin at up to ~70 rad/s -- make sure Havok's speed cap is well above that
  havokPlugin.setVelocityLimits(200, 400);
  scene.getPhysicsEngine()!.setSubTimeStep(SUB_STEP_MS);
  const hud = new Hud();
  const course = new Course(scene);                  // v0.23 test course (own floor, far from the arena)
  const SUN_OFFSET = sun.position.clone();
  const fx = new Fx(scene, document.getElementById('fxlayer')!);
  const race = new Race(scene, fx);                  // v0.33 race track (own floor too, far from the arena and the course)
  // v0.27 loose cubes land on the arena floor (walls bounce them) and on the test course floor
  setDebrisFloors([{ cx: 0, cz: 0, half: ARENA_SIZE / 2, wallH: WALL_H }, { cx: COURSE_ORIGIN.x, cz: COURSE_ORIGIN.z, half: COURSE.size / 2, wallH: 0 }, race.debrisFloor]);

  // ---- Lab scene (builder preview, no physics) ----
  const lab = new Lab(engine, catalog);
  const builder = new Builder(catalog);
  // v0.32 phones: simple menu instead of the builder; no shadows, lighter glow
  const mmenu = MOBILE ? new MobileMenu(PRESETS, { player: 'Noisy Cricket', opponent: 'Hammer Time' }) : null;
  const inMenu = () => builder.visible || !!mmenu?.visible;
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
  rd.start.addEventListener('click', beginCountdown);
  window.addEventListener('keydown', e => {
    if ((e.code === 'Enter' || e.code === 'NumpadEnter') && !e.repeat && phase === 'ready' && !inMenu() && mode !== 'course') { e.preventDefault(); beginCountdown(); }
  });
  /** Countdown display; returns true once FIGHT! is reached. */
  const tickCountdown = (now: number): boolean => {
    const t = now - countdownAt, n = 3 - Math.floor(t / COUNT_MS);
    if (n > 0) { rd.count.textContent = String(n); rd.count.className = 'on'; return false; }
    rd.count.textContent = mode === 'race' ? 'GO!' : 'FIGHT!'; rd.count.className = 'on fight';
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
    builder.show(
      b => lab.setBuild(b),
      ({ player, opponent, difficulty: d, breakableWeapons: bw, driveBoost }) => { buildA = player; buildB = opponent; difficulty = d; breakableWeapons = bw; DRIVE.boost = driveBoost; start(); },   // v0.22 test boost (both bots)
      ({ player, driveBoost }) => { courseBuild = player; DRIVE.boost = driveBoost; showCourseMenu(); },   // v0.23 test course
      ({ player, difficulty: d, driveBoost, raceSpeed }) => { raceBuild = player; raceDiff = d; DRIVE.boost = driveBoost; raceSpeedMul = raceSpeed; startRace(); },   // v0.33 race
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
  };
  rr.again.onclick = () => startRace();
  rr.lab.onclick = () => { leaveRace(); openLab(); };
  const RIVAL_IDS = ['B', 'C', 'D'] as const;
  let raceSpeedMul = 1;   // v0.34d lab RACE SPEED slider: x1 = the v0.34 race pace, up to x3

  function startRace() {
    if (!raceBuild) return;
    leaveCourse();
    if (mode === 'race') { race.dispose(); bots = []; fx.clear(); } else clearBots();
    mode = 'race';
    document.body.classList.add('inrace');
    rr.box.classList.remove('on'); raceShown = -1;
    hud.hideWinner();
    setArenaVisible(false); course.setVisible(false); race.setVisible(true);
    // three different AI rivals from the presets
    const names = Object.keys(PRESETS).sort(() => Math.random() - 0.5).slice(0, 3);
    combat = new Combat([], fx);
    DRIVE.raceSpeed = 2 * raceSpeedMul;   // v0.34 race only: x2 speed (bots are built with it); v0.34d x race speed slider (1-3)
    DRIVE.raceWeaponsNeutral = true;   // v0.34 race only: weapons don't change the driving
    DRIVE.raceSteer = true;            // v0.34c race only: speed-sensitive steering + heading hold
    DRIVE.raceArcade = true;           // v0.34f race only: turn-rate steering + sideways grip (race.ts)
    rampT = 0; rampDir = 0;
    race.begin([
      { id: 'A', human: true, build: raceBuild },
      ...names.map((n, i) => ({ id: RIVAL_IDS[i], human: false, build: JSON.parse(JSON.stringify(PRESETS[n])) as BotBuild })),
    ], catalog, combat, raceDiff, {
      onSpawn: b => { castShadows(shadows, botMeshes(b)); skinBot(b, shadows); },
      sign: (t, ms, c) => hud.sign(t, ms, c),
    });
    bots = race.bots();
    for (const b of bots) combat.replaceBot(undefined, b);
    over = false; camFocus = null;
    phase = 'ready'; rd.count.className = '';
    const p = race.player()!.bot;
    cam.target = p.root.position.clone(); cam.radius = camCtl.radius(11);
    sun.position = p.root.position.add(SUN_OFFSET);
    drawRaceHud(performance.now(), true);
    if (!raceSeen) showRaceReady(); else goCountdown();
    canvas.focus();
  }
  function leaveRace() {
    DRIVE.raceSpeed = 1;   // v0.34: arena / course / lab at normal speed
    DRIVE.raceWeaponsNeutral = false;
    DRIVE.raceSteer = false;
    DRIVE.raceArcade = false;
    if (mode !== 'race') return;
    race.dispose(); bots = []; fx.clear(); fx.focus = null;
    mode = 'match';
    document.body.classList.remove('inrace');
    rr.box.classList.remove('on'); raceShown = -1;
    rd.box.classList.remove('on'); rd.count.className = '';
    race.setVisible(false); setArenaVisible(true);
    sun.position = SUN_OFFSET.clone();
    cam.target = new Vector3(0, 0.5, 0); cam.radius = camCtl.radius(16);
  }
  function showRaceReady() {
    const p = race.player()!.bot;
    rd.title.innerHTML = `RACE <span class="vs">${RACE.laps} LAPS · 4 BOTS</span>`;
    const rows: [string, string][] = [
      ['DRIVE', 'W A S D (or gamepad left stick)'],
      ['WEAPON', p.weapon.hint('SPACE') + ' — weapons are on'],
      ['TO WIN', `First across the line after ${RACE.laps} laps. Hit, flip and wreck the others on the way.`],
      ['WRECKED', 'Destroyed, or off the track (into the pit, over a wall): back at the last checkpoint in 2 s, repaired.'],
      ['STUCK', 'Can\'t drive, or barely moving for 4 s (upside down, wedged, pinned): towed back to the last checkpoint, repaired.'],
      ['DAMAGE', 'Your damage score (DMG) counts every point of damage you deal to the other bots.'],
      ['TRACK', 'Banked turn · ramp jump over a pit · kill saws · hammer · hairpin'],
      ['KEYS', 'R: restart · B: lab · Q: camera'],
    ];
    rd.table.innerHTML = rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('');
    rd.start.style.display = '';
    rd.small.textContent = 'Enter or click START · B: back to the lab';
    rd.box.classList.add('on');
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
    if (isDown('KeyB')) { leaveRace(); openLab(); return; }
    helpEl.innerHTML = `WASD drive &nbsp;·&nbsp; SPACE weapon &nbsp;·&nbsp; Q camera &nbsp;·&nbsp; R restart &nbsp;·&nbsp; B lab`;
    if (phase === 'countdown' && tickCountdown(now)) phase = 'fight';
    const waiting = phase !== 'fight';
    scene.getPhysicsEngine()?.setTimeStep(PHYS_STEP);
    for (const r of race.racers) {
      if (r.down || r.bot.eliminated) continue;
      const d: Drive = waiting ? { throttle: 0, turn: 0, fire: false } : r.human && !RACE_TEST.autopilot ? steerRamp(readDrive('A'), dt) : race.aiDrive(r, dt);
      runBot(r.bot, d, dt, now, waiting, false, phase === 'countdown');
    }
    race.update(dt, now, !waiting);
    bots = race.bots();
    const pr = race.player()!;
    const target = pr.down ? (pr.bot.eliminated?.pos ?? pr.bot.root.position) : pr.bot.root.position;
    cam.target = Vector3.Lerp(cam.target, target, 0.1).add(fx.shakeOffset());
    camGuard(target, 'race');   // v0.34h
    cam.radius += (camCtl.radius(11) - cam.radius) * 0.05;
    if (!pr.down) camCtl.chase(pr.bot.root.rotationQuaternion, dt);
    sun.position = target.add(SUN_OFFSET);
    fx.focus = target;
    fx.update(dt, cam);
    drawRaceHud(now);
    if (race.playerFinishedAt > 0 && now - race.playerFinishedAt > 1500 && (raceShown < 0 || now - raceShown > 500)) showRaceResults(now);
  }

  /** Race HUD (position, lap, times, order) + minimap. Redrawn ~10x a second. */
  const mapOutline = race.outline();
  function drawRaceHud(now: number, force = false) {
    if (!force && now - raceHudAt < 90) return;
    raceHudAt = now;
    const st = race.standings(), pr = race.player();
    if (!pr) return;
    const pos = st.indexOf(pr) + 1;
    const best = pr.lapTimes.length ? fmtTime(Math.min(...pr.lapTimes)) : '—';
    const last = pr.lapTimes.length ? fmtTime(pr.lapTimes[pr.lapTimes.length - 1]) : '—';
    const stuck = (r: Racer) => r.stuckSince !== undefined && now - r.stuckSince >= 1000 ? ` <i class="x">STUCK ${Math.max(1, Math.ceil((RACE.stuckMs - (now - r.stuckSince)) / 1000))}</i>` : '';
    const tag = (r: Racer) => r.finished !== undefined ? ' <i>FIN</i>' : r.down ? ` <i class="x">${r.down.why === 'stuck' ? 'TOWED' : 'WRECK'}</i>` : stuck(r);
    const dmg = (r: Racer) => Math.round(combat?.stats[r.id]?.dmg ?? 0);   // v0.34 damage dealt to other bots (hazards don't count)
    rr.hud.innerHTML = `<div class="pos">${ordinal(pos)}<span> / ${st.length}</span></div>`
      + `<div>LAP <b>${pr.finished !== undefined ? RACE.laps : race.lap(pr)} / ${RACE.laps}</b> &nbsp; TIME <b>${fmtTime(pr.finished ?? race.t)}</b></div>`
      + `<div>LAST <b>${last}</b> &nbsp; BEST <b>${best}</b> &nbsp; DMG <b>${dmg(pr)}</b></div>`
      + `<ol>${st.map(r => `<li style="color:${r.paint}">${r.name}${r.human ? ' <b>(YOU)</b>' : ''} <span class="dmg">${dmg(r)}</span>${tag(r)}</li>`).join('')}</ol>`;
    // minimap
    const cv = rr.map, g = cv.getContext('2d');
    if (!g) return;
    const b = race.bounds, pad = 8, sx = (cv.width - pad * 2) / (b.x1 - b.x0), sz = (cv.height - pad * 2) / (b.z1 - b.z0), k = Math.min(sx, sz);
    const X = (x: number) => pad + (x - b.x0) * k, Y = (z: number) => cv.height - pad - (z - b.z0) * k;
    g.clearRect(0, 0, cv.width, cv.height);
    g.lineWidth = RACE.width * k; g.lineJoin = 'round'; g.strokeStyle = 'rgba(60,72,82,.9)';
    g.beginPath(); mapOutline.forEach((p, i) => i ? g.lineTo(X(p.x), Y(p.z)) : g.moveTo(X(p.x), Y(p.z))); g.closePath(); g.stroke();
    g.lineWidth = 1; g.strokeStyle = 'rgba(0,229,255,.6)'; g.stroke();
    const f = race.samples[0];
    g.strokeStyle = '#fff'; g.lineWidth = 2; g.beginPath();
    g.moveTo(X(f.x - Math.sin(f.h) * 4), Y(f.z + Math.cos(f.h) * 4)); g.lineTo(X(f.x + Math.sin(f.h) * 4), Y(f.z - Math.cos(f.h) * 4)); g.stroke();
    for (const r of [...race.racers].sort((a, c) => Number(a.human) - Number(c.human))) {
      if (r.down) continue;
      const p = r.bot.root.position;
      g.fillStyle = r.paint; g.beginPath(); g.arc(X(p.x - RACE_ORIGIN.x), Y(p.z - RACE_ORIGIN.z), r.human ? 5 : 3.5, 0, Math.PI * 2); g.fill();
      if (r.human) { g.strokeStyle = '#fff'; g.lineWidth = 1.5; g.stroke(); }
    }
  }

  function showRaceResults(now: number) {
    raceShown = now;
    const st = race.standings();
    rr.table.innerHTML = `<tr><th></th><th>BOT</th><th>TIME</th><th>BEST LAP</th><th>DAMAGE</th></tr>` + st.map((r, i) => {
      const t = r.finished !== undefined ? fmtTime(r.finished) : `racing — lap ${race.lap(r)}`;
      const best = r.lapTimes.length ? fmtTime(Math.min(...r.lapTimes)) : '—';
      return `<tr class="${r.human ? 'you' : ''}"><td>${ordinal(i + 1)}</td><td style="color:${r.paint}">${r.name}${r.human ? ' (YOU)' : ''}</td><td>${t}</td><td>${best}</td><td>${Math.round(combat?.stats[r.id]?.dmg ?? 0)}</td></tr>`;
    }).join('');
    rr.box.classList.add('on');
  }

  openLab();
  // v0.33 test aids (not advertised): ?race=<preset> jumps straight into a race with that bot; &autopilot=1 lets the AI
  // drive your bot too. window.__bb exposes the race for the sandbox test runs.
  const qs = new URLSearchParams(location.search);
  RACE_TEST.autopilot = qs.get('autopilot') === '1';
  if (qs.get('race') && PRESETS[qs.get('race')!]) {
    builder.hide();
    raceBuild = JSON.parse(JSON.stringify(PRESETS[qs.get('race')!])); raceDiff = (qs.get('ai') as Difficulty) ?? 'normal'; DRIVE.boost = Number(qs.get('boost') ?? 3); raceSpeedMul = Number(qs.get('racespeed') ?? 1);
    raceSeen = true; startRace();
  }
  (window as unknown as { __bb: unknown }).__bb = { race, get phase() { return phase; } };

  // v0.8 real spinner damage: weapon energy measured around every physics step
  scene.onBeforePhysicsObservable.add(() => {
    if (mode === 'course') { courseCombat?.beforePhysics(); course.beforePhysics(); } else combat?.beforePhysics();
    const stepDt = SUB_STEP_MS / 1000;   // v0.21: observers run once per physics sub-step
    const racing = mode === 'race';   // v0.34 race: no gyro / magnets (weapons don't change the driving); stabilizer instead
    for (const b of bots) if (!b.eliminated) { if (!racing) applyGyro(b, stepDt); armBefore(b); if (!racing) applyMagnets(b, stepDt); hingesBefore(b); wheelsBefore(b, stepDt); }   // v0.8 gyro; v0.11 arm + magnets; v0.12 hinges; v0.21 drive motors
    // v0.31 countdown: the weapons spin up but the bots stay where they were put (a spinning-up shell would turn its chassis)
    if (racing) race.beforePhysics(stepDt);
    if (mode !== 'course' && phase === 'countdown') for (const b of bots) if (!b.eliminated) {
      const w = b.body.getAngularVelocity(); b.body.setAngularVelocity(new Vector3(w.x, 0, w.z));
    }
  });
  scene.onAfterPhysicsObservable.add(() => {
    const stepDt = SUB_STEP_MS / 1000;
    if (mode === 'course') courseCombat?.afterPhysics(stepDt); else combat?.afterPhysics(stepDt);
    for (const b of bots) if (!b.eliminated) armAfter(b, stepDt);   // v0.11 reactionless hammer
    if (mode === 'race') race.afterPhysics();   // v0.34 race: spinner spin-up doesn't twist the chassis
    if (mode === 'course' && bots.length) course.afterPhysics();     // v0.23: timing lines + readouts, every sub-step
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
