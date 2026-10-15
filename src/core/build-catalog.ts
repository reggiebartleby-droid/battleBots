/** Browser-safe catalog assembly (no fs). Node loader lives in catalog.ts. */
import type { BalanceConfig, BodyDef, BodyId, Catalog, PartDef } from './types.js';

export function buildCatalog(bodies: BodyDef[], parts: PartDef[], balance: BalanceConfig): Catalog {
  const catalog: Catalog = { bodies: {} as Record<BodyId, BodyDef>, parts: {}, balance };
  for (const b of bodies) catalog.bodies[b.id] = b;
  for (const p of parts) {
    if (catalog.parts[p.id]) throw new Error(`Duplicate part id "${p.id}"`);
    catalog.parts[p.id] = p;
  }
  return catalog;
}
