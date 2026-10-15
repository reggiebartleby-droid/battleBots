import type { Bot } from './bot.js';
import type { Stats } from './combat.js';
import { canAttack, isImmobilized } from '../../src/core/state.js';

const ICON: Record<string, string> = { weapon: '⚙', front: '◣', armor: '▣', wheels: '◎', motor: '⚡', secondary: '🔥' };
const FLASH_MS = 350;

export class Hud {
  private boards = [document.getElementById('board1')!, document.getElementById('board2')!];
  private timerEl = document.getElementById('timer')!;
  private finishEl = document.getElementById('finish')!;
  private winnerEl = document.getElementById('winner')!;
  private controlsEl = document.getElementById('controls')!;
  private controlsUntil = 0;
  private signEl = document.getElementById('sign')!;
  private signUntil = 0;

  update(bots: Bot[], secondsLeft: number, stats?: Record<'A' | 'B', Stats>) {
    bots.forEach((b, i) => this.boards[i].innerHTML = this.board(b, stats?.[b.id]));
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
  }

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

  private board(b: Bot, st?: Stats) {
    const now = performance.now();
    const rows = Object.values(b.state.parts).map(p => {
      const pct = (p.hp / p.maxHp) * 100;
      const cls = p.hp <= 0 ? 'dead' : pct < 30 ? 'low' : pct < 60 ? 'mid' : '';
      const flash = b.lastHit && b.lastHit.socket === p.socketId && now - b.lastHit.t < FLASH_MS ? ' flash' : '';
      return `<div class="part${flash}"><span>${ICON[p.socketType]} ${p.socketId}</span><div class="bar"><i class="${cls}" style="width:${pct}%"></i></div><span>${p.hp}</span></div>`;
    }).join('');

    const ws = b.weapon.status(canAttack(b.state));
    const weaponRow = `<div class="part wpn ${ws.cls}"><span>weapon</span><div class="bar"><i class="w" style="width:${ws.pct}%"></i></div><span class="lbl">${ws.label}</span></div>`;
    const statRow = st
      ? `<div class="part stats"><span>hits ${st.hits}</span><span>dealt ${st.dmg}</span><span>bumps ${st.bumps} · wedges ${st.wedges}</span></div>`
      : '';
    return `<h3 style="color:${b.build.cosmetics.paint}">${b.build.cosmetics.name}</h3>${rows}${weaponRow}${statRow}<div class="part" style="opacity:.6"><span>dmg taken</span><span></span><span>${b.state.totalDamageTaken}</span></div>`;
  }
}
