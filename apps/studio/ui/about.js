// The About window (#699): the version and build of this copy, the computer's system, and the
// open-source notices (the same list as Settings › Licence). Commands in src/about.rs.
(() => {
  const { invoke } = window.__TAURI__.core;
  /** @type {(id: string) => any} An element by id; its kind is in the HTML. */
  const $ = (id) => document.getElementById(id);
  const el = (tag, props = {}, ...children) => {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...children);
    return node;
  };
  let version = '';

  invoke('about_info').then((info) => {
    version = info.version;
    $('version').textContent = `Version ${info.version}`;
    const build = [info.commit && `build ${info.commit.slice(0, 7)}`, info.built].filter(Boolean).join(', ');
    $('build').textContent = build ? `(${build})` : '';
    $('system').textContent = info.system;
  });

  $('whats-new').addEventListener('click', () => {
    const url = version ? `https://github.com/snjsomnath/mr-studio/releases/tag/v${version}` : 'https://github.com/snjsomnath/mr-studio/releases';
    void invoke('open_link', { url });
  });

  /** @type {{ packages: { name: string, version: string, licence: string, text?: string }[], texts: Record<string, string>, rust: number, npm: number } | null} */
  let notices = null;
  function renderNotices() {
    if (!notices) return;
    const list = notices;
    const q = $('notices-search').value.trim().toLowerCase();
    const shown = list.packages.filter((p) => !q || `${p.name} ${p.licence}`.toLowerCase().includes(q));
    $('notices-summary').textContent = `${shown.length} of ${list.packages.length} libraries (${list.rust} Rust crates, ${list.npm} npm packages).`;
    $('notices-list').replaceChildren(
      ...shown.slice(0, 400).map((p) => {
        const details = el('details', {}, el('summary', {}, el('b', {}, p.name), el('span', {}, p.version), el('span', { className: 'licence-id' }, p.licence)));
        details.addEventListener('toggle', () => {
          if (details.open && !details.querySelector('pre')) details.append(el('pre', {}, (p.text && list.texts[p.text]) ?? 'The package does not include its licence text; its licence is named above.'));
        });
        return details;
      }),
    );
  }
  $('notices-show').addEventListener('click', async () => {
    try {
      notices ??= await invoke('licence_notices');
      $('notices').hidden = false;
      $('notices-show').hidden = true;
      renderNotices();
    } catch (e) {
      $('notices-error').hidden = false;
      $('notices-error').textContent = String(e);
    }
  });
  $('notices-search').addEventListener('input', renderNotices);
})();
