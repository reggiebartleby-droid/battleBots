/**
 * v0.24 camera views (user: "need to be able to permanently change the angle", all modes).
 * Q cycles BROADCAST -> HIGH -> OVERHEAD -> CHASE in the arena, the test course and the lab.
 * Left-drag still orbits, the mouse wheel zooms; the view, the dragged angle and the zoom are remembered
 * in this browser (survive restarts, stations, the lab and page reloads).
 * CHASE sits behind P1's bot and turns with it (in the lab it uses the BROADCAST height: nothing drives there).
 */
import { ArcRotateCamera, Quaternion, Scalar, Vector3 } from '@babylonjs/core';

export type CamView = 'broadcast' | 'high' | 'overhead' | 'chase';
const ORDER: CamView[] = ['broadcast', 'high', 'overhead', 'chase'];
const NAME: Record<CamView, string> = { broadcast: 'BROADCAST (low)', high: 'HIGH', overhead: 'OVERHEAD', chase: 'CHASE (behind you)' };

/** beta = angle down from straight overhead (rad): 1.42 is the old low broadcast camera. zoom = radius multiplier. */
const MAIN: Record<CamView, { beta: number; zoom: number }> = {
  broadcast: { beta: 1.42, zoom: 1 },
  high:      { beta: 0.95, zoom: 1.1 },
  overhead:  { beta: 0.2,  zoom: 1.35 },
  chase:     { beta: 1.2,  zoom: 0.65 },
};
const LAB: Record<CamView, number> = { broadcast: 1.25, high: 0.85, overhead: 0.25, chase: 1.25 };

/** v0.26 chase camera turn cap. follow = how hard it closes the gap (1/s, was the old 4), maxRate = top pan speed
 *  (rad/s, 3.0 = ~170 deg/s; deliberate in-place turns measure 4-9 rad/s, wild spins up to ~7), maxAccel = how fast the pan speeds up / slows down (rad/s^2). */
export const CHASE_CAM = { follow: 4, maxRate: 3.0, maxAccel: 10 };

const KEY = 'bb.camera.v1';
interface Saved { view: CamView; alpha: number; beta: number; zoom: number; labBeta: number; labRadius: number }

export class CamControl {
  private s: Saved;
  private toast: HTMLDivElement;
  private toastTimer = 0;
  private chaseRate = 0;                                          // rad/s the chase camera is panning at

  constructor(private main: ArcRotateCamera, private lab: ArcRotateCamera, canvas: HTMLCanvasElement, private inLab: () => boolean) {
    this.s = { view: 'broadcast', alpha: -Math.PI / 2, beta: MAIN.broadcast.beta, zoom: 1, labBeta: LAB.broadcast, labRadius: lab.radius };
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) { const j = JSON.parse(raw); if (ORDER.includes(j.view)) this.s = { ...this.s, ...j }; }
    } catch { /* no storage: defaults */ }

    for (const c of [main, lab]) {
      c.lowerBetaLimit = 0.15;                                    // was 1.1 (main) / 0.6 (lab): high + overhead views
      c.upperBetaLimit = 1.5;
      c.inputs.removeByType('ArcRotateCameraMouseWheelInput');    // own wheel zoom below (the auto-zoom used to undo it)
      c.overrideCloneAlphaBetaRadius = true;                      // following a bot used to re-aim the angle every frame (the drift)
    }
    main.lowerRadiusLimit = 3; main.upperRadiusLimit = 45;
    main.alpha = this.s.alpha; main.beta = this.s.beta;
    lab.beta = this.s.labBeta; lab.radius = Scalar.Clamp(this.s.labRadius, lab.lowerRadiusLimit ?? 4, lab.upperRadiusLimit ?? 12);

    canvas.addEventListener('wheel', e => {
      e.preventDefault();
      const f = e.deltaY > 0 ? 1.1 : 1 / 1.1;
      if (this.inLab()) this.s.labRadius = this.lab.radius = Scalar.Clamp(this.lab.radius * f, this.lab.lowerRadiusLimit ?? 4, this.lab.upperRadiusLimit ?? 12);
      else this.s.zoom = Scalar.Clamp(this.s.zoom * f, 0.4, 2.5);
      this.save();
    }, { passive: false });
    // remember the dragged angle when the mouse lets go
    window.addEventListener('pointerup', () => { this.grab(); this.save(); });
    window.addEventListener('keydown', e => {
      if (e.repeat || e.code !== 'KeyQ') return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement) return;
      this.cycle();
    });

    this.toast = document.createElement('div');
    this.toast.style.cssText = 'position:absolute;top:44px;left:50%;transform:translateX(-50%);padding:6px 14px;background:rgba(0,0,0,.7);'
      + 'border:1px solid #3ee6c4;color:#3ee6c4;font:bold 13px monospace;letter-spacing:1px;border-radius:4px;pointer-events:none;'
      + 'z-index:50;display:none';
    document.body.appendChild(this.toast);
  }

  get view() { return this.s.view; }
  /** Short label for the help line. */
  label() { return `Q: camera (${this.s.view})`; }

  /** Next view: snaps the height + zoom to the preset (drag / wheel tweak it from there). */
  cycle() {
    this.s.view = ORDER[(ORDER.indexOf(this.s.view) + 1) % ORDER.length];
    const p = MAIN[this.s.view];
    this.s.beta = this.main.beta = p.beta;
    if (this.s.view !== 'chase') this.main.alpha = this.s.alpha;   // back to the remembered angle after CHASE
    this.s.zoom = p.zoom;
    this.s.labBeta = this.lab.beta = LAB[this.s.view];
    this.save();
    this.show(`CAMERA: ${NAME[this.s.view]}${this.inLab() && this.s.view === 'chase' ? ' — in matches / course' : ''}`);
  }

  /** Radius for the match / course camera: the mode's automatic framing times the player's zoom. */
  radius(auto: number) { return auto * this.s.zoom; }

  /** CHASE: swing the camera round behind this bot (heading from rotationQuaternion).
   *  v0.26 turn cap (user: the camera spinning wildly with a spun bot "feels broken"): the camera turns at most
   *  CHASE_CAM.maxRate and speeds up / slows down at most CHASE_CAM.maxAccel, like a TV camera operator panning.
   *  The bot still spins as hard as the hit makes it; the camera follows smoothly instead of whipping. */
  chase(q: Quaternion | null | undefined, dt: number) {
    if (this.s.view !== 'chase' || !q) { this.chaseRate = 0; return; }
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

  private grab() {
    if (this.inLab()) { this.s.labBeta = this.lab.beta; this.s.labRadius = this.lab.radius; return; }
    if (this.s.view !== 'chase') this.s.alpha = this.main.alpha;
    this.s.beta = this.main.beta;
  }
  private save() { try { localStorage.setItem(KEY, JSON.stringify(this.s)); } catch { /* no storage */ } }
  private show(text: string) {
    this.toast.textContent = text; this.toast.style.display = 'block';
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => { this.toast.style.display = 'none'; }, 1600);
  }
}
