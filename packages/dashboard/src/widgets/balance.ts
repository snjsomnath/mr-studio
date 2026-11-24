import { formatValue } from '../bind.ts';
import { defineWidget } from '../registry.ts';
import { TEXT } from '../rules.ts';
import { h, setText, slotColor } from './dom.ts';

type Part = { label?: string; value?: number; slot?: number };

/** A share of what was used that came from the community's own sources: 1 when nothing came from outside. */
export function selfSufficiency(sources: readonly Part[], outside: string): number | null {
  const total = sources.reduce((sum, s) => sum + Math.max(0, s.value ?? 0), 0);
  if (total <= 0) return null;
  const bought = sources.filter((s) => s.label === outside).reduce((sum, s) => sum + Math.max(0, s.value ?? 0), 0);
  return 1 - bought / total;
}

const item = {
  label: { kind: 'text', max: TEXT.label, label: 'Label', required: true },
  value: { kind: 'number', label: 'Value', bindable: true },
  slot: { kind: 'slot', label: 'Colour' },
} as const;

/**
 * Where a quantity came from and went to over the shown period (#281): two bands, in and out,
 * split by share, and one headline number (self-sufficiency, or any share the layer gives).
 * As a chip it is the headline alone.
 */
export const balance = defineWidget({
  type: 'balance',
  name: 'Balance',
  description: 'Where something came from and went to, as two bands split by share, with one headline number such as self-sufficiency.',
  sizes: ['chip', 'wide', 'block'],
  example: { sources: [{ label: 'Roofs', value: 180 }, { label: 'Grid', value: 40 }], uses: [{ label: 'Homes', value: 150 }, { label: 'Battery', value: 70 }], unit: 'kW' },
  props: {
    sources: { kind: 'list', label: 'In', required: true, bindable: true, max: 4, item },
    uses: { kind: 'list', label: 'Out', bindable: true, max: 4, item },
    headline: { kind: 'number', label: 'Headline (0 to 1)', bindable: true },
    headline_label: { kind: 'text', max: TEXT.label, label: 'Headline label', default: 'self-sufficient' },
    outside: { kind: 'text', max: TEXT.label, label: 'Bought from outside', default: 'Grid' },
    unit: { kind: 'text', max: TEXT.unit, label: 'Unit' },
    decimals: { kind: 'number', min: 0, max: 2, label: 'Decimals' },
  },
  listMax: (_prop, size) => (size === 'block' ? 3 : 4),
  // The headline, then each band read as one shape; a block also labels every part with its value.
  reads: (props, size) => {
    if (size === 'chip') return 1;
    const bands = (props.uses as unknown[] | undefined)?.length ? 2 : 1;
    if (size === 'wide') return 1 + bands;
    return 1 + ((props.sources as unknown[] | undefined)?.length ?? 0) + ((props.uses as unknown[] | undefined)?.length ?? 0);
  },
  mount(el, env) {
    const root = h('div', `mrs-balance mrs-balance-${env.size}`);
    const head = h('div', 'mrs-stat-row');
    const number = h('span', 'mrs-number');
    const label = h('span', 'mrs-unit');
    head.append(number, label);
    root.append(head);
    const bands = [h('div', 'mrs-band'), h('div', 'mrs-band')];
    if (env.size !== 'chip') root.append(...bands);
    el.append(root);
    const fill = (band: HTMLElement, parts: Part[], props: Record<string, any>, name: string) => {
      band.hidden = parts.length === 0;
      const total = parts.reduce((sum, p) => sum + Math.max(0, p.value ?? 0), 0);
      band.replaceChildren(h('span', 'mrs-band-name', name));
      const track = h('div', 'mrs-band-track');
      parts.forEach((p, i) => {
        const share = total > 0 ? Math.max(0, p.value ?? 0) / total : 0;
        const seg = h('div', 'mrs-band-part');
        seg.style.flexGrow = String(share);
        seg.style.background = slotColor(p.slot, i + 1);
        seg.title = `${p.label}: ${formatValue(p.value, props)}${props.unit ? ` ${props.unit}` : ''}`;
        // A part too thin to label keeps its colour only; the block lists every part below.
        if (share >= 0.18) seg.append(h('span', 'mrs-band-label', p.label ?? ''));
        track.append(seg);
      });
      band.append(track);
      if (env.size === 'block') {
        const keys = h('div', 'mrs-band-keys');
        parts.forEach((p, i) => {
          const key = h('span', 'mrs-band-key');
          const dot = h('i', 'mrs-band-dot');
          dot.style.background = slotColor(p.slot, i + 1);
          key.append(dot, `${p.label} ${formatValue(p.value, props)}${props.unit ? ` ${props.unit}` : ''}`);
          keys.append(key);
        });
        band.append(keys);
      }
    };
    return {
      update(props) {
        const sources = (props.sources ?? []) as Part[];
        const uses = (props.uses ?? []) as Part[];
        const headline = typeof props.headline === 'number' ? props.headline : selfSufficiency(sources, props.outside ?? 'Grid');
        setText(number, headline === null || headline === undefined ? '–' : formatValue(headline, { format: 'percent' }));
        setText(label, props.headline_label ?? 'self-sufficient');
        if (env.size === 'chip') return;
        fill(bands[0]!, sources, props, 'In');
        fill(bands[1]!, uses, props, 'Out');
      },
    };
  },
});
