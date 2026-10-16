import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  loadCatalog, validateBuild, partWeight, createBotState, applyDamage,
  canAttack, isImmobilized, isDestroyed, currentSpeed, type BotBuild,
} from '../core/index.js';

const dataDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data');
const catalog = loadCatalog(dataDir);

// Part weight table
console.log('--- Part weights ---');
for (const p of Object.values(catalog.parts)) {
  console.log(`${p.id.padEnd(16)} ${p.type.padEnd(9)} w=${partWeight(p, catalog.balance)}`);
}

const build: BotBuild = {
  bodyId: 'vertical_spinner',
  sockets: { weapon: 'vs_disc', weapon_motor: 'wm_std', front: 'front_wedgelet', armor: 'armor_light', wheels: 'wheels_std', motor: 'motor_std', secondary: null },
  cosmetics: { name: 'Demo Bot', paint: '#ff3b1f' },
};

console.log('\n--- Validate ---');
const v = validateBuild(build, catalog);
console.log(v.ok ? 'OK' : 'INVALID', `weight ${v.totalWeight}/${v.weightLimit}`, v.errors);

console.log('\n--- Fight sim ---');
const s = createBotState(build, catalog);
console.log('speed', currentSpeed(s), 'canAttack', canAttack(s));
applyDamage(s, 'wheels', 50);
console.log('after wheels hit: immobilized =', isImmobilized(s), '-> FINISH HIM/HER!');
for (const id of Object.keys(s.parts)) applyDamage(s, id, 999);
console.log('all parts hit: destroyed =', isDestroyed(s), 'damage taken', s.totalDamageTaken);
