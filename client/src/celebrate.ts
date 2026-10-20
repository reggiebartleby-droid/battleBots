/** v0.52 (user) FIRST PLACE celebration -- the player wins a Big Arena battle or finishes 1st in a race:
 *  a big flashing neon "1ST PLACE!" sign (#firstplace, CSS) + neon energy fireworks bursting around the player's bot
 *  (additive particle bursts: cyan, magenta, green, gold) for CELEBRATE.ms. */
import { Color4, DynamicTexture, ParticleSystem, Scene, Vector3 } from '@babylonjs/core';

export const CELEBRATE = {
  ms: 3000,          // sign + fireworks this long
  bursts: 9,         // fireworks over that time
  resultsMs: 3500,   // the results card waits this long after a win (instead of 1.5 s)
};
const COLOURS = ['#36f1ff', '#ff2bd6', '#39ff14', '#ffd23f'];

export class Celebrate {
  private el: HTMLElement;
  private tex: DynamicTexture;
  private systems: ParticleSystem[] = [];
  private timers: number[] = [];

  constructor(private scene: Scene) {
    this.el = document.getElementById('firstplace')!;
    // a soft round spark (no image file needed)
    this.tex = new DynamicTexture('fwSpark', 64, scene, false);
    const g = this.tex.getContext() as CanvasRenderingContext2D;
    const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grd.addColorStop(0, 'rgba(255,255,255,1)'); grd.addColorStop(0.35, 'rgba(255,255,255,.75)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd; g.fillRect(0, 0, 64, 64);
    this.tex.hasAlpha = true;
    this.tex.update();
  }

  /** Go: sign + fireworks around `at()` (followed, so the bursts stay around a moving bot). */
  start(at: () => Vector3) {
    this.stop();
    this.el.classList.remove('on'); void this.el.offsetWidth; this.el.classList.add('on');   // restart the CSS animation
    this.timers.push(window.setTimeout(() => this.el.classList.remove('on'), CELEBRATE.ms));
    for (let i = 0; i < CELEBRATE.bursts; i++) {
      this.timers.push(window.setTimeout(() => this.burst(at(), COLOURS[i % COLOURS.length]), (i / CELEBRATE.bursts) * (CELEBRATE.ms - 600)));
    }
  }

  /** Stop + clean up (a new race / battle, leaving). */
  stop() {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    for (const s of this.systems) s.dispose(false);
    this.systems = [];
    this.el.classList.remove('on');
  }

  private burst(center: Vector3, hex: string) {
    const a = Math.random() * Math.PI * 2, r = 2.5 + Math.random() * 3;
    const pos = center.add(new Vector3(Math.sin(a) * r, 3 + Math.random() * 3, Math.cos(a) * r));
    const ps = new ParticleSystem('firework', 260, this.scene);
    ps.particleTexture = this.tex;
    ps.emitter = pos;
    ps.createSphereEmitter(0.2, 1);
    const c = Color4.FromHexString(hex + 'ff');
    ps.color1 = c; ps.color2 = new Color4(1, 1, 1, 1); ps.colorDead = new Color4(c.r, c.g, c.b, 0);
    ps.minSize = 0.12; ps.maxSize = 0.32;
    ps.minLifeTime = 0.8; ps.maxLifeTime = 1.5;
    ps.minEmitPower = 5; ps.maxEmitPower = 9;
    ps.gravity = new Vector3(0, -4, 0);
    ps.blendMode = ParticleSystem.BLENDMODE_ADD;   // neon glow: sparks add light
    ps.manualEmitCount = 220;
    ps.targetStopDuration = 0.1;
    ps.disposeOnStop = true;
    ps.start();
    this.systems.push(ps);
    // a bright flash at the burst centre
    const flash = new ParticleSystem('fwFlash', 4, this.scene);
    flash.particleTexture = this.tex; flash.emitter = pos;
    flash.color1 = flash.color2 = c; flash.colorDead = new Color4(c.r, c.g, c.b, 0);
    flash.minSize = 2.2; flash.maxSize = 3; flash.minLifeTime = flash.maxLifeTime = 0.25;
    flash.minEmitPower = flash.maxEmitPower = 0;
    flash.blendMode = ParticleSystem.BLENDMODE_ADD;
    flash.manualEmitCount = 2; flash.targetStopDuration = 0.05; flash.disposeOnStop = true;
    flash.start();
    this.systems.push(flash);
    ps.onDisposeObservable.add(() => { this.systems = this.systems.filter(s => s !== ps); });
    flash.onDisposeObservable.add(() => { this.systems = this.systems.filter(s => s !== flash); });
  }
}
