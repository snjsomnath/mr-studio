import { colormaps, cssGradient, defineLayer, stretch } from '@mrstudio/sdk';
import type { FieldFrame, FlowOverlay, LayerManifest, TableContext } from '@mrstudio/sdk';

import manifest from '../layer.json';

interface Params {
  speed: number;
  direction: number;
  style: 'ribbons' | 'particles' | 'map';
  scale: string;
  trees: boolean;
  detail: string;
  playback: number;
  opacity: number;
  backdrop: number;
}

/** The field arrives a few times a second; the tracers animate on the table in between. */
const FIELD_HZ = 8;
/** Share of the table's longer side a tracer crosses per second, per m/s of wind. */
const TRACER_RATE = 0.04;
const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];

function kernelParams(ctx: TableContext<Params>) {
  const { speed, direction, trees, detail } = ctx.params;
  return { speed, direction_deg: direction, trees, resolution: Number(detail) };
}

export default defineLayer<Params>({
  manifest: manifest as LayerManifest,

  async table(ctx) {
    // Frames are quantised over 0..fieldMax; the legend ends at the chosen colour range.
    let fieldMax = 2.5 * ctx.params.speed;
    const ramp = () => stretch(colormaps.speed, Number(ctx.params.scale) / fieldMax);
    // Under ribbons and particles the speed map is a quiet backdrop (#143), as strong as the author sets; 0 hides it.
    const mapOpacity = () => ctx.params.opacity * (ctx.params.style === 'map' ? 1 : ctx.params.backdrop ?? 0.25);
    const flowStyle = () => ({
      mode: ctx.params.style === 'particles' ? ('particles' as const) : ('ribbons' as const),
      // Both styles are coloured by speed with white highlights, as in the Chalmers demo (#159).
      colormap: colormaps.speed,
      max: Number(ctx.params.scale),
      rate: TRACER_RATE * ctx.params.playback,
      opacity: ctx.params.opacity,
    });

    const speed = ctx.map.addField('speed', { colormap: ramp(), opacity: mapOpacity() });
    let flow: FlowOverlay | null = null;
    let u: FieldFrame | null = null;
    let v: FieldFrame | null = null;
    const restyle = () => {
      speed.setStyle({ colormap: ramp(), opacity: mapOpacity() });
      if (ctx.params.style === 'map') {
        flow?.remove();
        flow = null;
      } else if (flow) {
        flow.setStyle(flowStyle());
      } else {
        flow = ctx.map.addFlow('flow', flowStyle());
        if (u && v) flow.set(u, v);
      }
    };
    restyle();

    const stream = await ctx.engine.open('wind', kernelParams(ctx), ['speed', 'u', 'v'], { maxHz: FIELD_HZ });
    stream.on('speed', (frame) => {
      if (frame.max !== fieldMax) {
        fieldMax = frame.max;
        speed.setStyle({ colormap: ramp() });
      }
      speed.set(frame);
    });
    stream.on('u', (frame) => (u = frame));
    stream.on('v', (frame) => {
      v = frame;
      // The components travel as two frames; draw once both belong to the same result.
      if (u && u.revision === frame.revision) flow?.set(u, frame);
    });
    stream.onStatus((status) => {
      ctx.publish({
        settled: status.state === 'done',
        progress: Math.round(status.progress * 100),
        peak: Math.round(status.info.peak_mps * 10) / 10,
        cell: status.info.lattice.cell_m,
      });
    });

    return {
      update(changed) {
        if (changed.some((key) => key === 'style' || key === 'scale' || key === 'opacity' || key === 'backdrop' || key === 'playback')) restyle();
        if (changed.some((key) => key === 'speed' || key === 'direction' || key === 'trees' || key === 'detail')) stream.set(kernelParams(ctx));
      },
    };
  },

  panel(ctx, el) {
    el.innerHTML = `
      <style>
        .wind-panel { display: grid; gap: 12px; }
        .wind-readout { display: flex; justify-content: space-between; align-items: center; gap: 12px; font-variant-numeric: tabular-nums; }
        .wind-speed { font-size: 2rem; font-weight: 600; }
        .wind-from { opacity: 0.7; }
        .wind-arrow { width: 44px; height: 44px; flex: none; transition: transform 0.2s; }
        .wind-ramp { height: 10px; border-radius: 5px; }
        .wind-ticks { display: flex; justify-content: space-between; font-size: 0.8rem; opacity: 0.7; margin-top: 4px; }
        .wind-status { font-size: 0.85rem; opacity: 0.7; }
      </style>
      <div class="wind-panel">
        <div class="wind-readout">
          <div><div class="wind-speed"></div><div class="wind-from"></div></div>
          <svg class="wind-arrow" viewBox="-12 -12 24 24" aria-hidden="true">
            <circle r="11" fill="none" stroke="currentColor" stroke-opacity="0.25"/>
            <path d="M0 8 L0 -7 M-4 -3 L0 -8 L4 -3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </div>
        <div><div class="wind-ramp"></div><div class="wind-ticks"><span>0</span><span></span><span></span></div></div>
        <div class="wind-status"></div>
      </div>`;
    const speed = el.querySelector<HTMLElement>('.wind-speed')!;
    const from = el.querySelector<HTMLElement>('.wind-from')!;
    const arrow = el.querySelector<SVGElement>('.wind-arrow')!;
    const ramp = el.querySelector<HTMLElement>('.wind-ramp')!;
    const [, middle, top] = el.querySelectorAll<HTMLElement>('.wind-ticks span');
    const status = el.querySelector<HTMLElement>('.wind-status')!;
    ramp.style.background = cssGradient(colormaps.speed);

    function update() {
      const { direction, scale } = ctx.params;
      const { settled, progress, peak } = ctx.shared;
      speed.textContent = `${ctx.params.speed} m/s`;
      from.textContent = `from the ${COMPASS[Math.round(direction / 45) % 8]}`;
      // The arrow points the way the wind blows, as seen on the table.
      arrow.style.transform = `rotate(${direction + 180 - ctx.site.extent.rotation_deg}deg)`;
      middle!.textContent = `${Number(scale) / 2}`;
      top!.textContent = `${scale}+ m/s`;
      const fastest = peak ? ` Fastest spot ${peak} m/s.` : '';
      status.textContent = settled ? `Steady.${fastest}` : progress === undefined ? '' : `Settling, ${progress}%.${fastest}`;
    }
    update();
    return { update };
  },
});
