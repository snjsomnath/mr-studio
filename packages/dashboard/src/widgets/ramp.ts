import { colormaps, cssGradient } from '@mrstudio/sdk';
import type { Colormap } from '@mrstudio/sdk';

import { defineWidget } from '../registry.ts';
import { h, setText } from './dom.ts';

/** The colour key for what the table is showing. */
export const ramp = defineWidget({
  type: 'ramp',
  name: 'Colour key',
  description: 'The colour ramp of the field on the table, with what its two ends mean.',
  sizes: ['tile', 'band'],
  props: {
    colormap: { kind: 'colormap', label: 'Colour ramp', required: true, bindable: true },
    low: { kind: 'text', max: 12, label: 'Low end', required: true, bindable: true },
    high: { kind: 'text', max: 12, label: 'High end', required: true, bindable: true },
  },
  reads: () => 2,
  mount(el) {
    const low = h('span', 'mrs-ramp-end');
    const bar = h('div', 'mrs-ramp-bar');
    const high = h('span', 'mrs-ramp-end');
    const wrap = h('div', 'mrs-ramp');
    wrap.append(low, bar, high);
    el.append(wrap);
    let shown = '';
    return {
      update(props) {
        setText(low, props.low ?? '');
        setText(high, props.high ?? '');
        if (props.colormap !== shown) {
          shown = props.colormap;
          const map = (colormaps as Record<string, Colormap>)[shown];
          bar.style.background = map ? cssGradient(map) : 'var(--mrs-line)';
        }
      },
    };
  },
});
