import { formatValue } from '../bind.ts';
import { defineWidget } from '../registry.ts';
import { TEXT } from '../rules.ts';
import { h, setText, slotColor } from './dom.ts';

/** How a scenario stands: not run yet, being worked out, or done. */
export type ScenarioState = 'idle' | 'running' | 'done';

/** The change from the first scenario (the baseline) to `value`, as a share; null when there is no baseline. */
export function scenarioChange(baseline: number | undefined, value: number | undefined): number | null {
  if (baseline === undefined || value === undefined || !Number.isFinite(baseline) || !Number.isFinite(value) || baseline === 0) return null;
  return (value - baseline) / Math.abs(baseline);
}

/**
 * Two or three scenarios side by side (#281): one figure each, and how far each is from the
 * first ("as today"). A card that is not worked out yet says so instead of showing a stale number.
 * As a chip it shows only the change of the last scenario worked out, the one number a ribbon needs.
 */
export const compare = defineWidget({
  type: 'compare',
  name: 'Compare',
  description: 'Two or three scenarios side by side, one figure each and the change from the first; each card shows whether it is worked out yet.',
  sizes: ['chip', 'wide', 'block'],
  props: {
    scenarios: {
      kind: 'list',
      label: 'Scenarios',
      required: true,
      bindable: true,
      max: 3,
      item: {
        label: { kind: 'text', max: TEXT.label, label: 'Label', required: true },
        value: { kind: 'number', label: 'Value', bindable: true },
        state: { kind: 'enum', options: ['idle', 'running', 'done'], label: 'State', bindable: true },
        slot: { kind: 'slot', label: 'Colour' },
      },
    },
    unit: { kind: 'text', max: TEXT.unit, label: 'Unit' },
    decimals: { kind: 'number', min: 0, max: 2, label: 'Decimals' },
    better: { kind: 'enum', options: ['lower', 'higher'], label: 'Better is', default: 'lower' },
  },
  // A chip is one number; otherwise each card is one read, and the change on the cards after the first is one more.
  reads: (props, size) => {
    const count = (props.scenarios as unknown[] | undefined)?.length ?? 0;
    return size === 'chip' ? 1 : count + (count > 1 ? 1 : 0);
  },
  mount(el, env) {
    const root = h('div', `mrs-compare${env.size === 'chip' ? ' is-chip' : ''}`);
    el.append(root);
    const cards: { card: HTMLElement; label: HTMLElement; value: HTMLElement; change: HTMLElement }[] = [];
    const chip = h('div', 'mrs-stat-row');
    const chipValue = h('span', 'mrs-number');
    const chipLabel = h('span', 'mrs-unit');
    chip.append(chipValue, chipLabel);
    if (env.size === 'chip') root.append(chip);
    return {
      update(props) {
        const list = (props.scenarios ?? []) as { label?: string; value?: number; state?: ScenarioState; slot?: number }[];
        const better = props.better === 'higher' ? 1 : -1;
        const baseline = list[0]?.state === 'idle' || list[0]?.state === 'running' ? undefined : list[0]?.value;
        const changeText = (change: number | null) => (change === null ? '' : `${change > 0 ? '▲' : change < 0 ? '▼' : '■'} ${Math.round(Math.abs(change) * 100)}%`);
        if (env.size === 'chip') {
          // The last scenario that is worked out: the plan until the best one is found.
          const done = list.slice(1).filter((item) => item.state !== 'idle' && item.state !== 'running' && item.value !== undefined);
          const last = done[done.length - 1];
          const change = last ? scenarioChange(baseline, last.value) : null;
          setText(chipValue, change === null ? '–' : changeText(change));
          chipValue.dataset.good = change === null || change === 0 ? '' : String(Math.sign(change) === better);
          setText(chipLabel, last?.label ?? '');
          return;
        }
        while (cards.length < list.length) {
          const card = h('div', 'mrs-scenario');
          const label = h('div', 'mrs-scenario-label');
          const value = h('div', 'mrs-number');
          const change = h('div', 'mrs-scenario-change');
          card.append(label, value, change);
          root.append(card);
          cards.push({ card, label, value, change });
        }
        while (cards.length > list.length) cards.pop()!.card.remove();
        list.forEach((item, i) => {
          const c = cards[i]!;
          const state: ScenarioState = item.state ?? (item.value === undefined ? 'idle' : 'done');
          c.card.dataset.state = state;
          c.card.style.setProperty('--mrs-scenario', slotColor(item.slot, i + 1));
          setText(c.label, item.label ?? '');
          setText(c.value, state === 'done' ? `${formatValue(item.value, props)}${props.unit ? ` ${props.unit}` : ''}` : state === 'running' ? 'Working…' : 'Not run');
          const change = i > 0 && state === 'done' ? scenarioChange(baseline, item.value) : null;
          setText(c.change, changeText(change));
          c.change.dataset.good = change === null || change === 0 ? '' : String(Math.sign(change) === better);
        });
      },
    };
  },
});
