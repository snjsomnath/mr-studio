// Injected by the shell into every surface window: the final colour pass for the
// display the window is on. Only what a GPU composites cheaply is used (#181): CSS
// filter functions on the root element for saturation, contrast and brightness, and two
// blended layers over the page for midtones (soft-light grey) and white balance
// (multiply by channel gains). SVG filters made WebKit on the Mac redraw in software and
// freeze over the animated map, so there are none. The editor's preview does the same
// (packages/runtime/src/editor/display-tab.ts): change both together.
(() => {
  const fmt = (n) => Number(n).toFixed(4);

  // White balance as channel gains, scaled so no channel goes above 1 (nothing clips).
  function gains(temperature, tint) {
    const raw = [(1 + 0.25 * temperature) * (1 + 0.1 * tint), 1 - 0.2 * tint, (1 - 0.25 * temperature) * (1 + 0.1 * tint)];
    const top = Math.max(...raw);
    return raw.map((g) => g / top);
  }

  // The soft-light grey whose curve puts mid grey where gamma would: black and white stay put.
  function midtoneGrey(gamma) {
    const target = Math.pow(0.5, 1 / gamma);
    const level = target <= 0.5 ? 2 * target - 0.5 : ((target - 0.5) / (Math.SQRT1_2 - 0.5) + 1) / 2;
    return Math.round(Math.min(1, Math.max(0, level)) * 255);
  }

  function layer(id, blend) {
    let node = document.getElementById(id);
    if (!node && document.body) {
      node = document.createElement('div');
      node.id = id;
      node.setAttribute('aria-hidden', 'true');
      node.style.cssText = `position:fixed;inset:0;pointer-events:none;z-index:2147483647;mix-blend-mode:${blend}`;
      document.body.append(node);
    }
    return node;
  }

  let current = null;
  function apply() {
    const s = current;
    if (!s) return;
    const plain = s.saturation === 1 && s.contrast === 1 && s.brightness === 1;
    document.documentElement.style.filter = plain ? '' : `saturate(${fmt(s.saturation)}) contrast(${fmt(s.contrast)}) brightness(${fmt(s.brightness)})`;
    const mid = layer('mrs-colour-midtones', 'soft-light');
    if (mid) {
      const grey = midtoneGrey(s.gamma);
      mid.style.display = s.gamma === 1 ? 'none' : '';
      mid.style.background = `rgb(${grey}, ${grey}, ${grey})`;
    }
    const balance = layer('mrs-colour-balance', 'multiply');
    if (balance) {
      const [r, g, b] = gains(s.temperature, s.tint).map((v) => Math.round(v * 255));
      balance.style.display = s.temperature === 0 && s.tint === 0 ? 'none' : '';
      balance.style.background = `rgb(${r}, ${g}, ${b})`;
    }
  }
  window.__mrsColour = (settings) => {
    current = settings;
    apply();
  };
  // The controller's size on this display (#682): style.css and the dashboard multiply their
  // unit by it. The table ignores it, since its text is sized in millimetres on the model.
  window.__mrsSize = (size) => {
    const root = document.documentElement;
    if (size === 1) root.style.removeProperty('--mrs-ui-scale');
    else root.style.setProperty('--mrs-ui-scale', String(size));
  };

  // The script runs before the page exists; the blended layers need a body.
  document.addEventListener('DOMContentLoaded', apply);

  // Colour bars, grey steps and a smooth ramp, to judge the settings on the real surface.
  window.__mrsTestCard = (on) => {
    document.getElementById('mrs-test-card')?.remove();
    if (!on || !document.body) return;
    const bars = ['#fff', '#ff0', '#0ff', '#0f0', '#f0f', '#f00', '#00f', '#000'];
    const steps = (colours) => `linear-gradient(90deg, ${colours.map((c, i) => `${c} ${(i * 100) / colours.length}% ${((i + 1) * 100) / colours.length}%`).join(', ')})`;
    const greys = Array.from({ length: 16 }, (_, i) => `rgb(${i * 17} ${i * 17} ${i * 17})`);
    const card = document.createElement('div');
    card.id = 'mrs-test-card';
    card.style.cssText = 'position:fixed;inset:0;z-index:2147483646;display:grid;grid-template-rows:5fr 2fr 1fr 1fr 1fr 1fr';
    const rows = [steps(bars), steps(greys), 'linear-gradient(90deg, #000, #fff)', 'linear-gradient(90deg, #000, #f00)', 'linear-gradient(90deg, #000, #0f0)', 'linear-gradient(90deg, #000, #00f)'];
    for (const background of rows) {
      const row = document.createElement('div');
      row.style.background = background;
      card.append(row);
    }
    document.body.append(card);
  };
})();
