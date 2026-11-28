// A gallery of the example panels with made-up data, for looking at the system
// without a host or a site:  pnpm --filter @mrstudio/dashboard gallery
//   ?view=energy   a hand-made site page (the default)
//   ?view=auto     panels from layers, laid out automatically; too many for one page
//   ?view=refused  what dev mode shows for panels that break the rules
//   ?view=gauges   gauges at several values, tile and chip (#491)
//   ?view=fit      every core widget at every size it takes, measured for overflow (#681);
//                  &case=worst fills every text to its limit (fit.mjs runs this in CI)
//                  &shape=controller on the controller's shorter canvas, under a layer's hero (#715)
//   &theme=light   a site's restyle     &still   freeze the clock     &rail=none
import type { PanelSpec } from '@mrstudio/sdk';

import energy from '../examples/energy-page.json';
import light from '../examples/light-theme.json';
import sunlight from '../../layers/sunlight/layer.json';
import '../src/dashboard.css';
import { coreWidgets, DashboardView, examplePanel, worstCasePanel } from '../src/index.ts';
import type { PanelInput } from '../src/index.ts';

const query = new URLSearchParams(location.search);
// &size=1.5: the display's controller size from the app's settings (#682).
if (query.has('size')) document.documentElement.style.setProperty('--mrs-ui-scale', query.get('size')!);
const view = new DashboardView(document.getElementById('canvas')!, { dev: true, rotateS: 6, empty: 'Turn a layer on to see it here' });
if (query.get('theme') === 'light') {
  view.setTheme(light);
  document.getElementById('rail')!.style.cssText = 'background:#fff;border-color:#d8d2c4';
}
if (query.get('rail') === 'none') document.getElementById('rail')!.remove();
if (query.has('grid')) document.body.classList.add('grid');

// A made-up summer day for a small energy community.
let hour = 14.5;
const curve = (fn: (h: number) => number) => Array.from({ length: 49 }, (_, i) => Math.round(fn(i / 2)));
const solarAt = (h: number) => Math.max(0, 180 * Math.sin(((h - 5) / 16) * Math.PI)) * (h > 5 && h < 21 ? 1 : 0);
const demandAt = (h: number) => 70 + 45 * Math.exp(-((h - 8) ** 2) / 6) + 70 * Math.exp(-((h - 18.5) ** 2) / 8);
const state = () => {
  const solar = solarAt(hour);
  const demand = demandAt(hour);
  const made = curve(solarAt).slice(0, Math.round(hour * 2) + 1).reduce((a, b) => a + b, 0) / 2;
  return {
    hour,
    dayFraction: hour / 24,
    solar,
    solarState: solar > demand ? 'more than we are using' : solar > 0 ? 'less than we are using' : 'the sun is down',
    demand,
    demandChange: demand - demandAt(hour - 1),
    battery: Math.max(0.08, Math.min(0.96, 0.2 + (hour - 7) * 0.085 - Math.max(0, hour - 16) * 0.2)),
    batteryState: solar > demand ? 'charging from the roofs' : 'covering the evening',
    selfSufficiency: Math.min(0.92, 0.25 + made / 2600),
    used: made * 0.46,
    sharedOut: made * 0.27,
    stored: made * 0.17,
    sold: made * 0.1,
    solarCurve: curve(solarAt),
    demandCurve: curve(demandAt),
    altitude: 41.2,
    daylightHours: 17.6,
    sun: 'sun 41.2° up, bearing 231°',
    dayStatus: '',
    ramp: 'daylight',
    rampLow: 'Shade',
    rampHigh: 'Sun',
    sunrise: 4.2,
    sunset: 21.9,
  };
};

const input = (layer: string, spec: PanelSpec, page?: number): PanelInput => ({
  key: `${layer}/${spec.id}`,
  spec,
  page,
  source: () => ({ params: { mode: 'instant', hour }, shared: state(), site: { name: 'Sample district' } }),
});

const which = query.get('view') ?? 'energy';
if (which === 'fit') {
  view.destroy();
  fitGallery(query.get('case') === 'worst' ? 'worst' : 'example', query.get('shape') === 'controller');
} else if (which === 'energy') {
  view.setPanels((energy.panels as PanelSpec[]).map((spec) => input('energy', spec, 0)));
} else if (which === 'auto') {
  // Two layers on at once: more than one screen may hold, so the layout makes a second page.
  const extra = (energy.panels as PanelSpec[]).map(({ at: _at, layer: _layer, ...spec }) => spec as PanelSpec);
  view.setPanels([...(sunlight.panels as PanelSpec[]).map((spec) => input('sunlight', spec)), ...extra.map((spec) => input('energy', spec))]);
} else if (which === 'gauges') {
  const gauges = [0.12, 0.5, 0.62, 0.9].flatMap((value) => [
    { id: `tile-${value * 100}`, widget: 'gauge', size: 'tile', title: `Target 50%`, props: { value, max: 1, target: 0.5, format: 'percent' } },
    { id: `chip-${value * 100}`, widget: 'gauge', size: 'chip', title: `Chip`, props: { value, max: 1, format: 'percent' } },
  ]) as PanelSpec[];
  view.setPanels(gauges.map((spec) => input('demo', spec)));
} else {
  view.setPanels([
    input('demo', { id: 'ok', widget: 'stat', size: 'tile', title: 'This one is fine', props: { value: 42, unit: 'kW' } }),
    input('demo', { id: 'crowded', widget: 'stat', size: 'chip', title: 'Too much for a chip', props: { value: 42, caption: 'and a caption', delta: 3 } }),
    input('demo', { id: 'wordy', widget: 'stat', size: 'tile', title: 'A title that goes on for far longer than a glance allows', props: { value: 1 } }),
    input('demo', { id: 'many', widget: 'bars', size: 'wide', title: 'Seven bars', props: { items: Array.from({ length: 7 }, (_, i) => ({ label: `Bar ${i + 1}`, value: i })) } }),
  ]);
  view.setTheme({ 'color.text': '#4a5060', 'type.label': '10px' });
}

/**
 * Every core widget at every size, each alone on a canvas the size of the TV's, measured for
 * content that spills out of its panel (#681). The results go to `window.__fit` for fit.mjs.
 * The widgets that need a table (map, control) or a layer's code (custom) are left out.
 */
function fitGallery(which: 'example' | 'worst', controller: boolean): void {
  const box = document.getElementById('tv')!;
  box.style.cssText = 'display:block;height:auto;overflow:auto';
  box.replaceChildren();
  document.documentElement.style.overflow = 'auto';
  document.body.style.overflow = 'auto';
  const views: DashboardView[] = [];
  const skip = new Set(['map', 'control', 'custom']);
  for (const widget of coreWidgets().list()) {
    if (skip.has(widget.type)) continue;
    for (const size of widget.sizes) {
      const spec = which === 'worst' ? worstCasePanel(widget, size) : examplePanel(widget, size);
      const canvas = document.createElement('div');
      // The TV's canvas: the screen less the control rail's share. The controller's is narrower
      // (a rail of layers on each side) and short (a layer's hero above it), and its unit never
      // drops below the controls' (runtime style.css, --mrs-u-floor).
      canvas.style.cssText = controller ? 'width:87.5vw;height:52vh;margin-left:6.25vw;--mrs-u-floor:min(0.8vh,0.5vw);--mrs-margin:calc(1.5 * var(--mrs-u))' : 'width:78vw;height:100vh;margin-left:22vw';
      canvas.dataset.case = `${widget.type}/${size}`;
      box.append(canvas);
      const dash = new DashboardView(canvas, { dev: true });
      dash.setPanels([{ ...input(widget.type, { ...spec, at: { col: 1, row: 1 } }, 0), key: `${widget.type}/${size}` }]);
      views.push(dash);
    }
  }
  // Fonts, the first layout and the canvas's rows (set once its size is known) settle before
  // anything is measured.
  void document.fonts.ready.then(() =>
    setTimeout(() => {
      const found = views.flatMap((dash) => dash.checkOverflow());
      const refused = views.flatMap((dash) => dash.issues.filter((issue) => issue.rule !== 'overflow'));
      (window as unknown as { __fit: unknown }).__fit = { cases: views.length, overflow: found, refused };
    }, 400),
  );
}

if (!query.has('still') && which !== 'fit') {
  setInterval(() => {
    hour = (hour + 0.25) % 24;
    view.sync();
  }, 1500);
}
