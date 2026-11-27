// Operator mode (#394): the exhibition computer's window in place of the editor. Present and
// stop, which screen is which, open the screens again, and how the table is doing. Leaving it,
// quitting and changing the PIN take the PIN; a forgotten one takes this computer's password.
// It talks to the shell through the commands in src-tauri/src/operator_mode.rs.
const { invoke } = window.__TAURI__.core;
/** @type {(id: string) => any} An element by id; its kind is in the HTML. */
const $ = (id) => document.getElementById(id);
/** @type {<K extends keyof HTMLElementTagNameMap>(tag: K, props?: Record<string, unknown>, ...children: (Node | string)[]) => HTMLElementTagNameMap[K]} */
const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
};
const ROLE = { table: 'Table', tv: 'Controller', dev: 'Table and controls' };

let state;
let busy = false;

function showError(message) {
  $('error').textContent = message ?? '';
  $('error').hidden = !message;
}

async function load() {
  state = await invoke('operator_state');
  $('table').textContent = state.table ?? (state.last_table ? `Ready to present ${state.last_table}` : 'No table open');
  $('status').textContent = state.presenting ? 'Presenting' : 'Not presenting';
  $('status').classList.toggle('on', state.presenting);
  $('present').textContent = state.presenting ? 'Stop presenting' : 'Present';
  $('present').classList.toggle('stop', state.presenting);
  $('present').disabled = busy || (!state.table && !state.last_table);
  $('restart').hidden = !state.presenting;
  $('phones').textContent = !state.table
    ? ''
    : state.lan
      ? `Phones join with code ${state.code}. ${state.phones === 0 ? 'No phones are' : state.phones === 1 ? 'One phone is' : `${state.phones} phones are`} connected.`
      : 'Phones cannot join: this computer keeps the table to itself (Settings, Phones and startup).';
  $('no-pin').hidden = state.pin_set;
  $('set-pin').textContent = state.pin_set ? 'Change the PIN…' : 'Set a PIN…';
  $('screens').replaceChildren(
    ...state.screens.map((s) => {
      // A screen not in use yet says what it shows when presenting, as Settings › Screens does (#579).
      const roles = (list) => list.map((r) => ROLE[r] ?? r).join(' and ');
      const shows = s.shows.length ? roles(s.shows) : s.planned?.length ? `${roles(s.planned)} (when presenting)` : '';
      const health = s.alive == null ? ['', ''] : s.alive ? ['ok', s.fps ? `Running, ${Math.round(s.fps)} fps` : 'Running'] : ['bad', 'Not answering'];
      return el(
        'li',
        {},
        el('span', { className: 'n' }, String(s.number)),
        el('span', { className: 'what' }, el('b', {}, shows || 'Not used'), el('span', {}, `${s.name}${s.primary ? ', main display' : ''}`)),
        el('span', { className: `health ${health[0]}` }, health[1]),
      );
    }),
  );
  $('problems-panel').hidden = state.problems.length === 0;
  $('problems').replaceChildren(...state.problems.map((p) => el('li', {}, p)));
  const who = state.mac
    ? 'Use the password of the Mac account that is logged in.'
    : /Win/i.test(navigator.platform)
      ? 'Use the password of the Windows account that is logged in.'
      : 'Use the password of an administrator of this computer.';
  document.querySelectorAll('[data-who]').forEach((node) => (node.textContent = who));
}

async function run(button, command, args) {
  showError();
  busy = true;
  button.disabled = true;
  try {
    await invoke(command, args);
  } catch (e) {
    showError(String(e));
  }
  busy = false;
  button.disabled = false;
  await load().catch((e) => showError(String(e)));
}

$('present').addEventListener('click', () => run($('present'), state?.presenting ? 'stop_presenting' : 'operator_present'));
$('restart').addEventListener('click', () => run($('restart'), 'operator_restart_screens'));
$('identify').addEventListener('click', () => run($('identify'), 'identify'));

// ---- Dialogs ----

let quitting = false;

function open(name) {
  const which = name === 'quit' ? 'leave' : name;
  quitting = name === 'quit';
  $('scrim').hidden = false;
  document.querySelectorAll('[data-dialog]').forEach((d) => (d.hidden = d.id !== `dialog-${which}`));
  const dialog = $(`dialog-${which}`);
  dialog.reset();
  dialog.querySelector('[data-error]').hidden = true;
  if (which === 'leave') {
    dialog.querySelector('[data-title]').textContent = quitting ? 'Quit MR Studio' : 'Leave operator mode';
    dialog.querySelector('[data-lead]').textContent = quitting
      ? 'The table comes off the screens and MR Studio closes.'
      : state?.start
        ? 'The table stays on the screens and the editor opens. The next start is in operator mode again; Settings turns that off.'
        : 'The table stays on the screens and the editor opens.';
    dialog.querySelector('[data-submit]').textContent = quitting ? 'Quit' : 'Leave';
  }
  dialog.querySelectorAll('[data-current]').forEach((node) => (node.hidden = !state?.pin_set));
  queueMicrotask(() => [...dialog.querySelectorAll('input')].find((i) => i.offsetParent)?.focus());
}

function close() {
  $('scrim').hidden = true;
}

function fail(dialog, message) {
  const error = dialog.querySelector('[data-error]');
  error.textContent = message;
  error.hidden = false;
}

document.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => open(b.dataset.open)));
document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close));
window.addEventListener('keydown', (event) => event.key === 'Escape' && !$('scrim').hidden && $('dialog-shift').hidden && close());

async function submit(dialog, command, args, after) {
  const button = dialog.querySelector('[type=submit]');
  button.disabled = true;
  try {
    await invoke(command, args);
    after?.();
  } catch (e) {
    fail(dialog, String(e));
  }
  button.disabled = false;
  await load().catch(() => {});
}

const value = (form, name) => form.elements[name].value.trim();
const samePins = (form) => {
  if (value(form, 'pin') === value(form, 'again')) return true;
  fail(form, 'The two new PINs are not the same.');
  return false;
};

$('dialog-leave').addEventListener('submit', (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  void submit(form, 'operator_exit', { pin: value(form, 'pin'), quit: quitting });
});

$('dialog-set').addEventListener('submit', (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!samePins(form)) return;
  void submit(form, 'operator_set_pin', { current: state?.pin_set ? value(form, 'current') : null, pin: value(form, 'pin') }, close);
});

$('dialog-forgot').addEventListener('submit', (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!samePins(form)) return;
  void submit(form, 'operator_password', { password: form.elements.password.value, pin: value(form, 'pin') }, close);
});

$('dialog-shift').addEventListener('submit', (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  void submit(form, 'operator_password', { password: form.elements.password.value, pin: null });
});
$('stay').addEventListener('click', () => {
  close();
  void run($('present'), 'operator_present');
});

load()
  .then(() => location.hash === '#shift' && open('shift'))
  .catch((e) => showError(String(e)));
// Keeps the screens' health current.
setInterval(() => !busy && load().catch(() => {}), 2000);
