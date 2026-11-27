import { formatValue } from '../bind.ts';
import { defineWidget } from '../registry.ts';
import { TEXT } from '../rules.ts';
import { h, setText, slotColor } from './dom.ts';

const SVG = 'http://www.w3.org/2000/svg';

/** A trend: up to three lines on one scale. */
export const series = defineWidget({
  type: 'series',
  name: 'Trend',
  description: 'Up to three lines over time on one shared scale, with an optional marker for now.',
  sizes: ['wide', 'block', 'hero', 'strip'],
  example: { series: [{ label: 'Solar', values: [0, 0, 5, 40, 110, 165, 180, 160, 105, 40, 6, 0] }, { label: 'Demand', values: [70, 75, 110, 95, 80, 78, 82, 90, 130, 140, 100, 80] }], unit: 'kW', start: '00', end: '24', now: 0.6 },
  props: {
    series: {
      kind: 'list',
      label: 'Lines',
      required: true,
      max: 3,
      item: {
        label: { kind: 'text', max: TEXT.label, label: 'Label', required: true },
        values: { kind: 'numbers', maxLength: 96, label: 'Values', required: true, bindable: true },
        slot: { kind: 'slot', label: 'Colour' },
      },
    },
    unit: { kind: 'text', max: TEXT.unit, label: 'Unit' },
    decimals: { kind: 'number', min: 0, max: 2, label: 'Decimals' },
    start: { kind: 'text', max: 12, label: 'Left end of the time axis', bindable: true },
    end: { kind: 'text', max: 12, label: 'Right end of the time axis', bindable: true },
    now: { kind: 'number', min: 0, max: 1, label: 'Marker for now, 0 to 1', bindable: true },
  },
  listMax: (_prop, size) => (size === 'wide' ? 2 : 3),
  // Each line is a read, and the scale is one more.
  reads: (props) => ((props.series as unknown[] | undefined)?.length ?? 0) + 1,
  mount(el) {
    const wrap = h('div', 'mrs-series');
    const legend = h('div', 'mrs-legend');
    const plot = h('div', 'mrs-plot');
    const top = h('span', 'mrs-plot-max');
    const bottom = h('span', 'mrs-plot-min');
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('viewBox', '0 0 100 100');
    svg.setAttribute('preserveAspectRatio', 'none');
    const marker = h('div', 'mrs-plot-now');
    plot.append(svg, top, bottom, marker);
    const axis = h('div', 'mrs-plot-axis');
    const start = h('span', '');
    const end = h('span', '');
    axis.append(start, end);
    wrap.append(legend, plot, axis);
    el.append(wrap);
    // The scale's labels sit left of the plot. A long top value with its unit widens the gutter
    // rather than running out of the panel (#681).
    const fit = () => {
      if (!wrap.isConnected || wrap.clientWidth === 0) return;
      wrap.style.removeProperty('--mrs-plot-gutter');
      const gutter = Math.max(top.offsetWidth, bottom.offsetWidth);
      const room = plot.getBoundingClientRect().left - wrap.getBoundingClientRect().left;
      const gap = parseFloat(getComputedStyle(top).marginRight) || 0;
      if (gutter + gap > room) wrap.style.setProperty('--mrs-plot-gutter', `${Math.ceil(gutter + gap)}px`);
    };
    return {
      fit,
      update(props) {
        const lines = (props.series ?? []) as { label?: string; values?: number[]; slot?: number }[];
        const all = lines.flatMap((line) => line.values ?? []);
        // One scale for every line, from zero unless the data goes below it.
        const low = Math.min(0, ...all);
        const high = Math.max(...all, low + 1e-9);
        setText(top, `${formatValue(high, props)}${props.unit ? ` ${props.unit}` : ''}`);
        setText(bottom, formatValue(low, props));
        svg.replaceChildren();
        legend.replaceChildren();
        // With one line the panel's title names it; a legend would only repeat the title.
        legend.hidden = lines.length < 2;
        lines.forEach((line, index) => {
          const values = line.values ?? [];
          const colour = slotColor(line.slot, index + 1);
          if (values.length > 1) {
            const path = document.createElementNS(SVG, 'polyline');
            path.setAttribute('points', values.map((v, i) => `${((i / (values.length - 1)) * 100).toFixed(2)},${(100 - ((v - low) / (high - low)) * 100).toFixed(2)}`).join(' '));
            path.setAttribute('vector-effect', 'non-scaling-stroke');
            path.style.stroke = colour;
            svg.append(path);
          }
          const entry = h('span', 'mrs-legend-entry');
          const swatch = h('i', 'mrs-swatch');
          swatch.style.background = colour;
          entry.append(swatch, h('span', '', line.label ?? ''));
          legend.append(entry);
        });
        marker.hidden = props.now === undefined;
        if (props.now !== undefined) marker.style.left = `${props.now * 100}%`;
        setText(start, props.start ?? '');
        setText(end, props.end ?? '');
        axis.hidden = props.start === undefined && props.end === undefined;
        fit();
      },
    };
  },
});
