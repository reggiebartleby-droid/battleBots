import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  loadCatalog, validateBuild, partWeight, createBotState, applyDamage,
  canAttack, isImmobilized, isDestroyed, socketArmor, type BotBuild,
} from '../core/index.js';

const dataDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data');
const catalog = loadCatalog(dataDir);

const good: BotBuild = {
  bodyId: 'vertical_spinner',
  sockets: { weapon: 'vs_disc', front: 'front_wedgelet', armor: 'armor_light', wheels: 'wheels_std', motor: 'motor_std', secondary: null },
  cosmetics: { name: 'T' },
};

test('catalog loads 6 bodies and all parts', () => {
  assert.equal(Object.keys(catalog.bodies).length, 6);
  assert.ok(Object.keys(catalog.parts).length >= 25);
});

test('weight formula: base + stat*coef', () => {
  // vs_disc: 20 + 30*1.0 + 30*2.5 = 125
  assert.equal(partWeight(catalog.parts['vs_disc'], catalog.balance), 125);
  // motor_std: 10 + 15*1.0 + 8*1.5 = 37
  assert.equal(partWeight(catalog.parts['motor_std'], catalog.balance), 37);
});

test('every weapon fits exactly one body', () => {
  for (const p of Object.values(catalog.parts).filter(p => p.type === 'weapon')) {
    const hosts = Object.values(catalog.bodies).filter(b => b.allowedWeaponKinds.includes(p.kind as any));
    assert.equal(hosts.length, 1, `${p.id} fits ${hosts.length} bodies`);
  }
});

test('valid build passes', () => {
  const v = validateBuild(good, catalog);
  assert.deepEqual(v.errors, []);
  assert.ok(v.totalWeight <= v.weightLimit);
});

test('wrong weapon kind for body is rejected', () => {
  const v = validateBuild({ ...good, sockets: { ...good.sockets, weapon: 'oh_hammer' } }, catalog);
  assert.ok(v.errors.some(e => e.includes("doesn't accept weapon kind")));
});

test('wrong part type in socket is rejected', () => {
  const v = validateBuild({ ...good, sockets: { ...good.sockets, armor: 'wheels_std' } }, catalog);
  assert.ok(v.errors.some(e => e.includes("can't go in armor socket")));
});

test('missing required socket and unknown socket are rejected', () => {
  const { motor, ...rest } = good.sockets;
  const v = validateBuild({ ...good, sockets: { ...rest, turret: 'vs_bar' } }, catalog);
  assert.ok(v.errors.some(e => e.includes('"motor" is required')));
  assert.ok(v.errors.some(e => e.includes('no socket "turret"')));
});

test('over weight is rejected', () => {
  const heavy: BotBuild = { ...good, sockets: { weapon: 'vs_bar', front: 'front_plow', armor: 'armor_heavy', wheels: 'wheels_armored', motor: 'motor_fast', secondary: 'sec_flame' } };
  const v = validateBuild(heavy, catalog);
  assert.ok(v.errors.some(e => e.startsWith('Over weight')));
});

test('full-body spinner has no front/armor sockets', () => {
  const v = validateBuild({ bodyId: 'full_body_spinner', sockets: { weapon: 'fbs_shell', wheels: 'wheels_std', motor: 'motor_std' }, cosmetics: { name: 'S' } }, catalog);
  assert.deepEqual(v.errors, []);
});

test('damage: armor reduces, 0 HP disables by socket', () => {
  const s = createBotState(good, catalog);
  assert.equal(applyDamage(s, 'armor', 10), 4);          // 10 - 6 armor
  assert.equal(socketArmor(s.parts['armor']), 6);
  applyDamage(s, 'armor', 999);
  assert.equal(socketArmor(s.parts['armor']), 0);        // destroyed -> armor 0
  assert.ok(canAttack(s));
  applyDamage(s, 'weapon', 999);
  assert.ok(!canAttack(s));
  assert.ok(!isImmobilized(s));
  applyDamage(s, 'motor', 999);
  assert.ok(isImmobilized(s));
  assert.ok(!isDestroyed(s));
  applyDamage(s, 'wheels', 999);
  applyDamage(s, 'front', 999);
  assert.ok(isDestroyed(s));
});

test('flipper: one wheel set left still mobile', () => {
  const s = createBotState({ bodyId: 'flipper', sockets: { weapon: 'fl_pneumatic', front: null, armor: 'armor_light', wheels_1: 'wheels_light', wheels_2: 'wheels_light', motor: 'motor_std' }, cosmetics: { name: 'F' } }, catalog);
  applyDamage(s, 'wheels_1', 999);
  assert.ok(!isImmobilized(s));
  applyDamage(s, 'wheels_2', 999);
  assert.ok(isImmobilized(s));
});
