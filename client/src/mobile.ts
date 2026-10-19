/**
 * v0.39 (user): phones get the race only (no arena, no menu) -- same as the desktop tester version: track + car pickers
 * on the start card and the results. Race controls: auto-gas, a left-right STEER slider (left thumb), FIRE + BRAKE
 * (right thumb; BRAKE held = slow down, then reverse).
 *
 * v0.41 (user: phone mode too hard): ◀ ▶ steer buttons (left / right thumb) replace the slider, no FIRE button (the weapon
 * auto-fires when a bot is close in front), BRAKE stays; drive boost + race speed x2 (desktop x3); camera further out.
 *
 * v0.32 quick-and-dirty phone / tablet mode (user: not meant for phones, but "somewhat playable" there).
 * On when the browser says it's a phone or tablet. ?mobile=1 forces it on (test on the PC), ?desktop=1 forces it off.
 *  - Lab: a simple menu (your bot, opponent, AI level, FIGHT) -- no part editing; no test course.
 *  - Match: on-screen joystick (left, one-stick drive like the gamepad) + FIRE (right) + CAM / RESTART / MENU.
 *  - Landscape only (a "rotate your phone" card when upright).
 *  - Performance: lower render resolution, no shadows, lighter glow, big cubes.
 */
import type { BotBuild } from '../../src/core/types.js';
import type { Difficulty } from './ai.js';

function detect(): boolean {
  const q = new URLSearchParams(location.search);
  if (q.get('desktop') === '1') return false;
  if (q.get('mobile') === '1') return true;
  const ua = navigator.userAgent;
  if (/Android|iPhone|iPad|iPod|Mobile|Silk|Kindle/i.test(ua)) return true;
  return /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;   // iPadOS reports itself as a Mac
}
export const MOBILE = detect();
if (MOBILE) document.body.classList.add('mobile');
/** v0.39 full screen on a phone (needs a tap; iPhones don't support it -- ignored there). */
export function goFullscreen() {
  if (!MOBILE) return;
  try { if (!document.fullscreenElement) void document.documentElement.requestFullscreen?.().catch(() => {}); } catch { /* not supported */ }
}

/** Touch drive state, read by input.ts (merged with keyboard / gamepad like the gamepad is). */
export const TOUCH = { throttle: 0, turn: 0, fireHeld: false, fireLatch: false, brake: false };   // v0.39 brake (race)

/** Short virtual key presses for the RESTART / MENU buttons (input.ts isDown sees them). */
export const VKEYS = new Set<string>();
export function tapKey(code: string, ms = 160) { VKEYS.add(code); setTimeout(() => VKEYS.delete(code), ms); }

const STICK_R = 60;      // px the knob can travel from the centre
const STEER_R = 95;      // v0.39 race: px the knob can travel sideways on the STEER slider
const DEADZONE = 0.12;

/** Joystick + FIRE + small buttons. onCam cycles the camera. */
export function setupTouchControls(onCam: () => void) {
  if (!MOBILE) return;
  const zone = document.getElementById('m-stick')!;
  const knob = document.getElementById('m-knob')!;
  let id: number | null = null;
  const move = (e: PointerEvent) => {
    const r = zone.getBoundingClientRect();
    let dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
    const dz = (v: number) => Math.abs(v) < DEADZONE ? 0 : (v - Math.sign(v) * DEADZONE) / (1 - DEADZONE);
    if (document.body.classList.contains('inrace')) {   // v0.39 race: steer only (auto-gas), left-right slider
      dx = Math.max(-STEER_R, Math.min(STEER_R, dx));
      knob.style.transform = `translate(${dx}px, 0px)`;
      TOUCH.throttle = 0;
      TOUCH.turn = dz(dx / STEER_R);
      return;
    }
    const len = Math.hypot(dx, dy);
    if (len > STICK_R) { dx *= STICK_R / len; dy *= STICK_R / len; }
    knob.style.transform = `translate(${dx}px, ${dy}px)`;
    TOUCH.throttle = dz(-dy / STICK_R);
    TOUCH.turn = dz(dx / STICK_R);
  };
  const release = (e: PointerEvent) => {
    if (e.pointerId !== id) return;
    id = null; TOUCH.throttle = 0; TOUCH.turn = 0; knob.style.transform = '';
  };
  zone.addEventListener('pointerdown', e => { e.preventDefault(); id = e.pointerId; try { zone.setPointerCapture(id); } catch { /* ok */ } move(e); });
  zone.addEventListener('pointermove', e => { if (e.pointerId === id) move(e); });
  zone.addEventListener('pointerup', release);
  zone.addEventListener('pointercancel', release);

  const fire = document.getElementById('m-fire')!;
  fire.addEventListener('pointerdown', e => { e.preventDefault(); try { fire.setPointerCapture(e.pointerId); } catch { /* ok */ } TOUCH.fireHeld = true; TOUCH.fireLatch = true; fire.classList.add('down'); });
  for (const ev of ['pointerup', 'pointercancel']) fire.addEventListener(ev, () => { TOUCH.fireHeld = false; fire.classList.remove('down'); });
  // v0.39 race: BRAKE (held = brake, then reverse)
  const brake = document.getElementById('m-brake')!;
  brake.addEventListener('pointerdown', e => { e.preventDefault(); try { brake.setPointerCapture(e.pointerId); } catch { /* ok */ } TOUCH.brake = true; brake.classList.add('down'); });
  for (const ev of ['pointerup', 'pointercancel']) brake.addEventListener(ev, () => { TOUCH.brake = false; brake.classList.remove('down'); });

  // v0.41 race (user): ◀ ▶ steer buttons replace the STEER slider (and the FIRE button: the weapon auto-fires, main.ts)
  const steer = { left: false, right: false };
  for (const [id, side] of [['m-left', 'left'], ['m-right', 'right']] as const) {
    const b = document.getElementById(id)!;
    const set = (on: boolean) => { steer[side] = on; b.classList.toggle('down', on); TOUCH.turn = (steer.right ? 1 : 0) - (steer.left ? 1 : 0); };
    b.addEventListener('pointerdown', e => { e.preventDefault(); try { b.setPointerCapture(e.pointerId); } catch { /* ok */ } set(true); });
    for (const ev of ['pointerup', 'pointercancel']) b.addEventListener(ev, () => set(false));
  }

  document.getElementById('m-cam')!.addEventListener('click', onCam);
  document.getElementById('m-restart')!.addEventListener('click', () => tapKey('KeyR'));
  document.getElementById('m-menu')!.addEventListener('click', () => tapKey('KeyB'));
  // no long-press menus / text selection on the controls
  document.getElementById('m-controls')!.addEventListener('contextmenu', e => e.preventDefault());
}

const MENU_KEY = 'bb.mobile.v1';
export interface MobilePick { player: BotBuild; opponent: BotBuild; difficulty: Difficulty }

/** The phone "lab": pick a preset bot, an opponent and the AI level, then FIGHT. */
export class MobileMenu {
  private el = {
    box: document.getElementById('mmenu')!,
    bot: document.getElementById('mm-bot') as HTMLSelectElement,
    opp: document.getElementById('mm-opp') as HTMLSelectElement,
    diff: document.getElementById('mm-diff') as HTMLSelectElement,
    fight: document.getElementById('mm-fight') as HTMLButtonElement,
  };
  private onPreview: (b: BotBuild) => void = () => {};
  private onFight: (p: MobilePick) => void = () => {};

  constructor(private presets: Record<string, BotBuild>, defaults: { player: string; opponent: string }) {
    const names = Object.keys(presets);
    for (const n of names) { this.el.bot.add(new Option(n, n)); this.el.opp.add(new Option(n, n)); }
    let saved: { bot?: string; opp?: string; diff?: Difficulty } = {};
    try { saved = JSON.parse(localStorage.getItem(MENU_KEY) ?? '{}'); } catch { /* defaults */ }
    this.el.bot.value = saved.bot && presets[saved.bot] ? saved.bot : defaults.player;
    this.el.opp.value = saved.opp && presets[saved.opp] ? saved.opp : defaults.opponent;
    this.el.diff.value = saved.diff ?? 'normal';
    this.el.bot.onchange = () => { this.save(); this.onPreview(this.pick(this.el.bot.value)); };
    this.el.opp.onchange = this.el.diff.onchange = () => this.save();
    this.el.fight.onclick = () => {
      this.save();
      try { if (!document.fullscreenElement) void document.documentElement.requestFullscreen?.().catch(() => {}); } catch { /* not supported (iPhone) */ }
      this.hide();
      this.onFight({ player: this.pick(this.el.bot.value), opponent: this.pick(this.el.opp.value), difficulty: this.el.diff.value as Difficulty });
    };
  }

  get visible() { return this.el.box.classList.contains('on'); }
  show(onPreview: (b: BotBuild) => void, onFight: (p: MobilePick) => void) {
    this.onPreview = onPreview; this.onFight = onFight;
    this.el.box.classList.add('on');
    document.body.classList.add('inlab');
    onPreview(this.pick(this.el.bot.value));
  }
  hide() { this.el.box.classList.remove('on'); document.body.classList.remove('inlab'); }

  private pick(name: string): BotBuild { return JSON.parse(JSON.stringify(this.presets[name])); }
  private save() { try { localStorage.setItem(MENU_KEY, JSON.stringify({ bot: this.el.bot.value, opp: this.el.opp.value, diff: this.el.diff.value })); } catch { /* no storage */ } }
}
