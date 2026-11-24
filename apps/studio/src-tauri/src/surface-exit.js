// Runs on every surface while presenting. Shows, briefly at the start and
// whenever the pointer goes to the top edge, the way back to the editor.
(() => {
  if (window.top !== window) return;
  function build() {
    const host = document.createElement('div');
    Object.assign(host.style, { position: 'fixed', top: '10px', left: '50%', transform: 'translateX(-50%)', zIndex: '2147483000' });
    const root = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = `
      button { all: unset; display: flex; align-items: center; gap: 8px; height: 30px; padding: 0 12px; border-radius: 15px;
        background: rgba(255, 255, 255, .96); color: #1c2230; box-shadow: 0 2px 12px rgba(0, 0, 0, .35); cursor: default;
        font: 12px/1 system-ui, -apple-system, 'Segoe UI Variable', 'Segoe UI', Inter, sans-serif;
        opacity: 0; pointer-events: none; transition: opacity .25s; }
      button.on { opacity: 1; pointer-events: auto; }
      button:hover { background: #fff; }
      button:focus-visible { outline: 2px solid #3557d4; outline-offset: 2px; }
      kbd { font: inherit; color: #667085; }
    `;
    const button = document.createElement('button');
    button.type = 'button';
    button.append('Back to the editor ');
    const keys = document.createElement('kbd');
    keys.textContent = 'Esc';
    button.append(keys);
    button.addEventListener('click', () => (window.location.href = '/__shell/edit'));
    root.append(style, button);
    document.body.append(host);

    let timer;
    const show = (ms) => {
      button.classList.add('on');
      clearTimeout(timer);
      timer = setTimeout(() => button.classList.remove('on'), ms);
    };
    // A table that visitors see shows it only on the pointer at the top edge.
    if (!window.__MRS_EXIT_QUIET__) show(6000);
    window.addEventListener('mousemove', (event) => event.clientY < 90 && show(2500));
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build);
  else build();
})();
