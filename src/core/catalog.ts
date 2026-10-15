/**
 * Loads data/*.json into a Catalog. Node-only (uses fs); the browser client
 * imports the JSON directly and calls buildCatalog() from build-catalog.ts.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { BalanceConfig, BodyDef, Catalog, PartDef } from './types.js';
import { buildCatalog } from './build-catalog.js';

export { buildCatalog };

export function loadCatalog(dataDir: string): Catalog {
  const read = (f: string) => JSON.parse(readFileSync(join(dataDir, f), 'utf8'));
  const bodies: BodyDef[] = read('bodies.json');
  const balance: BalanceConfig = read('balance.json');
  const partsDir = join(dataDir, 'parts');
  const parts: PartDef[] = readdirSync(partsDir)
    .filter(f => f.endsWith('.json'))
    .sort()
    .flatMap(f => JSON.parse(readFileSync(join(partsDir, f), 'utf8')) as PartDef[]);
  return buildCatalog(bodies, parts, balance);
}
