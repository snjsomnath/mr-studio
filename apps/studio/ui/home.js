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

/** "Edited 10 minutes ago", "Edited yesterday", "Edited 21 Nov". */
function edited(ms) {
  if (!ms) return 'Not edited yet';
  const minutes = Math.round((Date.now() - ms) / 60000);
  if (minutes < 1) return 'Edited just now';
  if (minutes < 60) return `Edited ${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `Edited ${hours} hour${hours === 1 ? '' : 's'} ago`;
  if (hours < 48) return 'Edited yesterday';
  const date = new Date(ms);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return `Edited ${date.toLocaleDateString([], { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) })}`;
}

/** "740 KB", "48 MB", "1.2 GB". */
function size(bytes) {
  const units = ['bytes', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** Where deleted tables go: the Recycle Bin on Windows, the Trash elsewhere. */
const TRASH = /Win/.test(navigator.platform || navigator.userAgent) ? 'Recycle Bin' : 'Trash';

/** Asks before deleting a table, naming it and saying where its files go. Cancel is the default. */
function confirmDelete(site, bytes) {
  const dialog = $('delete-dialog');
  $('delete-title').textContent = `Delete “${site.name}”?`;
  $('delete-folder').textContent = site.path;
  $('delete-size').textContent = bytes ? ` (${bytes})` : '';
  for (const node of document.querySelectorAll('.trash-name')) node.textContent = TRASH;
  $('delete-confirm').textContent = `Move to ${TRASH}`;
  showError(undefined, 'delete-error');
  dialog.returnValue = '';
  const confirm = $('delete-confirm');
  const done = async () => {
    confirm.disabled = true;
    try {
      await invoke('delete_table', { path: site.path });
      dialog.close();
      await load();
    } catch (e) {
      showError(e, 'delete-error');
    }
    confirm.disabled = false;
  };
  confirm.onclick = done;
  $('delete-cancel').onclick = () => dialog.close();
  dialog.showModal();
  $('delete-cancel').focus();
}

async function load(fresh) {
  const state = await invoke('launcher_state');
  $('version').textContent = `Version ${state.version}`;
  showError(state.error);
  // A newer version of a table waits for the show to stop (#401).
  $('waiting').hidden = !state.waiting;
  $('waiting-text').textContent = state.waiting ? `“${state.waiting}”: a new version waits for the show to stop. Stop presenting and it goes in, or update now.` : '';
  $('tables').replaceChildren(
    ...state.sites.map((site) => {
      const example = site.source === 'built in';
      const picture = el('span', { className: 'thumb' });
      const facts = el('small', { className: 'facts' }, site.problem ?? (example ? 'Comes with MR Studio, for trying things out' : edited(site.edited)));
      const open = el(
        'button',
        { type: 'button', className: 'open', disabled: !!site.problem, title: site.problem ? '' : `Open in the editor\n${site.path}` },
        picture,
        el('span', { className: 'text' }, el('b', {}, site.name), facts, el('small', { className: 'path' }, site.path)),
        el('span', { className: 'tag' }, example ? 'Example' : ''),
      );
      open.addEventListener('click', () => openTable(site.path));
      const row = el('li', { className: site.problem ? 'broken' : fresh && site.path === fresh ? 'fresh' : '' }, open);
      const tools = el('span', { className: 'card-tools' });
      // Duplicate (#99): a copy to change, the way to start from an example or from another table.
      if (!site.problem) {
        const copy = el(
          'button',
          { type: 'button', className: 'remove', title: example ? 'Make your own copy of this example to change' : 'Make a copy of this table, with its own name' },
          'Duplicate',
        );
        copy.addEventListener('click', async () => {
          copy.disabled = true;
          showError();
          try {
            const made = await invoke('duplicate_table', { path: site.path });
            await load(made);
          } catch (e) {
            showError(e);
            copy.disabled = false;
          }
        });
        tools.append(copy);
        // Read only: a copy is opened, so a demo or a test changes nothing in the table itself.
        const look = el(
          'button',
          { type: 'button', className: 'remove', title: 'Open a copy of this table: nothing changed in the editor, on the controller or on phones is saved to it' },
          'Open read-only',
        );
        look.addEventListener('click', () => openTable(site.path, false, true));
        tools.append(look);
      }
      if (site.source === 'added') {
        const remove = el('button', { type: 'button', className: 'remove', title: 'Take it off this list. The folder is not deleted.' }, 'Remove from list');
        remove.addEventListener('click', async () => {
          await invoke('remove_site', { path: site.path });
          await load();
        });
        tools.append(remove);
      }
      // Your own tables can be deleted, after a confirmation; the examples come with the app (#184).
      if (!example) {
        const del = el('button', { type: 'button', className: 'remove danger', title: `Move this table's folder to the ${TRASH}` }, 'Delete…');
        del.addEventListener('click', () => confirmDelete(site, facts.dataset.size));
        tools.append(del);
      }
      if (tools.childElementCount) row.append(tools);
      // The picture from the last time it was closed, and the space it takes, come after (#131).
      invoke('table_details', { path: site.path })
        .then((details) => {
          if (details.thumbnail) picture.style.backgroundImage = `url("${details.thumbnail}")`;
          picture.classList.toggle('has-picture', !!details.thumbnail);
          facts.dataset.size = size(details.bytes);
          if (!site.problem && !example) facts.textContent = `${edited(site.edited)} · ${size(details.bytes)}`;
          if (example) facts.textContent = `Comes with MR Studio · ${size(details.bytes)}`;
        })
        .catch(() => {});
      return row;
    }),
  );
  $('tables-hint').textContent = state.sites_folder ? `New tables are kept in ${state.sites_folder}.` : '';
}

// On success the shell closes this window.
async function openTable(path, welcome = false, readOnly = false) {
  if (busy) return;
  busy = true;
  document.body.style.cursor = 'progress';
  showError();
  try {
    if (readOnly) await invoke('open_site_read_only', { path });
    else await invoke('open_site', { path, welcome });
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

// ---- Open a table file (#85) -------------------------------------------------

/** Opens a .mrstable file: asks for one without `file`, unpacks it as a new table here and
 *  says what this computer still needs for it. With nothing missing it opens at once. */
async function openTableFile(file) {
  if (busy) return;
  showError();
  let imported;
  try {
    document.body.style.cursor = 'progress';
    imported = await invoke('import_table', { file: file ?? null, mode: null });
    // This computer already has this table (#372): update it, or keep both. When it is on the
    // screens, the update can wait for the show to stop (#401).
    if (imported?.kind === 'same_table') {
      document.body.style.cursor = '';
      const mode = await askSameTable(imported);
      if (!mode) return;
      document.body.style.cursor = 'progress';
      imported = await invoke('import_table', { file: imported.file, mode });
    }
    if (imported?.kind === 'waiting') {
      await load();
      return;
    }
  } catch (e) {
    showError(e);
    return;
  } finally {
    document.body.style.cursor = '';
  }
  if (!imported) return;
  if (imported.missing.length === 0 && imported.problems.length === 0) {
    await openTable(imported.path);
    return;
  }
  const dialog = $('import-dialog');
  $('import-title').textContent = imported.updated ? `“${imported.name}” is updated` : `“${imported.name}” is here`;
  $('import-where').textContent = imported.updated
    ? `The new version is in ${imported.path}. This computer's calibration is kept, and the earlier version is in the ${TRASH}.`
    : `It is a new table in ${imported.path}.`;
  $('import-missing').hidden = imported.missing.length === 0;
  $('import-sources').replaceChildren(
    ...imported.missing.map((s) => el('li', {}, el('b', { textContent: s.name || s.id }), el('span', { textContent: `Used by ${s.layers.join(', ') || 'a layer'}` }))),
  );
  $('import-problems').hidden = imported.problems.length === 0;
  $('import-problem-list').replaceChildren(...imported.problems.map((p) => el('li', { textContent: p })));
  $('import-upgraded').hidden = !imported.upgraded;
  $('import-upgraded').textContent = imported.upgraded ?? '';
  $('import-sources-button').hidden = imported.missing.length === 0;
  $('import-sources-button').onclick = () => invoke('open_sources').catch(showError);
  $('import-open').onclick = async () => {
    dialog.close();
    await openTable(imported.path);
  };
  await load().catch(() => {});
  dialog.showModal();
  $('import-open').focus();
}

/** Asks what to do with a table file of a table this computer already has (#372).
 *  Resolves 'update', 'copy', or null when cancelled. */
function askSameTable(same) {
  const dialog = $('same-dialog');
  $('same-title').textContent = `“${same.existing_name}” is already on this computer`;
  $('same-when').textContent = same.edited ? `The one here was last changed ${new Date(same.edited).toLocaleString()}.` : '';
  // Open here (#401): on the screens it can wait for the show to stop; in the editor it opens again updated.
  $('same-what').textContent = same.presenting
    ? 'The file is another version of it, and it is on the screens now. It can go in when the show stops, or the show stops now and starts again with it. This computer\'s calibration stays as it is.'
    : same.open
      ? `The file is another version of it, and it is open now. Updating opens it again with what the file has; this computer's calibration stays as it is, and the version here goes to the ${TRASH}.`
      : `The file is another version of it. Update it to show what the file has; this computer's calibration stays as it is, and the version here goes to the ${TRASH}.`;
  $('same-wait').hidden = !same.presenting;
  dialog.classList.toggle('is-showing', !!same.presenting);
  $('same-update').textContent = same.presenting ? 'Stop and update now' : 'Update it';
  $('same-update').classList.toggle('primary', !same.presenting);
    return new Promise((resolve) => {
    const done = (mode) => {
      dialog.close();
      resolve(mode);
    };
    $('same-update').onclick = () => done('update');
    $('same-wait').onclick = () => done('wait');
    $('same-copy').onclick = () => done('copy');
    $('same-cancel').onclick = () => done(null);
    dialog.oncancel = () => resolve(null);
    dialog.showModal();
    $(same.presenting ? 'same-wait' : 'same-update').focus();
  });
}

/** A table file the app was asked to open (a double click on one) while Home was coming up. */
async function openWaitingFile() {
  const file = await invoke('take_opened_file').catch(() => null);
  if (file) await openTableFile(file);
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
for (const id of ['nav-file', 'card-file']) $(id).addEventListener('click', () => openTableFile());
window.addEventListener('mrs-opened-file', () => void openWaitingFile());
$('nav-settings').addEventListener('click', () => invoke('open_settings').catch(showError));
// Operator mode (#394): the exhibition computer's own window; leaving it takes the PIN.
$('nav-operator').addEventListener('click', () => invoke('open_operator').catch(showError));
$('nav-quit').addEventListener('click', () => invoke('quit'));
$('waiting-now').addEventListener('click', async () => {
  showError();
  try {
    await invoke('update_waiting_now');
  } catch (e) {
    showError(e);
  }
  await load().catch(() => {});
});
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

load().then(openWaitingFile).catch(showError);
