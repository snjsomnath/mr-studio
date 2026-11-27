import { formatValue } from '../bind.ts';
import { defineWidget } from '../registry.ts';
import { TEXT } from '../rules.ts';
import { h, setText, slotColor } from './dom.ts';

/** The shares of a whole, each part's start and end as fractions of the ring. Negative and missing parts count as none. */
export function donutParts(values: readonly (number | undefined)[]): { from: number; to: number }[] {
  const clean = values.map((v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0));
  const total = clean.reduce((s, v) => s + v, 0);
  let at = 0;
  return clean.map((v) => {
    const from = at;
    at += total > 0 ? v / total : 0;
    return { from, to: at };
  });
}

/** Shares of a whole (#356): a ring of a few parts, a headline in its middle, and a key beside it. */
export const donut = defineWidget({
  type: 'donut',
  name: 'Donut',
  description: 'Shares of a whole as a ring of up to five parts, with a headline in the middle and a key.',
  sizes: ['tile', 'wide', 'block'],
  example: { items: [{ label: 'Used here', value: 46 }, { label: 'Shared', value: 27 }, { label: 'Stored', value: 17 }, { label: 'Sold', value: 10 }], format: 'percent' },
  props: {
    items: {
      kind: 'list',
      label: 'Parts',
      required: true,
      bindable: true,
      max: 5,
      item: {
        label: { kind: 'text', max: TEXT.label, label: 'Name', required: true },
        value: { kind: 'number', label: 'Value', required: true, bindable: true },
        slot: { kind: 'slot', label: 'Colour' },
      },
    },
    headline: { kind: 'value', label: 'In the middle', bindable: true },
    format: { kind: 'enum', options: ['number', 'percent'], label: 'Format of the middle', default: 'number' },
    decimals: { kind: 'number', min: 0, max: 2, label: 'Decimals' },
  },
  listMax: (_prop, size) => (size === 'tile' ? 3 : size === 'wide' ? 4 : 5),
  // Each part is a name with its share; the middle is one more.
  reads: (props) => ((props.items as unknown[] | undefined)?.length ?? 0) + (props.headline !== undefined ? 1 : 0),
  mount(el) {
    const box = h('div', 'mrs-donut');
    // The ring is masked to a ring, so the middle sits beside it in a holder, not inside it.
    const hole = h('div', 'mrs-donut-hole');
    const ring = h('div', 'mrs-donut-ring');
    const middle = h('span', 'mrs-number mrs-donut-middle');
    hole.append(ring, middle);
    const key = h('ul', 'mrs-donut-key');
    box.append(hole, key);
    el.append(box);
    // The ring is as big as the panel allows once the key has the width its names and shares
    // need (up to 60% of the panel), so the key is never pushed out of the panel (#681).
    const fit = () => {
      if (!box.isConnected || box.clientWidth === 0) return;
      key.style.cssText = 'flex: none; width: max-content';
      const need = key.offsetWidth;
      key.style.cssText = '';
      const gap = parseFloat(getComputedStyle(box).columnGap) || 0;
      const width = box.clientWidth;
      const side = Math.floor(Math.max(width * 0.3, Math.min(box.clientHeight, width - gap - Math.min(need, width * 0.6))));
      hole.style.width = hole.style.height = `${side}px`;
    };
    return {
      fit,
      update(props) {
        const items = (props.items ?? []) as { label?: string; value?: number; slot?: number }[];
        const parts = donutParts(items.map((i) => i.value));
        const stops = parts.map((p, i) => `${slotColor(items[i]!.slot, i + 1)} ${p.from * 360}deg ${p.to * 360}deg`);
        ring.style.background = stops.length && parts[parts.length - 1]!.to > 0 ? `conic-gradient(${stops.join(', ')})` : 'var(--mrs-line)';
        setText(middle, props.headline === undefined ? '' : formatValue(props.headline, props));
        while (key.children.length < items.length) {
          const row = h('li', 'mrs-donut-row');
          row.append(h('span', 'mrs-list-mark'), h('span', 'mrs-list-label'), h('span', 'mrs-list-value'));
          key.append(row);
        }
        while (key.children.length > items.length) key.lastElementChild!.remove();
        items.forEach((item, i) => {
          const [mark, label, share] = [...(key.children[i] as HTMLElement).children] as HTMLElement[];
          mark!.style.background = slotColor(item.slot, i + 1);
          setText(label!, item.label ?? '');
          setText(share!, `${Math.round((parts[i]!.to - parts[i]!.from) * 100)}%`);
        });
        fit();
      },
    };
  },
});
