# BattleBots — core

Engine-agnostic bot-building system (TypeScript + JSON parts). No rendering, no physics.

## Layout
- `data/bodies.json` — the 6 bodies: sockets + allowed weapon kinds (hard compatibility).
- `data/parts/*.json` — parts with raw stats (hp / armor / damage / speed). Weight is derived.
- `data/balance.json` — base weight per part type + stat coefficients.
- `src/core/types.ts` — data model.
- `src/core/weight.ts` — `weight = base(type) + Σ(stat × coef)`.
- `src/core/validate.ts` — `validateBuild()` (same rules on client and server).
- `src/core/state.ts` — runtime per-part HP, `applyDamage()`, `canAttack / isImmobilized / isDestroyed`.
- `src/core/catalog.ts` — loads the JSON (Node). Browser calls `buildCatalog()` with fetched JSON.
- `src/test/core.test.ts`, `src/examples/demo.ts`.

## Run
```
npm install
npm test
npm run demo
```

## Design source
Project doc: `design/battlebots-design-summary.md`.
