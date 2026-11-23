// Runs in the editor window, which shows the host's /edit page. It adds the shell's
// part of the editor: Present, Stop and the way back to the launcher. A page with its own
// Present button marks it `data-shell-present`, and then this bar leaves Present to it and
// only offers Stop while presenting. A page that does all of it itself sets
// `window.mrsShellControls = true` and gets no bar.
(() => {
  if (window.top !== window) return;
  const invoke = (command, args) => window.__TAURI__.core.invoke(command, args);

  // Ctrl+Shift+Q quits, as on the surfaces. Ctrl+Shift+S is Save As here (the File menu,
  // #130); on the surfaces it still opens the displays and settings.
  window.addEventListener('keydown', (event) => {
    if (!(event.ctrlKey || event.metaKey) || !event.shiftKey) return;
    if (event.code === 'KeyQ') { event.preventDefault(); invoke('quit'); }
  }, true);

  // A webview has no tabs. A page that asks for a window of one of this table's views
  // gets a real one from the shell; any other address is left alone.
  const browserOpen = window.open;
  window.open = function (url, ...rest) {
    try {
      const target = new URL(url, window.location.href);
      const view = target.pathname.replace(/^\//, '');
      if (target.origin === window.location.origin && ['table', 'tv', 'dev', 'phone'].includes(view)) {
        window.location.href = '/__shell/window/' + view;
        return null;
      }
    } catch {}
    return browserOpen.call(window, url, ...rest);
  };

  function build() {
    if (window.mrsShellControls) return;
    const host = document.createElement('div');
    host.setAttribute('data-shell-bar', '');
    Object.assign(host.style, { position: 'fixed', bottom: '34px', right: '12px', zIndex: '2147483000' });
    const root = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = `
      :host { all: initial; }
      .bar { display: flex; gap: 6px; align-items: center; padding: 4px; border-radius: 8px;
        background: #ffffff; border: 1px solid #d9dde5; box-shadow: 0 2px 10px rgba(16, 24, 40, .18);
        font: 12px/1 system-ui, -apple-system, 'Segoe UI Variable', 'Segoe UI', Inter, sans-serif; color: #1c2230; }
      button { all: unset; box-sizing: border-box; height: 28px; padding: 0 10px; border-radius: 6px; cursor: default;
        display: inline-flex; align-items: center; gap: 6px; color: #1c2230; }
      button:hover { background: #eef1f6; }
      button:focus-visible { outline: 2px solid #3557d4; outline-offset: 1px; }
      button.primary { background: #3557d4; color: #fff; font-weight: 600; }
      button.primary:hover { background: #2c49b8; }
      button.stop { background: #fdecec; color: #a4262c; font-weight: 600; }
      button[disabled] { opacity: .55; }
      [hidden] { display: none !important; }
      .note { padding: 0 6px; color: #a4262c; max-width: 320px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      svg { width: 14px; height: 14px; fill: currentColor; }
    `;
    const bar = document.createElement('div');
    bar.className = 'bar';
    const note = document.createElement('span');
    note.className = 'note';
    note.hidden = true;
    const home = document.createElement('button');
    home.type = 'button';
    home.textContent = 'Home';
    home.title = 'Other tables and a new table. Displays and settings are there too.';
    const go = document.createElement('button');
    go.type = 'button';
    bar.append(note, home, go);
    root.append(style, bar);

    let presenting = false;
    const icon = (path) => `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="${path}"/></svg>`;
    function draw() {
      go.hidden = !presenting && !!document.querySelector('[data-shell-present]');
      go.className = presenting ? 'stop' : 'primary';
      go.innerHTML = presenting ? `${icon('M3 3h10v10H3z')}<span>Stop presenting</span>` : `${icon('M4 2.5v11l9-5.5z')}<span>Present</span>`;
      go.title = presenting ? 'Take the site off the table and the TV' : 'Show the site on the table and the TV';
    }
    async function refresh() {
      try {
        presenting = (await invoke('presenting_state')).presenting;
        draw();
      } catch (e) {
        say(e);
      }
    }
    function say(error) {
      note.textContent = error ? String(error) : '';
      note.title = note.textContent;
      note.hidden = !error;
    }
    home.addEventListener('click', () => invoke('open_home').catch(say));
    go.addEventListener('click', async () => {
      go.disabled = true;
      say();
      try {
        await invoke(presenting ? 'stop_presenting' : 'present');
      } catch (e) {
        say(e);
      }
      go.disabled = false;
      await refresh();
    });
    window.addEventListener('focus', refresh);
    // The page's own Present button does not tell the bar; look again shortly after any click.
    document.addEventListener('click', () => setTimeout(refresh, 600), true);
    draw();
    refresh();
    // The page builds its own controls after it has loaded.
    setTimeout(refresh, 1500);
    document.body.append(host);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build);
  else build();
})();
