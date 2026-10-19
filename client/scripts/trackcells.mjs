/**
 * v0.45 stamp a 3D track (trackgeo.ts) onto a cube grid: for every grid cell the road covers, the surface height there
 * (the smooth driving surface, so cube column tops sit on the colliders) + which sample / u it came from. Walls too.
 * Shared by bake-stunt.mjs and bake-rally.mjs. Run with node --experimental-strip-types (trackgeo.ts is TypeScript).
 */
import { surf3, extent3, nrm, LIP_H } from '../src/trackgeo.ts';

export const SHOULDER = 0.3;    // race.ts Race.SHOULDER
export const WALL_T = 0.3;      // race.ts wall thickness

/** cells: Map "i,k" -> { y, i: sample index, u, wall: bool }. size = cell size (m). wallH: wall height above the edge. */
export function stampTrack(line, width, size, wallH, opts = {}) {
  const S = line.samples, n = S.length, cells = new Map();
  const set = (x, z, y, si, u, wall) => {
    const i = Math.floor(x / size), k = Math.floor(z / size), key = i + ',' + k;
    const c = cells.get(key);
    // road beats wall; between two of the same kind the higher one wins (bank overlaps, wall corners)
    const better = !c || (c.wall && !wall) || (c.wall === wall && y > c.y);
    if (better) cells.set(key, { y, si, u, wall });
  };
  for (let i = 0; i < n; i++) {
    const a = S[i], b = S[(i + 1) % n];
    if (a.gap || b.gap) continue;
    for (let f = 0; f < 1; f += 0.2) {
      // interpolate position + heading along the segment a -> b (short way round)
      let dh = b.h - a.h; dh = Math.atan2(Math.sin(dh), Math.cos(dh));
      const x = a.x + (b.x - a.x) * f, z = a.z + (b.z - a.z) * f, h = a.h + dh * f, nn = nrm(h);
      const p = f < 0.5 ? a : b, dy = (b.y - a.y) * f - (p === b ? (b.y - a.y) : 0);
      const extL = extent3(p, 1, width) + SHOULDER, extR = extent3(p, -1, width) + SHOULDER;
      for (let u = -extR - WALL_T * 2; u <= extL + WALL_T * 2; u += size * 0.4) {
        const side = u >= 0 ? 1 : -1, ext = side > 0 ? extL : extR;
        const X = x + nn.x * u, Z = z + nn.z * u;
        if (Math.abs(u) <= ext) {
          const uc = Math.max(-(extR - SHOULDER), Math.min(extL - SHOULDER, u));
          set(X, Z, surf3(p, uc, width) + dy, i, u, false);
        } else {
          const edge = side > 0 ? p.edgeL : p.edgeR, mouth = side > 0 ? p.mouthL : p.mouthR, lip = side > 0 ? p.lipL : p.lipR;
          if ((edge !== 'wall' && !lip) || mouth || (opts.noWalls && opts.noWalls(p))) continue;
          if (lip && Math.abs(u) > ext + WALL_T) continue;   // the curb is one wall-thickness wide
          const ue = side * (ext - SHOULDER);
          set(X, Z, surf3(p, ue, width) + dy + (lip ? LIP_H : wallH), i, u, true);
        }
      }
    }
  }
  return cells;
}
