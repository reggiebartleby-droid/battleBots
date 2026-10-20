/** The BattleBox. v0.18: sci-fi look -- black floor/surroundings, neon outlines in one selectable colour,
 *  floor grid with a selectable number of squares. Colliders (floor + 4 walls) are unchanged from v0.7;
 *  everything neon is visual only (no physics). */
import {
  Color3, Constants, GlowLayer, Mesh, MeshBuilder, PhysicsAggregate, PhysicsShapeType, Scene, StandardMaterial, Vector3,
} from '@babylonjs/core';

export const ARENA_SIZE = 16;   // metres, inner width
export const WALL_H = 2.5;

/** Neon colours for the arena selector (first = default). */
export const ARENA_COLOURS: { id: string; label: string; hex: string }[] = [
  { id: 'cyan', label: 'Cyan', hex: '#00e5ff' },
  { id: 'blue', label: 'Blue', hex: '#2f6bff' },
  { id: 'purple', label: 'Purple', hex: '#a040ff' },
  { id: 'gold', label: 'Gold', hex: '#ffc400' },
  { id: 'silver', label: 'Silver', hex: '#d8e2ec' },
  { id: 'green', label: 'Bright green', hex: '#39ff14' },
  { id: 'red', label: 'Red', hex: '#ff1e2d' },
];
/** Floor squares per row/column (first = default). 16 = 1 m squares; 1 = one black square. */
export const FLOOR_GRIDS = [16, 8, 4, 2, 1];

export interface ArenaStyle { colour: string; grid: number }

/** v0.21 collision filter bits. Driving surfaces (the floor; later ramps / obstacle tops) are what the bots' round
 *  wheel treads roll on; the walls are their own group. Everything else in the game collides with both as before. */
export const SURFACE_BIT = 1 << 6;
export const WALL_BIT = 1 << 7;

/** v0.49 one BattleBox built by buildArena (the 16 m original, or the 32 m Big Arena). */
export interface ArenaBox {
  half: number;
  center: Vector3;
  /** n spawn points (corners, then edge midpoints), y = 0.6, with the facing toward the centre */
  spawns(n: number): { pos: Vector3; facing: number }[];
  setVisible(on: boolean): void;
  /** for cubes.ts setDebrisFloors */
  debrisFloor: { cx: number; cz: number; half: number; wallH: number };
}

export function buildArena(scene: Scene) {
  // ---- Shared materials + the one glow layer (every box uses them) ----
  const black = new StandardMaterial('arenaBlack', scene);
  black.diffuseColor = new Color3(0, 0, 0);
  black.specularColor = new Color3(0, 0, 0);

  const glass = new StandardMaterial('lexan', scene);
  glass.disableLighting = true;
  glass.alpha = 0.6;
  glass.alphaMode = Constants.ALPHA_ADD;   // only adds a faint tint -- never darkens the bots seen through it
  glass.backFaceCulling = false;

  // ---- Neon (visual only) ----
  const neon = (name: string) => {
    const m = new StandardMaterial(name, scene);
    m.disableLighting = true;
    return m;
  };
  const M = {
    minor: neon('neonMinor'),    // floor grid
    major: neon('neonMajor'),    // floor seams every 4 m + outer edge
    frame: neon('neonFrame'),    // wall frames, posts, rails, hazards
    faint: neon('neonFaint'),    // wall mid-line
    hot: neon('neonHot'),        // killsaw slots
  };
  const glow = new GlowLayer('arenaGlow', scene, { blurKernelSize: 48 });
  glow.intensity = 0.6;
  // Only the neon glows. Everything else (bots, blocks) is drawn black into the glow pass so it hides the
  // glow behind it instead of being washed over by it. The see-through floor/walls are left out entirely.
  const neonMeshes = new Set<Mesh>();
  glow.customEmissiveColorSelector = (mesh, _sub, mat, out) => {
    const cube = (mesh.metadata as { cubeGlow?: Color3 } | null)?.cubeGlow;   // v0.27 Cube Bots look
    if (neonMeshes.has(mesh as Mesh)) { const e = (mat as StandardMaterial).emissiveColor; out.set(e.r, e.g, e.b, 1); }
    else if (cube) out.set(cube.r, cube.g, cube.b, 1);
    else out.set(0, 0, 0, 1);
  };

  /** Thin glowing bar from a to b (collected, then merged per material). */
  let pending: Mesh[] = [];
  const bar = (a: Vector3, b: Vector3, t: number, m: StandardMaterial) => {
    const len = Vector3.Distance(a, b);
    const box = MeshBuilder.CreateBox('neon', { width: t, height: t, depth: len }, scene);
    box.position = a.add(b).scale(0.5);
    box.lookAt(b);
    box.material = m;
    pending.push(box);
  };
  const flush = (name: string): Mesh[] => {
    const byMat = new Map<StandardMaterial, Mesh[]>();
    for (const b of pending) { const k = b.material as StandardMaterial; (byMat.get(k) ?? byMat.set(k, []).get(k)!).push(b); }
    pending = [];
    const out: Mesh[] = [];
    for (const list of byMat.values()) {
      const merged = Mesh.MergeMeshes(list, true, true)!;
      merged.name = name;
      merged.isPickable = false;
      neonMeshes.add(merged);
      out.push(merged);
    }
    return out;
  };

  const gridBuilders: ((n: number) => void)[] = [];

  /** One box: colliders (floor + 4 walls), neon frame, hazards, floor grid. prefix '' = the original names
   *  (floor / wall* / arena*, which main.ts shows / hides as "the arena"); v0.49 'big' = the Big Arena. */
  const buildBox = (size: number, origin: Vector3, prefix: string): ArenaBox => {
    const half = size / 2, k = size / ARENA_SIZE;   // k: hazards sit at the same relative spots
    const N = (n: string) => prefix ? prefix + n[0].toUpperCase() + n.slice(1) : n;
    const O = (x: number, y: number, z: number) => new Vector3(origin.x + x, origin.y + y, origin.z + z);
    const own: Mesh[] = [];

    // ---- Colliders (same shapes / friction / restitution as the original) ----
    const floor = MeshBuilder.CreateBox(N('floor'), { width: size, depth: size, height: 0.5 }, scene);
    floor.position = O(0, -0.25, 0);
    floor.material = black;
    floor.receiveShadows = true;
    new PhysicsAggregate(floor, PhysicsShapeType.BOX, { mass: 0, friction: 0.8, restitution: 0.1 }, scene).shape.filterMembershipMask = SURFACE_BIT;
    glow.addExcludedMesh(floor); own.push(floor);

    const walls: { x: number; z: number; rot: number }[] = [
      { x: 0, z: half, rot: 0 }, { x: 0, z: -half, rot: 0 },
      { x: half, z: 0, rot: Math.PI / 2 }, { x: -half, z: 0, rot: Math.PI / 2 },
    ];
    for (const [i, w] of walls.entries()) {
      const wall = MeshBuilder.CreateBox(N(`wall${i}`), { width: size + 0.5, depth: 0.25, height: WALL_H }, scene);
      wall.position = O(w.x, WALL_H / 2, w.z);
      wall.rotation.y = w.rot;
      wall.material = glass;
      new PhysicsAggregate(wall, PhysicsShapeType.BOX, { mass: 0, friction: 0.3, restitution: 0.4 }, scene).shape.filterMembershipMask = WALL_BIT;
      glow.addExcludedMesh(wall); own.push(wall);
    }

    /** 12-edge outline of an axis-aligned box, with a black body inside. */
    const outline = (c: Vector3, sx: number, sy: number, sz: number, t: number, m: StandardMaterial) => {
      const body = MeshBuilder.CreateBox(N('arenaBlock'), { width: sx * 0.99, height: sy * 0.99, depth: sz * 0.99 }, scene);
      body.position = c.clone(); body.material = black; body.isPickable = false; own.push(body);
      const hx = sx / 2, hy = sy / 2, hz = sz / 2;
      const p = (x: number, y: number, z: number) => c.add(new Vector3(x, y, z));
      for (const y of [-hy, hy]) for (const z of [-hz, hz]) bar(p(-hx, y, z), p(hx, y, z), t, m);
      for (const x of [-hx, hx]) for (const z of [-hz, hz]) bar(p(x, -hy, z), p(x, hy, z), t, m);
      for (const x of [-hx, hx]) for (const y of [-hy, hy]) bar(p(x, y, -hz), p(x, y, hz), t, m);
    };

    // Walls: top edge, faint mid-line, uprights every 4 m, kick rail
    for (const w of walls) {
      const side = w.rot !== 0;
      const at = (u: number, y: number) => side ? O(w.x, y, u) : O(u, y, w.z);
      bar(at(-half, WALL_H), at(half, WALL_H), 0.06, M.frame);
      bar(at(-half, WALL_H * 0.62), at(half, WALL_H * 0.62), 0.025, M.faint);
      for (let u = -half + 4; u < half; u += 4) bar(at(u, 0), at(u, WALL_H), 0.05, M.frame);
      outline(at(0, 0.125), side ? 0.3 : size + 0.5, 0.25, side ? size + 0.5 : 0.3, 0.05, M.frame);
    }
    // Corner posts + pulverizers
    for (const x of [-half, half]) for (const z of [-half, half]) {
      outline(O(x, (WALL_H + 0.2) / 2, z), 0.3, WALL_H + 0.2, 0.3, 0.05, M.frame);
      const px = x - Math.sign(x) * 0.9 * k, pz = z - Math.sign(z) * 0.9 * k;
      outline(O(px, 1.6, pz), 0.8, 0.3, 0.8, 0.05, M.frame);
      outline(O(px, 2.2, pz), 0.15, 1.2, 0.15, 0.035, M.frame);
    }
    // Killsaw strips
    for (const z of [-2.5 * k, 2.5 * k]) {
      outline(O(0, 0.02, z), 6 * k, 0.03, 0.5, 0.04, M.frame);
      bar(O(-2.7 * k, 0.045, z), O(2.7 * k, 0.045, z), 0.06, M.hot);
    }
    own.push(...flush(N('arenaNeon')));

    // Floor grid (rebuilt when the square count changes; the bigger box keeps the same square size)
    let gridMeshes: Mesh[] = [];
    let visible = true;
    gridBuilders.push((n0: number) => {
      for (const m of gridMeshes) { neonMeshes.delete(m); m.dispose(); }
      const n = Math.max(1, Math.round(n0 * k));
      const step = size / n;
      for (let i = 0; i <= n; i++) {
        const v = -half + i * step;
        const major = i === 0 || i === n || Math.abs((v + half) % 4) < 1e-6;   // edges + the 4 m plate seams
        const m = major ? M.major : M.minor, t = major ? 0.05 : 0.025;
        bar(O(v, 0.01, -half), O(v, 0.01, half), t, m);
        bar(O(-half, 0.01, v), O(half, 0.01, v), t, m);
      }
      gridMeshes = flush(N('arenaGrid'));
      if (prefix) for (const m of gridMeshes) m.setEnabled(visible);
    });

    const ring = [[-1, -1], [1, 1], [1, -1], [-1, 1], [0, -1], [0, 1], [-1, 0], [1, 0]];
    return {
      half, center: origin.clone(),
      spawns: (n: number) => ring.slice(0, n).map(([sx, sz]) => {
        const r = half * 0.62;
        const pos = O(sx * r, 0.6, sz * r);
        return { pos, facing: Math.atan2(-sx, -sz) };   // nose toward the centre
      }),
      setVisible: (on: boolean) => { visible = on; for (const m of [...own, ...gridMeshes]) m.setEnabled(on); },
      debrisFloor: { cx: origin.x, cz: origin.z, half, wallH: WALL_H },
    };
  };

  const main = buildBox(ARENA_SIZE, Vector3.Zero(), '');

  const setColour = (hex: string) => {
    const c = Color3.FromHexString(hex);
    M.minor.emissiveColor = c.scale(0.9);
    M.major.emissiveColor = c.scale(1.4);
    M.frame.emissiveColor = c.scale(1.2);
    M.faint.emissiveColor = c.scale(0.35);
    M.hot.emissiveColor = c.scale(2);
    glass.emissiveColor = c.scale(0.06);
  };

  let current: ArenaStyle = { colour: '', grid: 0 };
  const setStyle = (s: Partial<ArenaStyle>) => {
    const colour = ARENA_COLOURS.find(c => c.id === s.colour)?.id ?? (current.colour || ARENA_COLOURS[0].id);
    const grid = FLOOR_GRIDS.includes(s.grid as number) ? s.grid as number : (current.grid || FLOOR_GRIDS[0]);
    if (colour !== current.colour) setColour(ARENA_COLOURS.find(c => c.id === colour)!.hex);
    if (grid !== current.grid) for (const g of gridBuilders) g(grid);
    current = { colour, grid };
    return current;
  };
  setStyle({});

  /** v0.49 another BattleBox (the Big Arena), same look + colour + grid picker. Starts hidden. */
  const addBox = (size: number, origin: Vector3, prefix: string): ArenaBox => {
    const box = buildBox(size, origin, prefix);
    if (current.grid) gridBuilders[gridBuilders.length - 1](current.grid);
    box.setVisible(false);
    return box;
  };

  return { half: main.half, spawnA: new Vector3(-4.5, 0.6, -4.5), spawnB: new Vector3(4.5, 0.6, 4.5), setStyle, addBox };
}
