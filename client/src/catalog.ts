import { buildCatalog } from '../../src/core/build-catalog.js';
import type { BalanceConfig, BodyDef, PartDef } from '../../src/core/types.js';
import bodies from '../../data/bodies.json';
import balance from '../../data/balance.json';
import weapons from '../../data/parts/weapons.json';
import fronts from '../../data/parts/fronts.json';
import armor from '../../data/parts/armor.json';
import drivetrain from '../../data/parts/drivetrain.json';
import secondary from '../../data/parts/secondary.json';
import weaponMotors from '../../data/parts/weapon_motors.json';

export const catalog = buildCatalog(
  bodies as BodyDef[],
  [...weapons, ...fronts, ...armor, ...drivetrain, ...secondary, ...weaponMotors] as PartDef[],
  balance as BalanceConfig,
);
