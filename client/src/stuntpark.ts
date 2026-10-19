/**
 * v0.45 STUNT PARK -- Junkyard Scrap Pit (user 2026-10-19). Cube world: scripts/bake-stunt.mjs -> tracks/stunt.cubes.
 *
 * Live: the crane arm on the scrap mountain swings round, the steam works' gears turn, smokestacks puff, the crowd on
 * the scrap grandstand cheers, start lights.
 *
 * ROLLING TIRES (user): real physics tires (one each from three chutes, every few seconds while racing):
 *   - down the corkscrew, against the traffic          - into the half-pipe from its outer lip (they roll up the walls
 *   - across the start straight after the crossing        and get launched)
 * A bot can knock a tire into another bot; a tire hitting a bot fast enough does damage (more the faster it hits).
 */
import { Color3, Mesh, MeshBuilder, PhysicsAggregate, PhysicsShapeType, Quaternion, Scene, StandardMaterial, TransformNode, Vector3 } from '@babylonjs/core';
import { WALL_BIT } from './arena.js';
import { CubeSwarm, CubeWorld } from './cubeworld.js';
import type { Race, TrackScenery } from './race.js';
import type { Bot } from './bot.js';
import { MOBILE } from './mobile.js';

export const TIRES = {
  max: 7,
  every: [3.2, 5.5] as [number, number],   // s between spawns (random in range)
  r: 0.42, w: 0.3, mass: 30,
  lifeS: 28, stillS: 6,
  hitR: 1.0, hitMin: 3.5,                   // m/s relative speed before a tire hurts
  dmg: [2, 1.1, 14] as [number, number, number],   // base + per m/s over hitMin, capped
  cooldown: 0.6,
};
interface Tire { mesh: Mesh; agg: PhysicsAggregate; born: number; still: number; last: Map<Bot, number> }
interface Spawner { pos: Vector3; vel: Vector3; axle: Vector3 }

export class StuntPark extends CubeWorld implements TrackScenery {
  private crane: Mesh | null = null;
  private gears: Mesh[] = [];
  private smoke: CubeSwarm | null = null;
  private puffs: { x: number; y: number; z: number; age: number; life: number; s: number }[] = [];
  private puffAt = 0;
  private tires: Tire[] = [];
  private tireLook: Mesh | null = null;
  private tireMat: StandardMaterial;
  private nextTire = 2;
  private spawners: Spawner[] = [];
  private raceT = 0;

  constructor(scene: Scene, race: Race) {
    super(scene, race, 'tracks/stunt.cubes');
    this.tireMat = new StandardMaterial('sp_tire', scene);
    this.tireMat.diffuseColor = Color3.FromHexString('#1c1a19'); this.tireMat.specularColor = new Color3(0.05, 0.05, 0.05);
    this.spawners = this.makeSpawners();
  }

  // ------------------------------------------------------------------------------------------------ cube world
  protected built() {
    const H = this.H as unknown as { gears: [number, number, number, number, number][]; crane: [number, number, number] };
    const crane = this.object('crane');
    crane.position = this.O.add(new Vector3(...H.crane));
    this.crane = crane;
    const gear = this.template('gear');
    H.gears.forEach((g, n) => {
      const m = gear.clone('sp_gear' + n, null)!;
      m.metadata = { dir: g[3] };
      m.position = this.O.add(new Vector3(g[0], g[1], g[2]));
      m.scaling.setAll(g[4] / 2);
      this.keep(m); this.gears.push(m);
    });
    const smoke = this.object('smoke', false);
    smoke.material = this.propMat;
    this.smoke = new CubeSwarm(smoke, MOBILE ? 60 : 160);
    this.tireLook = this.template('tire');
  }

  protected live(dt: number) {
    if (this.crane) this.crane.rotation.y += dt * 0.18;
    for (const g of this.gears) g.rotation.z += dt * 0.6 * (g.metadata?.dir ?? 1) / g.scaling.x;
    this.updateSmoke(dt);
  }

  private updateSmoke(dt: number) {
    const sw = this.smoke; if (!sw) return;
    const H = this.H as unknown as { smoke: [number, number, number][] };
    this.puffAt -= dt;
    if (this.puffAt <= 0) {
      this.puffAt = MOBILE ? 0.5 : 0.22;
      const s = H.smoke[Math.floor(Math.random() * H.smoke.length)];
      this.puffs.push({ x: s[0] + (Math.random() - .5) * .4, y: s[1], z: s[2] + (Math.random() - .5) * .4, age: 0, life: 5 + Math.random() * 2, s: 0.8 + Math.random() * 0.5 });
    }
    sw.begin();
    this.puffs = this.puffs.filter(p => (p.age += dt) < p.life);
    for (const p of this.puffs) {
      const k = p.age / p.life, g = 0.36 * (1 - k * 0.5);
      sw.add(this.O.x + p.x + p.age * 0.9, this.O.y + p.y + p.age * 1.5, this.O.z + p.z + p.age * 0.3, p.s * (1 + k * 2.4), g + 0.05, g, g - 0.03, p.age * 0.4);
    }
    sw.end();
  }

  // ------------------------------------------------------------------------------------------------ rolling tires
  private makeSpawners(): Spawner[] {
    const R = this.race, S = R.samples;
    const at = (seg: number, q: number) => S.find(p => p.seg === seg && p.q >= q) ?? S[0];
    const left = (h: number) => new Vector3(-Math.sin(h), 0, Math.cos(h));
    const out: Spawner[] = [];
    { const p = at(1, 80), T = R.tangentAt(p);   // corkscrew top: rolls down against the traffic
      out.push({ pos: R.at(p, 0, R.surfaceY(p, 0) + TIRES.r + 0.15), vel: T.scale(-4), axle: left(p.h) }); }
    { const p = at(3, 37), u = 6.2, n = left(p.h);   // half-pipe outer lip: drops in, rides the walls
      out.push({ pos: R.at(p, u, R.surfaceY(p, u) + TIRES.r + 0.3), vel: n.scale(-1.5).add(R.tangentAt(p).scale(2)), axle: R.tangentAt(p) }); }
    { const p = at(0, 30), u = 3.6, n = left(p.h);   // start straight after the crossing: across the road
      out.push({ pos: R.at(p, u, R.surfaceY(p, u) + TIRES.r + 0.1), vel: n.scale(-6), axle: R.tangentAt(p) }); }
    return out;
  }

  begin() {
    for (const t of this.tires) { t.agg.dispose(); t.mesh.dispose(); }
    this.tires = []; this.nextTire = 2; this.raceT = 0;
  }

  private spawnTire() {
    const sp = this.spawners[Math.floor(Math.random() * this.spawners.length)];
    const mesh = MeshBuilder.CreateCylinder('sp_tire', { diameter: TIRES.r * 2, height: TIRES.w, tessellation: 16 }, this.scene);
    // cylinder axis (y) -> the axle
    const ax = sp.axle.normalize(), fw = Vector3.Cross(ax, Vector3.Up()).normalize(), up = Vector3.Cross(fw, ax);
    mesh.rotationQuaternion = Quaternion.RotationQuaternionFromAxis(fw, ax, up);
    mesh.position = sp.pos.add(new Vector3((Math.random() - .5) * 0.4, 0, (Math.random() - .5) * 0.4));
    mesh.material = this.tireMat; mesh.isPickable = false;
    if (this.tireLook) {   // cube tire look: baked with the axle along x
      const look = this.tireLook.clone('sp_tirelook', mesh)!;
      look.metadata = null; look.setEnabled(true);
      look.rotationQuaternion = Quaternion.RotationQuaternionFromAxis(new Vector3(0, 1, 0), new Vector3(-1, 0, 0), new Vector3(0, 0, 1));
      look.position.setAll(0); look.scaling.setAll(1);
      mesh.visibility = 0; mesh.isVisible = true;
    }
    const agg = new PhysicsAggregate(mesh, PhysicsShapeType.CYLINDER, { mass: TIRES.mass, friction: 0.9, restitution: 0.35 }, this.scene);
    agg.shape.filterMembershipMask = WALL_BIT;
    agg.body.setLinearVelocity(sp.vel.clone());
    agg.body.setAngularVelocity(ax.scale(-sp.vel.length() / TIRES.r * Math.sign(Vector3.Dot(Vector3.Cross(ax, sp.vel), Vector3.Up()) || 1)));
    this.tires.push({ mesh, agg, born: this.raceT, still: 0, last: new Map() });
  }

  hazards(dt: number, now: number) {
    this.raceT += dt;
    if ((this.nextTire -= dt) <= 0 && this.tires.length < TIRES.max) {
      this.spawnTire();
      this.nextTire = TIRES.every[0] + Math.random() * (TIRES.every[1] - TIRES.every[0]);
    }
    const live = this.race.racers.filter(r => !r.down && !r.bot.eliminated).map(r => r.bot);
    const O = this.race.origin;
    this.tires = this.tires.filter(t => {
      const p = t.mesh.position, v = t.agg.body.getLinearVelocity(), sp = v.length();
      t.still = sp < 0.3 ? t.still + dt : 0;
      const gone = this.raceT - t.born > TIRES.lifeS || t.still > TIRES.stillS || p.y < O.y - 3 || Math.abs(p.x - O.x) > 75 || Math.abs(p.z - O.z) > 75;
      if (gone) { t.agg.dispose(); t.mesh.dispose(); return false; }
      for (const b of live) {
        const bp = b.root.position;
        if (Math.abs(bp.y - p.y) > 1.2 || Math.hypot(bp.x - p.x, bp.z - p.z) > TIRES.hitR) continue;
        const rel = v.subtract(b.body.getLinearVelocity()).length();
        if (rel < TIRES.hitMin || now - (t.last.get(b) ?? -1e9) < TIRES.cooldown * 1000) continue;
        t.last.set(b, now);
        const dmg = Math.min(TIRES.dmg[2], TIRES.dmg[0] + TIRES.dmg[1] * (rel - TIRES.hitMin));
        this.race.envHit(b, bp.add(p).scale(0.5), dmg, '#ff9a3c', 'TIRE HIT!');
      }
      return true;
    });
  }

  dragAt() { return 0; }
  setVisible(on: boolean) {
    super.setVisible(on);
    for (const t of this.tires) t.mesh.setEnabled(on);
  }
  update(dt: number, go: boolean) { super.update(dt, go); }
}
void TransformNode;
