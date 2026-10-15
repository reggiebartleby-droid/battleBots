import type { BotBuild, Catalog, PartDef, WeaponKind } from './types.js';
import { partWeight } from './weight.js';

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  totalWeight: number;
  weightLimit: number;
  /** socketId -> resolved part (only sockets that are filled and valid). */
  resolved: Record<string, PartDef>;
}

/** Same rules on client and server. */
export function validateBuild(build: BotBuild, catalog: Catalog): ValidationResult {
  const errors: string[] = [];
  const resolved: Record<string, PartDef> = {};
  const body = catalog.bodies[build.bodyId];

  if (!body) {
    return { ok: false, errors: [`Unknown body "${build.bodyId}"`], totalWeight: 0, weightLimit: 0, resolved };
  }

  const socketIds = new Set(body.sockets.map(s => s.id));

  // Sockets in the build that the body doesn't have
  for (const id of Object.keys(build.sockets)) {
    if (!socketIds.has(id)) errors.push(`Body "${body.id}" has no socket "${id}"`);
  }

  let totalWeight = 0;

  for (const socket of body.sockets) {
    const partId = build.sockets[socket.id] ?? null;

    if (partId === null) {
      if (socket.required !== false) errors.push(`Socket "${socket.id}" is required`);
      continue;
    }

    const part = catalog.parts[partId];
    if (!part) { errors.push(`Unknown part "${partId}" in socket "${socket.id}"`); continue; }

    if (part.type !== socket.type) {
      errors.push(`Part "${part.id}" (${part.type}) can't go in ${socket.type} socket "${socket.id}"`);
      continue;
    }

    if (socket.type === 'weapon' && !body.allowedWeaponKinds.includes(part.kind as WeaponKind)) {
      errors.push(`Body "${body.id}" doesn't accept weapon kind "${part.kind}" ("${part.id}")`);
      continue;
    }

    resolved[socket.id] = part;
    totalWeight += partWeight(part, catalog.balance);
  }

  totalWeight = Math.round(totalWeight * 100) / 100;
  if (totalWeight > body.weightLimit) {
    errors.push(`Over weight: ${totalWeight} > ${body.weightLimit}`);
  }

  return { ok: errors.length === 0, errors, totalWeight, weightLimit: body.weightLimit, resolved };
}
