import { TOUCH, VKEYS } from './mobile.js';

export interface Drive { throttle: number; turn: number; fire: boolean }

export const KEYS = {
  A: { up: 'KeyW', down: 'KeyS', left: 'KeyA', right: 'KeyD', fire: ['Space'], label: 'WASD + SPACE (or gamepad 1)' },
  B: { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', fire: ['ShiftRight', 'Enter'], label: 'Arrows + Right SHIFT (or gamepad 2)' },
} as const;

const keys = new Set<string>();
window.addEventListener('keydown', e => {
  keys.add(e.code);
  if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
});
window.addEventListener('keyup', e => keys.delete(e.code));
window.addEventListener('blur', () => keys.clear());

export function isDown(code: string) { return keys.has(code) || VKEYS.has(code); }   // v0.32: + phone buttons

/** v0.21 gamepads (browser Gamepad API, standard mapping): P1 = first connected pad, P2 = second.
 *  Left stick = one-stick drive like a real transmitter (partial throttle / turn); A / Cross or the right
 *  trigger = fire. The keyboard still works: whichever input is bigger wins. Browsers only report a pad
 *  after one of its buttons has been pressed on the page. */
const DEADZONE = 0.12;
function pad(n: number): Gamepad | null {
  try { return [...(navigator.getGamepads?.() ?? [])].filter((g): g is Gamepad => !!g && g.connected)[n] ?? null; }
  catch { return null; }
}
function dz(v: number) { return Math.abs(v) < DEADZONE ? 0 : (v - Math.sign(v) * DEADZONE) / (1 - DEADZONE); }
const bigger = (a: number, b: number) => (Math.abs(b) > Math.abs(a) ? b : a);

export function readDrive(player: 'A' | 'B'): Drive {
  const k = KEYS[player];
  let throttle = (keys.has(k.up) ? 1 : 0) - (keys.has(k.down) ? 1 : 0);
  let turn = (keys.has(k.right) ? 1 : 0) - (keys.has(k.left) ? 1 : 0);
  let fire: boolean = k.fire.some(c => keys.has(c));
  const g = pad(player === 'A' ? 0 : 1);
  if (g) {
    throttle = bigger(throttle, -dz(g.axes[1] ?? 0));   // stick up = negative axis
    turn = bigger(turn, dz(g.axes[0] ?? 0));
    fire = fire || !!g.buttons[0]?.pressed || (g.buttons[7]?.value ?? 0) > 0.5;
  }
  if (player === 'A') {                                   // v0.32 phone joystick + FIRE (a quick tap still counts for one frame)
    throttle = bigger(throttle, TOUCH.throttle);
    turn = bigger(turn, TOUCH.turn);
    fire = fire || TOUCH.fireHeld || TOUCH.fireLatch;
    TOUCH.fireLatch = false;
  }
  return { throttle, turn, fire };
}
