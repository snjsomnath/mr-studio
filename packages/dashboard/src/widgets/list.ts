import { formatValue } from '../bind.ts';
import { defineWidget } from '../registry.ts';
import { TEXT } from '../rules.ts';
import { h, setText, slotColor } from './dom.ts';

/** A short ranked list (#356): names and numbers, highest first unless the layer has ordered it. */
export const list = defineWidget({
  type: 'list',
  name: 'List',
  description: 'A short ranked list of names and numbers, such as the busiest streets or the buildings drawing most.',
  sizes: ['tile', 'wide', 'tall'],
  props: {
    items: {
      kind: 'list',
      label: 'Rows',
      required: true,
      bindable: true,
      max: 6,
      item: {
        label: { kind: 'text', max: TEXT.label, label: 'Name', required: true },
        value: { kind: 'value', label: 'Value', bindable: true },
        slot: { kind: 'slot', label: 'Colour' },
      },
    },
    unit: { kind: 'text', max: TEXT.unit, label: 'Unit' },
    decimals: { kind: 'number', min: 0, max: 2, label: 'Decimals' },
    order: { kind: 'enum', options: ['highest', 'lowest', 'as given'], label: 'Order', default: 'highest' },
  },
  listMax: (_prop, size) => (size === 'tile' ? 3 : size === 'wide' ? 4 : 6),
  // Each row is a name and a number read together.
  reads: (props) => (props.items as unknown[] | undefined)?.length ?? 0,
  mount(el) {
    const table = h('ol', 'mrs-list');
    el.append(table);
    return {
      update(props) {
        const items = [...((props.items ?? []) as { label?: string; value?: number | string; slot?: number }[])];
        const num = (v: unknown) => (typeof v === 'number' ? v : -Infinity);
        if (props.order === 'highest' || props.order === undefined) items.sort((a, b) => num(b.value) - num(a.value));
        if (props.order === 'lowest') items.sort((a, b) => num(a.value) - num(b.value));
        while (table.children.length < items.length) {
          const row = h('li', 'mrs-list-row');
          row.append(h('span', 'mrs-list-mark'), h('span', 'mrs-list-label'), h('span', 'mrs-list-value'));
          table.append(row);
        }
        while (table.children.length > items.length) table.lastElementChild!.remove();
        items.forEach((item, i) => {
          const row = table.children[i] as HTMLElement;
          const [mark, label, value] = [...row.children] as HTMLElement[];
          mark!.style.background = item.slot ? slotColor(item.slot) : 'transparent';
          setText(label!, item.label ?? '');
          setText(value!, `${formatValue(item.value, props)}${props.unit && typeof item.value === 'number' ? ` ${props.unit}` : ''}`);
        });
      },
    };
  },
});
