// File › Settings (#40, #393): this computer (which display shows the table and which the controller,
// phones and startup), then the app's own pages. Colour, Calibration and Updates have scripts of their own.
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
  ['table', 'Table'],
  ['tv', 'Controller'],
  ['dev', 'Table and controls in one window'],
];
const KINDS = { projector: 'Projector', tv: 'TV' };

let screens; // presenting_state: displays (with model and kind), windows, configured
let roles = []; // role per display index, '' when unused
let saving = false;

function showError(message) {
  $('error').textContent = message ?? '';
  $('error').hidden = !message;
}

async function load() {
  const [state, presenting] = await Promise.all([invoke('launcher_state'), invoke('presenting_state')]);
  screens = presenting;
  roles = screens.displays.map(() => '');
  for (const w of screens.windows) roles[w.display] = w.role;
  $('version').textContent = `Version ${state.version}`;
  $('fullscreen').checked = screens.windows.length === 0 || screens.windows.some((w) => w.fullscreen);
  $('autostart').checked = state.autostart;
  $('nightly-on').checked = Boolean(state.nightly_restart);
  if (state.nightly_restart) $('nightly-time').value = state.nightly_restart;
  $('nightly-time').disabled = !state.nightly_restart;
  $('lan').checked = state.lan;
  $('operator-start').checked = state.operator_start;
  $('operator-pin').textContent = state.operator_pin ? 'A PIN is set.' : 'No PIN yet: set one in the operator window.';
  $('running').hidden = !state.running;
  if (state.running) {
    const what = state.presenting ? 'Presenting' : 'Open';
    $('running').replaceChildren(el('b', {}, `${what}: ${state.running.name}${state.read_only ? ' (read-only copy)' : ''}`), el('span', {}, state.join_url ? `Phones join with ${state.running.code}` : 'Phones cannot join'));
  }
  showError(state.error);
  renderDisplays();
}

function renderDisplays() {
  const several = screens.displays.length > 1;
  $('screens-status').textContent = !several ? 'One display: the table goes on it' : screens.configured ? 'Chosen by hand' : 'Chosen automatically, by the makers';
  $('screens-status').classList.toggle('is-auto', !screens.configured);
  $('automatic').hidden = !screens.configured;
  $('displays').replaceChildren(
    ...screens.displays.map((d) => {
      const select = el('select', { ariaLabel: `Display ${d.index + 1} shows` }, ...ROLES.map(([value, text]) => el('option', { value }, text)));
      select.value = roles[d.index];
      select.addEventListener('change', () => {
        roles[d.index] = select.value;
        // A table or a controller exists once; taking it for this display frees it elsewhere.
        if (select.value) roles = roles.map((role, i) => (i !== d.index && role === select.value ? '' : role));
        save();
      });
      const kind = KINDS[d.kind];
      const details = [`${d.width} × ${d.height}`, d.scale !== 1 ? `${Math.round(d.scale * 100)}%` : '', d.primary ? 'main display' : ''];
      return el(
        'li',
        { className: roles[d.index] ? `is-${roles[d.index]}` : '' },
        el('span', { className: 'number' }, String(d.index + 1)),
        el(
          'span',
          { className: 'what' },
          el('b', {}, d.model || d.name || `Display ${d.index + 1}`, kind ? el('span', { className: 'kind' }, kind) : ''),
          el('small', {}, details.filter(Boolean).join(' · ')),
        ),
        select,
      );
    }),
  );
  renderMap();
}

// A small picture of how the displays sit next to each other.
function renderMap() {
  const map = $('map');
  if (!screens.displays.length) return map.replaceChildren();
  const pad = 14;
  const left = Math.min(...screens.displays.map((d) => d.x));
  const top = Math.min(...screens.displays.map((d) => d.y));
  const right = Math.max(...screens.displays.map((d) => d.x + d.width));
  const bottom = Math.max(...screens.displays.map((d) => d.y + d.height));
  const scale = Math.min((map.clientWidth - 2 * pad) / (right - left), (map.clientHeight - 2 * pad) / (bottom - top));
  const offsetX = (map.clientWidth - (right - left) * scale) / 2;
  const offsetY = (map.clientHeight - (bottom - top) * scale) / 2;
  map.replaceChildren(
    ...screens.displays.map((d) => {
      const role = roles[d.index];
      const name = role ? ROLES.find(([value]) => value === role)[1].replace(' in one window', '') : '';
      const screen = el('div', { className: 'screen' }, el('b', {}, String(d.index + 1)), el('span', {}, name));
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

// Saves the choice; while presenting the windows move at once.
async function save(windows) {
  const fullscreen = $('fullscreen').checked;
  windows ??= roles.flatMap((role, display) => (role ? [{ display, role, fullscreen }] : []));
  saving = true;
  showError();
  try {
    await invoke('save_displays', { windows });
  } catch (e) {
    showError(String(e));
  }
  saving = false;
  await load();
}

async function saveSettings() {
  showError();
  try {
    await invoke('save_settings', {
      lan: $('lan').checked,
      autostart: $('autostart').checked,
      nightlyRestart: $('nightly-on').checked ? $('nightly-time').value || '03:00' : null,
    });
  } catch (e) {
    showError(String(e));
  }
  await load();
}

$('identify').addEventListener('click', async () => {
  $('identify').disabled = true;
  try {
    await invoke('identify');
  } catch (e) {
    showError(String(e));
  }
  $('identify').disabled = false;
});
$('automatic').addEventListener('click', () => save([]));
$('fullscreen').addEventListener('change', () => save());
$('lan').addEventListener('change', saveSettings);
$('autostart').addEventListener('change', saveSettings);
$('nightly-on').addEventListener('change', saveSettings);
$('nightly-time').addEventListener('change', saveSettings);
// Operator mode (#394).
$('operator-start').addEventListener('change', async () => {
  showError();
  await invoke('set_operator_start', { on: $('operator-start').checked }).catch((e) => showError(String(e)));
  await load();
});
$('operator-open').addEventListener('click', () => invoke('open_operator').catch((e) => showError(String(e))));
$('operator-log').addEventListener('click', () => invoke('open_operator_log').catch((e) => showError(String(e))));
$('open-sources').addEventListener('click', () => invoke('open_sources').catch((e) => showError(String(e))));

window.addEventListener('resize', () => screens && renderMap());
// Plugging in a projector while this window is open should not need a restart.
window.addEventListener('focus', () => screens && !saving && load().catch((e) => showError(String(e))));

load().catch((e) => showError(String(e)));

// Say the keys and the hints of the computer this runs on.
const mac = /Mac/i.test(navigator.platform);
if (mac) document.querySelectorAll('.keys kbd').forEach((key) => key.textContent === 'Ctrl' && (key.textContent = 'Cmd'));
document.querySelectorAll('[data-only="windows"]').forEach((node) => (node.hidden = !/Win/i.test(navigator.platform)));
// A tab named in the address opens first, e.g. index.html#colour.
const first = document.querySelector(`[role=tab][data-tab="${location.hash.slice(1)}"]`);
if (first) queueMicrotask(() => first.click());
