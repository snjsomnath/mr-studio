// The Home page: the first window. Pick a table to open in the editor, or start a new one.
// Talks to the shell through the commands in src-tauri/src/main.rs.
const { invoke } = window.__TAURI__.core;
const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
};

let busy = false;

function showError(message, where = 'error') {
  $(where).textContent = message ? String(message) : '';
  $(where).hidden = !message;
}

// ---- Home ------------------------------------------------------------------

async function load() {
  const state = await invoke('launcher_state');
  $('version').textContent = `Version ${state.version}`;
  showError(state.error);
  $('tables').replaceChildren(
    ...state.sites.map((site) => {
      const open = el(
        'button',
        { type: 'button', className: 'open', disabled: !!site.problem, title: site.problem ? '' : 'Open in the editor' },
        el('span', { className: 'swatch' }),
        el('span', {}, el('b', {}, site.name), el('small', {}, site.problem ?? (site.source === 'built in' ? 'Comes with MR Studio, for trying things out' : site.path))),
        el('span', { className: 'tag' }, site.source === 'built in' ? 'Example' : ''),
      );
      open.addEventListener('click', () => openTable(site.path));
      const row = el('li', { className: site.problem ? 'broken' : '' }, open);
      if (site.source === 'added') {
        const remove = el('button', { type: 'button', className: 'remove', title: 'Take it off this list. The folder is not deleted.' }, 'Remove');
        remove.addEventListener('click', async () => {
          await invoke('remove_site', { path: site.path });
          await load();
        });
        row.append(remove);
      }
      return row;
    }),
  );
  $('tables-hint').textContent = state.sites_folder ? `New tables are kept in ${state.sites_folder}.` : '';
}

// On success the shell closes this window.
async function openTable(path, welcome = false) {
  if (busy) return;
  busy = true;
  document.body.style.cursor = 'progress';
  showError();
  try {
    await invoke('open_site', { path, welcome });
  } catch (e) {
    showError(e);
    show('home');
  }
  document.body.style.cursor = '';
  busy = false;
}

async function openFolder() {
  try {
    const added = await invoke('add_site');
    if (added) await openTable(added.path);
  } catch (e) {
    showError(e);
  }
}

async function newTable() {
  showError();
  try {
    // With the editor's wizard in this copy of the app, it takes over from here.
    if (await invoke('new_table')) return;
  } catch (e) {
    showError(e);
    return;
  }
  step = 0;
  $('new-form').reset();
  readPlace();
  readSize();
  show('new');
}

function show(view) {
  $('view-home').hidden = view !== 'home';
  $('view-new').hidden = view !== 'new';
  if (view === 'new') drawStep();
}

for (const id of ['nav-new', 'card-new']) $(id).addEventListener('click', newTable);
for (const id of ['nav-open', 'card-open']) $(id).addEventListener('click', openFolder);
$('nav-settings').addEventListener('click', () => invoke('open_settings').catch(showError));
$('nav-quit').addEventListener('click', () => invoke('quit'));
$('new-back').addEventListener('click', () => show('home'));
window.addEventListener('focus', () => !busy && $('view-new').hidden && load().catch(showError));

// ---- New table: name, place, size --------------------------------------------

let step = 0;

/** Latitude and longitude from "57.7, 11.9", a Google Maps link or an OpenStreetMap link. */
function parsePlace(text) {
  const number = '(-?\\d{1,3}(?:\\.\\d+)?)';
  const patterns = [
    new RegExp(`@${number},${number}`), // google.com/maps/@57.7,11.9,15z
    new RegExp(`[?&](?:q|ll|query)=${number}(?:,|%2C)${number}`), // ...?q=57.7,11.9
    new RegExp(`#map=\\d+(?:\\.\\d+)?/${number}/${number}`), // openstreetmap.org/#map=15/57.7/11.9
    new RegExp(`mlat=${number}&mlon=${number}`),
    new RegExp(`^\\s*${number}\\s*[,;\\s]\\s*${number}\\s*$`), // 57.7, 11.9
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    const lat = Number(match[1]);
    const lon = Number(match[2]);
    if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) return { lat, lon };
  }
  return null;
}

function readPlace() {
  const text = $('new-place').value.trim();
  const place = parsePlace(text);
  const read = $('place-read');
  read.className = place ? 'read ok' : 'read';
  if (place) {
    const ns = place.lat >= 0 ? 'N' : 'S';
    const ew = place.lon >= 0 ? 'E' : 'W';
    read.textContent = `Found: ${Math.abs(place.lat).toFixed(5)}° ${ns}, ${Math.abs(place.lon).toFixed(5)}° ${ew}`;
  } else {
    read.textContent = text ? 'No coordinates found in that yet.' : '';
  }
  return place;
}

function readSize() {
  const choice = document.querySelector('input[name="width"]:checked').value;
  const width = choice === 'custom' ? Number($('new-width-custom').value) : Number(choice);
  const shape = Number(document.querySelector('input[name="shape"]:checked').value);
  const ok = Number.isFinite(width) && width >= 50 && width <= 20000;
  const height = ok ? Math.round(width / shape) : 0;
  $('size-read').textContent = ok ? `The table shows ${width} × ${height} metres.` : 'Give a width between 50 and 20 000 metres.';
  return ok ? { width_m: width, height_m: height } : null;
}

function drawStep() {
  showError(null, 'new-error');
  document.querySelectorAll('#new-form section').forEach((section) => (section.hidden = Number(section.dataset.step) !== step));
  [...$('stepper').children].forEach((item, i) => (item.className = i === step ? 'now' : i < step ? 'done' : ''));
  $('new-prev').hidden = step === 0;
  $('new-next').textContent = step === 2 ? 'Create the table' : 'Continue';
  const first = document.querySelector(`#new-form section[data-step="${step}"] input`);
  (step < 2 ? first : $('new-next')).focus();
}

$('new-place').addEventListener('input', readPlace);
$('new-form').addEventListener('change', readSize);
$('new-width-custom').addEventListener('input', () => {
  document.querySelector('input[name="width"][value="custom"]').checked = true;
  readSize();
});
$('new-prev').addEventListener('click', () => {
  step -= 1;
  drawStep();
});

$('new-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const name = $('new-name').value.trim();
  if (step === 0 && !/[a-z0-9]/i.test(name)) return showError('Give the table a name with at least one letter or digit.', 'new-error');
  const place = readPlace();
  if (step === 1 && !place) return showError('Paste a map link or type the coordinates, for example 57.7066, 11.9384.', 'new-error');
  if (step < 2) {
    step += 1;
    return drawStep();
  }
  const size = readSize();
  if (!size) return showError('Give a width between 50 and 20 000 metres.', 'new-error');
  $('new-next').disabled = true;
  try {
    const path = await invoke('create_site', { site: { name, lat: place.lat, lon: place.lon, ...size } });
    await openTable(path, true);
  } catch (e) {
    showError(e, 'new-error');
  }
  $('new-next').disabled = false;
});

load().catch(showError);
