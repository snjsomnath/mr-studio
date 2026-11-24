// A team widget (#353): the hour as a dial of the day, with the sun above the horizon by day
// and the moon by night. On the controller a tap plays or pauses the day (the layer's `play`).
import { defineWidget } from '@mrstudio/sdk';

const SVG = 'http://www.w3.org/2000/svg';
const svg = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>) => {
  const node = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
};

export const dayClock = defineWidget({
  type: 'day-clock',
  name: 'Day clock',
  description: 'The hour on a dial of the day, the sun up by day and the moon by night; a tap plays or pauses the day.',
  sizes: ['chip', 'tile'],
  example: { hour: 14.5, playing: true },
  props: {
    hour: { kind: 'value', label: 'Hour (0 to 24)', required: true, bindable: true },
    playing: { kind: 'value', label: 'Playing', bindable: true },
  },
  reads: () => 1,
  mount(el, env) {
    const box = document.createElement('div');
    box.style.cssText = 'display:flex;align-items:center;gap:calc(var(--mrs-u,8px)*1.5);height:100%;justify-content:center;';
    const chip = env.size === 'chip';
    const dial = svg('svg', { viewBox: '-50 -50 100 100', width: chip ? '2.6em' : '45%', height: chip ? '2.6em' : '85%' });
    const ring = svg('circle', { r: 40, fill: 'none', stroke: 'var(--mrs-line, #333)', 'stroke-width': 6 });
    // The day (06 to 18) is the top half; midnight sits at the bottom.
    const day = svg('path', { d: 'M -40 0 A 40 40 0 0 1 40 0', fill: 'none', stroke: 'var(--mrs-data-1, #ffc845)', 'stroke-opacity': 0.35, 'stroke-width': 6 });
    const body = svg('circle', { r: 9, fill: 'var(--mrs-data-1, #ffc845)' });
    dial.append(ring, day, body);
    const words = document.createElement('div');
    words.style.cssText = 'display:grid;gap:0.2em;';
    const time = document.createElement('span');
    time.style.cssText = 'font-size:var(--mrs-type-number-s, 2em);font-weight:600;color:var(--mrs-text);font-variant-numeric:tabular-nums;';
    const state = document.createElement('span');
    state.style.cssText = 'color:var(--mrs-muted);font-size:var(--mrs-type-label, 0.9em);';
    words.append(time, state);
    if (chip) state.hidden = true;
    box.append(dial, words);
    el.append(box);

    let playing = false;
    const touch = env.controls?.touch === true && env.controls.find('play') !== undefined;
    if (touch) {
      box.style.cursor = 'pointer';
      box.setAttribute('role', 'button');
      box.addEventListener('click', () => env.controls!.set('play', !playing));
    }
    return {
      update(props) {
        const hour = typeof props.hour === 'number' ? ((props.hour % 24) + 24) % 24 : 0;
        // A bound value arrives as text (there is no yes/no prop kind yet).
        playing = props.playing === true || props.playing === 'true';
        // 06:00 on the left, noon at the top, 18:00 on the right.
        const angle = ((hour - 6) / 24) * Math.PI * 2;
        const x = -Math.cos(angle) * 40;
        const y = -Math.sin(angle) * 40;
        const daylight = hour >= 6 && hour < 18;
        body.setAttribute('cx', x.toFixed(2));
        body.setAttribute('cy', y.toFixed(2));
        body.setAttribute('fill', daylight ? 'var(--mrs-data-1, #ffc845)' : 'var(--mrs-text, #ddd)');
        body.setAttribute('fill-opacity', daylight ? '1' : '0.7');
        time.textContent = `${String(Math.floor(hour)).padStart(2, '0')}:00`;
        state.textContent = touch ? (playing ? 'Playing · tap to pause' : 'Paused · tap to play') : playing ? 'Playing' : 'Paused';
      },
    };
  },
});
