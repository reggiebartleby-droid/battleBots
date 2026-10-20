/**
 * v0.24 camera views (user: "need to be able to permanently change the angle", all modes).
 * Q cycles BROADCAST -> HIGH -> OVERHEAD -> CHASE in the arena, the test course and the lab.
 * Left-drag still orbits, the mouse wheel zooms; the view, the dragged angle and the zoom are remembered
 * in this browser (survive restarts, stations, the lab and page reloads).
 * CHASE sits behind P1's bot and turns with it (in the lab it uses the BROADCAST height: nothing drives there).
 *
 * v0.57 (user: tune the default camera for both modes, keep it right on every screen):
 *  - each mode has its own camera: RACE, BATTLE ROYAL (Big Arena) and ARENA (1v1 arena + test course).
 *    View, height, zoom and FOV are saved per mode in this browser.
 *  - F9 opens the camera tuner: live numbers, [ / ] change the FOV, COPY puts every mode's numbers on the clipboard
 *    (paste them to Claude to make them everyone's defaults), RESET puts this mode back to the defaults.
 *  - screen shape: Babylon keeps the vertical FOV fixed, so a narrower screen (16:10, 4:3) used to see less to the
 *    sides. 16:9 is now the reference: a narrower screen widens its FOV until it sees at least as much side to side
 *    as 16:9 does; wider screens (ultrawide) keep the extra edges. Resolution alone changes nothing (1080p = 1440p).
 */
import { ArcRotateCamera, Quaternion, Scalar, Vector3 } from '@babylonjs/core';

export type CamView = 'broadcast' | 'high' | 'overhead' | 'chase';
export type CamMode = 'race' | 'brawl' | 'boss' | 'arena';   // v0.58 + boss battle
const ORDER: CamView[] = ['broadcast', 'high', 'overhead', 'chase'];
const MODES: CamMode[] = ['race', 'brawl', 'boss', 'arena'];
const NAME: Record<CamView, string> = { broadcast: 'BROADCAST (low)', high: 'HIGH', overhead: 'OVERHEAD', chase: 'CHASE (behind you)' };
const MODE_NAME: Record<CamMode, string> = { race: 'RACE', brawl: 'BATTLE ROYAL', boss: 'BOSS BATTLE', arena: 'ARENA / COURSE' };

/** beta = angle down from straight overhead (rad): 1.42 is the old low broadcast camera. zoom = radius multiplier. */
const MAIN: Record<CamView, { beta: number; zoom: number }> = {
  broadcast: { beta: 1.42, zoom: 1 },
  high:      { beta: 0.95, zoom: 1.1 },
  overhead:  { beta: 0.2,  zoom: 1.35 },
  chase:     { beta: 1.2,  zoom: 0.65 },
};
const LAB: Record<CamView, number> = { broadcast: 1.25, high: 0.85, overhead: 0.25, chase: 1.25 };

/** v0.57 FOV: Babylon's default (0.8 rad, ~46 deg vertical at 16:9). Range the tuner allows, and the step per [ / ] press. */
const FOV_DEFAULT = 0.8;
const FOV_MIN = 20 * Math.PI / 180, FOV_MAX = 90 * Math.PI / 180, FOV_STEP = 2 * Math.PI / 180;
/** 16:9 is the reference screen shape; a narrower screen's FOV never goes above this (portrait phones). */
const REF_ASPECT = 16 / 9, FOV_CAP = 100 * Math.PI / 180;

interface ModeCam { view: CamView; alpha: number; beta: number; zoom: number; fov: number }
/** v0.57 built-in defaults per mode (until the user's tuned numbers are pasted in). Bump DEFAULTS_REV whenever
 *  these change: everyone's saved per-mode camera is dropped once so they get the new defaults (other settings stay). */
const DEFAULTS_REV = 2;
/** v0.57b the user's tuned cameras (2026-10-19, F9 COPY): CHASE, height 1.200, FOV 46 deg (the 0.8 default) in every mode;
 *  zoom race 1.047, Battle Royal 1.152, arena / course 1.152. Kept separate per mode so each can be retuned on its own. */
const DEFAULTS: Record<CamMode, ModeCam> = {
  race:  { view: 'chase', alpha: -Math.PI / 2, beta: 1.2, zoom: 1.047, fov: FOV_DEFAULT },
  brawl: { view: 'chase', alpha: -Math.PI / 2, beta: 1.2, zoom: 1.152, fov: FOV_DEFAULT },
  boss:  { view: 'chase', alpha: -Math.PI / 2, beta: 1.2, zoom: 1.152, fov: FOV_DEFAULT },   // v0.58 seeded from the Battle Royal camera
  arena: { view: 'chase', alpha: -Math.PI / 2, beta: 1.2, zoom: 1.152, fov: FOV_DEFAULT },
};

/** v0.23 chase camera turn cap. follow = how hard it closes the gap (1/s, was the old 4), maxRate = top pan speed
 *  (rad/s, 3.0 = ~170 deg/s; deliberate in-place turns measure 4-9 rad/s, wild spins up to ~7), maxAccel = how fast the pan speeds up / slows down (rad/s^2). */
export const CHASE_CAM = { follow: 4, maxRate: 3.0, maxAccel: 10 };

const KEY_V1 = 'bb.camera.v1';
const KEY = 'bb.camera.v2';
interface Saved { rev: number; modes: Record<CamMode, ModeCam>; labBeta: number; labRadius: number }

const clone = (m: ModeCam): ModeCam => ({ ...m });
const deg = (r: number) => r * 180 / Math.PI;

export class CamControl {
  private s: Saved;
  private mode: CamMode = 'arena';
  private toast: HTMLDivElement;
  private toastTimer = 0;
  private chaseRate = 0;                                          // rad/s the chase camera is panning at
  private tuner: HTMLDivElement;
  private tunerText: HTMLPreElement;
  private tunerOn = false;

  constructor(private main: ArcRotateCamera, private lab: ArcRotateCamera, canvas: HTMLCanvasElement, private inLab: () => boolean) {
    this.s = { rev: DEFAULTS_REV, modes: { race: clone(DEFAULTS.race), brawl: clone(DEFAULTS.brawl), boss: clone(DEFAULTS.boss), arena: clone(DEFAULTS.arena) },
      labBeta: LAB.chase, labRadius: lab.radius };
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const j = JSON.parse(raw) as Partial<Saved>;
        if (typeof j.labBeta === 'number') this.s.labBeta = j.labBeta;
        if (typeof j.labRadius === 'number') this.s.labRadius = j.labRadius;
        if (j.rev === DEFAULTS_REV && j.modes) for (const m of MODES) {
          const v = j.modes[m];
          if (v && ORDER.includes(v.view)) this.s.modes[m] = { ...this.s.modes[m], ...v };
        }
      } else {
        // first run of v0.57: start every mode from the v0.24-v0.56 shared camera this browser already had
        const old = localStorage.getItem(KEY_V1);
        if (old) {
          const j = JSON.parse(old);
          if (ORDER.includes(j.view)) for (const m of MODES) this.s.modes[m] = { ...this.s.modes[m], view: j.view, alpha: j.alpha, beta: j.beta, zoom: j.zoom };
          if (typeof j.labBeta === 'number') this.s.labBeta = j.labBeta;
          if (typeof j.labRadius === 'number') this.s.labRadius = j.labRadius;
        }
      }
    } catch { /* no storage: defaults */ }

    for (const c of [main, lab]) {
      c.lowerBetaLimit = 0.15;                                    // was 1.1 (main) / 0.6 (lab): high + overhead views
      c.upperBetaLimit = 1.5;
      c.inputs.removeByType('ArcRotateCameraMouseWheelInput');    // own wheel zoom below (the auto-zoom used to undo it)
      c.overrideCloneAlphaBetaRadius = true;                      // following a bot used to re-aim the angle every frame (the drift)
    }
    main.lowerRadiusLimit = 3; main.upperRadiusLimit = 45;
    main.beta = this.m.beta; main.alpha = this.m.alpha;           // (no applyMode here: inLab() can't be asked yet)
    lab.beta = this.s.labBeta; lab.radius = Scalar.Clamp(this.s.labRadius, lab.lowerRadiusLimit ?? 4, lab.upperRadiusLimit ?? 12);

    canvas.addEventListener('wheel', e => {
      e.preventDefault();
      const f = e.deltaY > 0 ? 1.1 : 1 / 1.1;
      if (this.inLab()) this.s.labRadius = this.lab.radius = Scalar.Clamp(this.lab.radius * f, this.lab.lowerRadiusLimit ?? 4, this.lab.upperRadiusLimit ?? 12);
      else this.m.zoom = Scalar.Clamp(this.m.zoom * f, 0.4, 2.5);
      this.save();
    }, { passive: false });
    // remember the dragged angle when the mouse lets go
    window.addEventListener('pointerup', () => { this.grab(); this.save(); });
    window.addEventListener('keydown', e => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.code === 'F9') { e.preventDefault(); if (!e.repeat) this.toggleTuner(); return; }
      if (this.tunerOn && (e.code === 'BracketLeft' || e.code === 'BracketRight')) {   // v0.57 FOV (repeat OK: hold to sweep)
        this.m.fov = Scalar.Clamp(this.m.fov + (e.code === 'BracketRight' ? FOV_STEP : -FOV_STEP), FOV_MIN, FOV_MAX);
        this.save(); return;
      }
      if (e.repeat || e.code !== 'KeyQ') return;
      this.cycle();
    });

    this.toast = document.createElement('div');
    this.toast.style.cssText = 'position:absolute;top:44px;left:50%;transform:translateX(-50%);padding:6px 14px;background:rgba(0,0,0,.7);'
      + 'border:1px solid #3ee6c4;color:#3ee6c4;font:bold 13px monospace;letter-spacing:1px;border-radius:4px;pointer-events:none;'
      + 'z-index:50;display:none';
    document.body.appendChild(this.toast);

    // v0.57 camera tuner (F9)
    this.tuner = document.createElement('div');
    this.tuner.id = 'bb-camtuner';
    this.tuner.style.cssText = 'position:absolute;top:80px;right:12px;padding:10px 12px;background:rgba(6,10,14,.88);border:1px solid #3ee6c4;'
      + 'color:#cfeee8;font:12px/1.45 ui-monospace,Consolas,monospace;border-radius:4px;z-index:60;display:none;min-width:250px';
    const title = document.createElement('div');
    title.textContent = 'CAMERA TUNER (F9)';
    title.style.cssText = 'color:#3ee6c4;font-weight:bold;letter-spacing:1px;margin-bottom:6px';
    this.tunerText = document.createElement('pre');
    this.tunerText.style.cssText = 'margin:0 0 8px;font:inherit;white-space:pre';
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:6px';
    const btn = (label: string, fn: () => void) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.style.cssText = 'flex:1;padding:4px 8px;background:#0f2a26;color:#3ee6c4;border:1px solid #3ee6c4;border-radius:3px;font:bold 12px monospace;cursor:pointer';
      b.addEventListener('pointerdown', e => e.stopPropagation());
      b.addEventListener('click', e => { e.stopPropagation(); fn(); (b as HTMLButtonElement).blur(); });
      row.appendChild(b);
    };
    btn('COPY', () => this.copy());
    btn('RESET MODE', () => this.resetMode());
    const help = document.createElement('div');
    help.style.cssText = 'margin-top:6px;color:#7fa9a1;font-size:11px';
    help.innerHTML = 'Q view · drag = angle/height · wheel = zoom<br>[ / ] = FOV · saved per mode in this browser';
    this.tuner.append(title, this.tunerText, row, help);
    document.body.appendChild(this.tuner);
  }

  /** The current mode's camera numbers. */
  private get m(): ModeCam { return this.s.modes[this.mode]; }
  get view() { return this.m.view; }
  get currentMode() { return this.mode; }
  /** Short label for the help line. */
  label() { return `Q: camera (${this.m.view})`; }

  /** v0.57 switch to a mode's own camera (race / Battle Royal / arena). Same mode again = nothing happens. */
  setMode(mode: CamMode) {
    if (mode === this.mode) return;
    this.grab();
    this.mode = mode;
    this.chaseRate = 0;
    this.applyMode();
  }
  private applyMode() {
    const m = this.m;
    this.main.beta = m.beta;
    this.main.alpha = m.alpha;
    this.applyFov();
  }

  /** v0.57 every frame: FOV for this screen shape (16:9 reference, see top), and the tuner's live numbers. */
  update() {
    this.applyFov();
    if (this.tunerOn) this.tunerText.textContent = this.readout();
  }
  /** Vertical FOV that shows at least the 16:9 width on a narrower screen. */
  effectiveFov(aspect = this.aspect()) {
    const f = this.m.fov;
    if (!(aspect > 0) || aspect >= REF_ASPECT) return f;
    return Math.min(FOV_CAP, 2 * Math.atan(Math.tan(f / 2) * REF_ASPECT / aspect));
  }
  private aspect() { return this.main.getEngine().getAspectRatio(this.main); }
  private applyFov() { if (!this.inLab()) this.main.fov = this.effectiveFov(); }

  /** Next view: snaps the height + zoom to the preset (drag / wheel tweak it from there). */
  cycle() {
    const m = this.m;
    m.view = ORDER[(ORDER.indexOf(m.view) + 1) % ORDER.length];
    const p = MAIN[m.view];
    m.beta = this.main.beta = p.beta;
    if (m.view !== 'chase') this.main.alpha = m.alpha;   // back to the remembered angle after CHASE
    m.zoom = p.zoom;
    this.s.labBeta = this.lab.beta = LAB[m.view];
    this.save();
    this.show(`CAMERA: ${NAME[m.view]}${this.inLab() && m.view === 'chase' ? ' — in matches / course' : ''}`);
  }

  /** Radius for the match / course camera: the mode's automatic framing times the player's zoom. */
  radius(auto: number) { return auto * this.m.zoom; }

  /** CHASE: swing the camera round behind this bot (heading from rotationQuaternion).
   *  v0.26 turn cap (user: the camera spinning wildly with a spun bot "feels broken"): the camera turns at most
   *  CHASE_CAM.maxRate and speeds up / slows down at most CHASE_CAM.maxAccel, like a TV camera operator panning.
   *  The bot still spins as hard as the hit makes it; the camera follows smoothly instead of whipping. */
  chase(q: Quaternion | null | undefined, dt: number) {
    if (this.m.view !== 'chase' || !q) { this.chaseRate = 0; return; }
    const f = Vector3.Forward().applyRotationQuaternion(q);
    if (f.x * f.x + f.z * f.z < 0.01) return;                    // pointing straight up/down: hold
    const want = Math.atan2(-f.z, -f.x);                          // camera sits opposite the nose
    let d = want - this.main.alpha;
    d = Math.atan2(Math.sin(d), Math.cos(d));                    // shortest way round
    const target = Scalar.Clamp(d * CHASE_CAM.follow, -CHASE_CAM.maxRate, CHASE_CAM.maxRate);   // rad/s wanted
    const dv = CHASE_CAM.maxAccel * dt;
    this.chaseRate += Scalar.Clamp(target - this.chaseRate, -dv, dv);
    this.main.alpha += this.chaseRate * dt;
  }

  // ---- v0.57 tuner ----
  private toggleTuner() {
    this.tunerOn = !this.tunerOn;
    this.tuner.style.display = this.tunerOn ? 'block' : 'none';
    if (this.tunerOn) this.tunerText.textContent = this.readout();
  }
  private readout() {
    const m = this.m, a = this.aspect(), eng = this.main.getEngine();
    return [
      `MODE    ${MODE_NAME[this.mode]}`,
      `VIEW    ${NAME[m.view]}`,
      `HEIGHT  ${deg(this.main.beta).toFixed(1)}° from overhead (${this.main.beta.toFixed(3)})`,
      `ZOOM    x${m.zoom.toFixed(2)}`,
      `FOV     ${deg(m.fov).toFixed(0)}° set · ${deg(this.effectiveFov(a)).toFixed(1)}° used`,
      `SCREEN  ${eng.getRenderWidth()}x${eng.getRenderHeight()} (${a.toFixed(2)}:1${a < REF_ASPECT - 0.01 ? ', FOV widened' : ''})`,
    ].join('\n');
  }
  /** One line with every mode's numbers (paste it to Claude to make them the defaults). */
  copyLine() {
    this.grab();
    const one = (k: CamMode) => { const m = this.s.modes[k]; return `${k}: view=${m.view} beta=${m.beta.toFixed(3)} zoom=${m.zoom.toFixed(3)} fov=${deg(m.fov).toFixed(0)}`; };
    return `CAM v0.57 | ${MODES.map(one).join(' | ')}`;
  }
  private copy() {
    const line = this.copyLine();
    const done = () => this.show('CAMERA NUMBERS COPIED — paste them to Claude');
    const fallback = () => {
      const t = document.createElement('textarea');
      t.value = line; document.body.appendChild(t); t.select();
      try { document.execCommand('copy'); done(); } catch { this.show('COPY FAILED — see the console (F12)'); }
      t.remove();
    };
    console.log(line);
    try { navigator.clipboard.writeText(line).then(done, fallback); } catch { fallback(); }
  }
  /** v0.58 (user, 2026-10-20): every battle / race starts on this mode's default camera (view, height, zoom, FOV), so
   *  testers always play on the tuned settings; Q / drag / wheel / F9 changes last until the next start. */
  startDefaults(mode: CamMode) {
    this.mode = mode;
    this.s.modes[mode] = clone(DEFAULTS[mode]);
    this.chaseRate = 0;
    this.applyMode();
    this.save();
  }
  private resetMode() {
    this.s.modes[this.mode] = clone(DEFAULTS[this.mode]);
    this.applyMode();
    this.save();
    this.show(`CAMERA: ${MODE_NAME[this.mode]} back to the defaults`);
  }

  private grab() {
    if (this.inLab()) { this.s.labBeta = this.lab.beta; this.s.labRadius = this.lab.radius; return; }
    if (this.m.view !== 'chase') this.m.alpha = this.main.alpha;
    this.m.beta = this.main.beta;
  }
  private save() { try { localStorage.setItem(KEY, JSON.stringify(this.s)); } catch { /* no storage */ } }
  private show(text: string) {
    this.toast.textContent = text; this.toast.style.display = 'block';
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => { this.toast.style.display = 'none'; }, 1600);
  }
}
