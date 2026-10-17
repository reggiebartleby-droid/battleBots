/**
 * v0.30 shared tester defaults. Every saved setting lives in the player's own browser; the built-in defaults
 * (each module's fallback values) are the user's own settings as of 2026-10-17:
 *   lab: NOISY CRICKET vs Hammer Time, AI Normal, breakable weapons off, drive boost x3
 *   look: Cube Bots, Pixel Glow, 8-bit cubes · camera: CHASE, zoom 0.65 · HUD: top strip, details off
 *   arena: cyan, 16 x 16 · Shell Shock aids: nose cap on, floor arrow off
 * When SETTINGS_VERSION changes, every saved setting is cleared once, so returning players get the new defaults too.
 * main.ts imports this module FIRST, so the reset runs before any module reads its saved settings.
 */
export const SETTINGS_VERSION = '0.30';
const VERSION_KEY = 'bb.settings.version';
const SAVED_KEYS = ['battlebots.builder.v1', 'bb.camera.v1', 'bb.cubes.v1', 'bb.shellAids.v1', 'bb-hud-view', 'bb-hud-details', 'bb-arena-style'];

try {
  if (localStorage.getItem(VERSION_KEY) !== SETTINGS_VERSION) {
    for (const k of SAVED_KEYS) localStorage.removeItem(k);
    localStorage.setItem(VERSION_KEY, SETTINGS_VERSION);
  }
} catch { /* no storage: the defaults apply anyway */ }
