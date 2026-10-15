export interface Drive { throttle: number; turn: number; fire: boolean }

export const KEYS = {
  A: { up: 'KeyW', down: 'KeyS', left: 'KeyA', right: 'KeyD', fire: ['Space'], label: 'WASD + SPACE' },
  B: { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', fire: ['ShiftRight', 'Enter'], label: 'Arrows + Right SHIFT' },
} as const;

const keys = new Set<string>();
window.addEventListener('keydown', e => {
  keys.add(e.code);
  if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
});
window.addEventListener('keyup', e => keys.delete(e.code));
window.addEventListener('blur', () => keys.clear());

export function isDown(code: string) { return keys.has(code); }

export function readDrive(player: 'A' | 'B'): Drive {
  const k = KEYS[player];
  return {
    throttle: (keys.has(k.up) ? 1 : 0) - (keys.has(k.down) ? 1 : 0),
    turn: (keys.has(k.right) ? 1 : 0) - (keys.has(k.left) ? 1 : 0),
    fire: k.fire.some(c => keys.has(c)),
  };
}
