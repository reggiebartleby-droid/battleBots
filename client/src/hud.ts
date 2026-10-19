import type { Bot } from './bot.js';
import type { Stats, ScoreBonus } from './combat.js';
import { canAttack, isImmobilized } from '../../src/core/state.js';

const ICON: Record<string, string> = { weapon: '⚙', weapon_motor: '⟳', front: '◣', armor: '▣', wheels: '◎', motor: '⚡', secondary: '🔥' };
const FLASH_MS = 350;
const BONUS_MS = 1400;

/** v0.19 HUD layouts: V cycles them, remembered in this browser. */
export const HUD_VIEWS = ['top', 'bottom', 'left'] as const;
export type HudView = typeof HUD_VIEWS[number];
const VIEW_KEY = 'bb-hud-view';
const DETAIL_KEY = 'bb-hud-details';

export interface HudScore { score: Record<string, number>; lastBonus: Partial<Record<string, ScoreBonus>> }

export class Hud {
  private boards = [document.getElementById('board1')!, document.getElementById('board2')!];
  private timerEl = document.getElementById('timer')!;
  private finishEl = document.getElementById('finish')!;
  private winnerEl = document.getElementById('winner')!;
  private controlsEl = document.getElementById('controls')!;
  private controlsUntil = 0;
  private signEl = document.getElementById('sign')!;
  private signUntil = 0;
  private signTimer = 0;   // v0.34i the sign clears itself (race mode never runs update(), so signs stuck on screen)
  view: HudView = 'top';
  details = false;

  constructor() {
    try {
      const v = localStorage.getItem(VIEW_KEY) as HudView | null;
      if (v && HUD_VIEWS.includes(v)) this.view = v;
      this.details = localStorage.getItem(DETAIL_KEY) === '1';
    } catch { /* ignore */ }
    this.applyView();
  }

  /** V: top strip -> bottom corners -> left strip. */
  cycleView() {
    this.view = HUD_VIEWS[(HUD_VIEWS.indexOf(this.view) + 1) % HUD_VIEWS.length];
    try { localStorage.setItem(VIEW_KEY, this.view); } catch { /* ignore */ }
    this.applyView();
  }

  /** H: show / hide the test numbers + per-part list. */
  toggleDetails() {
    this.details = !this.details;
    try { localStorage.setItem(DETAIL_KEY, this.details ? '1' : '0'); } catch { /* ignore */ }
  }

  private applyView() {
    for (const v of HUD_VIEWS) document.body.classList.toggle(`hud-${v}`, v === this.view);
  }

  update(bots: Bot[], secondsLeft: number, stats?: Record<string, Stats>, score?: HudScore) {
    bots.forEach((b, i) => this.boards[i].innerHTML = this.board(b, bots[1 - i], stats?.[b.id], score));
    const m = Math.floor(secondsLeft / 60), s = Math.floor(secondsLeft % 60);
    this.timerEl.textContent = `${m}:${s.toString().padStart(2, '0')}`;
    this.finishEl.classList.toggle('on', bots.some(b => isImmobilized(b.state)));
    if (this.controlsUntil && performance.now() > this.controlsUntil) { this.controlsEl.classList.remove('on'); this.controlsUntil = 0; }
    if (this.signUntil && performance.now() > this.signUntil) { this.signEl.classList.remove('on'); this.signUntil = 0; }
  }

  /** Flash a big test/debug sign in the middle of the screen (e.g. HITSTOP). */
  sign(text: string, ms = 350, color = '#ffd166') {
    this.signEl.textContent = text;
    this.signEl.style.color = color;
    this.signEl.classList.add('on');
    this.signUntil = performance.now() + ms;
    clearTimeout(this.signTimer);
    this.signTimer = window.setTimeout(() => this.clearSign(), ms);
  }
  /** v0.34i hide the sign now (also used when a race starts/ends). */
  clearSign() { clearTimeout(this.signTimer); this.signEl.classList.remove('on'); this.signUntil = 0; }

  /** Show the controls card for a few seconds (match start). */
  showControls(lines: string[], ms = 6000) {
    this.controlsEl.innerHTML = lines.map(l => `<div>${l}</div>`).join('');
    this.controlsEl.classList.add('on');
    this.controlsUntil = performance.now() + ms;
  }

  showWinner(text: string, color: string) {
    this.winnerEl.textContent = text;
    this.winnerEl.style.color = color;
    this.winnerEl.style.display = 'block';
  }
  hideWinner() { this.winnerEl.style.display = 'none'; }

  private board(b: Bot, other: Bot | undefined, st?: Stats, sc?: HudScore) {
    const now = performance.now();
    const parts = Object.values(b.state.parts);
    const hp = parts.reduce((a, p) => a + Math.max(0, p.hp), 0), hpMax = parts.reduce((a, p) => a + p.maxHp, 0);
    const armor = parts.filter(p => p.socketType === 'armor');
    const arHp = armor.reduce((a, p) => a + Math.max(0, p.hp), 0), arMax = armor.reduce((a, p) => a + p.maxHp, 0);
    const pctCls = (pct: number) => pct <= 0 ? 'dead' : pct < 30 ? 'low' : pct < 60 ? 'mid' : '';
    const hpPct = hpMax ? (hp / hpMax) * 100 : 0, arPct = arMax ? (arHp / arMax) * 100 : 0;
    const hitFlash = b.lastHit && now - b.lastHit.t < FLASH_MS ? ' flash' : '';
    const dealt = other?.state.totalDamageTaken ?? 0;
    const pts = sc?.score[b.id] ?? 0;
    const bon = sc?.lastBonus[b.id];
    const bonus = bon && now - bon.t < BONUS_MS ? `<span class="bonus">+${bon.pts} ${bon.text}</span>` : '';

    let html = `<h3 style="color:${b.build.cosmetics.paint}">${b.build.cosmetics.name}</h3>`
      + `<div class="meter${hitFlash}"><span>HP</span><div class="bar"><i class="${pctCls(hpPct)}" style="width:${hpPct}%"></i></div><span>${hp}</span></div>`
      + (arMax
        ? `<div class="meter"><span>ARMOR</span><div class="bar"><i class="ar ${pctCls(arPct)}" style="width:${arPct}%"></i></div><span>${arHp}</span></div>`
        : `<div class="meter"><span>ARMOR</span><div class="bar"></div><span>—</span></div>`)
      + `<div class="nums"><span>DMG DEALT <b>${dealt}</b></span><span>SCORE <b>${pts}</b>${bonus}</span></div>`;

    if (this.details) {
      const rows = parts.map(p => {
        const pct = (p.hp / p.maxHp) * 100;
        const flash = b.lastHit && b.lastHit.socket === p.socketId && now - b.lastHit.t < FLASH_MS ? ' flash' : '';
        return `<div class="part${flash}"><span>${ICON[p.socketType]} ${p.socketId}</span><div class="bar"><i class="${pctCls(pct)}" style="width:${pct}%"></i></div><span>${p.hp}</span></div>`;
      }).join('');
      const ws = b.weapon.status(canAttack(b.state));
      const weaponRow = `<div class="part wpn ${ws.cls}"><span>weapon</span><div class="bar"><i class="w" style="width:${ws.pct}%"></i></div><span class="lbl">${ws.label}</span></div>`;
      const statRow = st ? `<div class="part stats"><span>hits ${st.hits}</span><span>bumps ${st.bumps}</span><span>hit ${st.maxImpulse} m/s</span></div>` : '';
      html += `<div class="details">${rows}${weaponRow}${statRow}<div class="part"><span>dmg taken</span><span></span><span>${b.state.totalDamageTaken}</span></div></div>`;
    }
    return html;
  }
}
