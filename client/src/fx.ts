/**
 * Hit feedback: sparks at the contact point, defender flash, floating damage
 * numbers (DOM overlay projected from world space) and a little camera shake.
 */
import { Camera, Color3, Matrix, Mesh, MeshBuilder, Scene, StandardMaterial, Vector3 } from '@babylonjs/core';
import { botMeshes, type Bot } from './bot.js';
import { cubeHit, cubeKnockout } from './cubes.js';
import { totalMaxHp } from '../../src/core/state.js';

interface Spark { m: Mesh; v: Vector3; life: number; max: number }
interface Label { el: HTMLElement; pos: Vector3; life: number; max: number; age: number; pop: boolean; jitter: boolean; fw: boolean; drift: number }
interface Flash { mat: { emissiveColor: Color3 }; life: number }   // v0.16: bots use PBR materials
interface Debris { m: Mesh; v: Vector3; w: Vector3; life: number; max: number }

const SPARK_LIFE = 0.45;
const LABEL_LIFE = 0.9;
/** v0.55 (user) your points: one flashy gold, pop in bright like a firework, then drift up and fade out to nothing like
 *  firework smoke. Times in s: pop = scale-up flash, settle = back to size, life = total until fully invisible. */
const FIREWORK = { pop: 0.1, settle: 0.2, life: 1.4, rise: 1.8, popScale: 1.35, flash: 2.6, grow: 0.3, blur: 6, drift: 24 };
const FLASH_LIFE = 0.22;
/** v0.53 big hits stand out. Tier = one hit's (or one combo's) damage as a share of the victim's starting total HP:
 *  t1 chip < 2%, t2 solid 2-5%, t3 heavy 5-10% (yellow), t4 big 10-20% (orange, outline, pop),
 *  t5 massive 20%+ (red, outline, pop + jitter, a SMASH!-type word). Sizes/colours in index.html (.fxlabel.t1-t5). */
const HIT_TIER = [0.02, 0.05, 0.10, 0.20];
/** v0.53 hits on the same bot this close together add into one growing number */
const COMBO_MS = 450;
/** v0.53 extra camera shake for big (t4) / massive (t5) hits -- only when your bot gives or takes the hit */
const TIER_SHAKE = { 4: 0.22, 5: 0.45, cap: 0.7 } as const;
const BIG_WORDS = ['SMASH!', 'WRECKED!', 'CRUNCH!'];
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
  private dustMat: StandardMaterial;   // v0.56 cosmetic dust when a hit knocks no cube off
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
    this.dustMat = new StandardMaterial('fx_dust', scene);
    this.dustMat.emissiveColor = Color3.FromHexString('#b8b0a2');
    this.dustMat.disableLighting = true;
  }

  /** v0.33 race: hits far from this point (the player) shake the camera less. null = full shake (arena). */
  focus: Vector3 | null = null;
  private near(p: Vector3) { return this.focus ? Math.max(0, 1 - Vector3.Distance(p, this.focus) / 14) : 1; }
  /** v0.34h: a NaN in the shake made the camera target NaN for good (black 3D view, game still running). Bad hits
   *  don't shake the camera; the first one is reported (yellow console warning) so the source can be found. */
  private shakeAdd(amount: number, what: string, info: unknown) {
    if (Number.isFinite(amount)) { this.shake = Math.max(0, this.shake + amount); return; }
    if (!this.warned) { this.warned = true; console.warn(`[v0.34h] bad number in camera shake from ${what} -- ignored`, info); }
  }
  private warned = false;

  /** v0.53 your bot (set every frame by main.ts): big-hit shake only when it gives or takes the hit */
  me: Bot | null = null;
  /** v0.53 the live combo number per victim */
  private combos = new Map<string, { l: Label; total: number; t: number; tier: number }>();

  private tierOf(dmg: number, defender: Bot) {
    const max = totalMaxHp(defender.state);   // v0.56 + the chassis pool
    const f = max > 0 ? dmg / max : 0;
    let t = 1;
    for (const th of HIT_TIER) if (f >= th) t++;
    return t;
  }

  /** A real weapon hit. attacker (v0.53) = who gets the credit, if anyone -- for the your-bot-only shake. */
  hit(point: Vector3, dmg: number, defender: Bot, attackerColor: string, attacker?: Bot) {
    this.spawnSparks(point, 12, this.sparkMat, 4);
    const now = performance.now();
    // v0.54 (user): you only see the numbers for hits YOUR bot lands -- other bots' hits (on anyone, you included)
    // and hazards show no number. Per viewer: in multiplayer each player's fx.me is their own bot.
    const showNum = !!this.me && attacker === this.me;
    const c = showNum ? this.combos.get(defender.id) : undefined;
    let tier: number, before = 0;
    if (c && c.l.life > 0 && now - c.t <= COMBO_MS) {   // v0.53 add into the running number
      before = c.tier;
      c.total += dmg; c.t = now;
      tier = Math.max(c.tier, this.tierOf(c.total, defender));
      c.tier = tier;
      c.l.el.textContent = `-${c.total}`;
      c.l.el.className = `fxlabel dmg t${tier}`;
      c.l.life = c.l.max;
      c.l.age = 0;   // v0.55 every added hit pops the number in bright again
      c.l.jitter = tier >= 5;
    } else if (!showNum) {
      tier = this.tierOf(dmg, defender);   // no number; the tier still drives the your-bot-only shake below
    } else {
      tier = this.tierOf(dmg, defender);
      const l = this.label(`-${dmg}`, point.add(new Vector3(0, 0.6, 0)), attackerColor, `dmg t${tier}`);
      l.jitter = tier >= 5;
      l.fw = true; l.life = l.max = FIREWORK.life; l.drift = (Math.random() - 0.5) * 2;   // v0.55 firework pop + smoke fade
      this.combos.set(defender.id, { l, total: dmg, t: now, tier });
    }
    if (tier > before && tier >= 4) {
      if (tier >= 5 && showNum) this.label(BIG_WORDS[Math.floor(Math.random() * BIG_WORDS.length)], point.add(new Vector3(0, 1.5, 0)), '#ff2e4d', 'word').pop = true;
      if (tier >= 5 && before < 4) this.spawnSparks(point, 10, this.fireMat, 5);
      const mine = !!this.me && (defender === this.me || attacker === this.me);
      if (mine) {
        const add = Math.min(TIER_SHAKE.cap, this.shake + TIER_SHAKE[tier >= 5 ? 5 : 4]) - this.shake;
        this.shakeAdd(Math.max(0, add), 'big hit', { dmg, tier, defender: defender.id });
      }
    }
    this.flash(defender);
    // v0.27 Cube Bots look: knock cubes loose (no-op otherwise). v0.56 (user, gotcha b): a hit too small to knock a
    // whole cube off (each cube = a share of HP) still shows a puff of cosmetic dust -- not cubes, worth nothing
    if (cubeHit(defender, point, dmg) === 0) this.spawnSparks(point, 9, this.dustMat, 1.8, 1.4);
    const add = Math.min(0.35, this.shake + (0.08 + dmg * 0.004) * this.near(point)) - this.shake;   // v0.34h: same cap, NaN-checked
    this.shakeAdd(add, 'hit', { dmg, point: point.asArray(), defender: defender.id });
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
  explode(bot: Bot, at: Vector3, text = 'OUT!') {
    this.spawnSparks(at, EXPLODE.sparks, this.fireMat, EXPLODE.sparkSpeed, 1.6);
    this.spawnSparks(at, EXPLODE.sparks / 3, this.sparkMat, EXPLODE.sparkSpeed * 0.7, 1.2);
    this.label(text, at.add(new Vector3(0, 1.2, 0)), '#ff4d4d', 'dmg');
    this.shakeAdd(Math.max(0, EXPLODE.shake * this.near(at) - this.shake), 'explode', { at: at.asArray(), bot: bot.id, text });   // v0.34h
    cubeKnockout(bot);                // v0.27 Cube Bots look: every cube flies (the cubed meshes are hidden, so their clones below are too)
    for (const src of botMeshes(bot)) {
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
      if (l.fw) { this.firework(l, dt, tm, vp); continue; }   // v0.55 your points
      l.pos.y += 0.9 * dt;
      const p = Vector3.Project(l.pos, Matrix.Identity(), tm, vp);
      const k = Math.max(0, l.life / l.max);
      l.age += dt;
      // v0.53 big hits pop in (0.5 -> 1.4 -> 1) and massive ones jitter while fresh
      const pop = !l.pop ? 1 : l.age < 0.1 ? 0.5 + 9 * l.age : l.age < 0.22 ? 1.4 - (l.age - 0.1) * (0.4 / 0.12) : 1;
      const jx = l.jitter && l.age < 0.45 ? (Math.random() - 0.5) * 6 : 0, jy = l.jitter && l.age < 0.45 ? (Math.random() - 0.5) * 6 : 0;
      l.el.style.transform = `translate(-50%, -50%) translate(${p.x + jx}px, ${p.y + jy}px) scale(${(0.8 + 0.4 * k) * pop})`;
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

  /** v0.55 a points number: pops in bright (0.3 -> 1.35 -> 1, brightness flash), then rises, swells, blurs and fades
   *  to fully invisible, drifting a little sideways -- firework, then its smoke. */
  private firework(l: Label, dt: number, tm: Matrix, vp: ReturnType<Camera['viewport']['toGlobal']>) {
    const F = FIREWORK, a = (l.age += dt);
    const s = Math.min(1, Math.max(0, (a - F.settle) / (F.life - F.settle)));   // 0..1 through the smoke phase
    l.pos.y += F.rise * (1 - 0.6 * s) * dt;
    let scale: number, bright: number;
    if (a < F.pop) { scale = 0.3 + (F.popScale - 0.3) * (a / F.pop); bright = F.flash; }
    else if (a < F.settle) { const t = (a - F.pop) / (F.settle - F.pop); scale = F.popScale + (1 - F.popScale) * t; bright = F.flash + (1.3 - F.flash) * t; }
    else { scale = 1 + F.grow * s; bright = 1.3 - 0.3 * s; }
    const p = Vector3.Project(l.pos, Matrix.Identity(), tm, vp);
    const j = l.jitter && a < 0.45 ? 6 : 0;
    const jx = j ? (Math.random() - 0.5) * j : 0, jy = j ? (Math.random() - 0.5) * j : 0;
    l.el.style.transform = `translate(-50%, -50%) translate(${p.x + jx + l.drift * F.drift * s}px, ${p.y + jy}px) scale(${scale})`;
    l.el.style.filter = `brightness(${bright.toFixed(2)}) blur(${(F.blur * s * s).toFixed(1)}px)`;
    l.el.style.opacity = a < F.settle ? '1' : String(Math.max(0, Math.pow(1 - s, 1.5)));
    if (l.life <= 0 || s >= 1) { l.life = 0; l.el.remove(); }
  }

  /** Offset to add to the camera target this frame. */
  shakeOffset(): Vector3 {
    if (!Number.isFinite(this.shake)) { this.shakeAdd(NaN, 'shake value', this.shake); this.shake = 0; }   // v0.34h
    if (this.shake < 0.005) return Vector3.Zero();
    return new Vector3((Math.random() - 0.5) * this.shake, (Math.random() - 0.5) * this.shake * 0.6, (Math.random() - 0.5) * this.shake);
  }

  clear() {
    for (const s of this.sparks) s.m.dispose();
    for (const d of this.debris) d.m.dispose();
    for (const l of this.labels) l.el.remove();
    for (const f of this.flashes) f.mat.emissiveColor.set(0, 0, 0);
    this.sparks = []; this.debris = []; this.labels = []; this.flashes = []; this.shake = 0;
    this.combos.clear();   // v0.53
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

  private label(text: string, pos: Vector3, color: string, cls: string): Label {
    const el = document.createElement('div');
    el.className = `fxlabel ${cls}`;
    el.textContent = text;
    el.style.color = color;
    this.layer.appendChild(el);
    const l: Label = { el, pos: pos.clone(), life: LABEL_LIFE, max: LABEL_LIFE, age: 0, pop: false, jitter: false, fw: false, drift: 0 };
    this.labels.push(l);
    return l;
  }

  private flash(bot: Bot) {
    const mats = new Set<{ emissiveColor: Color3 }>();
    for (const m of botMeshes(bot)) {
      const mm = m.material as unknown as { emissiveColor?: Color3 } | null;
      if (mm?.emissiveColor) mats.add(mm as { emissiveColor: Color3 });
    }
    for (const mat of mats) {
      const existing = this.flashes.find(f => f.mat === mat);
      if (existing) existing.life = FLASH_LIFE; else this.flashes.push({ mat, life: FLASH_LIFE });
    }
  }
}
