/**
 * Weapon activation model. One instance per bot.
 *
 *  spinner  (disc/bar/drum, h_bar/h_disc/undercutter, shell/cage)
 *           fire key TOGGLES the motor; spin level ramps up over ~2 s and coasts
 *           down when switched off. Damage scales with spin level (stored energy).
 *  strike   (hammer/saw/hammer_saw)  fire = one swing: short active window, then cooldown.
 *           v0.10 real arm: tap = swing (the arm returns on its own), hold = pin after the swing;
 *           the swing itself is physics (bot.ts driveArm), this class only reports it.
 *  flipper  (pneumatic/electric)     fire = one flip: short active window, then cooldown.
 *  hold     (lifter/grappler/crusher) weapon is live while the key is HELD.
 *
 * Contacts while power() == 0 are just bumps (no damage).
 */
import type { WeaponKind } from '../../src/core/types.js';

export type WeaponMode = 'spinner' | 'strike' | 'flipper' | 'hold' | 'none';
export type WeaponPhase = 'ready' | 'active' | 'recover';

export const TUNING = {
  spinUp: 2.2,                     // seconds from 0 → full spin
  spinDown: 1.4,                   // seconds from full → 0 when switched off
  minSpinToHit: 0.15,              // below this a spinner contact is only a bump
  strike:            { window: 0.30, cooldown: 1.10 },
  pneumatic_flipper: { window: 0.25, cooldown: 1.60 },
  electric_flipper:  { window: 0.45, cooldown: 0.90 },
  holdHitCooldownMs: 600,          // lifter/grappler/crusher re-hit interval
  hitCooldownMs: 350,              // everything else
};

export function modeFor(kind?: WeaponKind): WeaponMode {
  if (!kind) return 'none';
  if (['disc', 'bar', 'drum', 'h_bar', 'h_disc', 'undercutter', 'shell', 'cage'].includes(kind)) return 'spinner';
  if (['hammer', 'saw', 'hammer_saw'].includes(kind)) return 'strike';
  if (kind === 'pneumatic_flipper' || kind === 'electric_flipper') return 'flipper';
  return 'hold';
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

export class Weapon {
  mode: WeaponMode;
  // spinner
  spinning = false;
  spinLevel = 0;
  // strike / flipper
  phase: WeaponPhase = 'ready';
  t = 0;                            // seconds spent in the current phase
  // hold
  held = false;
  holdPose = 0;                     // smoothed 0..1 for the arm animation
  /** v0.6: true while the bot is upside down — spinner coasts down (stays switched ON),
   *  swings/flips/grips can't start. Cleared when the bot is back on its wheels. */
  suppressed = false;
  /** v0.8: the weapon is a real body (vertical spinners). spinLevel is then measured from physics
   *  every frame (main.ts) instead of ramped by a timer; damage comes from the energy it loses on a hit. */
  realSpin = false;
  /** v0.8: weapon motor destroyed -- the switch does nothing, the weapon only coasts. */
  motorDead = false;
  /** v0.10: the overhead arm is a real body (bot.ts driveArm). */
  realArm = false;
  /** v0.10: arm state mirrored from bot.arm for the HUD / AI. */
  armState: 'ready' | 'swing' | 'pin' | 'retract' = 'ready';
  /** v0.12: flipper / control weapon is a real hinged body (bot.ts driveFlipper / driveControl). */
  realHinge = false;
  /** v0.12 pneumatic flipper: shots of gas left (Infinity = electric). */
  gas = Infinity;
  /** v0.12 flipper: seconds until the buffer tank is refilled / the electric drive has rewound. */
  refill = 0;
  /** v0.12 flipper: power of the current shot (1, or less for a self-righting shot). */
  firePower = 1;
  /** v0.12 control: seconds the key has been held (grappler: fork lifts after the jaw closes). */
  holdT = 0;
  /** This frame: fire key held / newly pressed (for driveArm). */
  fireHeld = false;
  pressed = false;

  private prevFire = false;

  constructor(public kind?: WeaponKind) { this.mode = modeFor(kind); }

  cfg() {
    if (this.kind === 'pneumatic_flipper') return TUNING.pneumatic_flipper;
    if (this.kind === 'electric_flipper') return TUNING.electric_flipper;
    return TUNING.strike;
  }

  /** Call once per frame. `fire` is the raw key/AI state; `alive` = weapon part still has HP. */
  update(dt: number, fire: boolean, alive: boolean) {
    const pressed = fire && !this.prevFire;
    this.prevFire = fire;
    this.fireHeld = fire;
    this.pressed = pressed;
    if (!alive) { this.spinning = false; this.held = false; }

    switch (this.mode) {
      case 'spinner':
        if (pressed && alive) this.spinning = !this.spinning;
        if (this.realSpin) break;                                   // measured from the real body instead
        this.spinLevel = clamp01(this.spinLevel + dt / (this.spinning && !this.suppressed ? TUNING.spinUp : -TUNING.spinDown));
        break;
      case 'strike':
      case 'flipper': {
        if (this.realArm || this.realHinge) {                       // physics runs the swing / flip; mirror it
          this.phase = this.armState === 'ready' ? 'ready' : this.armState === 'retract' ? 'recover' : 'active';
          break;
        }
        const c = this.cfg();
        this.t += dt;
        if (this.phase === 'ready' && pressed && alive && !this.suppressed) { this.phase = 'active'; this.t = 0; }
        else if (this.phase === 'active' && this.t >= c.window) { this.phase = 'recover'; this.t = 0; }
        else if (this.phase === 'recover' && this.t >= c.cooldown) { this.phase = 'ready'; this.t = 0; }
        break;
      }
      case 'hold':
        this.held = fire && alive && !this.suppressed;
        this.holdPose += ((this.held ? 1 : 0) - this.holdPose) * Math.min(1, dt * 10);
        break;
    }
  }

  /** v0.6: a spinner that lands a hit dumps its stored energy — spin restarts from 0.
   *  The motor stays ON, so it ramps straight back up (no key press needed). */
  spinReset() { if (this.mode === 'spinner' && !this.realSpin) this.spinLevel = 0; }

  /** 0 = this contact is only a bump; otherwise a multiplier on the weapon's damage stat. */
  power(): number {
    switch (this.mode) {
      case 'spinner': return this.spinLevel < TUNING.minSpinToHit ? 0 : Math.pow(this.spinLevel, 1.3);
      case 'strike':
      case 'flipper': return this.phase === 'active' ? 1 : 0;
      case 'hold': return this.held ? 1 : 0;
      default: return 0;
    }
  }

  /** Animation pose 0..1 (0 = rest, 1 = fully swung / lifted). */
  pose(): number {
    if (this.mode === 'hold') return this.holdPose;
    if (this.mode !== 'strike' && this.mode !== 'flipper') return 0;
    const c = this.cfg();
    if (this.phase === 'active') return Math.min(1, this.t / c.window);
    if (this.phase === 'recover') return 1 - Math.min(1, this.t / (c.cooldown * 0.6));
    return 0;
  }

  hitCooldownMs() { return this.mode === 'hold' ? TUNING.holdHitCooldownMs : TUNING.hitCooldownMs; }

  /** For the HUD. */
  status(alive: boolean): { label: string; pct: number; cls: string } {
    if (this.mode === 'none') return { label: 'no weapon', pct: 0, cls: 'off' };
    if (!alive) return { label: 'DESTROYED', pct: 0, cls: 'dead' };
    if (this.suppressed) return { label: 'UPSIDE DOWN', pct: Math.round(this.spinLevel * 100), cls: 'off' };
    switch (this.mode) {
      case 'spinner': {
        const pct = Math.round(this.spinLevel * 100);
        if (this.motorDead) return { label: `SPIN ${pct}% W-MOTOR DEAD`, pct, cls: 'dead' };
        const lbl = this.spinning && pct < 100 ? 'SPINNING UP' : this.spinning ? 'ON' : 'off';
        return { label: `SPIN ${pct}% ${lbl}`, pct, cls: this.spinning ? 'on' : 'off' };
      }
      case 'strike':
      case 'flipper': {
        if (this.realHinge) {                                       // v0.12 real flipper
          const gas = Number.isFinite(this.gas) ? ` · GAS ${Math.floor(this.gas)}` : '';
          if (this.motorDead) return { label: 'ACTUATOR DEAD', pct: 0, cls: 'dead' };
          if (this.armState === 'swing') return { label: 'FIRE!' + gas, pct: 100, cls: 'hit' };
          if (this.gas < 1) return { label: 'OUT OF GAS', pct: 0, cls: 'dead' };
          if (this.refill > 0 || this.armState === 'retract') return { label: 'REFILL' + gas, pct: 50, cls: 'off' };
          return { label: 'READY' + gas, pct: 100, cls: 'on' };
        }
        if (this.realArm) {
          if (this.motorDead) return { label: 'W-MOTOR DEAD', pct: 0, cls: 'dead' };
          if (this.armState === 'swing') return { label: 'SWING!', pct: 100, cls: 'hit' };
          if (this.armState === 'pin') return { label: 'PIN', pct: 100, cls: 'on' };
          if (this.armState === 'retract') return { label: 'RETRACT', pct: 50, cls: 'off' };
          return { label: 'READY', pct: 100, cls: 'on' };
        }
        if (this.phase === 'ready') return { label: 'READY', pct: 100, cls: 'on' };
        if (this.phase === 'active') return { label: this.mode === 'strike' ? 'SWING!' : 'FIRE!', pct: 100, cls: 'hit' };
        return { label: 'RELOAD', pct: Math.round((this.t / this.cfg().cooldown) * 100), cls: 'off' };
      }
      case 'hold': {
        if (this.motorDead) return { label: 'ACTUATOR DEAD', pct: 0, cls: 'dead' };
        const verb = this.kind === 'crusher' ? 'CRUSH' : this.kind === 'grappler' ? 'CLAMP' : 'LIFT';
        return this.held ? { label: verb, pct: 100, cls: 'on' } : { label: 'arm (hold key)', pct: 0, cls: 'off' };
      }
    }
  }

  /** One-line control hint for the player. */
  hint(key: string): string {
    switch (this.mode) {
      case 'spinner': return this.realSpin
        ? `${key}: spinner ON/OFF (≈ 3 s to top speed; damage = energy the weapon dumps into the hit)`
        : `${key}: spinner ON/OFF (spin-up ≈ 2 s; hits do more damage at full spin)`;
      case 'strike': return this.realArm
        ? `${key}: tap = swing (returns on its own) · hold = pin them down · damage = energy the arm dumps into the hit${this.kind !== 'hammer' ? ' · saw spins on its own' : ''}`
        : `${key}: swing (face the target, get close)`;
      case 'flipper': return this.realHinge
        ? `${key}: fire the flipper when they're on it${Number.isFinite(this.gas) ? ` · ${this.gas} shots of gas` : ' · electric: unlimited, weaker'} · upside down: ${key} flips you back over`
        : `${key}: fire flipper (face the target, get under them)`;
      case 'hold': return this.kind === 'crusher'
        ? `hold ${key}: beak crushes down (pierces armor while it presses) · drive them onto the lower jaw`
        : this.kind === 'grappler'
        ? `hold ${key}: clamp them, then the fork lifts · lifted bots lose their grip — carry them`
        : `hold ${key}: fork lifts them (their wheels leave the floor) · push them around`;
      default: return 'no weapon — ram only (no damage)';
    }
  }
}
