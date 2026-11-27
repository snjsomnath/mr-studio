// The Colour tab: the final colour pass per display. Commands in src-tauri/src/main.rs,
// the pass itself in src-tauri/src/colour.js.
(() => {
  /** @type {[key: string, label: string, min: number, max: number, neutral: number][]} */
  const SLIDERS = [
    ['saturation', 'Saturation', 0, 2.5, 1],
    ['contrast', 'Contrast', 0.5, 2, 1],
    ['brightness', 'Brightness', 0.5, 1.5, 1],
    ['gamma', 'Gamma (midtones)', 0.5, 2.5, 1],
    ['temperature', 'White balance: cool to warm', -1, 1, 0],
    ['tint', 'White balance: green to magenta', -1, 1, 0],
  ];
  const CUSTOM = '';

  let colourState;
  let display = null; // index of the display being edited
  let pending = null;
  let sending = false;

  const current = () => colourState.displays.find((d) => d.display === display);
  const same = (a, b) => SLIDERS.every(([key]) => Math.abs(a[key] - b[key]) < 1e-6);

  async function loadColour() {
    colourState = await invoke('colour_state');
    if (!current()) {
      // Start on the table if there is one, since that is the one worth tuning.
      const preferred = colourState.displays.find((d) => d.role === 'table') ?? colourState.displays.find((d) => d.role) ?? colourState.displays[0];
      display = preferred?.display ?? null;
    }
    render();
  }

  function render() {
    $('colour-displays').replaceChildren(
      ...colourState.displays.map((d) => {
        const radio = el('input', { type: 'radio', name: 'colour-display', checked: d.display === display });
        radio.addEventListener('change', () => {
          setTestCard(false);
          display = d.display;
          render();
        });
        const role = { table: 'the table', tv: 'the controller', dev: 'table and controls' }[d.role] ?? 'not used';
        return el('li', {}, el('label', {}, radio, el('span', { className: 'name' }, `${d.display + 1} · ${d.name}`), el('span', { className: 'role' }, role)));
      }),
    );
    const colour = current()?.colour;
    $('sliders').replaceChildren(
      ...SLIDERS.flatMap(([key, label, min, max, neutral]) => {
        const output = el('output', {}, colour ? colour[key].toFixed(2) : '');
        const range = el('input', { type: 'range', min, max, step: 0.01, value: colour?.[key] ?? neutral, disabled: !colour, ariaLabel: label });
        const change = (value) => {
          current().colour[key] = value;
          output.textContent = value.toFixed(2);
          renderPresets();
          send();
        };
        range.addEventListener('input', () => change(Number(range.value)));
        range.addEventListener('dblclick', () => {
          range.value = String(neutral);
          change(neutral);
        });
        return [el('label', {}, label), range, output];
      }),
    );
    renderPresets();
    renderLayers();
  }

  function renderLayers() {
    $('layers-block').hidden = colourState.layers.length === 0;
    $('layer-sliders').replaceChildren(
      ...colourState.layers.flatMap((layer) => {
        const output = el('output', {}, layer.intensity.toFixed(2));
        const range = el('input', { type: 'range', min: 0, max: 2, step: 0.01, value: layer.intensity, ariaLabel: `${layer.name} intensity` });
        const change = (value) => {
          layer.intensity = value;
          output.textContent = value.toFixed(2);
          sendLayer(layer);
        };
        range.addEventListener('input', () => change(Number(range.value)));
        range.addEventListener('dblclick', () => {
          range.value = '1';
          change(1);
        });
        return [el('label', {}, layer.active ? layer.name : `${layer.name} (off)`), range, output];
      }),
    );
  }

  const layerQueue = new Map(); // layer id -> latest value not yet sent
  let sendingLayers = false;
  async function sendLayer(layer) {
    layerQueue.set(layer.id, layer.intensity);
    if (sendingLayers) return;
    sendingLayers = true;
    while (layerQueue.size) {
      const [id, intensity] = layerQueue.entries().next().value;
      layerQueue.delete(id);
      try {
        await invoke('set_layer_intensity', { layer: id, intensity });
      } catch (e) {
        showError(String(e));
      }
    }
    sendingLayers = false;
  }

  function renderPresets() {
    const colour = current()?.colour;
    const match = colour && colourState.presets.find((p) => same(p.colour, colour));
    $('preset').replaceChildren(
      el('option', { value: CUSTOM, disabled: true, hidden: !!match }, 'Custom'),
      ...colourState.presets.map((p) => el('option', { value: p.name }, p.name)),
    );
    $('preset').value = match?.name ?? CUSTOM;
    $('preset').disabled = !colour;
    $('preset-delete').disabled = !match || match.built_in;
  }

  // Sliders fire faster than the shell needs; send the latest value once the last one is done.
  async function send() {
    pending = { display, colour: { ...current().colour } };
    if (sending) return;
    sending = true;
    while (pending) {
      const next = pending;
      pending = null;
      try {
        await invoke('set_colour', next);
      } catch (e) {
        showError(String(e));
      }
    }
    sending = false;
  }

  function setTestCard(on) {
    $('test-card').checked = on;
    if (display !== null) invoke('test_card', { display, on });
  }

  $('preset').addEventListener('change', () => {
    const preset = colourState.presets.find((p) => p.name === $('preset').value);
    if (!preset || !current()) return;
    current().colour = { ...preset.colour };
    render();
    send();
  });

  $('colour-reset').addEventListener('click', () => {
    if (!current()) return;
    current().colour = { ...colourState.presets[0].colour };
    render();
    send();
  });

  $('preset-save').addEventListener('click', async () => {
    if (!current()) return;
    showError();
    try {
      await invoke('save_preset', { name: $('preset-name').value, colour: current().colour });
      $('preset-name').value = '';
      await loadColour();
    } catch (e) {
      showError(String(e));
    }
  });

  $('preset-delete').addEventListener('click', async () => {
    await invoke('delete_preset', { name: $('preset').value });
    await loadColour();
  });

  $('test-card').addEventListener('change', () => setTestCard($('test-card').checked));

  for (const tab of document.querySelectorAll('[role=tab]')) {
    tab.addEventListener('click', () => {
      for (const other of document.querySelectorAll('[role=tab]')) {
        other.setAttribute('aria-selected', String(other === tab));
        $(`tab-${other.dataset.tab}`).hidden = other !== tab;
      }
      if (tab.dataset.tab === 'colour') loadColour().catch((e) => showError(String(e)));
      else setTestCard(false);
      if (tab.dataset.tab === 'calibration') window.loadCalibration();
      if (tab.dataset.tab === 'updates') window.loadUpdates();
      if (tab.dataset.tab === 'cli') window.loadCli();
    });
  }
  // Never leave the test card up behind a closed launcher.
  window.addEventListener('beforeunload', () => setTestCard(false));
})();
