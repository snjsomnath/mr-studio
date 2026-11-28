// The Licence page (#727): who MR Studio is licensed to here, the install code, adding a
// licence file, how it is used, and the open-source notices (#730). Commands in
// src-tauri/src/licence.rs. The page and its tab show only while licensing is shown.
(() => {
  const USES = [
    ['teaching', 'Teaching', 'At a school or university, including student projects'],
    ['research', 'Research', 'At a university or non-profit research organisation'],
    ['personal', 'Personal', 'Your own learning, hobby or study'],
    ['organisation', 'For an organisation', 'A museum, municipality or company: 90 days to evaluate, then a table licence'],
  ];
  const GOOD = ['free', 'licensed'];
  let notices = null;

  async function loadLicence() {
    const s = await invoke('licence_state');
    document.querySelector('[role=tab][data-tab="licence"]').hidden = !s.shown;
    $('licence-title').textContent = s.title;
    $('licence-detail').textContent = s.detail + (s.licence?.note ? ` ${s.licence.note}` : '');
    const pill = $('licence-pill');
    pill.textContent = s.licence ? s.licence.id : s.tier ? { education: 'Free', research: 'Free', personal: 'Free', evaluation: 'Evaluation' }[s.tier] ?? '' : 'Not set up';
    pill.className = `status-pill ${GOOD.includes(s.state) ? 'is-good' : s.reminder ? 'is-warn' : ''}`;
    $('licence-reminder').hidden = !s.reminder;
    $('licence-reminder').textContent = s.reminder ?? '';
    $('licence-problem').hidden = !s.problem;
    $('licence-problem').textContent = s.problem ?? '';
    const n = s.tables_here;
    const covered = s.entitlements.tables;
    let tables = n === 0 ? 'No tables yet' : n === 1 ? '1 table' : `${n} different tables`;
    if (covered != null) tables += n === 0 ? `, and the licence covers ${covered}` : ` of the ${covered} the licence covers`;
    $('licence-tables').textContent = `${tables}. Copies of a table count once.`;
    $('licence-code').textContent = s.install_code;
    $('licence-remove').hidden = !s.licence && !s.problem;
    $('licence-uses').replaceChildren(
      ...USES.map(([kind, name, words]) => {
        const button = el('button', { type: 'button', className: 'licence-use' }, el('b', {}, name), el('span', {}, words));
        button.setAttribute('role', 'radio');
        button.setAttribute('aria-checked', String(s.usage?.use === kind));
        button.addEventListener('click', () => run(() => invoke('licence_set_use', { kind })));
        return button;
      }),
    );
    $('notices-show').disabled = !s.notices;
    if (!s.notices) $('notices-show').title = 'This copy was built without its notices. Installed releases have them.';
  }
  window.loadLicence = () => loadLicence().catch((e) => showError(String(e)));

  async function run(action) {
    showError();
    try {
      await action();
    } catch (e) {
      showError(String(e));
    }
    window.loadLicence();
  }

  $('licence-add').addEventListener('click', () => run(() => invoke('licence_add', {})));
  $('licence-remove').addEventListener('click', () => run(() => invoke('licence_remove')));
  $('licence-copy').addEventListener('click', async () => {
    await navigator.clipboard?.writeText($('licence-code').textContent).catch(() => {});
    $('licence-copy').textContent = 'Copied';
    setTimeout(() => ($('licence-copy').textContent = 'Copy'), 1500);
  });

  function renderNotices() {
    const q = $('notices-search').value.trim().toLowerCase();
    const shown = notices.packages.filter((p) => !q || `${p.name} ${p.licence}`.toLowerCase().includes(q));
    $('notices-summary').textContent = `${shown.length} of ${notices.packages.length} libraries (${notices.rust} Rust crates, ${notices.npm} npm packages).`;
    $('notices-list').replaceChildren(
      ...shown.slice(0, 400).map((p) => {
        const details = el('details', {}, el('summary', {}, el('b', {}, p.name), el('span', {}, p.version), el('span', { className: 'licence-id' }, p.licence)));
        details.addEventListener('toggle', () => {
          if (details.open && !details.querySelector('pre')) details.append(el('pre', {}, notices.texts[p.text] ?? 'Licence text not included by the package; see its licence name above.'));
        }, { once: false });
        return details;
      }),
    );
  }
  $('notices-show').addEventListener('click', () =>
    run(async () => {
      notices ??= await invoke('licence_notices');
      $('notices').hidden = false;
      $('notices-show').hidden = true;
      renderNotices();
    }),
  );
  $('notices-search').addEventListener('input', () => notices && renderNotices());

  // The tab shows itself only while licensing is shown.
  window.loadLicence();
})();
