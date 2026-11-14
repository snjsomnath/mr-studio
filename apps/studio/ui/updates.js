// The Updates tab: says whether a newer MR Studio exists, shows what it brings before
// anyone installs it, and puts breaking changes first. Commands in src-tauri/src/main.rs.
(() => {
  let installing = false;

  function article(release) {
    const header = el('header', {}, el('h3', {}, release.title));
    if (release.published_at) header.append(el('time', {}, new Date(release.published_at).toLocaleDateString()));
    if (release.breaking) header.append(el('span', { className: 'tag' }, 'Breaking changes'));
    return el('article', {}, header, window.renderMarkdown(release.notes || 'No description was written for this release.'));
  }

  async function loadUpdates() {
    const state = await invoke('update_state');
    const found = state.available;
    const releases = found?.releases ?? [];
    $('updates-automatic').checked = state.automatic;
    $('updates-badge').hidden = !found?.latest;
    $('updates-badge').classList.toggle('breaking-badge', !!found?.breaking);

    let status;
    if (found?.latest) {
      const behind = releases.length > 1 ? ` That is ${releases.length} releases ahead of yours.` : '';
      status = `MR Studio ${found.latest} is available. You have ${state.current}.${behind}`;
    } else if (found) status = `MR Studio ${state.current} is the newest version.`;
    else if (state.error) status = `Could not look for updates (${state.error}). You have ${state.current}.`;
    else status = `You have MR Studio ${state.current}. Not checked yet.`;
    $('updates-status').textContent = status;

    // Breaking changes come before everything else, from every release in between.
    const breaking = releases.filter((r) => r.breaking);
    $('updates-breaking').hidden = breaking.length === 0;
    $('updates-breaking').replaceChildren(
      el('h3', {}, 'This update has breaking changes'),
      ...breaking.flatMap((r) => [
        el('h4', {}, r.title),
        r.breaking_notes ? window.renderMarkdown(r.breaking_notes) : el('p', {}, 'A new major version. Read its notes below before updating.'),
      ]),
      el('p', { className: 'hint' }, 'Sites saved by an older version are upgraded when they are opened, and the original file is kept beside the new one.'),
    );

    $('updates-install').hidden = !found?.latest;
    $('updates-install').disabled = installing;
    $('updates-install').textContent = state.can_install ? `Update to ${found?.latest} and restart` : 'Open the download page';
    if (!installing) {
      $('updates-note').textContent = !found?.latest ? '' : state.can_install ? 'The running session stops while the update installs.' : 'This copy cannot install updates by itself. Download the installer and run it.';
    }
    $('updates-notes').replaceChildren(...releases.map(article));
  }
  window.loadUpdates = () => loadUpdates().catch((e) => showError(String(e)));

  $('updates-check').addEventListener('click', async () => {
    $('updates-check').disabled = true;
    $('updates-status').textContent = 'Looking for updates…';
    try {
      await invoke('check_updates');
    } catch (e) {
      showError(String(e));
    }
    $('updates-check').disabled = false;
    window.loadUpdates();
  });

  $('updates-install').addEventListener('click', async () => {
    showError();
    installing = true;
    $('updates-install').disabled = true;
    try {
      // On success the app restarts, or the download page opens.
      await invoke('install_update');
    } catch (e) {
      showError(`The update was not installed: ${e}`);
    }
    installing = false;
    $('updates-progress').hidden = true;
    window.loadUpdates();
  });

  $('updates-automatic').addEventListener('change', () => invoke('set_update_check', { automatic: $('updates-automatic').checked }).catch((e) => showError(String(e))));

  const { listen } = window.__TAURI__.event;
  // The shell looks for updates a few seconds after it starts and says when it knows.
  listen('updates', () => window.loadUpdates());
  listen('update-progress', ({ payload }) => {
    $('updates-progress').hidden = false;
    if (payload.total) $('updates-progress').value = payload.received / payload.total;
    else $('updates-progress').removeAttribute('value');
    $('updates-note').textContent = `Downloading… ${(payload.received / 1e6).toFixed(1)} MB`;
  });
  window.loadUpdates();
})();
