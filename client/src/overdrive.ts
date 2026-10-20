/**
 * v0.59 Boss Battle super move: WEAPON OVERDRIVE + combos (design/boss-battle-plan.md, user-approved).
 *
 *  - Points fill each bot's meter (full at 100). E / controller Y fires it (AI allies: see update()).
 *  - Overdrive lasts 6 s: x2 damage and a glowing aura; spinners / shells jump to 1.5x top speed; hammers and saws
 *    swing on their own 3 times a second; flippers get unlimited gas and 1.5x power; lifters / grapplers / crushers
 *    get 2x torque (main.ts runBot reads bot.overdrive; combat.ts reads bot.odMul).
 *  - COMBO: 2+ bots in overdrive at once (anywhere): x3 for 2, x4 for 3, x5 for 4. When a combo starts (or grows) the
 *    boss is stunned 2 s (no restart while it runs, 10 s cooldown after) and every mini within 4 m of an overdriven
 *    bot pops (no points). A bot still in overdrive after the overlap drops back to x2.
 *  - AI allies: one with a full meter fires within 1 s of you firing yours; if you never do, it fires on its own 8 s
 *    after its meter filled.
 * All numbers are first guesses (tune at playtest).
 */
import { Color3, Mesh, MeshBuilder, Quaternion, Scene, StandardMaterial, Vector3 } from '@babylonjs/core';
import type { Bot, BotId } from './bot.js';

export const SUPER = {
  full: 100,                    // meter points to fill it
  ms: 6000,                     // overdrive length
  dmg: 2,                       // damage x alone; a combo of n bots = x(n + 1)
  spin: 1.5,                    // spinners / shells: x top speed (instantly)
  armEveryMs: 333,              // hammers / saws: a swing every this long (3 a second)
  flipPower: 1.5,               // flippers: x power (unlimited gas)
  controlTorque: 2,             // lifters / grapplers / crushers: x torque
  stunMs: 2000,                 // combo: boss stunned this long ...
  stunCooldownMs: 10000,        // ... and not again until this long after a stun ends
  popR: 4,                      // combo: minis within this of an overdriven bot pop
  follow: [200, 1000],          // AI ally with a full meter fires this long after you fire (ms, random in range)
  soloMs: 8000,                 // ... or on its own this long after its meter filled
  share: 0.2,                   // v0.59c (user) teamwork: this share of every point a teammate earns goes into your meter
  assist: { windowMs: 2000, meter: 8, pairMs: 2000 },   // v0.59c (user) teamwork: you hit the boss within 2 s of a teammate's hit = +8 meter each (once per pair per 2 s)
  aura: '#ffd23f',
  link: '#ff2ee6',
};

export interface OdFighter { id: BotId; human: boolean; bot: Bot; down?: unknown; name: string }
export interface OdHooks {
  sign(text: string, ms: number, color: string): void;
  /** a combo of n bots started / grew: stun the boss, pop the minis near these bots */
  onCombo(n: number, bots: Bot[]): void;
  /** a bot just went into overdrive (spinners jump to speed) */
  onFire(f: OdFighter): void;
}

interface Aura { a: Mesh; b: Mesh }

export class Overdrive {
  private meter: Record<string, number> = {};
  private until: Record<string, number> = {};
  private fullAt: Record<string, number> = {};
  private followAt: Record<string, number> = {};
  private lastN = 0;
  /** bots in overdrive right now (alive) */
  n = 0;
  private auras = new Map<Bot, Aura>();
  private links: Mesh[] = [];
  private matAura: StandardMaterial;
  private matLink: StandardMaterial;

  constructor(private scene: Scene, private hooks: OdHooks) {
    const mat = (name: string, hex: string) => {
      const m = new StandardMaterial(name, scene);
      m.emissiveColor = Color3.FromHexString(hex); m.diffuseColor = Color3.Black(); m.specularColor = Color3.Black();
      m.disableLighting = true; m.alpha = 0.85;
      return m;
    };
    this.matAura = mat('od_aura', SUPER.aura);
    this.matLink = mat('od_link', SUPER.link);
  }

  reset() {
    this.meter = {}; this.until = {}; this.fullAt = {}; this.followAt = {}; this.lastN = 0; this.n = 0; this.lastBossHit = {}; this.lastAssist = {};
    this.clearFx();
  }

  meterOf(id: string): number { return this.meter[id] ?? 0; }
  ready(id: string): boolean { return this.meterOf(id) >= SUPER.full; }
  active(id: string, now: number): boolean { return now < (this.until[id] ?? 0); }
  leftMs(id: string, now: number): number { return Math.max(0, (this.until[id] ?? 0) - now); }
  /** the damage multiplier this bot has right now */
  mulOf(id: string, now: number): number { return !this.active(id, now) ? 1 : this.n >= 2 ? this.n + 1 : SUPER.dmg; }

  /** points fill the meter */
  gain(f: OdFighter | undefined, pts: number, now: number) {
    if (!f || pts <= 0) return;
    const was = this.meterOf(f.id);
    if (was >= SUPER.full) return;
    this.meter[f.id] = Math.min(SUPER.full, was + pts);
    if (this.meter[f.id] >= SUPER.full) {
      this.fullAt[f.id] = now;
      if (f.human) this.hooks.sign('OVERDRIVE READY!', 1100, SUPER.aura);
    }
  }

  /** v0.59c teamwork: a bot earned points -- its own meter fills with them, every teammate's with SUPER.share of them;
   *  a boss hit within SUPER.assist.windowMs of a teammate's boss hit = ASSIST (+meter for both). */
  private lastBossHit: Record<string, number> = {};
  private lastAssist: Record<string, number> = {};
  teamPoints(f: OdFighter | undefined, all: OdFighter[], pts: number, bossHit: boolean, now: number) {
    if (!f || pts <= 0) return;
    this.gain(f, pts, now);
    for (const o of all) if (o.id !== f.id) this.gain(o, pts * SUPER.share, now);
    if (!bossHit) return;
    const A = SUPER.assist;
    for (const o of all) {
      if (o.id === f.id || now - (this.lastBossHit[o.id] ?? -1e9) > A.windowMs) continue;
      const pair = [f.id, o.id].sort().join('');
      if (now - (this.lastAssist[pair] ?? -1e9) < A.pairMs) continue;
      this.lastAssist[pair] = now;
      this.gain(f, A.meter, now); this.gain(o, A.meter, now);
      const me = f.human ? o : o.human ? f : undefined;
      if (me) this.hooks.sign(`ASSIST WITH ${me.name.toUpperCase()}! +${A.meter}`, 900, SUPER.aura);
    }
    this.lastBossHit[f.id] = now;
  }

  /** E / controller Y (or the AI): fire it if the meter is full. true = it fired. */
  fire(f: OdFighter, all: OdFighter[], now: number): boolean {
    if (!this.ready(f.id) || this.active(f.id, now) || f.down || f.bot.eliminated) return false;
    this.meter[f.id] = 0; delete this.fullAt[f.id]; delete this.followAt[f.id];
    this.until[f.id] = now + SUPER.ms;
    if (f.human) {
      this.hooks.sign('WEAPON OVERDRIVE!', 1200, SUPER.aura);
      // allies with a full meter follow your lead
      for (const o of all) if (!o.human && this.ready(o.id) && !this.active(o.id, now))
        this.followAt[o.id] = now + SUPER.follow[0] + Math.random() * (SUPER.follow[1] - SUPER.follow[0]);
    }
    this.hooks.onFire(f);
    return true;
  }

  /** once per frame (Boss Battle): AI firing, combos, multipliers onto the bots, the aura + combo lines */
  update(all: OdFighter[], now: number, on: boolean) {
    if (on) for (const f of all) {
      if (f.human || f.down || !this.ready(f.id)) continue;
      const fa = this.followAt[f.id], full = this.fullAt[f.id] ?? now;
      if ((fa !== undefined && now >= fa) || now - full >= SUPER.soloMs) this.fire(f, all, now);
    }
    if (!on) for (const id of Object.keys(this.until)) this.until[id] = 0;   // the battle's over: everything off
    const live = all.filter(f => !f.down && !f.bot.eliminated && this.active(f.id, now));
    this.n = live.length;
    if (this.n >= 2 && this.n > this.lastN) {
      this.hooks.sign(`COMBO x${this.n + 1}!`, 1500, SUPER.link);
      this.hooks.onCombo(this.n, live.map(f => f.bot));
    }
    this.lastN = this.n;
    for (const f of all) {
      const od = !f.down && this.active(f.id, now);
      f.bot.overdrive = od || undefined;
      f.bot.odMul = od ? this.mulOf(f.id, now) : undefined;
    }
    this.drawFx(live, now);
  }

  // ------------------------------------------------------------------------------------------------ looks
  /** two glowing gold rings spinning round each overdriven bot; neon lines linking the bots in a combo */
  private drawFx(live: OdFighter[], now: number) {
    const want = new Set(live.map(f => f.bot));
    for (const [b, a] of this.auras) if (!want.has(b) || b.eliminated) { a.a.dispose(); a.b.dispose(); this.auras.delete(b); }
    const t = now / 1000;
    for (const f of live) {
      let a = this.auras.get(f.bot);
      if (!a) {
        const ring = (n: string) => {
          const m = MeshBuilder.CreateTorus(n, { diameter: 2.1, thickness: 0.07, tessellation: 40 }, this.scene);
          m.material = this.matAura; m.isPickable = false; m.metadata = { cubeGlow: Color3.FromHexString(SUPER.aura) };
          m.rotationQuaternion = new Quaternion();
          return m;
        };
        a = { a: ring('od_ringA'), b: ring('od_ringB') };
        this.auras.set(f.bot, a);
      }
      const p = f.bot.root.position, pulse = 1 + 0.06 * Math.sin(t * 14);
      // blink in the last second so you know it's running out
      const vis = this.leftMs(f.id, now) < 1000 && Math.floor(now / 100) % 2 === 0 ? 0 : 1;
      for (const [m, tilt, spin] of [[a.a, 0.35, 2.6], [a.b, -0.35, -3.4]] as [Mesh, number, number][]) {
        m.position.set(p.x, p.y + 0.25, p.z);
        Quaternion.FromEulerAnglesToRef(tilt, t * spin, 0, m.rotationQuaternion!);
        m.scaling.setAll(pulse);
        m.visibility = vis;
      }
    }
    // combo lines: each overdriven bot to the next
    const pairs = live.length >= 2 ? live.map((f, i) => [f.bot, live[(i + 1) % live.length].bot] as [Bot, Bot]).slice(0, live.length === 2 ? 1 : live.length) : [];
    while (this.links.length > pairs.length) this.links.pop()!.dispose();
    while (this.links.length < pairs.length) {
      const m = MeshBuilder.CreateBox('od_link', { size: 1 }, this.scene);
      m.material = this.matLink; m.isPickable = false; m.metadata = { cubeGlow: Color3.FromHexString(SUPER.link) };
      m.rotationQuaternion = new Quaternion();
      this.links.push(m);
    }
    pairs.forEach(([a, b], i) => {
      const m = this.links[i];
      const pa = a.root.position.add(new Vector3(0, 0.5, 0)), pb = b.root.position.add(new Vector3(0, 0.5, 0));
      const d = pb.subtract(pa), len = d.length();
      if (len < 1e-3) { m.setEnabled(false); return; }
      m.setEnabled(true);
      m.position.copyFrom(pa.add(pb).scale(0.5));
      const w = 0.07 + 0.03 * Math.sin(t * 20 + i);
      m.scaling.set(w, len, w);
      Quaternion.FromUnitVectorsToRef(Vector3.Up(), d.scale(1 / len), m.rotationQuaternion!);
    });
  }
  private clearFx() {
    for (const a of this.auras.values()) { a.a.dispose(); a.b.dispose(); }
    this.auras.clear();
    for (const m of this.links) m.dispose();
    this.links = [];
  }
  dispose() { this.clearFx(); }
}
