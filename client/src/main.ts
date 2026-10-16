import {
  ArcRotateCamera, Color4, DirectionalLight, Engine, HavokPlugin, HemisphericLight, Quaternion, Scene, Vector3,
} from '@babylonjs/core';
import HavokPhysics from '@babylonjs/havok';
import type { BotBuild } from '../../src/core/types.js';
import { canAttack, currentSpeed, isDestroyed } from '../../src/core/state.js';
import { catalog } from './catalog.js';
import { buildArena, WALL_H, ARENA_COLOURS, FLOOR_GRIDS, type ArenaStyle } from './arena.js';
import { buildBot, forward, upVector, REST_Y, driveSpinner, spinOmega, applyGyro, disposeBot, freezeBot, snapSpinner, driveArm, armBefore, armAfter, applyMagnets, magnetGrip, driveFlipper, driveControl, hingesBefore, tyreBefore, tyreAfter, botMeshes, type Bot } from './bot.js';
import { applyEnvironment, castShadows, makeShadows } from './look.js';
import { readDrive, isDown, KEYS, type Drive } from './input.js';
import { Combat } from './combat.js';
import { Hud } from './hud.js';
import { Fx } from './fx.js';
import { Lab } from './lab.js';
import { Builder } from './builder.js';
import { aiDrive, type Difficulty } from './ai.js';

const MATCH_SECONDS = 180;
const SPIN_VISUAL = { x: 25, y: 20 };     // rad/s at full spin
/** Drive feel. Push strength = mass x (baseAccel + accelPerSpeed x speed).
 *  v0.7: the drive only acts while the wheels are actually on the floor (grounded + upright) --
 *  a bot lifted on a wedge, launched, or tipped has no grip, which is what makes lifts work. */
const DRIVE = {
  speedScale: 0.6,      // motor speed stat -> m/s
  gain: 6,              // how hard it chases the target speed (1/s)
  baseAccel: 16,        // m/s^2 every motor can manage
  accelPerSpeed: 3.5,   // extra m/s^2 per m/s of top speed (stronger motor pushes harder)
  wheelsDownDot: 0.8,   // up-vector . world-up must be above this for the wheels to grip at all
  groundedY: 0.08,      // chassis centre may be this far above its rest height and still count as on the floor
  lateralGrip: 8,       // sideways velocity damping (1/s)
  turnRate: 3.0,        // rad/s at full stick
  turnGain: 10,         // how fast yaw rate chases the stick (1/s) -- applied as a torque-like velocity blend
};
const PHYS_STEP = 1 / 60;
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
  const hud = new Hud();
  const fx = new Fx(scene, document.getElementById('fxlayer')!);

  // ---- Lab scene (builder preview, no physics) ----
  const lab = new Lab(engine, catalog);
  const builder = new Builder(catalog);

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
  const helpEl = document.getElementById('help')!;

  const controlLines = () => {
    const lines = [`<b>P1</b> ${KEYS.A.label} — ${bots[0].weapon.hint('SPACE')}`];
    if (p2Human) lines.push(`<b>P2</b> ${KEYS.B.label} — ${bots[1].weapon.hint('Right SHIFT')}`);
    lines.push(`Damage = real energy: spinners dump stored spin · hammers the swing · flippers / lifters what they throw or lift (plus the landing) · crushers pierce while pressing. Anything else is a <i>bump</i>.`);
    lines.push(`R restart · B lab · T toggle P2 human/AI · V HUD view · H details`);
    return lines;
  };

  const start = () => {
    if (!buildA || !buildB) return;
    for (const b of bots) disposeBot(b);
    fx.clear();
    bots = [
      buildBot('A', buildA, catalog, scene, arena.spawnA, Math.PI / 4, { breakableWeapons }),
      buildBot('B', buildB, catalog, scene, arena.spawnB, Math.PI + Math.PI / 4, { breakableWeapons }),
    ];
    for (const b of bots) castShadows(shadows, botMeshes(b));   // v0.16
    combat = new Combat(bots, fx);
    timeLeft = MATCH_SECONDS; over = false; camFocus = null;
    hud.hideWinner();
    hud.showControls(controlLines());
    canvas.focus();
  };

  const openLab = () => {
    builder.show(
      b => lab.setBuild(b),
      ({ player, opponent, difficulty: d, breakableWeapons: bw }) => { buildA = player; buildB = opponent; difficulty = d; breakableWeapons = bw; start(); },
    );
  };
  openLab();

  // v0.8 real spinner damage: weapon energy measured around every physics step
  scene.onBeforePhysicsObservable.add(() => {
    combat?.beforePhysics();
    const stepDt = Math.min(0.1, Math.max(1 / 240, engine.getDeltaTime() / 1000));   // same clamp as the physics step
    for (const b of bots) if (!b.eliminated) { applyGyro(b, stepDt); armBefore(b); applyMagnets(b, stepDt); hingesBefore(b); tyreBefore(b); }   // v0.8 gyro; v0.11 arm + magnets; v0.12 hinges + tyre grip
  });
  scene.onAfterPhysicsObservable.add(() => {
    const stepDt = Math.min(0.1, Math.max(1 / 240, engine.getDeltaTime() / 1000));
    combat?.afterPhysics(stepDt);
    for (const b of bots) if (!b.eliminated) { armAfter(b, stepDt); tyreAfter(b, stepDt, wheelsOnFloor(b)); }   // v0.11 reactionless hammer; v0.12 tyre grip
  });

  let lastToggle = 0;
  // v0.19 HUD: V cycles the layout (top / bottom / left), H shows the test numbers. One press = one step
  // (key events, not polling); ignored while typing in the lab.
  window.addEventListener('keydown', e => {
    if (e.repeat || builder.visible) return;
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    if (e.code === 'KeyV') hud.cycleView();
    else if (e.code === 'KeyH') hud.toggleDetails();
  });
  scene.onBeforeRenderObservable.add(() => {
    const dt = engine.getDeltaTime() / 1000;
    if (isDown('KeyR')) { start(); return; }
    if (isDown('KeyB')) { openLab(); return; }
    if (isDown('KeyT') && performance.now() - lastToggle > 400) { p2Human = !p2Human; lastToggle = performance.now(); hud.showControls(controlLines(), 4000); }
    helpEl.innerHTML = `P1: ${KEYS.A.label} &nbsp;|&nbsp; P2: ${p2Human ? KEYS.B.label + ' (human)' : 'AI ' + difficulty.toUpperCase()} (T toggles) &nbsp;|&nbsp; R: restart &nbsp;|&nbsp; B: lab &nbsp;|&nbsp; V: view &nbsp;|&nbsp; H: details`;

    const now = performance.now();
    scene.getPhysicsEngine()?.setTimeStep(PHYS_STEP);

    // Drive + weapons
    for (const b of bots) {
      if (b.eliminated) continue;                                 // frozen + hidden, nothing to drive
      const d: Drive = b.id === 'A' || p2Human
        ? readDrive(b.id)
        : (over ? { throttle: 0, turn: 0, fire: false } : aiDrive(b, bots[0], arena.half, dt, difficulty));

      // Upside down? -- helpless until the self-right fires
      updateInverted(b, now);
      // v0.12: a flipper can still fire upside down -- that's how it self-rights
      const flipper = b.hinges?.some(h => h.role === 'flipper') ?? false;
      b.weapon.suppressed = (!!b.inverted && !flipper) || !!b.rightingUntil;
      b.weapon.update(dt, d.fire && !over, canAttack(b.state));
      const helpless = !!b.inverted || !!b.rightingUntil;

      // v0.8 real spinner: the weapon motor drives a real body; spin level is measured, not timed
      if (b.spinner) {
        const motorAlive = (b.state.parts['weapon_motor']?.hp ?? 0) > 0;
        b.weapon.motorDead = !motorAlive;
        driveSpinner(b, b.weapon.spinning && !b.weapon.suppressed && canAttack(b.state), motorAlive);
        b.weapon.spinLevel = Math.min(1, Math.max(0, spinOmega(b) / b.spinner.omegaMax));
      }
      // v0.10 real overhead arm: tap = swing, hold = pin; the saw on the arm spins whenever it can
      if (b.arm) {
        const motorAlive = (b.state.parts['weapon_motor']?.hp ?? 0) > 0;
        const usable = !b.weapon.suppressed && canAttack(b.state);
        b.weapon.motorDead = !motorAlive;
        driveArm(b, b.weapon.fireHeld, b.weapon.pressed, usable, motorAlive, dt);
        b.weapon.armState = b.arm.state;
        if (b.saw) driveSpinner(b, usable && !over, motorAlive, b.saw);
      }

      // v0.12 real flipper: tap = fire (upside down = self-right shot into the floor)
      if (flipper) {
        const motorAlive = (b.state.parts['weapon_motor']?.hp ?? 0) > 0;
        b.weapon.motorDead = !motorAlive;
        const press = b.weapon.pressed || (!!b.inverted && b.id !== 'A' && !p2Human);   // the AI self-rights at once
        driveFlipper(b, press, !b.rightingUntil && canAttack(b.state) && !over, motorAlive, !!b.inverted, dt);
      } else if (b.hinges) {
        // v0.12 real control weapon: hold = lift / clamp / crush
        const motorAlive = (b.state.parts['weapon_motor']?.hp ?? 0) > 0;
        b.weapon.motorDead = !motorAlive;
        driveControl(b, b.weapon.held, !b.weapon.suppressed && canAttack(b.state) && !over, motorAlive, dt);
      }

      // Force-based drive: push toward the target speed with a force capped by the motor, so
      // mass x motor wins shoves and impulses aren't overwritten. Only while the wheels are on
      // the floor: upright enough AND the chassis sitting at (or near) its rest height.
      const spd = currentSpeed(b.state) * DRIVE.speedScale;   // motor speed stat -> m/s
      const v = b.body.getLinearVelocity();
      const fwd = forward(b); fwd.y = 0;
      const upDotNow = Vector3.Dot(upVector(b), Vector3.Up());
      const grounded = b.root.position.y < REST_Y + DRIVE.groundedY;
      const wheelsDown = upDotNow > DRIVE.wheelsDownDot && grounded && fwd.lengthSquared() > 1e-4;
      if (wheelsDown) fwd.normalize();
      if (spd > 0 && !over && !helpless && wheelsDown) {
        const mass = b.body.getMassProperties().mass ?? 50;
        const right = Vector3.Cross(Vector3.Up(), fwd);
        const vf = Vector3.Dot(v, fwd), vr = Vector3.Dot(v, right);
        const maxAccel = (DRIVE.baseAccel + DRIVE.accelPerSpeed * spd) * magnetGrip(b);   // motor strength (v0.11: x magnet grip)
        const wantAccel = (d.throttle * spd - vf) * DRIVE.gain;
        const accel = Math.max(-maxAccel, Math.min(maxAccel, wantAccel));
        const lateral = -vr * DRIVE.lateralGrip;                                  // tyres resist sliding
        const force = fwd.scale(accel * mass).add(right.scale(lateral * mass));
        b.body.applyForce(force, b.root.position);
        // Steering: blend the yaw rate toward the stick; pitch/roll are left to physics now
        const av = b.body.getAngularVelocity();
        const k = Math.min(1, dt * DRIVE.turnGain);
        b.body.setAngularVelocity(new Vector3(av.x, av.y + (d.turn * DRIVE.turnRate - av.y) * k, av.z));
      }

      // Weapon visuals
      if (b.weaponMesh && !b.spinner && !b.arm && !b.hinges) {   // real weapons are moved by physics
        const w = b.weapon;
        if (w.mode === 'spinner') {
          if (b.spinAxis === 'x') b.weaponMesh.rotation.x += SPIN_VISUAL.x * w.spinLevel * dt;
          if (b.spinAxis === 'y') b.weaponMesh.rotation.y += SPIN_VISUAL.y * w.spinLevel * dt;
        } else if (w.mode === 'strike') {
          b.weaponMesh.rotation.x = b.weaponRestRotX + w.pose() * 1.15;     // arm swings down over the front
        } else if (w.mode === 'flipper') {
          b.weaponMesh.rotation.x = b.weaponRestRotX - w.pose() * 1.2;      // plate kicks up
        } else if (w.mode === 'hold') {
          b.weaponMesh.rotation.x = b.weaponRestRotX - w.pose() * 0.7;      // arm lifts while gripping
        }
      }
      // Grey out dead parts
      for (const [sid, m] of Object.entries(b.partMeshes)) {
        const ps = b.state.parts[sid];
        if (ps && ps.hp <= 0) { m.visibility = 0.25; for (const c of m.getChildMeshes()) c.visibility = 0.25; }
      }
    }

    // Camera follows the midpoint of the bots still in play (+ hit shake) — unless a bot has gone
    // over the top of the cage and broken outside the footprint: then it follows that bot (and its
    // explosion) until OUT.camHoldMs after the last sighting.
    const live = bots.filter(b => !b.eliminated);
    const mid = live.length ? live.reduce((a, b) => a.add(b.root.position), Vector3.Zero()).scale(1 / live.length) : Vector3.Zero();
    const flyer = live.find(b => b.root.position.y > WALL_H && (Math.abs(b.root.position.x) > arena.half || Math.abs(b.root.position.z) > arena.half));
    if (flyer) camFocus = { pos: flyer.root.position.clone(), until: now + OUT.camHoldMs };
    const focusing = camFocus && now < camFocus.until;
    cam.target = Vector3.Lerp(cam.target, focusing ? camFocus!.pos : mid, focusing ? OUT.camLerp : 0.08).add(fx.shakeOffset());
    const dist = live.length === 2 ? Vector3.Distance(live[0].root.position, live[1].root.position) : 0;
    cam.radius += ((10 + dist * 0.9) - cam.radius) * 0.05;

    // OUT of the arena: past a wall plane and under the floor -> eliminated (explodes).
    const justOut = bots.filter(b => !b.eliminated && isOut(b));
    for (const b of justOut) eliminate(b, now);
    if (!over && justOut.length) {
      const w = bots.find(b => !b.eliminated);
      end(w ? `${w.build.cosmetics.name} WINS — ${justOut[0].build.cosmetics.name} OUT OF THE ARENA` : 'DOUBLE OUT — DRAW', w?.build.cosmetics.paint ?? '#fff');
    }

    fx.update(dt, cam);

    // Clock + end conditions
    if (!over) {
      timeLeft = Math.max(0, timeLeft - dt);
      const dead = bots.filter(b => isDestroyed(b.state) && !b.eliminated);
      if (dead.length) {
        const w = bots.find(b => !isDestroyed(b.state));
        end(w ? `${w.build.cosmetics.name} WINS BY KO` : 'DOUBLE KO', w?.build.cosmetics.paint ?? '#fff');
      } else if (timeLeft <= 0) {
        // Time-out: whoever took more damage (from any source) loses. Nothing else counts.
        const [a, b] = bots;
        const w: Bot | undefined = a.state.totalDamageTaken < b.state.totalDamageTaken ? a : b.state.totalDamageTaken < a.state.totalDamageTaken ? b : undefined;
        end(w ? `${w.build.cosmetics.name} WINS ON DAMAGE` : 'DRAW', w?.build.cosmetics.paint ?? '#fff');
      }
    }
    hud.update(bots, timeLeft, combat.stats, combat);
  });

  function end(text: string, color: string) { over = true; hud.showWinner(text + '  (R restart · B lab)', color); }

  /** Track upside-down / self-righting for one bot. */
  function updateInverted(b: Bot, now: number) {
    const upDot = Vector3.Dot(upVector(b), Vector3.Up());

    // Self-right in progress: at snap time put the chassis back on its wheels (yaw kept).
    if (b.rightingUntil) {
      if (now >= b.rightingUntil) {
        const fwd = forward(b);
        const yaw = Math.atan2(fwd.x, fwd.z);
        b.body.disablePreStep = false;                           // let the mesh transform drive the body this frame
        b.root.rotationQuaternion = Quaternion.RotationAxis(Vector3.Up(), yaw);
        b.body.setAngularVelocity(Vector3.Zero());
        scene.onAfterRenderObservable.addOnce(() => { b.body.disablePreStep = true; });
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
        if (!over) combat.onFlipped(b);                // v0.19 arcade score: FLIP bonus to whoever put it there
        const flip = b.hinges?.some(h => h.role === 'flipper');
        hud.sign(flip ? 'UPSIDE DOWN — FIRE THE FLIPPER!' : 'UPSIDE DOWN', flip ? 1200 : 700, '#ff9f43');
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
      b.rightingUntil = now + INVERT.snapMs;
      hud.sign('SELF-RIGHT!', 700, '#4dd2ff');
    }
  }

  function wheelsOnFloor(b: Bot): boolean {
    return Vector3.Dot(upVector(b), Vector3.Up()) > DRIVE.wheelsDownDot && b.root.position.y < REST_Y + DRIVE.groundedY;
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
    if (builder.visible || bots.length === 0) lab.render();
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
