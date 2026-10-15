/**
 * Hit feedback: sparks at the contact point, defender flash, floating damage
 * numbers (DOM overlay projected from world space) and a little camera shake.
 */
import { Camera, Color3, Matrix, Mesh, MeshBuilder, Scene, StandardMaterial, Vector3 } from '@babylonjs/core';
import type { Bot } from './bot.js';

interface Spark { m: Mesh; v: Vector3; life: number; max: number }
interface Label { el: HTMLElement; pos: Vector3; life: number; max: number }
interface Flash { mat: StandardMaterial; life: number }
interface Debris { m: Mesh; v: Vector3; w: Vector3; life: number; max: number }

const SPARK_LIFE = 0.45;
const LABEL_LIFE = 0.9;
const FLASH_LIFE = 0.22;
/** Elimination explosion (bot knocked out of the arena). */
const EXPLODE = {
  debrisLife: 1.8,      // s before the parts vanish
  debrisSpeed: 7,       // m/s burst speed of the flying parts
  debrisUp: 6,          // extra upward m/s so parts arc instead of dropping
  spin: 12,             // rad/s tumble
  sparks: 60,           // fireball sparks
  sparkSpeed: 9,
  shake: 0.6,
};

export class Fx {
  shake = 0;
  private sparks: Spark[] = [];
  private labels: Label[] = [];
  private flashes: Flash[] = [];
  private debris: Debris[] = [];
  private sparkMat: StandardMaterial;
  private bumpMat: StandardMaterial;
  private fireMat: StandardMaterial;
  private lastBump = 0;

  constructor(private scene: Scene, private layer: HTMLElement) {
    this.sparkMat = new StandardMaterial('fx_spark', scene);
    this.sparkMat.emissiveColor = Color3.FromHexString('#ffd166');
    this.sparkMat.disableLighting = true;
    this.bumpMat = new StandardMaterial('fx_bump', scene);
    this.bumpMat.emissiveColor = Color3.FromHexString('#8a8f98');
    this.bumpMat.disableLighting = true;
    this.fireMat = new StandardMaterial('fx_fire', scene);
    this.fireMat.emissiveColor = Color3.FromHexString('#ff5a1f');
    this.fireMat.disableLighting = true;
  }

  /** A real weapon hit. */
  hit(point: Vector3, dmg: number, defender: Bot, attackerColor: string) {
    this.spawnSparks(point, 12, this.sparkMat, 4);
    this.label(`-${dmg}`, point.add(new Vector3(0, 0.6, 0)), attackerColor, 'dmg');
    this.flash(defender);
    this.shake = Math.min(0.35, this.shake + 0.08 + dmg * 0.004);
  }

  /** Contact with no live weapon behind it. */
  bump(point: Vector3) {
    const now = performance.now();
    if (now - this.lastBump < 250) return;
    this.lastBump = now;
    this.spawnSparks(point, 3, this.bumpMat, 1.5);
    this.label('bump', point.add(new Vector3(0, 0.5, 0)), '#8a8f98', 'bump');
  }

  /**
   * Bot eliminated (knocked out of the arena): fireball + every part flies off tumbling.
   * Clones the bot's meshes as free debris so the real bot can be hidden/frozen by the caller.
   */
  explode(bot: Bot, at: Vector3) {
    this.spawnSparks(at, EXPLODE.sparks, this.fireMat, EXPLODE.sparkSpeed, 1.6);
    this.spawnSparks(at, EXPLODE.sparks / 3, this.sparkMat, EXPLODE.sparkSpeed * 0.7, 1.2);
    this.label('OUT!', at.add(new Vector3(0, 1.2, 0)), '#ff4d4d', 'dmg');
    this.shake = Math.max(this.shake, EXPLODE.shake);
    for (const src of [bot.root, ...bot.root.getChildMeshes()]) {
      if (!(src instanceof Mesh) || src.visibility < 0.01) continue;
      const m = src.clone(`debris_${src.name}`, src.parent as Mesh | null, true, false);   // no children, NO physics body
      if (!m) continue;
      m.setParent(null);                      // keep world transform, detach from the bot
      if (m.rotationQuaternion) { m.rotation = m.rotationQuaternion.toEulerAngles(); m.rotationQuaternion = null; }
      m.isPickable = false;
      m.setEnabled(true);
      const dir = new Vector3(Math.random() - 0.5, 0, Math.random() - 0.5).normalize();
      const v = dir.scale(EXPLODE.debrisSpeed * (0.5 + Math.random())).add(new Vector3(0, EXPLODE.debrisUp * (0.6 + Math.random() * 0.8), 0));
      const w = new Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).scale(EXPLODE.spin * 2);
      const life = EXPLODE.debrisLife * (0.7 + Math.random() * 0.5);
      this.debris.push({ m, v, w, life, max: life });
    }
  }

  update(dt: number, camera: Camera) {
    const engine = this.scene.getEngine();
    const w = engine.getRenderWidth(), h = engine.getRenderHeight();
    const vp = camera.viewport.toGlobal(w, h);
    const tm = this.scene.getTransformMatrix();

    for (const s of this.sparks) {
      s.life -= dt;
      s.v.y -= 9.8 * dt;
      s.m.position.addInPlace(s.v.scale(dt));
      const k = Math.max(0, s.life / s.max);
      s.m.scaling.setAll(0.03 + 0.07 * k);
      if (s.life <= 0) s.m.dispose();
    }
    this.sparks = this.sparks.filter(s => s.life > 0);

    for (const d of this.debris) {
      d.life -= dt;
      d.v.y -= 9.8 * dt;
      d.m.position.addInPlace(d.v.scale(dt));
      d.m.rotation.addInPlace(d.w.scale(dt));
      const k = Math.max(0, d.life / d.max);
      if (k < 0.3) d.m.scaling.scaleInPlace(Math.max(0.01, 1 - dt * 4));   // shrink away at the end
      if (d.life <= 0) d.m.dispose();
    }
    this.debris = this.debris.filter(d => d.life > 0);

    for (const l of this.labels) {
      l.life -= dt;
      l.pos.y += 0.9 * dt;
      const p = Vector3.Project(l.pos, Matrix.Identity(), tm, vp);
      const k = Math.max(0, l.life / l.max);
      l.el.style.transform = `translate(-50%, -50%) translate(${p.x}px, ${p.y}px) scale(${0.8 + 0.4 * k})`;
      l.el.style.opacity = String(Math.min(1, k * 1.6));
      if (l.life <= 0) l.el.remove();
    }
    this.labels = this.labels.filter(l => l.life > 0);

    for (const f of this.flashes) {
      f.life -= dt;
      const k = Math.max(0, f.life / FLASH_LIFE);
      f.mat.emissiveColor.set(k, k, k);
    }
    this.flashes = this.flashes.filter(f => f.life > 0);

    this.shake *= Math.exp(-dt * 7);
  }

  /** Offset to add to the camera target this frame. */
  shakeOffset(): Vector3 {
    if (this.shake < 0.005) return Vector3.Zero();
    return new Vector3((Math.random() - 0.5) * this.shake, (Math.random() - 0.5) * this.shake * 0.6, (Math.random() - 0.5) * this.shake);
  }

  clear() {
    for (const s of this.sparks) s.m.dispose();
    for (const d of this.debris) d.m.dispose();
    for (const l of this.labels) l.el.remove();
    for (const f of this.flashes) f.mat.emissiveColor.set(0, 0, 0);
    this.sparks = []; this.debris = []; this.labels = []; this.flashes = []; this.shake = 0;
  }

  private spawnSparks(at: Vector3, n: number, mat: StandardMaterial, speed: number, lifeScale = 1) {
    for (let i = 0; i < n; i++) {
      const m = MeshBuilder.CreateBox(`spark`, { size: 1 }, this.scene);
      m.material = mat;
      m.isPickable = false;
      m.position.copyFrom(at);
      const a = Math.random() * Math.PI * 2;
      const up = 0.4 + Math.random() * 0.6;
      const v = new Vector3(Math.cos(a), up * 1.4, Math.sin(a)).normalize().scale(speed * (0.6 + Math.random() * 0.8));
      const life = SPARK_LIFE * lifeScale * (0.6 + Math.random() * 0.6);
      this.sparks.push({ m, v, life, max: life });
    }
  }

  private label(text: string, pos: Vector3, color: string, cls: string) {
    const el = document.createElement('div');
    el.className = `fxlabel ${cls}`;
    el.textContent = text;
    el.style.color = color;
    this.layer.appendChild(el);
    this.labels.push({ el, pos: pos.clone(), life: LABEL_LIFE, max: LABEL_LIFE });
  }

  private flash(bot: Bot) {
    const mats = new Set<StandardMaterial>();
    for (const m of [bot.root, ...bot.root.getChildMeshes()]) {
      if (m.material instanceof StandardMaterial) mats.add(m.material);
    }
    for (const mat of mats) {
      const existing = this.flashes.find(f => f.mat === mat);
      if (existing) existing.life = FLASH_LIFE; else this.flashes.push({ mat, life: FLASH_LIFE });
    }
  }
}
