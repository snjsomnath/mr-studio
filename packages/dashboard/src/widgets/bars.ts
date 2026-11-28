import { formatValue } from '../bind.ts';
import { defineWidget } from '../registry.ts';
import { TEXT } from '../rules.ts';
import { h, setText, slotColor } from './dom.ts';

/** A few labelled bars on one scale. */
export const bars = defineWidget({
  type: 'bars',
  name: 'Bars',
  description: 'Up to six labelled bars on one scale, for comparing a few things.',
  sizes: ['wide', 'tall', 'block'],
  example: { items: [{ label: 'Roofs', value: 182 }, { label: 'Battery', value: 64 }, { label: 'Grid', value: 41 }], unit: 'kW' },
  props: {
    items: {
      kind: 'list',
      label: 'Bars',
      required: true,
      bindable: true,
      max: 6,
      item: {
        label: { kind: 'text', max: TEXT.label, label: 'Label', required: true },
        value: { kind: 'number', label: 'Value', required: true, bindable: true },
        slot: { kind: 'slot', label: 'Colour' },
      },
    },
    unit: { kind: 'text', max: TEXT.unit, label: 'Unit' },
    decimals: { kind: 'number', min: 0, max: 2, label: 'Decimals' },
    max: { kind: 'number', label: 'Full scale', bindable: true },
  },
  listMax: (_prop, size) => (size === 'wide' ? 4 : 6),
  // Each bar is a label and a value read together.
  reads: (props) => (props.items as unknown[] | undefined)?.length ?? 0,
  mount(el) {
    const list = h('div', 'mrs-bars');
    el.append(list);
    const rows: { label: HTMLElement; value: HTMLElement; fill: HTMLElement; row: HTMLElement }[] = [];
    return {
      update(props) {
        const items = (props.items ?? []) as { label?: string; value?: number; slot?: number }[];
        while (rows.length < items.length) {
          const row = h('div', 'mrs-bar');
          const label = h('span', 'mrs-bar-label');
          const value = h('span', 'mrs-bar-value');
          const track = h('div', 'mrs-bar-track');
          const fill = h('div', 'mrs-bar-fill');
          track.append(fill);
          row.append(label, value, track);
          list.append(row);
          rows.push({ label, value, fill, row });
        }
        while (rows.length > items.length) rows.pop()!.row.remove();
        const scale = Math.max(props.max ?? 0, ...items.map((item) => item.value ?? 0), 1e-9);
        items.forEach((item, index) => {
          const row = rows[index]!;
          setText(row.label, item.label ?? '');
          setText(row.value, `${formatValue(item.value, props)}${props.unit ? ` ${props.unit}` : ''}`);
          row.fill.style.width = `${Math.max(0, Math.min(1, (item.value ?? 0) / scale)) * 100}%`;
          row.fill.style.background = slotColor(item.slot);
        });
      },
    };
  },
});
