/**
 * Bot builder panels (HTML, Option A): left assembly rack (chassis + sockets),
 * right parts bin for the selected socket, telemetry readout, deploy bar.
 * Emits the build on every change so the lab preview can rebuild it.
 */
import type { BodyDef, BodyId, BotBuild, Catalog, PartDef, SocketDef, WeaponKind } from '../../src/core/types.js';
import { validateBuild } from '../../src/core/validate.js';
import { partWeight } from '../../src/core/weight.js';
import { DIFFICULTY, type Difficulty } from './ai.js';

const STORAGE_KEY = 'battlebots.builder.v1';

export const PRESETS: Record<string, BotBuild> = {
  'Red Disc': {
    bodyId: 'vertical_spinner',
    sockets: { weapon: 'vs_disc', weapon_motor: 'wm_std', front: 'front_wedgelet', armor: 'armor_light', wheels: 'wheels_std', motor: 'motor_std', secondary: null },
    cosmetics: { name: 'RED DISC', paint: '#e63946' },
  },
  'Blue Lift': {
    bodyId: 'control',
    sockets: { weapon: 'ct_lifter', weapon_motor: 'wm_std', front: 'front_wedge', armor_1: 'armor_medium', armor_2: 'armor_medium', wheels: 'wheels_std', motor: 'motor_fast', secondary: null },
    cosmetics: { name: 'BLUE LIFT', paint: '#1d7cf2' },
  },
  'Hammer Time': {
    bodyId: 'overhead',
    sockets: { weapon: 'oh_hammer', weapon_motor: 'wm_std', front: null, armor_1: 'armor_medium', armor_2: 'armor_light', wheels: 'wheels_std', motor: 'motor_std' },
    cosmetics: { name: 'HAMMER TIME', paint: '#f4a261' },
  },
  'Shell Shock': {
    bodyId: 'full_body_spinner',
    sockets: { weapon: 'fbs_shell', weapon_motor: 'wm_std', wheels: 'wheels_std', motor: 'motor_std' },
    cosmetics: { name: 'SHELL SHOCK', paint: '#2a9d8f' },
  },
  'Noisy Cricket': {
    bodyId: 'horizontal_spinner',
    sockets: { weapon: 'hs_bar', weapon_motor: 'wm_std', front: null, armor: 'armor_medium', wheels: 'wheels_std', motor: 'motor_std', secondary: null },
    cosmetics: { name: 'NOISY CRICKET', paint: '#43aa4b' },
  },
  'Flip Side': {
    bodyId: 'flipper',
    sockets: { weapon: 'fl_pneumatic', weapon_motor: 'wm_std', front: 'front_wedge', armor: 'armor_light', wheels_1: 'wheels_std', wheels_2: 'wheels_std', motor: 'motor_std' },
    cosmetics: { name: 'FLIP SIDE', paint: '#9b5de5' },
  },
};

const SOCKET_LABEL: Record<string, string> = {
  weapon: 'WEAPON', weapon_motor: 'WPN MOTOR', front: 'FRONT', armor: 'ARMOR', wheels: 'WHEELS', motor: 'MOTOR', secondary: 'SECONDARY',
};

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

/** Parts that may legally fill this socket on this body. */
export function compatibleParts(catalog: Catalog, body: BodyDef, socket: SocketDef): PartDef[] {
  return Object.values(catalog.parts).filter(p =>
    p.type === socket.type && (socket.type !== 'weapon' || body.allowedWeaponKinds.includes(p.kind as WeaponKind)));
}

/** Re-fit a build to a (possibly new) body, keeping parts that still fit. */
export function refitToBody(catalog: Catalog, build: BotBuild, bodyId: BodyId): BotBuild {
  const body = catalog.bodies[bodyId];
  const next: BotBuild = { bodyId, sockets: {}, cosmetics: clone(build.cosmetics) };
  for (const s of body.sockets) {
    const prev = build.sockets[s.id] ?? null;
    const options = compatibleParts(catalog, body, s);
    next.sockets[s.id] = prev && options.some(p => p.id === prev) ? prev
      : s.required === false ? null : (options[0]?.id ?? null);
  }
  return next;
}

function statLine(p: PartDef): string {
  const s = p.stats, out = [`hp ${s.hp}`];
  if (s.armor !== undefined) out.push(`arm ${s.armor}`);
  if (s.damage !== undefined) out.push(`dmg ${s.damage}`);
  if (s.speed !== undefined) out.push(`spd ${s.speed}`);
  return out.join(' · ');
}

function socketLabel(body: BodyDef, s: SocketDef): string {
  const same = body.sockets.filter(x => x.type === s.type).length;
  return SOCKET_LABEL[s.type] + (same > 1 ? ` ${s.id.split('_').pop()}` : '');
}

export interface DeployArgs { player: BotBuild; opponent: BotBuild; opponentName: string; difficulty: Difficulty }

export class Builder {
  build: BotBuild;
  private selectedSocket: string;
  private el = {
    overlay: document.getElementById('lab')!,
    body: document.getElementById('bb-body') as HTMLSelectElement,
    desc: document.getElementById('bb-desc')!,
    rack: document.getElementById('bb-rack')!,
    binTitle: document.getElementById('bb-bin-title')!,
    bin: document.getElementById('bb-bin')!,
    mass: document.getElementById('bb-mass')!,
    massBar: document.getElementById('bb-mass-bar')!,
    hp: document.getElementById('bb-hp')!,
    armor: document.getElementById('bb-armor')!,
    speed: document.getElementById('bb-speed')!,
    status: document.getElementById('bb-status')!,
    errors: document.getElementById('bb-errors')!,
    name: document.getElementById('bb-name') as HTMLInputElement,
    paint: document.getElementById('bb-paint') as HTMLInputElement,
    presets: document.getElementById('bb-presets') as HTMLSelectElement,
    opponent: document.getElementById('bb-opponent') as HTMLSelectElement,
    difficulty: document.getElementById('bb-difficulty') as HTMLSelectElement,
    deploy: document.getElementById('bb-deploy') as HTMLButtonElement,
  };
  private onChange: (b: BotBuild) => void = () => {};
  private onDeploy: (a: DeployArgs) => void = () => {};

  constructor(private catalog: Catalog) {
    const saved = this.load();
    this.build = refitToBody(catalog, saved?.build ?? clone(PRESETS['Red Disc']), (saved?.build ?? PRESETS['Red Disc']).bodyId);
    this.selectedSocket = 'weapon';

    for (const body of Object.values(catalog.bodies)) this.el.body.add(new Option(body.name, body.id));
    this.el.body.onchange = () => {
      this.build = refitToBody(catalog, this.build, this.el.body.value as BodyId);
      if (!(this.selectedSocket in this.build.sockets)) this.selectedSocket = 'weapon';
      this.render(); this.changed();
    };

    this.el.presets.add(new Option('load preset…', ''));
    for (const name of Object.keys(PRESETS)) { this.el.presets.add(new Option(name, name)); this.el.opponent.add(new Option(name, name)); }
    this.el.presets.onchange = () => {
      const p = PRESETS[this.el.presets.value];
      if (p) { this.build = clone(p); this.selectedSocket = 'weapon'; this.render(); this.changed(); }
      this.el.presets.value = '';
    };
    this.el.opponent.value = saved?.opponent && PRESETS[saved.opponent] ? saved.opponent : 'Blue Lift';
    this.el.difficulty.value = saved?.difficulty && DIFFICULTY[saved.difficulty] ? saved.difficulty : 'normal';

    this.el.name.oninput = () => { this.build.cosmetics.name = this.el.name.value.toUpperCase(); this.changed(); };
    this.el.paint.oninput = () => { this.build.cosmetics.paint = this.el.paint.value; this.changed(); };

    this.el.deploy.onclick = () => {
      if (!this.validation.ok) return;
      this.save();
      this.hide();
      this.onDeploy({ player: clone(this.build), opponent: clone(PRESETS[this.el.opponent.value]), opponentName: this.el.opponent.value, difficulty: this.el.difficulty.value as Difficulty });
    };

    this.render();
  }

  get validation() { return validateBuild(this.build, this.catalog); }
  get visible() { return this.el.overlay.classList.contains('on'); }

  show(onChange: (b: BotBuild) => void, onDeploy: (a: DeployArgs) => void) {
    this.onChange = onChange; this.onDeploy = onDeploy;
    this.el.overlay.classList.add('on');
    document.body.classList.add('inlab');
    this.changed();
  }
  hide() { this.el.overlay.classList.remove('on'); document.body.classList.remove('inlab'); }

  private changed() { this.renderTelemetry(); this.onChange(this.build); }

  private render() {
    const body = this.catalog.bodies[this.build.bodyId];
    this.el.body.value = this.build.bodyId;
    this.el.desc.textContent = body.description;
    this.el.name.value = this.build.cosmetics.name;
    this.el.paint.value = this.build.cosmetics.paint ?? '#ffffff';
    this.renderRack();
    this.renderBin();
    this.renderTelemetry();
  }

  private renderRack() {
    const body = this.catalog.bodies[this.build.bodyId];
    this.el.rack.innerHTML = '';
    for (const s of body.sockets) {
      const partId = this.build.sockets[s.id];
      const part = partId ? this.catalog.parts[partId] : undefined;
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'rack-row' + (s.id === this.selectedSocket ? ' sel' : '') + (part ? '' : ' empty');
      row.innerHTML = `<span class="lbl">${socketLabel(body, s)}</span>` +
        (part ? `<span class="pn">${part.name}</span><span class="ps">${statLine(part)} · ${partWeight(part, this.catalog.balance)} wt</span>`
              : `<span class="pn">— empty —</span><span class="ps">${s.required === false ? 'optional' : 'required'}</span>`);
      row.onclick = () => { this.selectedSocket = s.id; this.renderRack(); this.renderBin(); };
      this.el.rack.appendChild(row);
    }
  }

  private renderBin() {
    const body = this.catalog.bodies[this.build.bodyId];
    const s = body.sockets.find(x => x.id === this.selectedSocket)!;
    this.el.binTitle.textContent = `PARTS BIN · ${socketLabel(body, s)}`;
    this.el.bin.innerHTML = '';
    const current = this.build.sockets[s.id] ?? null;
    const pick = (id: string | null) => { this.build.sockets[s.id] = id; this.renderRack(); this.renderBin(); this.changed(); };
    if (s.required === false) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'bin-item' + (current === null ? ' sel' : '');
      b.innerHTML = `<span class="pn">— none —</span><span class="pw">0 wt</span><span class="ps">leave the socket empty</span>`;
      b.onclick = () => pick(null);
      this.el.bin.appendChild(b);
    }
    for (const p of compatibleParts(this.catalog, body, s)) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'bin-item' + (p.id === current ? ' sel' : '');
      b.innerHTML = `<span class="pn">${p.name}</span><span class="pw">${partWeight(p, this.catalog.balance)} wt</span><span class="ps">${statLine(p)}${p.description ? ' · ' + p.description : ''}</span>`;
      b.onclick = () => pick(p.id);
      this.el.bin.appendChild(b);
    }
  }

  private renderTelemetry() {
    const v = this.validation;
    const pct = v.weightLimit ? Math.min(100, (v.totalWeight / v.weightLimit) * 100) : 0;
    this.el.mass.textContent = `${v.totalWeight} / ${v.weightLimit}`;
    this.el.massBar.style.width = `${pct}%`;
    this.el.massBar.className = v.totalWeight > v.weightLimit ? 'over' : pct > 90 ? 'tight' : '';
    const parts = Object.values(v.resolved);
    this.el.hp.textContent = String(parts.reduce((a, p) => a + p.stats.hp, 0));
    this.el.armor.textContent = String(parts.reduce((a, p) => a + (p.stats.armor ?? 0), 0));
    this.el.speed.textContent = String(parts.reduce((a, p) => a + (p.stats.speed ?? 0), 0));
    this.el.status.textContent = v.ok ? '✓ BUILD VALID' : '✗ BUILD INVALID';
    this.el.status.className = v.ok ? 'ok' : 'bad';
    this.el.errors.innerHTML = v.errors.map(e => `<li>${e}</li>`).join('');
    this.el.deploy.disabled = !v.ok;
  }

  private save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ build: this.build, opponent: this.el.opponent.value, difficulty: this.el.difficulty.value })); } catch { /* ignore */ }
  }
  private load(): { build: BotBuild; opponent?: string; difficulty?: Difficulty } | null {
    try { const s = localStorage.getItem(STORAGE_KEY); return s ? JSON.parse(s) : null; } catch { return null; }
  }
}
