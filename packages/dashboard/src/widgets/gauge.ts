import { formatValue } from '../bind.ts';
import { defineWidget } from '../registry.ts';
import { TEXT } from '../rules.ts';
import { h, setText } from './dom.ts';

const NS = 'http://www.w3.org/2000/svg';
const svg = (tag: string, attrs: Record<string, string>) => {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
};
/** A point on the gauge's half circle, for a share from 0 (left) to 1 (right). */
const at = (share: number, r = 40): [number, number] => [50 - r * Math.cos(Math.PI * share), 50 - r * Math.sin(Math.PI * share)];
/**
 * The gauge's arc from one share to another. A share of 1 is half a turn, so the arc is never the
 * large one: with the large-arc flag set past half the range, SVG drew a 62% fill on another circle,
 * detached from the track (#491).
 */
export const gaugeArc = (from: number, to: number) => {
  const [x0, y0] = at(from);
  const [x1, y1] = at(to);
  return `M ${x0} ${y0} A 40 40 0 0 1 ${x1} ${y1}`;
};
const arc = gaugeArc;

/** Where a value sits on a range, 0 to 1. */
export function gaugeShare(value: unknown, min = 0, max = 1): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || max === min) return null;
  return Math.min(1, Math.max(0, (value - min) / (max - min)));
}

/** One value against its range (#356): a half circle that fills, and a tick for a target. */
export const gauge = defineWidget({
  type: 'gauge',
  name: 'Gauge',
  description: 'One value against its range, as a half circle that fills, with an optional tick for a target.',
  sizes: ['chip', 'tile'],
  example: { value: 0.62, max: 1, target: 0.5, format: 'percent' },
  props: {
    value: { kind: 'value', label: 'Value', required: true, bindable: true },
    min: { kind: 'number', label: 'Lowest', default: 0 },
    max: { kind: 'number', label: 'Highest', required: true, bindable: true },
    target: { kind: 'number', label: 'Target', bindable: true },
    unit: { kind: 'text', max: TEXT.unit, label: 'Unit' },
    format: { kind: 'enum', options: ['number', 'percent'], label: 'Format', default: 'number' },
    decimals: { kind: 'number', min: 0, max: 2, label: 'Decimals' },
    slot: { kind: 'slot', label: 'Colour' },
  },
  // The value is one read; a target one more.
  reads: (props) => 1 + (props.target !== undefined ? 1 : 0),
  mount(el, env) {
    const box = h('div', `mrs-gauge mrs-gauge-${env.size}`);
    const picture = svg('svg', { viewBox: '0 0 100 56', class: 'mrs-gauge-arc' });
    const track = svg('path', { d: arc(0, 1), class: 'mrs-gauge-track' });
    const fill = svg('path', { d: arc(0, 0.001), class: 'mrs-gauge-fill' });
    const tick = svg('line', { class: 'mrs-gauge-target' });
    picture.append(track, fill, tick);
    const words = h('div', 'mrs-stat-row');
    const number = h('span', 'mrs-number');
    const unit = h('span', 'mrs-unit');
    words.append(number, unit);
    box.append(picture, words);
    el.append(box);
    return {
      update(props) {
        const share = gaugeShare(props.value, props.min ?? 0, props.max);
        fill.setAttribute('d', arc(0, Math.max(0.001, share ?? 0)));
        fill.style.opacity = share === null ? '0' : '1';
        fill.style.stroke = `var(--mrs-data-${Number.isInteger(props.slot) ? props.slot : 1})`;
        const target = gaugeShare(props.target, props.min ?? 0, props.max);
        tick.style.display = target === null ? 'none' : '';
        if (target !== null) {
          const [x0, y0] = at(target, 32);
          const [x1, y1] = at(target, 48);
          for (const [k, v] of Object.entries({ x1: x0, y1: y0, x2: x1, y2: y1 })) tick.setAttribute(k, String(v));
        }
        setText(number, formatValue(props.value, props));
        setText(unit, props.format === 'percent' ? '' : (props.unit ?? ''));
      },
    };
  },
});
