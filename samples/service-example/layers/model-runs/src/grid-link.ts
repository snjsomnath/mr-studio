// A team widget (#353): this layer's own kind of panel, drawn by its code but held to the same
// contract as the core widgets. It is known on the site as `model-runs/grid-link`, and the
// layer's own panels name it `grid-link`. It uses only the theme's tokens (`--mrs-*`), so it
// follows the controller's theme and the TV's.
import { defineWidget } from '@mrstudio/sdk';

const SVG = 'http://www.w3.org/2000/svg';
const svg = (tag: string, attrs: Record<string, string>) => {
  const node = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
};

/** How much the community draws from the grid: a line into the community, as thick as the draw. */
export const gridLink = defineWidget({
  type: 'grid-link',
  name: 'Grid link',
  description: 'Power drawn from the grid into the community, as a line that thickens with the draw, and its size in kW.',
  sizes: ['chip', 'tile'],
  props: {
    value: { kind: 'value', label: 'Drawn from the grid (kW)', required: true, bindable: true },
    max: { kind: 'number', min: 1, label: 'Draw at full thickness (kW)', default: 15000 },
    unit: { kind: 'text', max: 6, label: 'Unit', default: 'kW' },
  },
  reads: () => 1,
  mount(el, env) {
    el.style.cssText = 'display:flex;align-items:center;gap:var(--mrs-gap);height:100%;';
    const picture = svg('svg', { viewBox: '0 0 120 40', preserveAspectRatio: 'xMidYMid meet' });
    picture.style.cssText = `flex:1 1 auto;min-width:0;height:${env.size === 'chip' ? '100%' : '60%'};`;
    const pylon = svg('path', { d: 'M8 36 L14 6 L20 36 M10 24 H18 M11 16 H17', fill: 'none', stroke: 'var(--mrs-muted)', 'stroke-width': '2' });
    const home = svg('path', { d: 'M96 36 V20 L106 12 L116 20 V36 Z', fill: 'var(--mrs-data-1)' });
    const line = svg('line', { x1: '22', y1: '24', x2: '94', y2: '24', stroke: 'var(--mrs-data-4)', 'stroke-linecap': 'round' });
    const head = svg('path', { d: 'M86 18 L96 24 L86 30 Z', fill: 'var(--mrs-data-4)' });
    picture.append(pylon, line, head, home);
    const number = document.createElement('span');
    number.className = 'mrs-number';
    number.style.fontSize = env.size === 'chip' ? 'var(--mrs-type-number-s)' : 'var(--mrs-type-number)';
    const unit = document.createElement('span');
    unit.className = 'mrs-unit';
    const words = document.createElement('div');
    words.append(number, unit);
    el.append(picture, words);
    return {
      update(props) {
        const value = typeof props.value === 'number' ? props.value : null;
        const share = value === null ? 0 : Math.min(1, Math.max(0, value / (props.max ?? 15000)));
        line.setAttribute('stroke-width', String(1 + share * 11));
        line.style.opacity = value === null ? '0.3' : '1';
        number.textContent = value === null ? '–' : value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(Math.round(value));
        unit.textContent = ` ${props.unit ?? 'kW'}`;
      },
    };
  },
});
