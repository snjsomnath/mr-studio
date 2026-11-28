// Home's part of licensing (#728, #729): asks once how MR Studio will be used, and shows the
// licence reminder. Only while licensing is shown (mrs_licence::shown); otherwise it does nothing.
(() => {
  const { invoke } = window.__TAURI__.core;
  /** @type {(id: string) => any} */
  const $ = (id) => document.getElementById(id);
  const USES = [
    ['teaching', 'Teaching and learning', 'At a school or university, including student projects. Free.'],
    ['research', 'Research', 'At a university or a non-profit research organisation. Free.'],
    ['personal', 'Personal', 'Your own learning, hobby or study, not for an employer or client. Free.'],
    ['organisation', 'For an organisation', 'A museum, municipality, company, or a table you set up for a client. Evaluate everything for 90 days, then a table licence.'],
  ];

  async function check() {
    const s = await invoke('licence_state');
    if (!s.shown) return;
    $('licence-reminder').hidden = !s.reminder;
    $('licence-reminder-text').textContent = s.reminder ?? '';
    if (s.state === 'unanswered' && !s.licence) ask();
  }

  function ask() {
    const dialog = $('use-dialog');
    if (dialog.open) return;
    let chosen = null;
    const buttons = USES.map(([kind, name, words]) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.setAttribute('role', 'radio');
      button.setAttribute('aria-checked', 'false');
      const b = document.createElement('b');
      b.textContent = name;
      const span = document.createElement('span');
      span.textContent = words;
      button.append(b, span);
      button.addEventListener('click', () => {
        chosen = kind;
        for (const other of buttons) other.setAttribute('aria-checked', String(other === button));
        $('use-confirm').disabled = false;
        $('use-note').textContent = kind === 'organisation' ? 'Already have a licence file? Double-click it, or add it in Settings, Licence.' : '';
      });
      return button;
    });
    $('use-choices').replaceChildren(...buttons);
    $('use-confirm').onclick = async () => {
      if (!chosen) return;
      await invoke('licence_set_use', { kind: chosen }).catch(() => {});
      dialog.close();
      check();
    };
    // The question is answered, not dismissed: Esc leaves it for the next start.
    dialog.showModal();
  }

  $('licence-reminder-open').addEventListener('click', () => invoke('open_settings', { page: 'licence' }));
  window.addEventListener('focus', () => check().catch(() => {}));
  check().catch(() => {});
})();
