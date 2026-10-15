/** The BattleBox: steel floor, lexan walls, killsaw strips, corner pulverizers. Placeholder primitives. */
import { Color3, MeshBuilder, PhysicsAggregate, PhysicsShapeType, Scene, StandardMaterial, Vector3 } from '@babylonjs/core';

export const ARENA_SIZE = 16;   // metres, inner width
export const WALL_H = 2.5;

export function buildArena(scene: Scene) {
  const half = ARENA_SIZE / 2;

  const steel = new StandardMaterial('steel', scene);
  steel.diffuseColor = new Color3(0.42, 0.44, 0.47);
  steel.specularColor = new Color3(0.3, 0.3, 0.3);

  const lexan = new StandardMaterial('lexan', scene);
  lexan.diffuseColor = new Color3(0.7, 0.85, 1);
  lexan.alpha = 0.15;
  lexan.backFaceCulling = false;

  const yellow = new StandardMaterial('yellow', scene);
  yellow.diffuseColor = new Color3(0.95, 0.75, 0.1);
  const red = new StandardMaterial('red', scene);
  red.diffuseColor = new Color3(0.8, 0.1, 0.1);
  const post = new StandardMaterial('post', scene);
  post.diffuseColor = new Color3(0.25, 0.26, 0.28);

  // Floor
  const floor = MeshBuilder.CreateBox('floor', { width: ARENA_SIZE, depth: ARENA_SIZE, height: 0.5 }, scene);
  floor.position.y = -0.25;
  floor.material = steel;
  new PhysicsAggregate(floor, PhysicsShapeType.BOX, { mass: 0, friction: 0.8, restitution: 0.1 }, scene);

  // Floor plate seams (visual only)
  for (let i = 1; i < 4; i++) {
    const s = MeshBuilder.CreateBox(`seamx${i}`, { width: ARENA_SIZE, depth: 0.05, height: 0.02 }, scene);
    s.position.set(0, 0.01, -half + i * (ARENA_SIZE / 4));
    s.material = post;
    const t = MeshBuilder.CreateBox(`seamz${i}`, { width: 0.05, depth: ARENA_SIZE, height: 0.02 }, scene);
    t.position.set(-half + i * (ARENA_SIZE / 4), 0.01, 0);
    t.material = post;
  }

  // Killsaw strips (visual)
  for (const z of [-2.5, 2.5]) {
    const k = MeshBuilder.CreateBox(`killsaw${z}`, { width: 6, depth: 0.5, height: 0.03 }, scene);
    k.position.set(0, 0.015, z);
    k.material = yellow;
    const slot = MeshBuilder.CreateBox(`slot${z}`, { width: 5.4, depth: 0.08, height: 0.035 }, scene);
    slot.position.set(0, 0.018, z);
    slot.material = red;
  }

  // Walls (lexan) + kick rail + posts
  const walls: { x: number; z: number; rot: number }[] = [
    { x: 0, z: half, rot: 0 }, { x: 0, z: -half, rot: 0 },
    { x: half, z: 0, rot: Math.PI / 2 }, { x: -half, z: 0, rot: Math.PI / 2 },
  ];
  for (const [i, w] of walls.entries()) {
    const wall = MeshBuilder.CreateBox(`wall${i}`, { width: ARENA_SIZE + 0.5, depth: 0.25, height: WALL_H }, scene);
    wall.position.set(w.x, WALL_H / 2, w.z);
    wall.rotation.y = w.rot;
    wall.material = lexan;
    new PhysicsAggregate(wall, PhysicsShapeType.BOX, { mass: 0, friction: 0.3, restitution: 0.4 }, scene);

    const rail = MeshBuilder.CreateBox(`rail${i}`, { width: ARENA_SIZE + 0.5, depth: 0.3, height: 0.25 }, scene);
    rail.position.set(w.x, 0.125, w.z);
    rail.rotation.y = w.rot;
    rail.material = red;
  }
  for (const x of [-half, half]) for (const z of [-half, half]) {
    const p = MeshBuilder.CreateBox(`post${x}${z}`, { width: 0.3, depth: 0.3, height: WALL_H + 0.2 }, scene);
    p.position.set(x, (WALL_H + 0.2) / 2, z);
    p.material = post;
    // Corner pulverizer (visual)
    const head = MeshBuilder.CreateBox(`pulv${x}${z}`, { width: 0.8, depth: 0.8, height: 0.3 }, scene);
    head.position.set(x - Math.sign(x) * 0.9, 1.6, z - Math.sign(z) * 0.9);
    head.material = red;
    const arm = MeshBuilder.CreateBox(`pulvarm${x}${z}`, { width: 0.15, depth: 0.15, height: 1.2 }, scene);
    arm.position.set(x - Math.sign(x) * 0.9, 2.2, z - Math.sign(z) * 0.9);
    arm.material = post;
  }

  return { half, spawnA: new Vector3(-4.5, 0.6, -4.5), spawnB: new Vector3(4.5, 0.6, 4.5) };
}
