/**
 * The frame meter on screen (#262): a small box in a corner of the table or controller with its
 * frames per second, the worst frame of the last 10 s, and what each layer's own code costs per
 * frame. Ctrl+Shift+P shows or hides it on one window; the editor's Show frame meter shows it on
 * the table and controller for the session (`session.performance`).
 */
import type { Connection, SessionState } from '@mrstudio/sdk';
import { meter, SLOW_SHARE, TARGET_FPS } from './perf.ts';
import type { Store } from './store.ts';

/** How often the numbers change, so they can be read. */
const REFRESH_MS = 500;

export function frameOverlay(store: Store, connection: Connection): void {
  let own: boolean | null = null;
  const box = document.createElement('div');
  box.className = 'frame-meter';
  box.setAttribute('aria-hidden', 'true');
  box.hidden = true;
  document.body.append(box);

  const name = (id: string) => {
    const layer = store.state.layers[id];
    const manifest = layer ? store.manifests.find((m) => m.id === layer.layer) : undefined;
    return manifest?.name ?? id;
  };
  const draw = () => {
    const r = meter.report();
    const slow = r.fps < TARGET_FPS * SLOW_SHARE;
    box.classList.toggle('is-slow', slow);
    const rows = r.layers
      .slice(0, 6)
      .map((l) => `<tr><td>${escape(name(l.id))}</td><td>${l.ms.toFixed(1)}</td><td>${Math.round(l.worst_ms)}</td></tr>`)
      .join('');
    box.innerHTML =
      `<div class="frame-meter-head"><b>${Math.round(r.fps)}</b> fps<span>worst ${Math.round(r.worst_ms)} ms</span>` +
      (r.heap_mb !== undefined ? `<span>${r.heap_mb} MB</span>` : '') +
      `</div>` +
      (rows ? `<table><thead><tr><th>Layer</th><th>ms/frame</th><th>worst</th></tr></thead><tbody>${rows}</tbody></table>` : '<p>No layer is running.</p>');
  };
  let timer = 0;
  const update = () => {
    const show = own ?? store.state.session.performance === true;
    if (show === !box.hidden) return;
    box.hidden = !show;
    window.clearInterval(timer);
    if (show) {
      draw();
      timer = window.setInterval(draw, REFRESH_MS);
    }
  };
  connection.on('session.changed', (p: { session: SessionState['session'] }) => {
    // The session's switch wins over this window's own choice once it changes.
    if (p.session.performance !== undefined) own = null;
    update();
  });
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'p') {
      e.preventDefault();
      own = box.hidden;
      update();
    }
  });
  update();
}

function escape(text: string): string {
  return text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}
