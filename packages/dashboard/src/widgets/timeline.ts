import { formatValue } from '../bind.ts';
import { defineWidget } from '../registry.ts';
import { h, setText } from './dom.ts';

/** Where "now" is in a span of hours, with the daylight part lifted out. */
export const timeline = defineWidget({
  type: 'timeline',
  name: 'Timeline',
  description: 'A span of hours with a marker on the hour being shown, the part already played, and daylight shaded.',
  sizes: ['band'],
  example: { now: 14.5, dayFrom: 4.2, dayTo: 21.9 },
  props: {
    now: { kind: 'number', label: 'Hour shown', required: true, bindable: true },
    start: { kind: 'number', label: 'First hour', default: 0, bindable: true },
    end: { kind: 'number', label: 'Last hour', default: 24, bindable: true },
    dayFrom: { kind: 'number', min: 0, max: 24, label: 'Daylight from', bindable: true },
    dayTo: { kind: 'number', min: 0, max: 24, label: 'Daylight to', bindable: true },
  },
  // The clock reading and the marker's place on the scale.
  reads: () => 2,
  mount(el) {
    const clock = h('span', 'mrs-timeline-now');
    const track = h('div', 'mrs-timeline-track');
    const day = h('div', 'mrs-timeline-day');
    const played = h('div', 'mrs-timeline-played');
    const ticks = h('div', 'mrs-timeline-ticks');
    const head = h('div', 'mrs-timeline-head');
    track.append(day, played, ticks, head);
    const wrap = h('div', 'mrs-timeline');
    wrap.append(clock, track);
    el.append(wrap);
    let span = '';
    return {
      update(props) {
        const start = props.start ?? 0;
        const end = Math.max(start + 1, props.end ?? 24);
        const at = (hour: number) => `${(Math.max(0, Math.min(1, (hour - start) / (end - start))) * 100).toFixed(2)}%`;
        const now = props.now ?? start;
        setText(clock, formatValue(((now % 24) + 24) % 24, { format: 'hour' }));
        head.style.left = at(now);
        played.style.width = at(now);
        const lit = props.dayFrom !== undefined && props.dayTo !== undefined && props.dayTo > props.dayFrom;
        day.hidden = !lit;
        if (lit) {
          day.style.left = at(props.dayFrom);
          day.style.width = `calc(${at(props.dayTo)} - ${at(props.dayFrom)})`;
        }
        // At most nine labels, however long the span: labels thin out, they never shrink.
        if (span !== `${start}-${end}`) {
          span = `${start}-${end}`;
          const step = [1, 2, 3, 6, 12, 24, 48].find((s) => (end - start) / s <= 8) ?? 48;
          ticks.replaceChildren();
          for (let hour = Math.ceil(start / step) * step; hour <= end; hour += step) {
            const tick = h('span', 'mrs-timeline-tick', formatValue(hour % 24, { format: 'hour' }));
            tick.style.left = at(hour);
            ticks.append(tick);
          }
        }
      },
    };
  },
});
