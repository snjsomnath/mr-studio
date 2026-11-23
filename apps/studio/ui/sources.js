// The Sources page (#41): one card per outside service, with its address, how it signs in,
// a field for its key, Save and Test. Keys go to the shell and on into the system keychain;
// they are never read back, so a saved key shows only as "saved". Commands in
// src-tauri/src/main.rs, logic in crates/mrs-host/src/sources.rs. In a plain browser on the
// host (`pnpm dev`), the same calls go to the host's /api/sources.
(() => {
  const tauri = window.__TAURI__?.core;
  const json = async (response) => {
    if (response.status === 204) return null;
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
    return body;
  };
  const api = tauri
    ? {
        page: () => tauri.invoke('sources_page'),
        save: (change) => tauri.invoke('sources_save', { change }),
        remove: (id) => tauri.invoke('sources_remove', { id }),
        test: (id) => tauri.invoke('sources_test', { id }),
        open: (url) => tauri.invoke('open_link', { url }),
      }
    : {
        page: () => fetch('/api/sources').then(json),
        save: (change) => fetch('/api/sources', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(change) }).then(json),
        remove: (id) => fetch(`/api/sources/${encodeURIComponent(id)}`, { method: 'DELETE' }).then(json),
        test: (id) => fetch(`/api/sources/${encodeURIComponent(id)}/test`, { method: 'POST' }).then(json),
        open: (url) => window.open(url, '_blank', 'noopener'),
      };

  const $ = (id) => document.getElementById(id);
  function el(tag, props = {}, ...children) {
    const node = Object.assign(document.createElement(tag), props);
    for (const child of children) if (child != null) node.append(child);
    return node;
  }

  const platform = navigator.userAgent.includes('Windows') ? 'windows' : navigator.userAgent.includes('Mac') ? 'mac' : 'other';
  $('vault-name').textContent = platform === 'windows' ? 'Windows Credential Manager' : platform === 'mac' ? 'the macOS Keychain' : "this computer's keychain";

  /** How a service signs in, in words, and which fields that needs. */
  const AUTH = {
    none: { label: 'Open, no key', user: null, secret: null, param: null },
    query: { label: 'Key in the address', user: null, secret: 'Key', param: 'Parameter name' },
    header: { label: 'Key in a header', user: null, secret: 'Key', param: 'Header name' },
    bearer: { label: 'Bearer token', user: null, secret: 'Token', param: null },
    basic: { label: 'User name and password', user: 'User name', secret: 'Password', param: null },
    'client-credentials': { label: 'Client id and secret', user: 'Client ID', secret: 'Client secret', param: 'Token address (optional)' },
  };
  /** Words a named service uses for its own key. */
  const WORDS = {
    mapbox: { secret: 'Access token', placeholder: 'pk.…' },
    vasttrafik: { user: 'Client ID (optional)', secret: 'Client secret or authentication key', placeholder: 'From developer.vasttrafik.se' },
    lantmateriet: { user: 'Geotorget user name', secret: 'Password' },
    carto: { secret: 'API key' },
  };
  const INITIALS = { vasttrafik: 'VT', lantmateriet: 'LM', mapbox: 'Mb', carto: 'CA', wms: 'WMS', wmts: 'WT', arcgis: 'AG', tiles: 'XYZ' };

  let templates = [];
  /** Test results this page has seen; a fresh one is shown under the card. */
  const fresh = new Map();

  function showError(error) {
    $('error').textContent = String(error?.message ?? error);
    $('error').hidden = false;
  }

  function pill(source) {
    if (source.problem) return el('span', { className: 'pill bad', textContent: 'Keychain problem' });
    if (!source.ready) return el('span', { className: 'pill warn', textContent: 'Needs a key' });
    if (source.status?.ok === false) return el('span', { className: 'pill bad', textContent: 'Test failed' });
    if (source.status?.ok) return el('span', { className: 'pill good', textContent: 'Works' });
    return el('span', { className: 'pill idle', textContent: 'Not tested' });
  }

  function card(source) {
    const template = templates.find((t) => t.kind === source.kind);
    const words = WORDS[source.kind] ?? {};
    const form = el('form', { className: 'card' });
    form.dataset.id = source.id;
    form.noValidate = true;

    form.append(
      el(
        'div',
        { className: 'card-head' },
        el('span', { className: 'mark', textContent: INITIALS[source.kind] ?? '•' }),
        el('div', { className: 'title' }, el('b', { textContent: source.name }), el('span', { className: 'purpose', textContent: template?.purpose ?? '' })),
        pill(source),
      ),
    );

    const fields = el('div', { className: 'fields' });
    const name = el('input', { value: source.name, maxLength: 80 });
    const url = el('input', { value: source.url, placeholder: 'https://', spellcheck: false });
    const auth = el('select');
    for (const [value, a] of Object.entries(AUTH)) auth.append(el('option', { value, textContent: a.label, selected: value === source.auth }));
    const param = el('input', { value: source.param ?? '', spellcheck: false });
    const user = el('input', { value: source.user ?? '', spellcheck: false, autocomplete: 'off' });
    const secret = el('input', { type: 'password', autocomplete: 'new-password', spellcheck: false, placeholder: source.has_secret ? '•••••••• saved. Type to replace it' : words.placeholder ?? '' });
    const forget = el('button', { type: 'button', className: 'quiet', textContent: 'Forget', title: 'Remove the saved key from this computer' });
    forget.hidden = !source.has_secret;

    const paramLabel = el('label', {}, '', param);
    const userLabel = el('label', {}, '', user);
    const secretLabel = el('label', { className: 'wide' }, '', el('div', { className: 'key-row' }, secret, forget));
    const nameLabel = el('label', {}, 'Name', name);
    const authLabel = el('label', {}, 'Sign-in', auth);
    fields.append(nameLabel, authLabel, el('label', { className: 'wide' }, source.url.includes('{z}') ? 'Tile address ({z}/{x}/{y})' : 'Address', url), userLabel, paramLabel, secretLabel);

    // A named service needs only its key; how it signs in stays behind More settings.
    let more = !template?.single;
    const layout = () => {
      const a = AUTH[auth.value];
      nameLabel.hidden = !more;
      authLabel.hidden = !more;
      paramLabel.hidden = !a.param || !more;
      paramLabel.firstChild.textContent = a.param ?? '';
      userLabel.hidden = !a.user;
      userLabel.firstChild.textContent = (auth.value === source.auth && words.user) || a.user || '';
      secretLabel.hidden = !a.secret;
      secretLabel.firstChild.textContent = (auth.value === source.auth && words.secret) || a.secret || '';
      if (a.param && !param.value) param.value = auth.value === 'query' ? 'key' : auth.value === 'header' ? 'X-API-Key' : '';
    };
    auth.addEventListener('change', layout);
    layout();
    form.append(fields);

    const result = el('p', { className: 'result', hidden: true });
    const shown = fresh.get(source.id) ?? (source.problem ? { ok: false, message: source.problem } : null);
    if (shown) Object.assign(result, { hidden: false, className: `result ${shown.ok ? 'good' : 'bad'}`, textContent: shown.message });
    form.append(result);

    const save = el('button', { type: 'submit', className: 'primary', textContent: 'Save', disabled: true });
    const test = el('button', { type: 'button', textContent: 'Test' });
    const remove = el('button', { type: 'button', className: 'quiet', textContent: 'Remove' });
    const actions = el('div', { className: 'actions' }, save, test, el('span', { className: 'spacer' }));
    if (!more) {
      const toggle = el('a', { className: 'link', textContent: 'More settings', href: '#' });
      toggle.addEventListener('click', (event) => {
        event.preventDefault();
        more = !more;
        toggle.textContent = more ? 'Fewer settings' : 'More settings';
        layout();
      });
      actions.append(toggle);
    }
    if (template?.get_key) {
      const link = el('a', { className: 'link', textContent: source.kind === 'lantmateriet' ? 'Get an account ↗' : 'Get a key ↗', href: template.get_key });
      link.addEventListener('click', (event) => {
        event.preventDefault();
        api.open(template.get_key);
      });
      actions.append(link);
    }
    actions.append(remove);
    form.append(actions);

    const dirty = () => (save.disabled = false);
    for (const input of [name, url, param, user, secret]) input.addEventListener('input', dirty);
    auth.addEventListener('change', dirty);

    const busy = (words) => Object.assign(result, { hidden: false, className: 'result busy', textContent: words });

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      save.disabled = true;
      busy('Saving…');
      try {
        await api.save({ id: source.id, name: name.value, url: url.value, auth: auth.value, param: param.value, user: user.value, secret: secret.value || undefined });
        secret.value = '';
        fresh.delete(source.id);
        await load();
        // A new key is tried at once, so the card says whether it works.
        const after = document.querySelector(`form[data-id="${CSS.escape(source.id)}"]`);
        after?.querySelector('button:not(.primary):not(.quiet)')?.click();
      } catch (error) {
        save.disabled = false;
        Object.assign(result, { className: 'result bad', textContent: String(error?.message ?? error) });
      }
    });
    test.addEventListener('click', async () => {
      test.disabled = true;
      busy('Trying the service…');
      try {
        const status = await api.test(source.id);
        fresh.set(source.id, status);
        await load();
      } catch (error) {
        Object.assign(result, { className: 'result bad', textContent: String(error?.message ?? error) });
      } finally {
        test.disabled = false;
      }
    });
    forget.addEventListener('click', async () => {
      try {
        await api.save({ id: source.id, forget_secret: true });
        fresh.delete(source.id);
        await load();
      } catch (error) {
        showError(error);
      }
    });
    remove.addEventListener('click', async () => {
      if (remove.dataset.armed !== '1') {
        remove.dataset.armed = '1';
        remove.textContent = 'Remove, and forget its key?';
        setTimeout(() => {
          remove.dataset.armed = '';
          remove.textContent = 'Remove';
        }, 4000);
        return;
      }
      try {
        await api.remove(source.id);
        fresh.delete(source.id);
        await load();
      } catch (error) {
        showError(error);
      }
    });
    return form;
  }

  function adder(template) {
    const button = el('button', { type: 'button' }, el('b', { textContent: template.single ? template.name : `${template.name}…` }), el('span', { textContent: template.purpose }));
    button.addEventListener('click', async () => {
      try {
        const change = { kind: template.kind };
        if (!template.single) {
          // A custom service starts with a name and an address to fill in on its card.
          const n = document.querySelectorAll('.card').length + 1;
          Object.assign(change, { name: `${template.name} ${n}`, url: template.kind === 'tiles' ? 'https://example.org/{z}/{x}/{y}.png' : 'https://example.org/service' });
        }
        const view = await api.save(change);
        await load();
        document.querySelector(`form[data-id="${CSS.escape(view.id)}"] input`)?.focus();
      } catch (error) {
        showError(error);
      }
    });
    return button;
  }

  async function load() {
    const page = await api.page();
    templates = page.templates;
    $('error').hidden = true;
    $('empty').hidden = page.sources.length > 0;
    $('cards').replaceChildren(...page.sources.map(card));
    const have = new Set(page.sources.map((s) => s.kind));
    $('add').replaceChildren(...templates.filter((t) => !(t.single && have.has(t.kind))).map(adder));
  }

  load().catch(showError);
  // Another window (or a second Sources page) may have changed something.
  window.addEventListener('focus', () => {
    if (!document.querySelector('.card button.primary:not(:disabled)')) load().catch(showError);
  });
})();
