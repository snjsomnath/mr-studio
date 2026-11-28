// Runs in the editor window when licensing is shown and there is something to say (#729): a
// quiet line at the top, never on the table, the TV or phones. The shell sets the words in
// window.__MRS_LICENCE_REMINDER__. Hidden for the rest of the session once closed.
(() => {
  if (window.top !== window) return;
  const words = window.__MRS_LICENCE_REMINDER__;
  if (!words) return;
  const key = 'mrs-licence-reminder-closed';
  try {
    if (sessionStorage.getItem(key) === words) return;
  } catch {}
  function build() {
    const host = document.createElement('div');
    Object.assign(host.style, { position: 'fixed', top: '8px', left: '50%', transform: 'translateX(-50%)', zIndex: '2147483000' });
    const root = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = `
      .bar { display: flex; align-items: center; gap: 10px; max-width: min(760px, calc(100vw - 32px)); padding: 7px 8px 7px 14px;
        font: 13px/1.35 system-ui, -apple-system, 'Segoe UI', sans-serif; color: #3b3320; background: #fff8e6;
        border: 1px solid #ecd9a6; border-radius: 10px; box-shadow: 0 4px 14px rgba(0,0,0,.08); }
      button { font: inherit; border: 1px solid #d9c48d; background: #fff; color: #3b3320; border-radius: 7px; padding: 3px 10px; cursor: pointer; white-space: nowrap; }
      button.close { border: none; background: none; padding: 2px 6px; font-size: 16px; line-height: 1; color: #8a7a4f; }
      button:hover { background: #fdf0cf; }
    `;
    const bar = document.createElement('div');
    bar.className = 'bar';
    bar.setAttribute('role', 'status');
    const text = document.createElement('span');
    text.textContent = words;
    const open = document.createElement('button');
    open.textContent = 'Licence…';
    open.addEventListener('click', () => (window.location.href = '/__shell/licence'));
    const close = document.createElement('button');
    close.className = 'close';
    close.title = 'Hide until MR Studio starts again';
    close.textContent = '×';
    close.addEventListener('click', () => {
      try {
        sessionStorage.setItem(key, words);
      } catch {}
      host.remove();
    });
    bar.append(text, open, close);
    root.append(style, bar);
    document.body.append(host);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build);
  else build();
})();
