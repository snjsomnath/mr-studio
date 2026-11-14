// The launcher: pick or make a site, open it in the editor, say which display shows
// which surface, present.
// It talks to the shell through the commands in src-tauri/src/main.rs.
const { invoke } = window.__TAURI__.core;
const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
};

const ROLES = [
  ['', 'Not used'],
  ['table', 'Table (projector)'],
  ['tv', 'TV (controls)'],
  ['dev', 'Dev (table and controls)'],
];

let state;
let site; // path of the chosen site
let roles = []; // role per display index, '' when unused
let busy = false; // a start or an open is under way

function showError(message) {
  $('error').textContent = message ?? '';
  $('error').hidden = !message;
}

async function load() {
  state = await invoke('launcher_state');
  site = state.site;
  roles = state.displays.map(() => '');
  for (const w of state.windows) roles[w.display] = w.role;
  $('version').textContent = `v${state.version}`;
  $('fullscreen').checked = state.windows.some((w) => w.fullscreen);
  $('autostart').checked = state.autostart;
  $('lan').checked = state.lan;
  $('running').hidden = !state.running;
  if (state.running) {
    const what = state.presenting ? 'Presenting' : 'Open';
    $('running').textContent = `${what}: ${state.running.name} · port ${state.running.port} · code ${state.running.code}`;
  }
  $('sites-hint').textContent = state.sites_folder ? `Sites in ${state.sites_folder} appear here by themselves.` : '';
  showError(state.error);
  renderSites();
  renderDisplays();
}

function renderSites() {
  $('sites').replaceChildren(
    ...state.sites.map((s) => {
      const radio = el('input', { type: 'radio', name: 'site', checked: s.path === site, disabled: !!s.problem });
      radio.addEventListener('change', () => {
        site = s.path;
        update();
      });
      const label = el('label', { className: s.problem ? 'broken' : '' }, radio, el('span', { className: 'name' }, s.name));
      if (s.source === 'added') {
        const remove = el('button', { type: 'button', className: 'remove', title: 'Remove from this list' }, 'Remove');
        remove.addEventListener('click', async (event) => {
          event.preventDefault();
          await invoke('remove_site', { path: s.path });
          await load();
        });
        label.append(remove);
      } else {
        label.append(el('span', { className: 'source' }, s.source));
      }
      label.append(el('span', { className: s.problem ? 'problem' : 'path' }, s.problem ?? s.path));
      return el('li', {}, label);
    }),
  );
  update();
}

function renderDisplays() {
  $('displays').replaceChildren(
    ...state.displays.map((d) => {
      const select = el('select', { ariaLabel: `Display ${d.index + 1} shows` }, ...ROLES.map(([value, text]) => el('option', { value }, text)));
      select.value = roles[d.index];
      select.addEventListener('change', () => {
        roles[d.index] = select.value;
        // A table or a TV exists once; taking it for this display frees it elsewhere.
        if (select.value) roles = roles.map((role, i) => (i !== d.index && role === select.value ? '' : role));
        renderDisplays();
      });
      const details = [`${d.width} × ${d.height}`, d.scale !== 1 ? `${Math.round(d.scale * 100)}%` : '', d.primary ? 'main display' : ''];
      return el(
        'li',
        {},
        el('span', { className: 'number' }, String(d.index + 1)),
        el('span', { className: 'what' }, d.name || `Display ${d.index + 1}`, el('small', {}, details.filter(Boolean).join(' · '))),
        select,
      );
    }),
  );
  renderMap();
  update();
}

// A small picture of how the displays sit next to each other.
function renderMap() {
  const map = $('map');
  const pad = 14;
  const left = Math.min(...state.displays.map((d) => d.x));
  const top = Math.min(...state.displays.map((d) => d.y));
  const right = Math.max(...state.displays.map((d) => d.x + d.width));
  const bottom = Math.max(...state.displays.map((d) => d.y + d.height));
  const scale = Math.min((map.clientWidth - 2 * pad) / (right - left), (map.clientHeight - 2 * pad) / (bottom - top));
  const offsetX = (map.clientWidth - (right - left) * scale) / 2;
  const offsetY = (map.clientHeight - (bottom - top) * scale) / 2;
  map.replaceChildren(
    ...state.displays.map((d) => {
      const role = roles[d.index];
      const screen = el('div', { className: 'screen' }, el('b', {}, String(d.index + 1)), el('span', {}, role ? ROLES.find(([value]) => value === role)[1] : ''));
      screen.dataset.role = role;
      Object.assign(screen.style, {
        left: `${offsetX + (d.x - left) * scale}px`,
        top: `${offsetY + (d.y - top) * scale}px`,
        width: `${d.width * scale - 4}px`,
        height: `${d.height * scale - 4}px`,
      });
      return screen;
    }),
  );
}

function update() {
  $('start').disabled = !site;
  $('edit').disabled = !site;
}

$('add-site').addEventListener('click', async () => {
  try {
    const added = await invoke('add_site');
    if (!added) return;
    await load();
    site = added.path;
    renderSites();
  } catch (e) {
    showError(String(e));
  }
});

$('identify').addEventListener('click', async () => {
  $('identify').disabled = true;
  try {
    await invoke('identify');
  } catch (e) {
    showError(String(e));
  }
  $('identify').disabled = false;
});

$('start').addEventListener('click', async () => {
  const fullscreen = $('fullscreen').checked;
  const windows = roles.flatMap((role, display) => (role ? [{ display, role, fullscreen }] : []));
  const label = $('start').textContent;
  busy = true;
  $('start').disabled = true;
  $('start').textContent = 'Starting…';
  showError();
  try {
    // On success the shell closes this window.
    await invoke('start', { request: { site, windows, lan: $('lan').checked, autostart: $('autostart').checked } });
  } catch (e) {
    showError(String(e));
    $('start').textContent = label;
    $('start').disabled = false;
  }
  busy = false;
});

// Opens `path` in the editor. On success the shell closes this window.
async function openInEditor(path) {
  busy = true;
  $('edit').disabled = true;
  showError();
  try {
    await invoke('open_site', { path });
  } catch (e) {
    showError(String(e));
  }
  busy = false;
  update();
}

$('edit').addEventListener('click', () => openInEditor(site));

$('new-site').addEventListener('click', () => {
  $('new-error').hidden = true;
  $('new-site-dialog').showModal();
});
$('new-cancel').addEventListener('click', () => $('new-site-dialog').close());
$('new-site-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const number = (id) => Number($(id).value);
  $('new-create').disabled = true;
  try {
    const path = await invoke('create_site', {
      site: { name: $('new-name').value, lat: number('new-lat'), lon: number('new-lon'), width_m: number('new-width'), height_m: number('new-height') },
    });
    $('new-site-dialog').close();
    await openInEditor(path);
    await load();
  } catch (e) {
    $('new-error').textContent = String(e);
    $('new-error').hidden = false;
  }
  $('new-create').disabled = false;
});

$('quit').addEventListener('click', () => invoke('quit'));
window.addEventListener('resize', () => state && renderMap());
// Plugging in a projector while the launcher is open should not need a restart.
window.addEventListener('focus', () => state && !busy && !$('new-site-dialog').open && load());

load().catch((e) => showError(String(e)));
