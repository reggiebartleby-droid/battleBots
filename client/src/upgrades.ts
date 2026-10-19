/**
 * v0.40 RACE UPGRADES (user, 2026-10-19): the SCRAP meter. Races only.
 *
 *  - The meter fills from: vacuumed cubes (+1 each, they still repair), finished laps by place (catch-up: 4th gets the
 *    most), damage dealt (+1 per 10), and glowing SCRAP boxes on the track (+25, back after 8 s). AI karts too.
 *  - Auto tiers, in order: 25 MOTOR (+15% top speed + drive), 60 ARMOR plating (side skirts, soak 40% of every hit),
 *    100 WEAPON (+25% weapon damage, glowing power cells), 150 RAM (spiked ram on the BACK: soaks hits from behind and
 *    has ONE piston punch that fires by itself at the first bot to get close behind; re-armed only when rebuilt).
 *  - Upgrades are real cubes on the bot: hits chip them off (the cubes are loot for the others but cost the owner
 *    nothing -- they came from the meter, not the wallet). Chipped to nothing = lost.
 *  - Lost upgrades rebuild with the next 25 scrap each, first in tier order. A wreck (KO) loses them all (they go to
 *    the rebuild queue); towed / off the track = a free poof, they come back on at the respawn.
 * Claude's calls (to review at playtest): the HP of each upgrade (UPG.hp), how much each soaks, the ram's reach and
 * punch, where the boxes sit, and that a wreck puts every upgrade in the rebuild queue (the meter isn't reset).
 */
import { Color3, Matrix, Mesh, MeshBuilder, Scene, StandardMaterial, TransformNode, Vector3, type ShadowGenerator } from '@babylonjs/core';
import { botMeshes, chassisFor, forward, type Bot, type BotId } from './bot.js';
import { CUBES, Skin } from './cubes.js';
import type { Race } from './race.js';
import type { Combat } from './combat.js';
import type { Fx } from './fx.js';

export type UpgKind = 'motor' | 'armor' | 'weapon' | 'ram';
export const UPG = {
  tiers: [{ kind: 'motor', at: 25 }, { kind: 'armor', at: 60 }, { kind: 'weapon', at: 100 }, { kind: 'ram', at: 150 }] as { kind: UpgKind; at: number }[],
  rebuild: 25,                    // scrap per lost upgrade rebuilt
  lapPts: [10, 20, 30, 40],       // a finished lap, by place then (1st .. 4th): catch-up
  dmgPer: 10,                     // +1 scrap per this much damage dealt
  box: 25,                        // a SCRAP box
  boxRespawnS: 8,
  boxR: 1.3,                      // m: drive this close to a box to take it
  boxFrac: [0.14, 0.38, 0.62, 0.86],   // where the boxes sit, fraction of a lap
  motorMul: 1.15,
  weaponMul: 1.25,
  armorSoak: 0.4,                 // of every hit (after the ram's share)
  ramSoak: 0.5,                   // of a hit from behind
  blockSoak: 0.25,                // motor block / power cells: a hit right on them
  hp: { motor: 20, armor: 45, weapon: 20, ram: 35 } as Record<UpgKind, number>,   // damage soaked before it's chipped away
  ram: { range: 1.9, side: 0.55, dv: 6.5, up: 2.2, selfDv: 1.5, dmg: 20, outS: 0.08, holdS: 0.18, backS: 0.45, reach: 0.9 },
};
const NAME: Record<UpgKind, string> = { motor: 'MOTOR', armor: 'ARMOR', weapon: 'WEAPON', ram: 'RAM' };
const SHORT: Record<UpgKind, string> = { motor: 'MOT', armor: 'ARM', weapon: 'WPN', ram: 'RAM' };
const ORDER = UPG.tiers.map(t => t.kind);

interface Geo { top: number; rear: number; sideX: number; w: number; d: number }
interface Addon {
  kind: UpgKind;
  anchor: Mesh;
  skin: Skin | null;
  hp: number;
  init: number;
  center: Vector3;                // local (bot root space)
  ramNode?: TransformNode;
  dead?: boolean;                 // chipped away during a physics step: removed in the next update
}
interface RState {
  id: BotId;
  meter: number;
  unlocked: UpgKind[];
  queue: UpgKind[];               // lost, waiting for rebuild scrap
  credit: number;                 // scrap toward the next rebuild
  addons: Map<UpgKind, Addon>;
  bot?: Bot;
  geo?: Geo;
  armed: boolean;                 // the ram's one punch
  punch: number;                  // -1 idle, else seconds into the punch
  lapsSeen: number;
  dmgSeen: number;
  downSeen: boolean;
}
interface Box { node: TransformNode; inner: Mesh; outer: Mesh; pos: Vector3; away: number; spin: number }

export interface UpgHooks {
  sign: (text: string, ms: number, color: string) => void;
  isPlayer: (id: BotId) => boolean;
  shadows?: ShadowGenerator;
}

export class Upgrades {
  private st = new Map<BotId, RState>();
  private boxes: Box[] = [];
  private mats: Record<string, StandardMaterial> = {};
  private race: Race | null = null;
  private pulse = 0;   // HUD: meter flashes after a gain (player)

  constructor(private scene: Scene, private fx: Fx, private hooks: UpgHooks) {
    const m = (name: string, hex: string, emis = 0) => {
      const mat = new StandardMaterial(name, scene);
      mat.diffuseColor = Color3.FromHexString(hex);
      mat.emissiveColor = Color3.FromHexString(hex).scale(emis);
      return (this.mats[name] = mat);
    };
    // names: cubes.ts roleColor reads the prefix (dark / steel / can / chrome); upg_* = its own colour
    m('dark_upg', '#3a3f46'); m('steel_upg', '#9aa3ad'); m('can_upg', '#c47a2c'); m('chrome_upg', '#dfe6ee');
    m('upg_glow', '#36f1ff', 0.9); m('upg_hot', '#ff6a1a', 0.7);
    m('upg_plate', '#4a5560'); m('upg_hazard', '#ffd23f', 0.3); m('upg_ram', '#2b2f36'); m('upg_spike', '#e8eef5', 0.2);   // v0.40 each upgrade its own colours
    m('upg_boxOuter', '#ffd23f', 1).wireframe = true;
    m('upg_boxInner', '#ff8a00', 0.9);
    for (const k of ['upg_boxOuter', 'upg_boxInner']) this.mats[k].disableLighting = true;
  }

  // ------------------------------------------------------------------------------------------------- race lifecycle
  /** A new race on this track: fresh meters, boxes placed. Call before race.begin (bots spawn through attach). */
  reset(race: Race) {
    this.clear();
    this.race = race;
    for (const f of UPG.boxFrac) {
      let s = race.length * f;
      for (let k = 0; k < 40 && ['jump', 'hazard'].includes(race.sampleAt(s).tag); k++) s += 2;   // not over the pit / in the saws
      const p = race.sampleAt(s);
      const u = (Math.round(f * 10) % 3 - 1) * race.width * 0.2;
      const pos = race.at(p, u, race.surfaceY(p, u) + 0.6);
      const node = new TransformNode('upg_box', this.scene);
      node.position.copyFrom(pos);
      const outer = MeshBuilder.CreateBox('upg_boxO', { size: 0.6 }, this.scene);
      outer.material = this.mats.upg_boxOuter; outer.parent = node; outer.isPickable = false;
      const inner = MeshBuilder.CreateBox('upg_boxI', { size: 0.32 }, this.scene);
      inner.material = this.mats.upg_boxInner; inner.parent = node; inner.isPickable = false;
      this.boxes.push({ node, inner, outer, pos, away: 0, spin: Math.random() * 6 });
    }
  }
  /** Leaving the race / a new one: boxes and addons go (the bots themselves are disposed by race.ts). */
  clear() {
    for (const s of this.st.values()) for (const a of s.addons.values()) if (!a.anchor.isDisposed()) a.anchor.dispose();
    this.st.clear();
    for (const b of this.boxes) b.node.dispose();
    this.boxes = [];
    this.race = null;
  }
  private state(id: BotId): RState {
    let s = this.st.get(id);
    if (!s) this.st.set(id, s = { id, meter: 0, unlocked: [], queue: [], credit: 0, addons: new Map(), armed: false, punch: -1, lapsSeen: 0, dmgSeen: 0, downSeen: false });
    return s;
  }

  /** race onSpawn: a racer's bot was (re)built -- put its upgrades back on (everything unlocked and not lost). */
  attach(bot: Bot) {
    const s = this.state(bot.id);
    for (const a of s.addons.values()) if (!a.anchor.isDisposed()) a.anchor.dispose();   // the old bot's (poofed)
    s.addons.clear();
    s.bot = bot; s.geo = geoOf(bot); s.punch = -1; s.downSeen = false;
    bot.shield = (raw, point) => this.shield(s, raw, point);
    for (const k of s.unlocked) if (!s.queue.includes(k)) this.build(s, k, false);
    this.effects(s);
  }

  // ------------------------------------------------------------------------------------------------- the meter
  /** Scrap for this racer (vacuumed cube, lap, damage, box). */
  gain(id: BotId, pts: number) {
    if (pts <= 0) return;
    const s = this.state(id);
    s.meter += pts;
    if (this.hooks.isPlayer(id)) this.pulse = performance.now();
    // tiers
    while (s.unlocked.length < UPG.tiers.length && s.meter >= UPG.tiers[s.unlocked.length].at) {
      const k = UPG.tiers[s.unlocked.length].kind;
      s.unlocked.push(k);
      if (this.alive(s)) this.build(s, k, true);
      if (this.hooks.isPlayer(id)) this.hooks.sign(`${NAME[k]} UPGRADE!`, 1400, '#36f1ff');
    }
    // rebuilds
    if (s.queue.length) {
      s.credit += pts;
      while (s.queue.length && s.credit >= UPG.rebuild) {
        s.credit -= UPG.rebuild;
        const k = s.queue.shift()!;
        if (this.alive(s)) this.build(s, k, true);
        if (this.hooks.isPlayer(id)) this.hooks.sign(`${NAME[k]} REBUILT`, 1200, '#36f1ff');
      }
      if (!s.queue.length) s.credit = 0;
    }
  }
  private alive(s: RState): boolean { return !!s.bot && !s.bot.eliminated && !s.bot.root.isDisposed(); }

  /** Every frame (after race.update): laps, damage, boxes, wrecks, the ram, chipped-away upgrades. */
  update(dt: number, race: Race, combat: Combat | null, go: boolean) {
    for (const b of this.boxes) {           // boxes spin + bob even before GO
      b.spin += dt;
      b.inner.rotation.set(b.spin * 1.3, b.spin * 2, 0);
      b.outer.rotation.y = -b.spin * 0.8;
      b.node.position.y = b.pos.y + Math.sin(b.spin * 2.2) * 0.08;
      if (b.away > 0) { b.away -= dt; if (b.away <= 0) b.node.setEnabled(true); }
    }
    for (const r of race.racers) {
      const s = this.state(r.id);
      if (r.bot !== s.bot) continue;        // respawning: attach comes with the new bot
      // dead addons (chipped away during a physics step)
      for (const a of [...s.addons.values()]) if (a.dead) this.lose(s, a, true);
      // wrecked / towed / off
      if (r.down && !s.downSeen) {
        s.downSeen = true;
        const ko = r.down.why === 'ko';
        for (const a of [...s.addons.values()]) {
          a.skin?.knockout(ko);              // KO: loot for the others (free for the owner); towed / off: a poof
          if (ko) this.lose(s, a, false);
        }
        if (ko && s.unlocked.length && this.hooks.isPlayer(r.id)) this.hooks.sign('UPGRADES LOST!', 1400, '#ff4d4d');
        continue;
      }
      if (r.down || !go || r.finished !== undefined) continue;
      // scrap: laps by place, damage dealt
      if (r.lapsDone > s.lapsSeen) {
        s.lapsSeen = r.lapsDone;
        const place = race.standings().indexOf(r) + 1;
        this.gain(r.id, UPG.lapPts[place - 1] ?? 0);
      }
      const dmg = combat?.stats[r.id]?.dmg ?? 0;
      if (dmg >= s.dmgSeen + UPG.dmgPer) { const n = Math.floor((dmg - s.dmgSeen) / UPG.dmgPer); s.dmgSeen += n * UPG.dmgPer; this.gain(r.id, n); }
      // boxes
      const p = r.bot.root.getAbsolutePosition();
      for (const b of this.boxes) {
        if (b.away > 0 || Vector3.DistanceSquared(p, b.node.position) > UPG.boxR * UPG.boxR) continue;
        b.away = UPG.boxRespawnS; b.node.setEnabled(false);
        this.fx.bump(b.node.position);
        this.gain(r.id, UPG.box);
        if (this.hooks.isPlayer(r.id)) this.hooks.sign(`+${UPG.box} SCRAP`, 800, '#ffd23f');
      }
      // the ram
      this.ramUpdate(s, race, combat, dt);
    }
  }

  // ------------------------------------------------------------------------------------------------- the addons
  private build(s: RState, k: UpgKind, fresh: boolean) {
    const bot = s.bot, g = s.geo;
    if (!bot || !g || s.addons.has(k)) return;
    const anchor = new Mesh(`upg_${k}_${bot.id}`, this.scene);
    anchor.parent = bot.root; anchor.position.setAll(0); anchor.rotationQuaternion = null; anchor.rotation.setAll(0);
    anchor.isVisible = false;
    const meshes: Mesh[] = [];
    const box = (name: string, mat: string, w: number, h: number, d: number, x: number, y: number, z: number, parent: TransformNode = anchor) => {
      const m = MeshBuilder.CreateBox(`upg_${k}_${name}`, { width: w, height: h, depth: d }, this.scene);
      m.material = this.mats[mat]; m.parent = parent; m.position.set(x, y, z); m.isPickable = false;
      meshes.push(m); return m;
    };
    const cyl = (name: string, mat: string, dia: number, len: number, x: number, y: number, z: number, axis: 'x' | 'y' | 'z', parent: TransformNode = anchor) => {
      const m = MeshBuilder.CreateCylinder(`upg_${k}_${name}`, { diameter: dia, height: len, tessellation: 12 }, this.scene);
      m.material = this.mats[mat]; m.parent = parent; m.position.set(x, y, z); m.isPickable = false;
      if (axis === 'x') m.rotation.z = Math.PI / 2; else if (axis === 'z') m.rotation.x = Math.PI / 2;
      meshes.push(m); return m;
    };
    let center = new Vector3(0, g.top, 0), ramNode: TransformNode | undefined;
    const T = g.top;
    switch (k) {
      case 'motor': {   // a motor block on the back of the deck, two copper motor cans, a hot exhaust
        const z = g.rear + 0.32;
        box('block', 'dark_upg', 0.56, 0.2, 0.34, 0, T + 0.1, z);
        cyl('canL', 'can_upg', 0.2, 0.36, -0.19, T + 0.3, z, 'z');
        cyl('canR', 'can_upg', 0.2, 0.36, 0.19, T + 0.3, z, 'z');
        box('exhaust', 'upg_hot', 0.12, 0.12, 0.16, 0, T + 0.16, g.rear + 0.08);
        center = new Vector3(0, T + 0.2, z);
        break;
      }
      case 'armor': {   // side skirts outside the wheels, front to back
        const len = g.d * 0.85, h = 0.3;
        box('skirtL', 'upg_plate', 0.12, h, len, -g.sideX, -0.02, 0);
        box('skirtR', 'upg_plate', 0.12, h, len, g.sideX, -0.02, 0);
        box('lipL', 'upg_hazard', 0.24, 0.1, len * 0.9, -g.sideX + 0.06, h / 2 + 0.02, 0);
        box('lipR', 'upg_hazard', 0.24, 0.1, len * 0.9, g.sideX - 0.06, h / 2 + 0.02, 0);
        center = new Vector3(0, 0, 0);
        break;
      }
      case 'weapon': {   // glowing power cells on the deck, one each side
        const x = g.w / 2 - 0.16, z = -0.1;
        box('cellL', 'upg_glow', 0.18, 0.3, 0.18, -x, T + 0.15, z);
        box('cellR', 'upg_glow', 0.18, 0.3, 0.18, x, T + 0.15, z);
        box('capL', 'chrome_upg', 0.22, 0.08, 0.22, -x, T + 0.33, z);
        box('capR', 'chrome_upg', 0.22, 0.08, 0.22, x, T + 0.33, z);
        center = new Vector3(0, T + 0.15, z);
        break;
      }
      case 'ram': {   // spiked ram on a piston, on the back
        ramNode = new TransformNode(`upg_ramNode_${bot.id}`, this.scene);
        ramNode.parent = anchor; ramNode.position.set(0, 0, g.rear);
        const pw = Math.min(1.2, g.w * 0.8);
        cyl('rodL', 'chrome_upg', 0.09, 0.26, -pw * 0.3, 0.02, -0.08, 'z');
        cyl('rodR', 'chrome_upg', 0.09, 0.26, pw * 0.3, 0.02, -0.08, 'z');
        const head = new TransformNode(`upg_ramHead_${bot.id}`, this.scene);
        head.parent = ramNode; head.position.set(0, 0, 0);
        box('plate', 'upg_ram', pw, 0.3, 0.12, 0, 0.02, -0.25, head);
        box('frame', 'upg_hazard', pw + 0.08, 0.08, 0.16, 0, 0.2, -0.25, head);
        for (const x of [-pw * 0.38, 0, pw * 0.38]) box(`spike${x.toFixed(2)}`, 'upg_spike', 0.1, 0.1, 0.26, x, 0.02, -0.43, head);
        center = new Vector3(0, 0, g.rear - 0.25);
        ramNode.metadata = { head };
        s.armed = true;
        break;
      }
    }
    // Cube Bots look: the addon becomes cubes (its HP); plain look: the meshes as they are
    let skin: Skin | null = null;
    if (CUBES.on) {
      skin = new Skin(this.scene, anchor, meshes, bot.build.cosmetics.paint ?? '#888888', () => null, this.hooks.shadows);
      skin.ownerId = bot.id;
      skin.free = true;
    }
    const a: Addon = { kind: k, anchor, skin, hp: UPG.hp[k], init: Math.max(1, skin?.alive() ?? 1), center, ramNode };
    s.addons.set(k, a);
    this.effects(s);
    if (fresh) this.fx.bump(bot.root.getAbsolutePosition().add(new Vector3(0, 0.6, 0)));
  }

  /** Chipped to nothing (or wrecked): off it comes. queue = it goes in the rebuild queue. */
  private lose(s: RState, a: Addon, announce: boolean) {
    s.addons.delete(a.kind);
    if (!s.queue.includes(a.kind)) { s.queue.push(a.kind); s.queue.sort((x, y) => ORDER.indexOf(x) - ORDER.indexOf(y)); }
    if (a.kind === 'ram') { s.armed = false; s.punch = -1; }
    if (a.skin && !a.skin.knocked) a.skin.knockout(true);   // what's left of it flies off (loot)
    if (!a.anchor.isDisposed()) a.anchor.dispose();
    this.effects(s);
    if (announce && this.hooks.isPlayer(s.id)) this.hooks.sign(`${NAME[a.kind]} LOST!`, 1200, '#ff4d4d');
  }

  private effects(s: RState) {
    const b = s.bot;
    if (!b) return;
    b.driveMul = s.addons.has('motor') ? UPG.motorMul : 1;
    b.dmgMul = s.addons.has('weapon') ? UPG.weaponMul : 1;
  }

  /** bot.shield: the rear ram soaks a share of a hit from behind, the armour plating a share of every hit, the motor
   *  block / power cells a share of a hit right on them. Each soaked point chips that addon's cubes off. */
  private shield(s: RState, raw: number, point: Vector3 | undefined): number {
    const b = s.bot, g = s.geo;
    if (!b || !g || !s.addons.size || raw <= 0) return raw;
    const lp = point ? Vector3.TransformCoordinates(point, Matrix.Invert(b.root.getWorldMatrix())) : undefined;
    let left = raw;
    const ram = s.addons.get('ram');
    if (ram && lp && lp.z < g.rear + 0.35) left -= this.soak(s, ram, left * UPG.ramSoak, point);
    const arm = s.addons.get('armor');
    if (arm) left -= this.soak(s, arm, left * UPG.armorSoak, point);
    for (const k of ['motor', 'weapon'] as UpgKind[]) {
      const a = s.addons.get(k);
      if (a && lp && Vector3.Distance(lp, a.center) < 0.5) left -= this.soak(s, a, left * UPG.blockSoak, point);
    }
    return Math.max(0, left);
  }
  private soak(s: RState, a: Addon, amt: number, point: Vector3 | undefined): number {
    if (a.dead || amt <= 0) return 0;
    const take = Math.min(amt, Math.max(0, a.hp));
    const before = a.hp;
    a.hp -= take;
    if (a.skin && s.bot) {
      // cubes still on should follow the HP left
      const want = Math.ceil(a.init * Math.max(0, a.hp) / UPG.hp[a.kind]);
      const n = a.skin.alive() - want;
      const at = point ?? Vector3.TransformCoordinates(a.center, s.bot.root.getWorldMatrix());
      if (n > 0) a.skin.chip(at, n);
    }
    if (a.hp <= 0 && before > 0) a.dead = true;   // removed in update (not in the middle of a physics step)
    return take;
  }

  // ------------------------------------------------------------------------------------------------- the ram
  private ramUpdate(s: RState, race: Race, combat: Combat | null, dt: number) {
    const a = s.addons.get('ram'), b = s.bot, g = s.geo;
    if (!a?.ramNode || !b || !g) return;
    const head = (a.ramNode.metadata as { head: TransformNode }).head;
    const R = UPG.ram;
    if (s.punch >= 0) {   // animate: out fast, hold, back slow
      s.punch += dt;
      const t = s.punch;
      const ext = t < R.outS ? t / R.outS : t < R.outS + R.holdS ? 1 : Math.max(0, 1 - (t - R.outS - R.holdS) / R.backS);
      head.position.z = -R.reach * ext;
      if (t > R.outS + R.holdS + R.backS) { s.punch = -1; head.position.z = 0; }
      return;
    }
    if (!s.armed || b.inverted || b.rightingUntil) return;
    // anyone close behind?
    const inv = Matrix.Invert(b.root.getWorldMatrix());
    const victim = race.racers.find(o => {
      if (o.id === s.id || o.down || o.bot.eliminated) return false;
      const l = Vector3.TransformCoordinates(o.bot.root.getAbsolutePosition(), inv);
      return l.z < g.rear && l.z > g.rear - R.range && Math.abs(l.x) < g.w / 2 + R.side && Math.abs(l.y) < 1;
    });
    if (!victim) return;
    s.armed = false; s.punch = 0;
    const back = forward(b).scale(-1); back.y = 0; back.normalize();
    const vb = victim.bot, m = vb.body.getMassProperties().mass ?? 100;
    vb.body.applyImpulse(back.scale(R.dv * m).addInPlace(new Vector3(0, R.up * m, 0)), vb.body.getObjectCenterWorld());
    const mine = b.body.getMassProperties().mass ?? 100;
    b.body.applyImpulse(back.scale(-R.selfDv * mine), b.body.getObjectCenterWorld());   // the piston kicks us forward too
    const at = Vector3.TransformCoordinates(new Vector3(0, 0, g.rear - 0.5), b.root.getWorldMatrix());
    combat?.scriptedHit(b, vb, at, R.dmg);
    if (this.hooks.isPlayer(s.id)) this.hooks.sign('RAM!', 900, '#ffd23f');
    if (this.hooks.isPlayer(victim.id)) this.hooks.sign('RAMMED!', 900, '#ff4d4d');
  }

  // ------------------------------------------------------------------------------------------------- HUD
  /** One HUD line: scrap, the bar to the next tier (or rebuild), the four upgrades. */
  hud(id: BotId, now: number): string {
    const s = this.state(id);
    const n = s.unlocked.length, next = UPG.tiers[n], prev = n ? UPG.tiers[n - 1].at : 0;
    let pct: number, label: string;
    if (s.queue.length) { pct = s.credit / UPG.rebuild; label = `REBUILD ${NAME[s.queue[0]]}`; }
    else if (next) { pct = (s.meter - prev) / (next.at - prev); label = `${NAME[next.kind]} @${next.at}`; }
    else { pct = 1; label = 'MAX'; }
    const icon = (k: UpgKind) => {
      const cls = s.addons.has(k) ? 'on' : s.queue.includes(k) ? 'lost' : s.unlocked.includes(k) ? 'on' : '';
      const extra = k === 'ram' && s.addons.has(k) ? (s.armed ? '⚡' : '') : '';
      return `<span class="ui ${cls}">${SHORT[k]}${extra}</span>`;
    };
    const lit = now - this.pulse < 350 ? ' lit' : '';
    return `<div class="upgln${lit}">SCRAP <b>${Math.floor(s.meter)}</b><span class="bar"><i style="width:${Math.round(Math.max(0, Math.min(1, pct)) * 100)}%"></i></span><span class="nx">${label}</span> ${ORDER.map(icon).join('')}</div>`;
  }
  /** for the sandbox tests */
  debug() { return [...this.st.values()].map(s => ({ id: s.id, meter: s.meter, unlocked: [...s.unlocked], queue: [...s.queue], on: [...s.addons.keys()], cubes: Object.fromEntries([...s.addons].map(([k, a]) => [k, a.skin?.alive() ?? 0])), hp: Object.fromEntries([...s.addons].map(([k, a]) => [k, Math.round(a.hp)])), armed: s.armed, drive: s.bot?.driveMul, dmg: s.bot?.dmgMul })); }
}

/** Where the upgrades go on this bot: deck top, rear face, outside the wheels (local, bot root space). */
function geoOf(bot: Bot): Geo {
  const ch = chassisFor(bot.build.bodyId);
  let top = ch.h / 2, rear = -ch.d / 2, sideX = ch.w / 2 + 0.3;
  if (bot.build.bodyId === 'full_body_spinner') {   // the shell covers the base: go on top of / behind / beside it
    bot.root.computeWorldMatrix(true);
    const inv = Matrix.Invert(bot.root.getWorldMatrix());
    let maxY = top, minZ = rear, maxX = sideX;
    for (const m of botMeshes(bot)) {
      m.computeWorldMatrix(true);
      for (const v of m.getBoundingInfo().boundingBox.vectorsWorld) {
        const l = Vector3.TransformCoordinates(v, inv);
        if (Math.abs(l.x) < 1.5 && Math.abs(l.z) < 1.5) { maxY = Math.max(maxY, l.y); minZ = Math.min(minZ, l.z); maxX = Math.max(maxX, Math.abs(l.x)); }
      }
    }
    top = Math.min(maxY, 0.8); rear = Math.max(minZ - 0.02, -1.2); sideX = Math.min(maxX + 0.08, 1.3);
  }
  return { top, rear, sideX, w: ch.w, d: ch.d };
}
