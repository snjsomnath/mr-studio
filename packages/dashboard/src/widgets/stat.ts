import { formatValue } from '../bind.ts';
import { defineWidget } from '../registry.ts';
import { TEXT } from '../rules.ts';
import { h, setText } from './dom.ts';

/** One headline number. The panel's title is its label. */
export const stat = defineWidget({
  type: 'stat',
  name: 'Stat',
  description: 'One headline number with its unit, and optionally a line of context and a change.',
  sizes: ['chip', 'tile', 'wide'],
  example: { value: 412, unit: 'kW', caption: 'from the roofs', delta: 18 },
  props: {
    value: { kind: 'value', label: 'Value', required: true, bindable: true },
    unit: { kind: 'text', max: TEXT.unit, label: 'Unit' },
    format: { kind: 'enum', options: ['number', 'hour', 'percent'], label: 'Format', default: 'number' },
    decimals: { kind: 'number', min: 0, max: 2, label: 'Decimals' },
    caption: { kind: 'text', max: TEXT.caption, label: 'Context line', bindable: true },
    delta: { kind: 'number', label: 'Change', bindable: true },
  },
  // The number is one read. Context and a change are one more each, so a chip has room for neither.
  reads: (props) => 1 + (props.caption !== undefined ? 1 : 0) + (props.delta !== undefined ? 1 : 0),
  mount(el) {
    const row = h('div', 'mrs-stat-row');
    const number = h('span', 'mrs-number');
    const unit = h('span', 'mrs-unit');
    const delta = h('span', 'mrs-delta');
    const caption = h('div', 'mrs-caption');
    row.append(number, unit, delta);
    el.append(row, caption);
    return {
      update(props) {
        setText(number, formatValue(props.value, props));
        setText(unit, props.format === 'number' || props.format === undefined ? (props.unit ?? '') : '');
        const change = props.delta as number | undefined;
        delta.hidden = change === undefined;
        if (change !== undefined) {
          // The arrow carries the direction, so the colour is never the only signal.
          setText(delta, `${change > 0 ? '▲' : change < 0 ? '▼' : '■'} ${formatValue(Math.abs(change), props)}`);
          delta.dataset.direction = change > 0 ? 'up' : change < 0 ? 'down' : 'flat';
        }
        setText(caption, props.caption ?? '');
      },
    };
  },
});
