/**
 * Weapon activation model. One instance per bot.
 *
 *  Every weapon is a real physics body (bot.ts); this class only holds the key state and mirrors what
 *  the physics is doing, for the HUD and the AI. (v0.20: the old timer-driven spin-up / swing / flip
 *  windows and the spin reset were removed -- they only served the stand-in weapons.)
 *
 *  spinner  (disc/bar/drum, h_bar/h_disc/undercutter, shell/cage)
 *           fire key TOGGLES the motor; spinLevel is measured from the real body every frame (main.ts).
 *  strike   (hammer/saw/hammer_saw)  tap = swing (the arm returns on its own), hold = pin after the swing.
 *  flipper  (pneumatic/electric)     fire = one flip.
 *  hold     (lifter/grappler/crusher) weapon is live while the key is HELD.
 *
 * power() > 0 = the weapon is live right now (the AI uses it to keep clear).
 */
import type { WeaponKind } from '../../src/core/types.js';

export type WeaponMode = 'spinner' | 'strike' | 'flipper' | 'hold' | 'none';
export type WeaponPhase = 'ready' | 'active' | 'recover';

export const TUNING = {
  minSpinToHit: 0.15,              // below this spin level a spinner counts as not live (AI)
};

export function modeFor(kind?: WeaponKind): WeaponMode {
  if (!kind) return 'none';
  if (['disc', 'bar', 'drum', 'h_bar', 'h_disc', 'undercutter', 'shell', 'cage'].includes(kind)) return 'spinner';
  if (['hammer', 'saw', 'hammer_saw'].includes(kind)) return 'strike';
  if (kind === 'pneumatic_flipper' || kind === 'electric_flipper') return 'flipper';
  return 'hold';
}

export class Weapon {
  mode: WeaponMode;
  // spinner
  spinning = false;
  spinLevel = 0;
  // strike / flipper (mirrored from the real arm / hinge)
  phase: WeaponPhase = 'ready';
  // hold
  held = false;
  /** v0.6: true while the bot is upside down — spinner coasts down (stays switched ON),
   *  swings/flips/grips can't start. Cleared when the bot is back on its wheels. */
  suppressed = false;
  /** v0.8: the weapon is a real spinner body; spinLevel is measured from physics every frame (main.ts). */
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

  /** Call once per frame. `fire` is the raw key/AI state; `alive` = weapon part still has HP. */
  update(dt: number, fire: boolean, alive: boolean) {
    const pressed = fire && !this.prevFire;
    this.prevFire = fire;
    this.fireHeld = fire;
    this.pressed = pressed;
    if (!alive) { this.spinning = false; this.held = false; }

    switch (this.mode) {
      case 'spinner':
        if (pressed && alive) this.spinning = !this.spinning;      // spinLevel is measured from the real body
        break;
      case 'strike':
      case 'flipper':                                               // physics runs the swing / flip; mirror it
        this.phase = this.armState === 'ready' ? 'ready' : this.armState === 'retract' ? 'recover' : 'active';
        break;
      case 'hold':
        this.held = fire && alive && !this.suppressed;
        break;
    }
  }

  /** 0 = the weapon isn't live right now (used by the AI). */
  power(): number {
    switch (this.mode) {
      case 'spinner': return this.spinLevel < TUNING.minSpinToHit ? 0 : Math.pow(this.spinLevel, 1.3);
      case 'strike':
      case 'flipper': return this.phase === 'active' ? 1 : 0;
      case 'hold': return this.held ? 1 : 0;
      default: return 0;
    }
  }

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
        return { label: 'READY', pct: 100, cls: 'on' };
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
      case 'spinner': return `${key}: spinner ON / OFF (about 3 s to full speed)`;
      case 'strike': return `${key}: tap = swing · hold = pin them down${this.kind !== 'hammer' ? ' · the saw spins on its own' : ''}`;
      case 'flipper': return `${key}: fire the flipper when they're on it${Number.isFinite(this.gas) ? ` · ${this.gas} shots of gas` : ' · electric: unlimited, weaker'} · upside down: ${key} flips you back over`;
      case 'hold': return this.kind === 'crusher'
        ? `hold ${key}: beak crushes down (pierces armor while it presses) · drive them onto the lower jaw`
        : this.kind === 'grappler'
        ? `hold ${key}: clamp them, then the fork lifts · lifted bots lose their grip — carry them`
        : `hold ${key}: fork lifts them (their wheels leave the floor) · push them around`;
      default: return 'no weapon — ram only (no damage)';
    }
  }
}
