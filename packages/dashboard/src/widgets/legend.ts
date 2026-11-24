import { defineWidget } from '../registry.ts';
import { TEXT } from '../rules.ts';
import { h, setText } from './dom.ts';

interface Row {
  id?: string;
  label?: string;
  color?: string;
  shape?: string;
}

/** A layer's legend as a panel (#356): what the colours on the table mean, for a TV page or a custom view. */
export const legend = defineWidget({
  type: 'legend',
  name: 'Legend',
  description: "A layer's legend: what the colours on the table mean. By default what the layer publishes as its legend, else its legend in layer.json.",
  sizes: ['tile', 'wide', 'tall', 'band'],
  props: {
    items: {
      kind: 'list',
      label: 'Rows (default: the layer legend)',
      bindable: true,
      max: 6,
      default: { bind: 'shared.legend' },
      item: {
        label: { kind: 'text', max: TEXT.label, label: 'Label', required: true },
        color: { kind: 'text', max: 40, label: 'Colour (CSS)' },
        shape: { kind: 'enum', options: ['fill', 'line', 'point'], label: 'Shape' },
      },
    },
  },
  listMax: (_prop, size) => (size === 'tile' ? 3 : size === 'band' ? 5 : 6),
  // Each row is a swatch and its words.
  reads: (props) => Math.max(1, (props.items as unknown[] | undefined)?.length ?? 3),
  mount(el, env) {
    const list = h('ul', `mrs-legend mrs-legend-${env.size}`);
    el.append(list);
    return {
      update(props) {
        const given = props.items as Row[] | undefined;
        const rows = (given?.length ? given : (env.layer?.manifest?.legend ?? [])).filter((r) => r && typeof r.label === 'string').slice(0, env.size === 'tile' ? 3 : env.size === 'band' ? 5 : 6);
        while (list.children.length < rows.length) {
          const row = h('li', 'mrs-legend-row');
          row.append(h('span', 'mrs-legend-swatch'), h('span', 'mrs-legend-label'));
          list.append(row);
        }
        while (list.children.length > rows.length) list.lastElementChild!.remove();
        rows.forEach((r, i) => {
          const [swatch, label] = [...(list.children[i] as HTMLElement).children] as HTMLElement[];
          swatch!.dataset.shape = r.shape ?? 'fill';
          swatch!.style.setProperty('--swatch', r.color ?? 'var(--mrs-accent)');
          setText(label!, r.label ?? '');
        });
      },
    };
  },
});
