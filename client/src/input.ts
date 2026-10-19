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

/** v0.43 race (user: controller support): RT = gas, LT = brake / reverse, left stick steers (stick up still = gas),
 *  weapon on A only (RT is the gas). Arena / course / lab keep the v0.21 mapping (A or RT = weapon). */
export function readDrive(player: 'A' | 'B', race = false): Drive {
  const k = KEYS[player];
  let throttle = (keys.has(k.up) ? 1 : 0) - (keys.has(k.down) ? 1 : 0);
  let turn = (keys.has(k.right) ? 1 : 0) - (keys.has(k.left) ? 1 : 0);
  let fire: boolean = k.fire.some(c => keys.has(c));
  const g = pad(player === 'A' ? 0 : 1);
  if (g) {
    throttle = bigger(throttle, -dz(g.axes[1] ?? 0));   // stick up = negative axis
    turn = bigger(turn, dz(g.axes[0] ?? 0));
    if (race) {
      const trig = (i: number) => { const b = g.buttons[i]; return b ? Math.max(b.value, b.pressed ? 1 : 0) : 0; };
      const pedal = trig(7) - trig(6);                   // RT gas, LT brake / reverse
      if (Math.abs(pedal) > 0.08) throttle = bigger(throttle, pedal);
      fire = fire || !!g.buttons[0]?.pressed;
    } else fire = fire || !!g.buttons[0]?.pressed || (g.buttons[7]?.value ?? 0) > 0.5;
  }
  if (player === 'A') {                                   // v0.32 phone joystick + FIRE (a quick tap still counts for one frame)
    throttle = bigger(throttle, TOUCH.throttle);
    turn = bigger(turn, TOUCH.turn);
    fire = fire || TOUCH.fireHeld || TOUCH.fireLatch;
    TOUCH.fireLatch = false;
  }
  return { throttle, turn, fire };
}

/** v0.43 controller 1 connected? (browsers only report a pad after one of its buttons is pressed on the page) */
export function padConnected(): boolean { return !!pad(0); }

/** v0.43 controller 1 button presses (standard mapping: 0 A, 3 Y, 4 LB, 5 RB, 8 Back/View, 9 Start, 14/15 D-pad left/right).
 *  One call per new press; polled every animation frame. onPadChange fires when a controller connects / disconnects. */
const padHandlers: ((btn: number) => void)[] = [];
const padChange: ((on: boolean) => void)[] = [];
export function onPadButton(fn: (btn: number) => void) { padHandlers.push(fn); }
export function onPadChange(fn: (on: boolean) => void) { padChange.push(fn); if (padOn) fn(true); }   // already connected: tell it now
let padWas: boolean[] = [], padOn = false;
function pollPad() {
  const g = pad(0);
  if (!!g !== padOn) { padOn = !!g; padWas = []; for (const f of padChange) f(padOn); }
  if (g) {
    const now = g.buttons.map(b => b.pressed);
    now.forEach((p, i) => { if (p && !padWas[i]) for (const f of padHandlers) f(i); });
    padWas = now;
  }
  requestAnimationFrame(pollPad);
}
requestAnimationFrame(pollPad);

/** v0.43 press a keyboard key from the controller (the game's own key handlers do the rest). */
export function pressKey(code: string) {
  window.dispatchEvent(new KeyboardEvent('keydown', { code }));
  window.dispatchEvent(new KeyboardEvent('keyup', { code }));
}
