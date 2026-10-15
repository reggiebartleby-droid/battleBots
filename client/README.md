# BattleBots — client prototype (Babylon.js + Havok)

Local 2-player prototype. Imports the engine-agnostic core from `../src/core` and the part JSON from `../data`.

## Run
```
cd client
npm install
npm run dev
```
Open the URL Vite prints. P1: WASD. P2: Arrows. R: restart. Mouse drag: camera.

## Files
- `src/main.ts` — scene, physics init, camera, game loop, win conditions. Demo builds `BUILD_A` / `BUILD_B` at the top.
- `src/arena.ts` — BattleBox (floor, lexan walls, killsaw strips, pulverizers). Placeholder primitives.
- `src/bot.ts` — assembles a bot from a `BotBuild`: one Havok rigid body + child meshes per part.
- `src/combat.ts` — collision → `applyDamage()`. Weapon-driven targeting by hit angle (front/side/rear).
- `src/hud.ts` — per-part HP scoreboard, timer, FINISH HIM/HER!, winner banner.
- `src/input.ts` — keyboard.
- `src/catalog.ts` — bundles `../data/*.json` into a Catalog.

## Known placeholders
- One rigid body per bot; weapons spin visually only. Spinner "stored energy" is a flat damage bonus.
- Wall/floor hits do no damage. Killsaws and pulverizers are visual only.
- Damage numbers are untuned.
