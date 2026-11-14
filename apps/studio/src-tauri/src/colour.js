// Injected by the shell into every surface window: the final colour pass for the
// display the window is on. One CSS filter on the root element covers the map, the
// field overlays and every decoration, whatever drew them.
(() => {
  const SVG = 'http://www.w3.org/2000/svg';
  const fmt = (n) => Number(n).toFixed(4);

  // White balance as channel gains, scaled so no channel goes above 1 (nothing clips).
  function gains(temperature, tint) {
    const raw = [(1 + 0.25 * temperature) * (1 + 0.1 * tint), 1 - 0.2 * tint, (1 - 0.25 * temperature) * (1 + 0.1 * tint)];
    const top = Math.max(...raw);
    return raw.map((g) => g / top);
  }

  function filterFor(s) {
    const neutralBalance = s.temperature === 0 && s.tint === 0;
    if (s.saturation === 1 && s.contrast === 1 && s.brightness === 1 && s.gamma === 1 && neutralBalance) return '';
    // The built-in functions are the cheapest path, so use them whenever they are enough.
    if (s.gamma === 1 && neutralBalance) return `saturate(${fmt(s.saturation)}) contrast(${fmt(s.contrast)}) brightness(${fmt(s.brightness)})`;

    let svg = document.getElementById('mrs-colour');
    if (!svg) {
      svg = document.createElementNS(SVG, 'svg');
      svg.id = 'mrs-colour';
      svg.setAttribute('aria-hidden', 'true');
      svg.style.cssText = 'position:fixed;width:0;height:0;pointer-events:none';
      (document.body ?? document.documentElement).append(svg);
    }
    const [r, g, b] = gains(s.temperature, s.tint);
    const slope = fmt(s.contrast * s.brightness);
    const intercept = fmt(s.brightness * (0.5 - 0.5 * s.contrast));
    const each = (attributes) => ['R', 'G', 'B'].map((c) => `<feFunc${c} ${attributes}/>`).join('');
    // Same order as the simple path: saturation, white balance, gamma, contrast, brightness.
    svg.innerHTML = `<filter id="mrs-colour-filter" color-interpolation-filters="sRGB" x="0" y="0" width="100%" height="100%">
      <feColorMatrix type="saturate" values="${fmt(s.saturation)}"/>
      <feColorMatrix type="matrix" values="${fmt(r)} 0 0 0 0  0 ${fmt(g)} 0 0 0  0 0 ${fmt(b)} 0 0  0 0 0 1 0"/>
      <feComponentTransfer>${each(`type="gamma" amplitude="1" exponent="${fmt(1 / s.gamma)}" offset="0"`)}</feComponentTransfer>
      <feComponentTransfer>${each(`type="linear" slope="${slope}" intercept="${intercept}"`)}</feComponentTransfer>
    </filter>`;
    return 'url(#mrs-colour-filter)';
  }

  let current = null;
  function apply() {
    if (current) document.documentElement.style.filter = filterFor(current);
  }
  window.__mrsColour = (settings) => {
    current = settings;
    apply();
  };
  // The script runs before the page exists; the gamma path needs a body to hold its filter.
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
    card.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:grid;grid-template-rows:5fr 2fr 1fr 1fr 1fr 1fr';
    const rows = [steps(bars), steps(greys), 'linear-gradient(90deg, #000, #fff)', 'linear-gradient(90deg, #000, #f00)', 'linear-gradient(90deg, #000, #0f0)', 'linear-gradient(90deg, #000, #00f)'];
    for (const background of rows) {
      const row = document.createElement('div');
      row.style.background = background;
      card.append(row);
    }
    document.body.append(card);
  };
})();
