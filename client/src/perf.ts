/**
 * v0.44 performance readout (cube Oval build plan, step 8): frame rate, triangles drawn and draw calls, top right.
 * On with the lab's SETTINGS > PERF READOUT checkbox, or ?perf=1 in the address (works in the tester version too).
 */
import { Engine, Scene, SceneInstrumentation } from '@babylonjs/core';

export function setupPerf(engine: Engine, scene: Scene) {
  const box = document.createElement('div');
  box.id = 'bb-perfbox';
  box.style.cssText = 'position:fixed;top:8px;right:8px;z-index:50;font:12px/1.4 monospace;color:#d7e3e6;background:rgba(8,12,16,.78);'
    + 'border:1px solid #33424c;border-radius:4px;padding:6px 9px;pointer-events:none;white-space:pre;display:none';
  document.body.appendChild(box);
  const inst = new SceneInstrumentation(scene);
  inst.captureFrameTime = false;
  const cb = document.getElementById('bb-perf') as HTMLInputElement | null;
  let on = new URLSearchParams(location.search).get('perf') === '1';
  if (cb) { cb.checked = on; cb.addEventListener('change', () => { on = cb.checked; box.style.display = on ? 'block' : 'none'; }); }
  box.style.display = on ? 'block' : 'none';
  let at = 0, frames = 0, last = performance.now();
  scene.onAfterRenderObservable.add(() => {
    frames++;
    const now = performance.now();
    if (!on || now - at < 500) return;
    const fps = frames * 1000 / (now - last); frames = 0; last = now; at = now;
    const tris = Math.round(scene.getActiveIndices() / 3);
    box.textContent = `FPS   ${fps.toFixed(0)}\nTRIS  ${tris.toLocaleString('en-US')}\nDRAWS ${inst.drawCallsCounter.current}\nMESH  ${scene.getActiveMeshes().length}`;
    void engine;
  });
}
