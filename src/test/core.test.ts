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
  sockets: { weapon: 'vs_disc', weapon_motor: 'wm_std', front: 'front_wedgelet', armor: 'armor_light', wheels: 'wheels_std', motor: 'motor_std', secondary: null },
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
  const heavy: BotBuild = { ...good, sockets: { weapon: 'vs_bar', weapon_motor: 'wm_std', front: 'front_plow', armor: 'armor_heavy', wheels: 'wheels_armored', motor: 'motor_fast', secondary: 'sec_flame' } };
  const v = validateBuild(heavy, catalog);
  assert.ok(v.errors.some(e => e.startsWith('Over weight')));
});

test('full-body spinner has no front/armor sockets', () => {
  const v = validateBuild({ bodyId: 'full_body_spinner', sockets: { weapon: 'fbs_shell', weapon_motor: 'wm_std', wheels: 'wheels_std', motor: 'motor_std' }, cosmetics: { name: 'S' } }, catalog);
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
  assert.ok(!isDestroyed(s));                            // weapon motor still alive
  applyDamage(s, 'weapon_motor', 999);
  assert.ok(isDestroyed(s));
});

test('flipper: one wheel set left still mobile', () => {
  const s = createBotState({ bodyId: 'flipper', sockets: { weapon: 'fl_pneumatic', weapon_motor: 'wm_std', front: null, armor: 'armor_light', wheels_1: 'wheels_light', wheels_2: 'wheels_light', motor: 'motor_std' }, cosmetics: { name: 'F' } }, catalog);
  applyDamage(s, 'wheels_1', 999);
  assert.ok(!isImmobilized(s));
  applyDamage(s, 'wheels_2', 999);
  assert.ok(isImmobilized(s));
});

test('horizontal spinner (v0.9): needs a weapon motor, Noisy Cricket fits 275', () => {
  const cricket: BotBuild = { bodyId: 'horizontal_spinner', sockets: { weapon: 'hs_bar', weapon_motor: 'wm_std', front: null, armor: 'armor_medium', wheels: 'wheels_std', motor: 'motor_std', secondary: null }, cosmetics: { name: 'NC' } };
  const v = validateBuild(cricket, catalog);
  assert.deepEqual(v.errors, []);
  assert.equal(v.weightLimit, 275);
  // hs_bar 144 + wm_std 22 + armor_medium 37 + wheels_std 30 + motor_std 37 = 270
  assert.equal(v.totalWeight, 270);
  const { weapon_motor, ...rest } = cricket.sockets;
  assert.ok(validateBuild({ ...cricket, sockets: rest }, catalog).errors.some(e => e.includes('"weapon_motor" is required')));
});

test('overhead (v0.10): needs a weapon motor, Hammer Time fits 275', () => {
  const ht: BotBuild = { bodyId: 'overhead', sockets: { weapon: 'oh_hammer', weapon_motor: 'wm_std', front: null, armor_1: 'armor_medium', armor_2: 'armor_light', wheels: 'wheels_std', motor: 'motor_std' }, cosmetics: { name: 'HT' } };
  const v = validateBuild(ht, catalog);
  assert.deepEqual(v.errors, []);
  assert.equal(v.weightLimit, 275);
  // oh_hammer 115 + wm_std 22 + armor_medium 37 + armor_light 25 + wheels_std 30 + motor_std 37 = 266
  assert.equal(v.totalWeight, 266);
  const { weapon_motor, ...rest } = ht.sockets;
  assert.ok(validateBuild({ ...ht, sockets: rest }, catalog).errors.some(e => e.includes('"weapon_motor" is required')));
});

test('vertical spinner needs a weapon motor; weapon motors only fit that socket', () => {
  const { weapon_motor, ...rest } = good.sockets;
  const v = validateBuild({ ...good, sockets: rest }, catalog);
  assert.ok(v.errors.some(e => e.includes('"weapon_motor" is required')));
  const v2 = validateBuild({ ...good, sockets: { ...good.sockets, motor: 'wm_std' } }, catalog);
  assert.ok(v2.errors.some(e => e.includes("can't go in motor socket")));
  // wm_std: 8 + 14*1.0 = 22
  assert.equal(partWeight(catalog.parts['wm_std'], catalog.balance), 22);
});

test('v0.12: flipper, control and full-body spinner need a weapon motor; presets fit 275', () => {
  const builds: BotBuild[] = [
    // Flip Side: fl_pneumatic 88 + wm_std 22 + front_wedge 35 + armor_light 25 + wheels_std 30 x2 + motor_std 37 = 267
    { bodyId: 'flipper', sockets: { weapon: 'fl_pneumatic', weapon_motor: 'wm_std', front: 'front_wedge', armor: 'armor_light', wheels_1: 'wheels_std', wheels_2: 'wheels_std', motor: 'motor_std' }, cosmetics: { name: 'FS' } },
    // Blue Lift: ct_lifter 74 (v0.13 armored fork) + 22 + 35 + armor_medium 37 x2 + 30 + motor_fast 40 = 275
    { bodyId: 'control', sockets: { weapon: 'ct_lifter', weapon_motor: 'wm_std', front: 'front_wedge', armor_1: 'armor_medium', armor_2: 'armor_medium', wheels: 'wheels_std', motor: 'motor_fast', secondary: null }, cosmetics: { name: 'BL' } },
    // Shell Shock: fbs_shell 170 + 22 + 30 + 37 = 259
    { bodyId: 'full_body_spinner', sockets: { weapon: 'fbs_shell', weapon_motor: 'wm_std', wheels: 'wheels_std', motor: 'motor_std' }, cosmetics: { name: 'SS' } },
  ];
  const totals = [267, 275, 259];
  builds.forEach((b, i) => {
    const v = validateBuild(b, catalog);
    assert.deepEqual(v.errors, []);
    assert.equal(v.weightLimit, 275);
    assert.equal(v.totalWeight, totals[i]);
    const { weapon_motor, ...rest } = b.sockets;
    assert.ok(validateBuild({ ...b, sockets: rest }, catalog).errors.some(e => e.includes('"weapon_motor" is required')));
  });
});
