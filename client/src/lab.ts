/**
 * The robotics lab: a separate Babylon scene where the player's bot sits on a
 * turntable and is rebuilt live as parts change. No physics here.
 * Props are placeholder primitives (shelves, bench, monitor) until real models exist.
 */
import {
  ArcRotateCamera, Color3, Color4, DirectionalLight, DynamicTexture, Engine, GlowLayer, HemisphericLight,
  Mesh, MeshBuilder, PointLight, Scene, SceneLoader, ShadowGenerator, StandardMaterial, Vector3,
} from '@babylonjs/core';
import '@babylonjs/loaders/glTF';
import type { BotBuild, Catalog } from '../../src/core/types.js';
import { assembleBotMesh, ARM, CONTROL, FLIP, SPINNER, type BotMesh } from './bot.js';
import { isDown } from './input.js';
import type { WeaponKind } from '../../src/core/types.js';
import { applyEnvironment, castShadows, makeShadows } from './look.js';
import { CUBES, skinPreview } from './cubes.js';

/** Stand-in Meshy models shown instead of the primitive assembly for matching presets. */
const PROTOTYPE_MODELS: Record<string, { url: string; scale: number }> = {
  vertical_spinner: { url: '/models/red_disc.glb', scale: 1.6 },
};

const TURNTABLE_RPM = 4;

export class Lab {
  readonly scene: Scene;
  private bot: BotMesh | null = null;
  private proto: Mesh | null = null;
  private loadToken = 0;
  private turntable: Mesh;
  private shadows: ShadowGenerator;
  private angle = 0;
  readonly camera: ArcRotateCamera;
  /** v0.24 weapon test (SPACE or the TEST WEAPON button): the weapon's real motion, played on the turntable.
   *  Same speeds / strokes / timings as in a match (bot.ts constants), but no physics: nothing to hit. */
  private wt = { held: false, was: false, on: false, omega: 0, sawOmega: 0, angle: 0, jaw: 0, t: 0, phase: 'rest' as 'rest' | 'up' | 'hold' | 'down' };
  /** Held by the lab's TEST WEAPON button. */
  private btnHeld = false;
  /** A press seen as an event (a quick tap can fall between two frames). */
  private latch = false;
  set buttonHeld(v: boolean) { if (v && !this.btnHeld) this.latch = true; this.btnHeld = v; }

  constructor(private engine: Engine, private catalog: Catalog) {
    const scene = new Scene(engine);
    this.scene = scene;
    scene.clearColor = new Color4(0.03, 0.04, 0.05, 1);
    scene.fogMode = Scene.FOGMODE_EXP2;
    scene.fogDensity = 0.035;
    scene.fogColor = new Color3(0.03, 0.04, 0.05);

    window.addEventListener('keydown', e => {
      if (e.code === 'Space' && !e.repeat && !(e.target instanceof HTMLInputElement && e.target.type === 'text')) this.latch = true;
    });
    const cam = this.camera = new ArcRotateCamera('labcam', -Math.PI / 2, 1.25, 7, new Vector3(0, 1.0, 0), scene);
    cam.lowerRadiusLimit = 4; cam.upperRadiusLimit = 12;
    cam.lowerBetaLimit = 0.6; cam.upperBetaLimit = 1.45;
    cam.wheelPrecision = 40;
    cam.attachControl(engine.getRenderingCanvas()!, true);

    new HemisphericLight('labhemi', new Vector3(0, 1, 0), scene).intensity = 0.25;
    const key = new DirectionalLight('labkey', new Vector3(-0.5, -1, 0.4), scene);
    key.intensity = 0.55; key.specular = new Color3(0.2, 0.2, 0.2);
    key.position = new Vector3(5, 10, -4);                 // v0.16: shadows need a light position
    applyEnvironment(scene, 0.7);                          // v0.16: what the bots' metal reflects
    this.shadows = makeShadows(key, 1024);
    const spot = new PointLight('labspot', new Vector3(0, 4, 0), scene);
    spot.intensity = 0.3; spot.diffuse = new Color3(0.8, 0.95, 1); spot.specular = new Color3(0.15, 0.15, 0.15);
    const teal = new PointLight('labteal', new Vector3(0, 0.3, 0), scene);
    teal.intensity = 0.25; teal.diffuse = Color3.FromHexString('#3ee6c4'); teal.specular = Color3.Black(); teal.range = 4;

    const glow = new GlowLayer('glow', scene, { blurKernelSize: 64 });
    glow.intensity = 0.45;

    const m = (name: string, hex: string, emissive?: string) => {
      const mm = new StandardMaterial(name, scene);
      mm.diffuseColor = Color3.FromHexString(hex);
      mm.specularColor = new Color3(0.15, 0.15, 0.15);
      if (emissive) mm.emissiveColor = Color3.FromHexString(emissive);
      return mm;
    };
    const concrete = m('concrete', '#1b2228');
    const panel = m('panel', '#232c33');
    const metal = m('metal', '#3a444c');
    const tealGlow = m('tealGlow', '#0f2a25', '#3ee6c4');
    const amberGlow = m('amberGlow', '#2a200f', '#f2b134');
    const screen = m('screen', '#06110f', '#1f6f5f');

    // Floor with grid lines
    const floor = MeshBuilder.CreateGround('labfloor', { width: 24, height: 24 }, scene);
    floor.material = concrete;
    const grid = MeshBuilder.CreateLineSystem('labgrid', {
      lines: [...Array(25)].flatMap((_, i) => {
        const p = -12 + i;
        return [[new Vector3(p, 0.005, -12), new Vector3(p, 0.005, 12)], [new Vector3(-12, 0.005, p), new Vector3(12, 0.005, p)]];
      }),
    }, scene);
    grid.color = new Color3(0.12, 0.3, 0.27);
    grid.alpha = 0.5;

    // Turntable + glowing ring
    this.turntable = MeshBuilder.CreateCylinder('turntable', { diameter: 3.2, height: 0.16, tessellation: 48 }, scene);
    this.turntable.position.y = 0.08;
    this.turntable.material = metal;
    this.turntable.receiveShadows = true;
    const ring = MeshBuilder.CreateTorus('ring', { diameter: 3.3, thickness: 0.06, tessellation: 64 }, scene);
    ring.position.y = 0.17; ring.material = tealGlow;
    const base = MeshBuilder.CreateCylinder('ttbase', { diameter: 3.8, height: 0.1, tessellation: 48 }, scene);
    base.position.y = 0.05; base.material = panel;

    // Back wall + shelving
    const wall = MeshBuilder.CreateBox('backwall', { width: 24, height: 6, depth: 0.3 }, scene);
    wall.position.set(0, 3, 7); wall.material = panel;
    for (const x of [-6, 6]) {
      const unit = MeshBuilder.CreateBox(`shelfunit${x}`, { width: 4, height: 3.6, depth: 1 }, scene);
      unit.position.set(x, 1.8, 6.3); unit.material = metal;
      for (let s = 0; s < 4; s++) {
        const shelf = MeshBuilder.CreateBox(`shelf${x}_${s}`, { width: 3.8, height: 0.06, depth: 0.9 }, scene);
        shelf.position.set(x, 0.4 + s * 0.9, 6.3); shelf.material = panel;
        // bins
        for (let b = 0; b < 3; b++) {
          const bin = MeshBuilder.CreateBox(`bin${x}_${s}_${b}`, { width: 1.0, height: 0.5, depth: 0.7 }, scene);
          bin.position.set(x - 1.2 + b * 1.2, 0.7 + s * 0.9, 6.3);
          bin.material = (s + b) % 3 === 0 ? amberGlow : (s + b) % 3 === 1 ? tealGlow : concrete;
        }
      }
    }

    // "ROBOT REVOLUTION" neon sign on the back wall above the bench
    {
      const tex = new DynamicTexture('signtex', { width: 2048, height: 512 }, scene, true);
      const ctx = tex.getContext() as CanvasRenderingContext2D;
      ctx.fillStyle = '#07090b'; ctx.fillRect(0, 0, 2048, 512);
      // scanlines
      ctx.fillStyle = 'rgba(62,230,196,0.06)';
      for (let y = 0; y < 512; y += 6) ctx.fillRect(0, y, 2048, 2);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = '900 190px Impact, "Arial Black", sans-serif';
      ctx.lineJoin = 'round';
      // ROBOT (teal) / REVOLUTION (amber): wide neon halo, white outline, bright coloured core.
      const word = (t: string, x: number, y: number, halo: string, core: string) => {
        ctx.shadowColor = halo; ctx.shadowBlur = 90;
        ctx.strokeStyle = halo; ctx.lineWidth = 22;
        ctx.strokeText(t, x, y); ctx.strokeText(t, x, y);          // two passes = denser halo
        ctx.shadowBlur = 0;
        ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 20; ctx.strokeText(t, x, y);
        ctx.strokeStyle = '#000000'; ctx.lineWidth = 9; ctx.strokeText(t, x, y);   // black separator
        ctx.fillStyle = core; ctx.fillText(t, x, y);
      };
      word('ROBOT', 1024, 150, '#3ee6c4', '#7dfbe3');
      word('REVOLUTION', 1024, 362, '#f2b134', '#ffd166');
      tex.update();
      const signMat = new StandardMaterial('signmat', scene);
      signMat.diffuseTexture = tex; signMat.emissiveTexture = tex;
      signMat.specularColor = Color3.Black();
      signMat.disableLighting = true;                               // pure emissive: no shading dulls it
      // Sits just above the monitor (top of monitor is y≈2.1) and inside the default camera's view.
      const SIGN_Y = 3.3;
      // Babylon planes face -Z by default, i.e. toward the camera here — no rotation needed.
      const sign = MeshBuilder.CreatePlane('sign', { width: 8.0, height: 2.0 }, scene);
      sign.position.set(0, SIGN_Y, 6.8); sign.material = signMat;
      // Let the glow layer bloom the sign's own texture, brighter than the rest of the scene.
      glow.customEmissiveColorSelector = (mesh, _sub, material, result) => {
        if (mesh === sign) { result.set(1.6, 1.6, 1.6, 1); return; }
        const cube = (mesh.metadata as { cubeGlow?: Color3 } | null)?.cubeGlow;   // v0.27 Cube Bots look
        if (cube) { result.set(cube.r, cube.g, cube.b, 1); return; }
        const c = (material as { emissiveColor?: Color3 }).emissiveColor ?? Color3.Black();
        result.set(c.r, c.g, c.b, 1);
      };
      const frame = MeshBuilder.CreateBox('signframe', { width: 8.3, height: 2.3, depth: 0.12 }, scene);
      frame.position.set(0, SIGN_Y, 6.9); frame.material = metal;
      const tube = MeshBuilder.CreateBox('signtube', { width: 8.2, height: 0.06, depth: 0.06 }, scene);
      tube.position.set(0, SIGN_Y - 1.2, 6.78); tube.material = tealGlow;
      const tube2 = tube.clone('signtube2'); tube2.position.y = SIGN_Y + 1.2; tube2.material = amberGlow;
      const signLight = new PointLight('signlight', new Vector3(0, SIGN_Y, 6.0), scene);
      signLight.diffuse = Color3.FromHexString('#8fe9d8'); signLight.intensity = 0.6; signLight.range = 8;
    }

    // Workbench with a monitor and an oscilloscope-ish box
    const bench = MeshBuilder.CreateBox('bench', { width: 5, height: 0.12, depth: 1.4 }, scene);
    bench.position.set(0, 1.0, 6.0); bench.material = metal;
    for (const x of [-2.3, 2.3]) {
      const leg = MeshBuilder.CreateBox(`benchleg${x}`, { width: 0.12, height: 1.0, depth: 1.2 }, scene);
      leg.position.set(x, 0.5, 6.0); leg.material = panel;
    }
    const monitor = MeshBuilder.CreateBox('monitor', { width: 1.6, height: 1.0, depth: 0.08 }, scene);
    monitor.position.set(-1.2, 1.6, 6.3); monitor.material = metal;
    const face = MeshBuilder.CreatePlane('monface', { width: 1.45, height: 0.85 }, scene);
    face.position.set(-1.2, 1.6, 6.25); face.material = screen;
    const scope = MeshBuilder.CreateBox('scope', { width: 1.1, height: 0.6, depth: 0.7 }, scene);
    scope.position.set(1.3, 1.36, 6.2); scope.material = panel;
    const scopeFace = MeshBuilder.CreatePlane('scopeface', { width: 0.6, height: 0.4 }, scene);
    scopeFace.position.set(1.1, 1.4, 5.84); scopeFace.material = screen;
    const trace = MeshBuilder.CreateLines('trace', {
      points: [...Array(13)].map((_, i) => new Vector3(1.1 - 0.27 + i * 0.045, 1.4 + Math.sin(i * 1.2) * 0.12, 5.83)),
    }, scene);
    trace.color = Color3.FromHexString('#3ee6c4');

    // Side gantry / robot arm silhouette
    const post = MeshBuilder.CreateBox('gantrypost', { width: 0.25, height: 4, depth: 0.25 }, scene);
    post.position.set(-4.5, 2, 0); post.material = metal;
    const arm = MeshBuilder.CreateBox('gantryarm', { width: 3.5, height: 0.2, depth: 0.2 }, scene);
    arm.position.set(-2.9, 3.6, 0); arm.material = metal;
    const claw = MeshBuilder.CreateCylinder('claw', { diameter: 0.3, height: 0.9 }, scene);
    claw.position.set(-1.4, 3.1, 0); claw.material = amberGlow;

    scene.onBeforeRenderObservable.add(() => {
      const dt = engine.getDeltaTime() / 1000;
      this.angle += dt * TURNTABLE_RPM * 2 * Math.PI / 60;
      this.turntable.rotation.y = this.angle;
      if (this.proto) this.proto.rotation.y = this.angle;
      if (this.bot) {
        this.bot.root.rotation.y = this.angle;
        this.weaponTest(dt);
      }
    });
  }

  /** Replace the preview with a new build. Invalid builds leave the last valid preview in place. */
  setBuild(build: BotBuild) {
    let next: BotMesh;
    try { next = assembleBotMesh('preview', build, this.catalog, this.scene); }
    catch { return; }
    this.bot?.root.dispose(false, true);
    this.proto?.dispose(false, true); this.proto = null;
    this.bot = next;
    this.wt = { ...this.wt, on: false, omega: 0, sawOmega: 0, angle: 0, jaw: 0, t: 0, phase: 'rest' };
    next.root.position.set(0, 0.16 + 0.35 / 2 + 0.1, 0);
    next.root.rotation.y = this.angle;
    castShadows(this.shadows, [next.root, ...next.root.getChildMeshes()]);
    // v0.27 Cube Bots look: the cubes replace the primitives (and the Meshy stand-in model, which isn't cubed)
    if (CUBES.on) skinPreview(this.scene, next.root, next.partMeshes, build.cosmetics.paint ?? '#1d7cf2', this.shadows);
    else this.loadPrototype(build);
  }

  /** Swap in a stand-in Meshy model for this body type, if one exists. Primitives stay until it loads. */
  private async loadPrototype(build: BotBuild) {
    const def = PROTOTYPE_MODELS[build.bodyId];
    if (!def) return;
    const token = ++this.loadToken;
    try {
      const res = await SceneLoader.ImportMeshAsync('', def.url, '', this.scene);
      if (token !== this.loadToken) { res.meshes.forEach(m => m.dispose(false, true)); return; }
      const root = new Mesh('protoRoot', this.scene);
      for (const m of res.meshes) if (!m.parent) m.parent = root;
      // glTF is right-handed; flip Z so the model faces the same way as the primitive bot.
      root.scaling.set(def.scale, def.scale, -def.scale);
      root.position.set(0, 0.16, 0);
      root.rotation.y = this.angle;
      castShadows(this.shadows, root.getChildMeshes());
      if (this.bot) this.bot.root.setEnabled(false);
      this.proto = root;
    } catch (e) {
      console.warn('prototype model failed to load, keeping primitives', e);
    }
  }

  render() { this.scene.render(); }

  /** One frame of the weapon test. Spinners: press = ON/OFF (3 s spin-up, coasts down like the real brake).
   *  Hammer / saw arm: tap = swing, hold = stay down, release = back to rest (saw spins while the arm is used).
   *  Flippers: press = fire (up fast, cushioned top, back down). Lifter / grappler / crusher: hold = lift / clamp. */
  private weaponTest(dt: number) {
    const bm = this.bot!, wm = bm.weaponMesh, kind = bm.weaponKind as WeaponKind | undefined;
    const w = this.wt;
    const typing = document.activeElement instanceof HTMLInputElement && document.activeElement.type === 'text';
    w.held = this.btnHeld || (isDown('Space') && !typing);
    const pressed = (w.held && !w.was) || this.latch;
    this.latch = false;
    w.was = w.held;
    if (!wm || !kind) return;
    const IDLE = 6;                                             // the old slow display spin, kept when the weapon is off
    const showPrimitives = () => { if (this.proto) { this.proto.setEnabled(false); bm.root.setEnabled(true); } };
    const idle = () => { if (this.proto) { this.proto.setEnabled(true); bm.root.setEnabled(false); } };

    if (bm.spinAxis !== 'none') {
      if (pressed) w.on = !w.on;
      const top = SPINNER.omega[kind] ?? 50;
      const up = top / (SPINNER.spinUpByKind[kind] ?? SPINNER.spinUpS);
      w.omega = w.on ? Math.min(top, w.omega + up * dt) : Math.max(0, w.omega - up * SPINNER.brake * dt);
      const omega = Math.max(IDLE, w.omega);
      if (bm.spinAxis === 'x') wm.rotation.x += SPINNER.dir.x * omega * dt;   // front edge up (launches)
      else wm.rotation.y += SPINNER.dir.y * omega * dt;                      // clockwise from above
      if (w.on || w.omega > 0) showPrimitives(); else idle();
      return;
    }

    if (kind === 'hammer' || kind === 'saw' || kind === 'hammer_saw') {
      const rest = (ARM.restDeg * Math.PI) / 180;
      if (pressed && (w.phase === 'rest' || w.phase === 'down')) { w.phase = 'up'; w.t = 0; }
      w.t += dt;
      if (w.phase === 'up') {
        // motor sized to cover the swing in ARM.swingS: constant acceleration from rest
        const acc = (2 * ARM.swingRad) / (ARM.swingS * ARM.swingS);
        w.angle = Math.min(ARM.swingRad, 0.5 * acc * w.t * w.t);
        if (w.angle >= ARM.swingRad) { w.phase = 'hold'; w.t = 0; }
      } else if (w.phase === 'hold') {
        if (!w.held && w.t > 0.1) { w.phase = 'down'; w.t = 0; }
      } else if (w.phase === 'down') {
        w.angle = Math.max(0, w.angle - Math.max(0.4, w.angle * ARM.retractEase) * dt);   // eases onto its rest stop
        if (w.angle <= 0) w.phase = 'rest';
      }
      wm.rotation.x = rest + w.angle;
      const disc = wm.getChildMeshes(true).find(c => c.name.endsWith('_saw'));
      if (disc) {
        const top = SPINNER.omega[kind] ?? 150, up = top / SPINNER.spinUpS;
        const busy = w.phase !== 'rest';
        w.sawOmega = busy ? Math.min(top, w.sawOmega + up * dt) : Math.max(0, w.sawOmega - up * SPINNER.brake * dt);
        disc.rotation.x += SPINNER.dir.x * Math.max(IDLE, w.sawOmega) * dt;
      }
      return;
    }

    if (kind === 'pneumatic_flipper' || kind === 'electric_flipper') {
      const f = FLIP[kind];
      const plate = wm.getChildMeshes(true).find(c => c.name.endsWith('_flipper'));
      if (pressed && w.phase === 'rest') { w.phase = 'up'; w.t = 0; }
      w.t += dt;
      if (w.phase === 'up') {
        const left = f.stroke - w.angle;                       // last cushionRad of the stroke eases to ~0
        const v = left < FLIP.cushionRad ? f.omega * Math.max(0.15, left / FLIP.cushionRad) : f.omega;
        w.angle = Math.min(f.stroke, w.angle + v * dt);
        if (w.angle >= f.stroke - 0.01 || w.t > FLIP.fireMaxS) { w.phase = 'hold'; w.t = 0; }
      } else if (w.phase === 'hold') {
        if (w.t > 0.15) { w.phase = 'down'; w.t = 0; }
      } else if (w.phase === 'down') {
        w.angle = Math.max(0, w.angle - FLIP.lowerOmega * dt);
        if (w.angle <= 0) w.phase = 'rest';
      }
      if (plate) plate.rotation.x = -w.angle;                  // raise = front edge up
      return;
    }

    if (kind === 'lifter' || kind === 'grappler' || kind === 'crusher') {
      const kids = wm.getChildMeshes(true);
      const fork = kids.find(c => c.name.endsWith('_fork'));
      const jaw = kids.find(c => c.name.endsWith('_jaw') || c.name.endsWith('_beak'));
      const LOWER = 3;                                          // rad/s back to rest
      w.t = w.held ? w.t + dt : 0;
      if (kind === 'lifter') {
        w.angle = w.held ? Math.min(CONTROL.fork.liftRad, w.angle + CONTROL.lifter.fork.omega * dt) : Math.max(0, w.angle - LOWER * dt);
      } else if (kind === 'grappler') {
        const close = CONTROL.jaw.openRad + CONTROL.jaw.closeRad;
        w.jaw = w.held ? Math.min(close, w.jaw + CONTROL.grappler.jaw.omega * dt) : Math.max(0, w.jaw - LOWER * dt);
        const lifting = w.held && w.t > CONTROL.grappler.forkDelayS;   // clamp first, then the fork lifts
        w.angle = lifting ? Math.min(CONTROL.fork.liftRad, w.angle + CONTROL.grappler.fork.omega * dt) : w.held ? w.angle : Math.max(0, w.angle - LOWER * dt);
      } else {
        const close = CONTROL.beak.openRad + CONTROL.beak.closeRad;
        w.jaw = w.held ? Math.min(close, w.jaw + CONTROL.crusher.beak.omega * dt) : Math.max(0, w.jaw - LOWER * dt);
      }
      if (fork) fork.rotation.x = -w.angle;                    // fork tip up
      if (jaw) jaw.rotation.x = -(kind === 'crusher' ? CONTROL.beak.openRad : CONTROL.jaw.openRad) + w.jaw;   // open -> closing down
    }
  }
}
