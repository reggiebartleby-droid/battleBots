/**
 * v0.45 RALLY DIRT -- Dinosaur Lava (user 2026-10-19). Cube world: scripts/bake-rally.mjs -> tracks/rally.cubes.
 *
 * Live: the lava sea glows and pulses; the volcano smokes; pterodactyls circle it; two long-necks wander the jungle;
 * the crowd on the viewing deck cheers; start lights; dirt kicked up behind the karts.
 *
 * DINO HERD CROSSING (user): every HERD.every s a herd of raptors (green / brown / orange / blue) runs across the start
 * straight after the finish line. A kart that meets one is knocked aside with a little damage -- no respawn.
 *
 * ERUPTION (user): when the leader starts the last lap the volcano erupts; lava bombs (with a shadow warning on the
 * road first) land ~30 m ahead of the leader and leave a hot lava crust across the road for a while. Driving over it
 * is a slow-down (race.ts physics3d asks dragAt), not a fall-in: it's there to help the others catch up.
 *
 * LAVA FALLS: race.ts decides (first fall back to the start line, then the checkpoint); burnAt() is the fire burst.
 */
import { Color3, Mesh, Scene, Vector3 } from '@babylonjs/core';
import { CubeSwarm, CubeWorld } from './cubeworld.js';
import type { Race, TrackScenery } from './race.js';
import type { Bot } from './bot.js';
import { MOBILE } from './mobile.js';

export const HERD = {
  every: 15,          // s between crossings (first one at first + every)
  first: 3,
  size: 5,
  speed: 8.5,         // m/s
  hitR: 1.25, dmg: 6, shove: 5.5, lift: 2.2, cooldown: 1.0,
  warnS: 2.0,         // s of rumble + dust before they come out of the trees
};
export const ERUPT = {
  ahead: 32,          // m of track in front of the leader
  len: 10,            // m of road the crust covers
  flightS: 1.6,       // lava bombs in the air (their shadows on the road = the warning)
  lastS: 9,           // the crust stays this long (cooling down)
  drag: 2.4,          // 1/s while on it (race.ts: never below a crawl)
  bombs: 9,
  hitR: 1.3, dmg: 5,
};

interface Dino { body: Mesh; legs: [Mesh, Mesh]; off: number; side: number; ph: number; last: Map<Bot, number> }
interface Ptero { body: Mesh; wings: [Mesh, Mesh]; r: number; h: number; ph: number; speed: number }
interface Bomb { x: number; z: number; t: number; land: boolean }

export class DinoLava extends CubeWorld implements TrackScenery {
  private lava: Mesh | null = null;
  private herd: Dino[] = [];
  private herdT = -HERD.first;     // seconds into the current crossing (<0 = waiting)
  private herdDir = 1;
  private brachios: { m: Mesh; cx: number; cz: number; r: number; ph: number }[] = [];
  private pteros: Ptero[] = [];
  private swarm: CubeSwarm | null = null;      // smoke, dust, sparks, bombs, crust: one instanced cube
  private parts: { x: number; y: number; z: number; vx: number; vy: number; vz: number; age: number; life: number; s: number; c: [number, number, number]; grav: number; grow: number }[] = [];
  private smokeAt = 0;
  private erupted = false;
  private eruptT = -1;
  private crust: { s0: number; s1: number; t: number } | null = null;
  private bombs: Bomb[] = [];
  private raceT = 0;
  private herdWarned = false;

  constructor(scene: Scene, race: Race) {
    super(scene, race, 'tracks/rally.cubes');
  }
  protected farY() { return -1.62; }

  // ------------------------------------------------------------------------------------------------ cube world
  protected built() {
    const H = this.H as unknown as { variants: string[] };
    const lava = this.object('lava');
    lava.material = this.lampMat.clone('dl_lava')!;
    lava.position.copyFrom(this.O); lava.freezeWorldMatrix();
    this.lava = lava;
    // raptors: one body + two legs per dino, colours by variant
    const tpl = H.variants.map(v => ({ body: this.template('raptor_' + v), leg: this.template('raptorleg_' + v) }));
    for (let n = 0; n < HERD.size; n++) {
      const t = tpl[n % tpl.length];
      const body = t.body.clone('dl_raptor' + n, null)!; body.metadata = null; this.keep(body);
      const legs = [0, 1].map(s => { const l = t.leg.clone('dl_leg' + n + s, body)!; l.metadata = null; l.position.set(-0.3, 0.6, s ? 0.18 : -0.3); this.keep(l); return l; }) as [Mesh, Mesh];
      body.setEnabled(false);
      this.herd.push({ body, legs, off: (n - HERD.size / 2) * 1.6 + (Math.random() - 0.5), side: (Math.random() - 0.5) * 6, ph: Math.random() * 6, last: new Map() });
    }
    const br = this.template('brachio');
    [[-62, -30, 14], [70, -26, 10]].forEach(([cx, cz, r], n) => { const m = br.clone('dl_brachio' + n, null)!; m.metadata = null; this.keep(m); this.brachios.push({ m, cx, cz, r, ph: n * 2 }); });
    const pb = this.template('ptero'), wl = this.template('pterowingL'), wr = this.template('pterowingR');
    for (let n = 0; n < 4; n++) {
      const body = pb.clone('dl_ptero' + n, null)!; body.metadata = null; this.keep(body);
      const wings = [wl, wr].map((w, s) => { const m = w.clone('dl_wing' + n + s, body)!; m.metadata = null; m.position.setAll(0); this.keep(m); return m; }) as [Mesh, Mesh];
      body.scaling.setAll(1.6);
      this.pteros.push({ body, wings, r: 16 + n * 5, h: 24 + n * 3, ph: n * 1.7, speed: 0.22 + n * 0.04 });
    }
    const blob = this.object('blob', false);
    // unlit, colour = the instance colour (over 1 = glowing): lava bombs, crust, embers, smoke, dust
    // lit like the crowd (instance colours work there); colours over 1 read as glowing in the dark red light
    blob.material = this.propMat;
    this.swarm = new CubeSwarm(blob, MOBILE ? 220 : 520, 0.48);
  }

  begin() {
    this.herdT = -HERD.first; this.herdDir = 1; this.herdWarned = false;
    this.erupted = false; this.eruptT = -1; this.crust = null; this.bombs = [];
    this.parts = []; this.raceT = 0;
    for (const d of this.herd) { d.body.setEnabled(false); d.last.clear(); }
  }

  // ------------------------------------------------------------------------------------------------ per frame
  protected live(dt: number, go: boolean) {
    const t = this.t;
    if (this.lava) { const k = 1.0 + 0.12 * Math.sin(t * 1.3) + 0.05 * Math.sin(t * 4.1); (this.lava.material as unknown as { emissiveColor: Color3 }).emissiveColor.set(k, k, k); }
    for (const b of this.brachios) {
      const a = b.ph + t * 0.05, x = b.cx + Math.cos(a) * b.r, z = b.cz + Math.sin(a) * b.r;
      b.m.position.set(this.O.x + x, this.O.y + Math.abs(Math.sin(t * 1.6 + b.ph)) * 0.12, this.O.z + z);
      b.m.rotation.y = -a - Math.PI;   // walking round the circle (nose along it)
    }
    const V = (this.H as unknown as { volcano: { x: number; z: number; h: number } }).volcano;
    for (const p of this.pteros) {
      const a = p.ph + t * p.speed;
      p.body.position.set(this.O.x + V.x + Math.cos(a) * p.r, this.O.y + p.h + Math.sin(t * 0.7 + p.ph) * 1.5, this.O.z + V.z + Math.sin(a) * p.r);
      p.body.rotation.y = -a - Math.PI / 2;
      const f = Math.sin(t * 5 + p.ph) * 0.6;
      p.wings[0].rotation.x = -f; p.wings[1].rotation.x = f;
    }
    if (!go) this.updateHerd(0, false);
    this.ambient(dt);
    this.drawSwarm(dt);
  }

  /** smoke from the crater, embers, dirt behind the karts */
  private ambient(dt: number) {
    const V = (this.H as unknown as { volcano: { x: number; z: number; h: number } }).volcano;
    this.smokeAt -= dt;
    if (this.smokeAt <= 0) {
      this.smokeAt = MOBILE ? 0.35 : 0.15;
      this.emit(V.x + (Math.random() - .5) * 2, V.h + 0.5, V.z + (Math.random() - .5) * 2, (Math.random() - .5) * .4, 1.8, (Math.random() - .5) * .4, 6, 1.2, [0.22, 0.18, 0.17], 0, 2.2);
      if (Math.random() < 0.4) this.emit(V.x, V.h, V.z, (Math.random() - .5) * 3, 6 + Math.random() * 3, (Math.random() - .5) * 3, 2.2, 0.22, [2.2, 0.7, 0.2], 9.8, 0);
    }
    // dirt spray behind moving karts (the "loose dirt")
    for (const r of this.race.racers) {
      if (r.down || r.bot.eliminated || Math.random() > (MOBILE ? 0.25 : 0.6)) continue;
      const v = r.bot.body.getLinearVelocity(), sp = Math.hypot(v.x, v.z);
      if (sp < 4) continue;
      const p = r.bot.root.position;
      this.emit(p.x - this.O.x - v.x * 0.06, 0.15, p.z - this.O.z - v.z * 0.06, -v.x * 0.15 + (Math.random() - .5), 1.2 + Math.random(), -v.z * 0.15 + (Math.random() - .5), 0.7, 0.16, [0.42, 0.26, 0.15], 6, 0.5);
    }
  }

  private emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, s: number, c: [number, number, number], grav: number, grow: number) {
    if (this.parts.length > (MOBILE ? 200 : 500)) return;
    this.parts.push({ x, y, z, vx, vy, vz, age: 0, life, s, c, grav, grow });
  }

  private drawSwarm(dt: number) {
    const sw = this.swarm; if (!sw) return;
    sw.begin();
    this.parts = this.parts.filter(p => (p.age += dt) < p.life);
    for (const p of this.parts) {
      p.vy -= p.grav * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      const k = p.age / p.life, s = p.s * (1 + k * p.grow), fade = p.grav > 0 && p.c[0] > 1 ? 1 - k * 0.6 : 1;
      sw.add(this.O.x + p.x, this.O.y + p.y, this.O.z + p.z, s, p.c[0] * fade, p.c[1] * fade, p.c[2] * fade, p.age * 0.8);
    }
    // eruption: bombs in the air + their shadows on the road, then the crust
    const R = this.race;
    for (const b of this.bombs) {
      const V = (this.H as unknown as { volcano: { x: number; z: number; h: number } }).volcano;
      const k = Math.min(1, b.t / ERUPT.flightS);
      if (k < 1) {
        const x = V.x + (b.x - V.x) * k, z = V.z + (b.z - V.z) * k, y = V.h + (0.3 - V.h) * k + Math.sin(k * Math.PI) * 14;
        sw.add(this.O.x + x, this.O.y + y, this.O.z + z, 0.7, 2.4, 0.8, 0.2, b.t * 3);
        const sh = 0.4 + k * 0.9;   // growing dark warning square on the road
        sw.add(this.O.x + b.x, this.O.y + 0.06, this.O.z + b.z, sh, 0.5 + k * 1.2, 0.08, 0.04, 0);
      }
    }
    if (this.crust) {
      const c = this.crust, age = c.t, heat = Math.max(0, 1 - age / ERUPT.lastS);
      for (let s = c.s0; s < c.s1; s += 0.6) {
        const p = R.sampleAt(s);
        for (let u = -R.width / 2 + 0.3; u <= R.width / 2 - 0.3; u += 0.6) {
          const pos = R.at(p, u, R.surfaceY(p, u) + 0.05), wob = Math.sin(s * 3.1 + u * 2.3);
          const r = 0.25 + heat * (1.9 + 0.3 * wob), g = 0.06 + heat * (0.55 + 0.15 * wob), b = 0.05 + heat * 0.08;
          sw.add(pos.x, pos.y, pos.z, 0.56, r, g, b, 0);
        }
      }
    }
    sw.end();
  }

  // ------------------------------------------------------------------------------------------------ hazards
  hazards(dt: number, now: number) {
    if (!this.loaded) return;   // no world (yet): no herd, no eruption
    this.raceT += dt;
    this.updateHerd(dt, true, now);
    this.updateEruption(dt, now);
  }

  private herdPath() { return (this.H as unknown as { herd: { x: number; z: number; nx: number; nz: number; from: number; to: number } }).herd; }

  private updateHerd(dt: number, go: boolean, now = 0) {
    if (!this.loaded || !this.herd.length) return;
    const P = this.herdPath(), span = P.to - P.from, runS = (span + 8) / HERD.speed;
    if (go) this.herdT += dt;
    if (this.herdT >= runS) { this.herdT = -(HERD.every - runS); this.herdDir = -this.herdDir; this.herdWarned = false; }
    const t = this.herdT;
    // warning: rumble dust at the tree line + a sign for the player if they're heading for it
    if (go && t > -HERD.warnS && t < 0) {
      const u0 = this.herdDir > 0 ? P.from : P.to;
      if (Math.random() < 0.5) this.emit(P.x + P.nx * u0 + (Math.random() - .5) * 6, 0.2, P.z + P.nz * u0 + (Math.random() - .5) * 2, 0, 1.4, 0, 1.4, 0.4, [0.35, 0.25, 0.16], 0, 2);
      const pl = this.race.player();
      if (pl && !this.herdWarned) {
        const L = this.race.length, sNow = ((pl.prog % L) + L) % L, sHerd = this.race.samples[this.race.nearestS(P.x, P.z)].s;
        const ahead = ((sHerd - sNow) % L + L) % L;
        if (ahead < 70) { this.herdWarned = true; this.race.signAll('DINO CROSSING!', 1400, '#ffb02a'); }
      }
    }
    const on = t >= 0 && t < runS;
    for (const d of this.herd) {
      d.body.setEnabled(this.visible && on);
      if (!on) continue;
      const u = (this.herdDir > 0 ? P.from : P.to) + this.herdDir * (t * HERD.speed - 4 + d.off * 0.6 + 4);
      const along = d.side;
      const tx = -P.nz, tz = P.nx;   // along the track
      const x = P.x + P.nx * u + tx * along, z = P.z + P.nz * u + tz * along;
      const hop = Math.abs(Math.sin(t * 9 + d.ph)) * 0.12;
      d.body.position.set(this.O.x + x, this.O.y + this.groundY(x, z) + hop, this.O.z + z);
      d.body.rotation.y = Math.atan2(-(P.nz * this.herdDir), P.nx * this.herdDir);   // nose (+x) along the run
      const sw = Math.sin(t * 12 + d.ph) * 0.7;
      d.legs[0].rotation.z = sw; d.legs[1].rotation.z = -sw;
      if (Math.random() < 0.3) this.emit(x, 0.1, z, (Math.random() - .5), 0.8, (Math.random() - .5), 0.8, 0.22, [0.4, 0.28, 0.17], 0, 1.5);
      if (!go) continue;
      for (const r of this.race.racers) {
        if (r.down || r.bot.eliminated) continue;
        const b = r.bot, bp = b.root.position;
        if (Math.hypot(bp.x - d.body.position.x, bp.z - d.body.position.z) > HERD.hitR || Math.abs(bp.y - d.body.position.y) > 1.6) continue;
        if (now - (d.last.get(b) ?? -1e9) < HERD.cooldown * 1000) continue;
        d.last.set(b, now);
        const m = b.body.getMassProperties().mass ?? 100;
        b.body.applyImpulse(new Vector3(P.nx * this.herdDir * HERD.shove, HERD.lift, P.nz * this.herdDir * HERD.shove).scale(m), b.body.getObjectCenterWorld());
        this.race.envHit(b, bp.add(new Vector3(0, 0.4, 0)), HERD.dmg, '#7ad35a', 'DINO HIT!');
      }
    }
  }
  /** ground height under a herd dino: the road surface on the road, 0 elsewhere (they hop the berms) */
  private groundY(x: number, z: number) {
    const R = this.race, i = R.nearestS(x, z), p = R.samples[i], n = { x: -Math.sin(p.h), z: Math.cos(p.h) };
    const u = (x - p.x) * n.x + (z - p.z) * n.z;
    if (Math.abs(u) <= R.width / 2) return R.surfaceY(p, u);
    if (Math.abs(u) <= R.width / 2 + 0.9) return R.surfaceY(p, Math.sign(u) * R.width / 2) + 0.9 * (1 - (Math.abs(u) - R.width / 2 - 0.45) ** 2 / 0.2);
    return 0;
  }

  private updateEruption(dt: number, now: number) {
    const R = this.race;
    if (!this.erupted) {
      const lead = R.racers.find(r => r.lapsDone >= R.laps - 1 && r.finished === undefined);
      if (lead) {
        this.erupted = true; this.eruptT = 0;
        R.signAll('ERUPTION!', 1600, '#ff4a1a');
        const L = R.length, sLead = ((lead.prog % L) + L) % L, s0 = sLead + ERUPT.ahead;
        this.crust = null;
        const V = (this.H as unknown as { volcano: { x: number; z: number; h: number } }).volcano;
        for (let n = 0; n < ERUPT.bombs; n++) {
          const p = R.sampleAt(s0 + (n / (ERUPT.bombs - 1)) * ERUPT.len), u = (Math.random() - 0.5) * (R.width - 1.5);
          const w = R.at(p, u, 0).subtract(this.O);
          this.bombs.push({ x: w.x, z: w.z, t: -n * 0.08, land: false });
        }
        for (let n = 0; n < 40; n++) this.emit(V.x, V.h, V.z, (Math.random() - .5) * 8, 8 + Math.random() * 8, (Math.random() - .5) * 8, 2.5, 0.35, [2.4, 0.8, 0.2], 9.8, 0);
        (this as unknown as { crustPending: [number, number] }).crustPending = [s0, s0 + ERUPT.len];
      }
      return;
    }
    if (this.eruptT < 0) return;
    this.eruptT += dt;
    for (const b of this.bombs) {
      b.t += dt;
      if (!b.land && b.t >= ERUPT.flightS) {
        b.land = true;
        for (let n = 0; n < 8; n++) this.emit(b.x, 0.3, b.z, (Math.random() - .5) * 5, 3 + Math.random() * 3, (Math.random() - .5) * 5, 1.2, 0.2, [2.4, 0.9, 0.2], 9.8, 0);
        for (const r of R.racers) {
          if (r.down) continue;
          const p = r.bot.root.position;
          if (Math.hypot(p.x - this.O.x - b.x, p.z - this.O.z - b.z) < ERUPT.hitR) R.envHit(r.bot, p.clone(), ERUPT.dmg, '#ff6a1f', 'LAVA BOMB!');
        }
      }
    }
    const pend = (this as unknown as { crustPending?: [number, number] }).crustPending;
    if (!this.crust && pend && this.eruptT >= ERUPT.flightS) this.crust = { s0: pend[0], s1: pend[1], t: 0 };
    if (this.crust) { this.crust.t += dt; if (this.crust.t > ERUPT.lastS) { this.crust = null; this.bombs = []; this.eruptT = -1; } }
    void now;
  }

  /** 1/s drag at local (x, z): the hot crust while it lasts (race.ts physics3d) */
  dragAt(x: number, z: number) {
    const c = this.crust; if (!c) return 0;
    const R = this.race, i = R.nearestS(x, z), s = R.samples[i].s, L = R.length;
    const rel = ((s - c.s0) % L + L) % L;
    return rel <= c.s1 - c.s0 ? ERUPT.drag * Math.max(0.3, 1 - c.t / ERUPT.lastS) : 0;
  }

  /** fire burst where a kart fell into the lava (race.ts wreck) */
  burnAt(pos: Vector3) {
    const x = pos.x - this.O.x, z = pos.z - this.O.z;
    for (let n = 0; n < 26; n++) this.emit(x, -1.2, z, (Math.random() - .5) * 4, 4 + Math.random() * 5, (Math.random() - .5) * 4, 1.4, 0.26, [2.4, 0.7 + Math.random() * 0.5, 0.15], 9.8, 0);
    for (let n = 0; n < 6; n++) this.emit(x, -1, z, (Math.random() - .5), 2, (Math.random() - .5), 3, 0.5, [0.2, 0.17, 0.16], 0, 2);
  }
}
