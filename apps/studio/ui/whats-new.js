// What's new, on Home (#268). When a newer MR Studio is published, Home shows what it brings:
// each new feature with its first picture, taken from the release notes the pull requests
// wrote (changes/, docs/RELEASING.md). After an update it shows the running version's notes
// once, until they are put away. The release list comes from src-tauri/src/updates.rs.
(() => {
  const { invoke } = window.__TAURI__.core;
  const { listen } = window.__TAURI__.event;
  /** @type {(id: string) => any} An element by id; its kind is in the HTML. */
  const $ = (id) => document.getElementById(id);
  const el = (tag, props = {}, ...children) => {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...children);
    return node;
  };
  const GROUPS = /^(new|fixes|breaking changes?)$/i;

  /** The features of a release: every ### heading with its first picture and first sentence. */
  function features(release) {
    const out = [];
    let current = null;
    // Notes for layer writers (#593) are in the full notes, not on Home's tiles.
    let developers = false;
    for (const raw of (release.notes || '').replace(/\r/g, '').replace(/<!--[\s\S]*?-->/g, '').split('\n')) {
      const heading = /^(#{2,4})\s+(.*)$/.exec(raw.trim());
      if (heading) {
        current = null;
        const title = heading[2].trim();
        if (heading[1].length === 2) developers = /^for developers$/i.test(title);
        if (heading[1].length >= 3 && !GROUPS.test(title) && !developers) {
          current = { title: title.replace(/\s*\((#\d+(?:,\s*#\d+)*)\)$/, ''), picture: null, text: '', release };
          out.push(current);
        }
        continue;
      }
      if (!current) continue;
      const picture = /!\[[^\]]*\]\((https:\/\/[^)\s]+)/.exec(raw);
      if (picture && !current.picture) current.picture = picture[1];
      else if (!current.text && raw.trim() && !raw.trim().startsWith('!')) current.text = raw.trim().replace(/[*_`]/g, '');
    }
    return out;
  }

  function tile(feature, open) {
    const thumb = el('span', { className: 'thumb' });
    if (feature.picture) {
      // Loaded at once: lazy pictures in Home's sideways list stayed grey until scrolled to (#593).
      const img = el('img', { src: feature.picture, alt: '', draggable: false });
      img.onerror = () => img.remove();
      thumb.append(img);
    }
    const button = el('button', { type: 'button', title: feature.text }, thumb, el('b', {}, feature.title), el('small', {}, feature.text));
    button.onclick = () => open(feature);
    return el('li', {}, button);
  }

  function showNotes(releases, focus) {
    const dialog = $('news-dialog');
    $('news-dialog-body').replaceChildren(
      ...releases.map((r) => {
        const header = el('header', {}, el('h3', {}, r.title));
        if (r.published_at) header.append(el('time', {}, new Date(r.published_at).toLocaleDateString()));
        if (r.breaking) header.append(el('span', { className: 'tag' }, 'Breaking changes'));
        return el('article', {}, header, window.renderMarkdown(r.notes || 'No description was written for this release.'));
      }),
    );
    dialog.showModal();
    const target = focus && [...dialog.querySelectorAll('h4')].find((h) => h.textContent.startsWith(focus.title));
    (target ?? dialog.querySelector('article'))?.scrollIntoView({ block: 'start' });
  }

  async function load() {
    const state = await invoke('update_state');
    const stamp = [state.commit && state.commit.slice(0, 7), state.built && new Date(state.built).toLocaleDateString()].filter(Boolean);
    $('version').textContent = `Version ${state.current}`;
    $('version').title = stamp.length ? `MR Studio ${state.current}, built from ${stamp.join(' on ')}` : `MR Studio ${state.current}, built on this computer`;
    if (stamp.length) $('build').textContent = stamp.join(' · ');

    const found = state.available;
    const newer = found?.releases ?? [];
    const installed = found?.installed;
    const section = $('whats-new');
    let releases;
    if (newer.length) {
      releases = newer;
      $('news-title').textContent = `MR Studio ${found.latest} is out`;
      $('news-sub').textContent =
        newer.length > 1 ? `${newer.length} releases newer than yours (${state.current}).` : `You have ${state.current}.`;
      $('news-download').hidden = false;
      $('news-download').textContent = state.can_install ? `Update to ${found.latest}` : `Download ${found.latest}`;
      $('news-close').hidden = true;
      section.classList.toggle('breaking', !!found.breaking);
    } else if (installed && state.seen_notes !== state.current) {
      releases = [installed];
      $('news-title').textContent = `New in MR Studio ${state.current}`;
      $('news-sub').textContent = 'You are on the newest version.';
      $('news-download').hidden = true;
      $('news-close').hidden = false;
      section.classList.remove('breaking');
    } else {
      section.hidden = true;
      return;
    }
    const all = releases.flatMap(features);
    const shown = all.slice(0, 5);
    const open = (feature) => showNotes(releases, feature);
    $('news-features').replaceChildren(...shown.map((f) => tile(f, open)));
    $('news-more').textContent = all.length > shown.length ? `See all ${all.length} changes` : "See what's new";
    $('news-more').onclick = () => showNotes(releases);
    $('news-breaking').hidden = !releases.some((r) => r.breaking);
    $('news-breaking').textContent = newer.length
      ? 'This update has breaking changes. Read them before updating.'
      : 'This version changed how some things work. Read the breaking changes at the top of the notes.';
    section.hidden = false;
  }

  $('news-download').onclick = async () => {
    $('news-download').disabled = true;
    // With a signing key this installs and restarts; without one the browser downloads
    // this computer's installer.
    await invoke('install_update').catch((e) => window.showError?.(`The update did not start: ${e}`));
    $('news-download').disabled = false;
  };
  $('news-close').onclick = async () => {
    await invoke('dismiss_whats_new').catch(() => {});
    $('whats-new').hidden = true;
  };
  $('news-dialog-close').onclick = () => $('news-dialog').close();
  $('news-dialog').addEventListener('click', (e) => e.target === $('news-dialog') && $('news-dialog').close());

  window.loadWhatsNew = () => load().catch((e) => console.warn('what is new', e));
  // The shell looks for updates a few seconds after it starts and says when it knows.
  listen('updates', () => window.loadWhatsNew());
  window.loadWhatsNew();
})();
