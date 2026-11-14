import { colormaps, cssGradient, defineLayer, hasSiteData, loadSiteData, lut, siteProjection } from '@mrstudio/sdk';
import type { CanvasOverlay, LayerManifest } from '@mrstudio/sdk';

import manifest from '../layer.json';
import { arrivals, positionAt, prepareCells, prepareTrips, stepAt } from './trips.ts';
import type { Cells, LonLat } from './trips.ts';

interface Params {
  play: boolean;
  progress: number;
  speed: string;
  trips: boolean;
  routes: boolean;
  cells: boolean;
  opacity: number;
}

/** The optional dataset drawn under the trips. */
const CELLS = 'trip_cells';
/** The step of the `progress` control. */
const PROGRESS_STEP = 0.5;
/** Seconds between the progress and arrival counts the table reports while playing. */
const REPORT_S = 0.25;
/** Seconds the finished state is held before the day starts again. */
const HOLD_S = 3;
const CELL_COLOURS = colormaps.speed;

function trace(overlay: CanvasOverlay, coordinates: LonLat[]): void {
  const g = overlay.context;
  coordinates.forEach((point, i) => {
    const [x, y] = overlay.project(point);
    if (i === 0) g.moveTo(x, y);
    else g.lineTo(x, y);
  });
}

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

export default defineLayer<Params>({
  manifest: manifest as LayerManifest,

  async table(ctx) {
    const distance = siteProjection(ctx.site).distance;
    // Bottom to top: values, routes, travellers.
    const cellCanvas = ctx.map.addCanvas('cells', { opacity: ctx.params.opacity });
    const routeCanvas = ctx.map.addCanvas('routes', { opacity: ctx.params.opacity });
    const tripCanvas = ctx.map.addCanvas('trips', { opacity: ctx.params.opacity });

    const [rawTrips, rawCells] = await Promise.all([
      loadSiteData(ctx.site, 'trips'),
      hasSiteData(ctx.site, CELLS) ? loadSiteData(ctx.site, CELLS) : null,
    ]);
    const trips = prepareTrips(rawTrips, distance);
    const cells: Cells | null = rawCells ? prepareCells(rawCells) : null;
    const colours = lut(CELL_COLOURS);
    const duration = Math.max(1, trips.duration);

    let time = (ctx.params.progress / 100) * duration;
    let held = 0;
    let sinceReport = Infinity;
    /** Progress values this table sent, to tell its own echoes from someone scrubbing. */
    const sent: number[] = [];
    let cellsDrawn = '';
    let routesDrawn = '';

    const step = () => (cells ? stepAt(time / duration, cells.steps.length) : 0);

    function report(): void {
      sinceReport = 0;
      const counts = arrivals(trips, time);
      ctx.publish({
        title: trips.title,
        seconds: Math.round(time),
        duration,
        groups: trips.groups.map((g, i) => ({ label: g.label, color: g.color, arrived: counts[i], total: trips.trips.filter((t) => t.group === i).length })),
        cells: cells ? { label: cells.label, unit: cells.unit, min: cells.min, max: cells.max, step: cells.steps[step()] } : null,
      });
      const progress = Math.round(((time / duration) * 100) / PROGRESS_STEP) * PROGRESS_STEP;
      if (ctx.params.play && progress !== ctx.params.progress && !sent.includes(progress)) {
        sent.push(progress);
        if (sent.length > 8) sent.shift();
        ctx.setParams({ progress });
      }
    }

    function drawCells(): void {
      const g = cellCanvas.context;
      cellCanvas.clear();
      if (!cells || !ctx.params.cells) return;
      const index = step();
      for (const cell of cells.cells) {
        const value = cell.values[index] ?? null;
        if (value === null) continue;
        const k = Math.round(Math.min(1, Math.max(0, (value - cells.min) / (cells.max - cells.min))) * 255) * 4;
        g.beginPath();
        for (const ring of cell.rings) {
          trace(cellCanvas, ring);
          g.closePath();
        }
        g.fillStyle = `rgb(${colours[k]} ${colours[k + 1]} ${colours[k + 2]} / 0.5)`;
        g.fill('evenodd');
      }
    }

    function drawRoutes(): void {
      const g = routeCanvas.context;
      routeCanvas.clear();
      if (!ctx.params.trips || !ctx.params.routes) return;
      g.lineWidth = Math.max(1, 1.2 * routeCanvas.pixelsPerMetre);
      g.lineJoin = 'round';
      // Many faint lines add up, so busy corridors read brighter.
      g.globalAlpha = Math.min(0.5, Math.max(0.06, 8 / Math.max(1, trips.trips.length)));
      trips.groups.forEach((group, index) => {
        g.beginPath();
        for (const trip of trips.trips) if (trip.group === index) for (const leg of trip.legs) trace(routeCanvas, leg.coordinates);
        g.strokeStyle = group.color;
        g.stroke();
      });
      g.globalAlpha = 1;
    }

    function drawTrips(): void {
      const g = tripCanvas.context;
      const scale = tripCanvas.pixelsPerMetre;
      tripCanvas.clear();
      if (ctx.params.trips) {
        const radius = Math.max(3, 4 * scale);
        for (const trip of trips.trips) {
          const { point, state } = positionAt(trip, time);
          if (state === 'arrived') continue;
          const [x, y] = tripCanvas.project(point);
          if (x < -radius || y < -radius || x > tripCanvas.width + radius || y > tripCanvas.height + radius) continue;
          const colour = trips.groups[trip.group]!.color;
          g.globalAlpha = state === 'home' ? 0.35 : 1;
          g.beginPath();
          g.arc(x, y, state === 'home' ? radius * 0.6 : radius, 0, Math.PI * 2);
          g.fillStyle = colour;
          g.fill();
          if (state === 'home') continue;
          g.lineWidth = Math.max(1, radius * 0.3);
          g.strokeStyle = '#0b0e14';
          g.stroke();
          if (state === 'waiting') {
            // A ring marks someone waiting for a connection.
            g.beginPath();
            g.arc(x, y, radius * 1.9, 0, Math.PI * 2);
            g.strokeStyle = colour;
            g.stroke();
          }
        }
        g.globalAlpha = 1;
      }
      if (!trips.destination) return;
      const [x, y] = tripCanvas.project(trips.destination.coordinates);
      const radius = Math.max(6, 7 * scale);
      g.beginPath();
      g.arc(x, y, radius, 0, Math.PI * 2);
      g.fillStyle = '#ffffff';
      g.fill();
      g.lineWidth = Math.max(2, radius * 0.4);
      g.strokeStyle = '#0b0e14';
      g.stroke();
      const label = trips.destination.label;
      if (!label) return;
      const size = Math.max(12, 11 * scale);
      g.font = `600 ${Math.round(size)}px system-ui, sans-serif`;
      g.textBaseline = 'middle';
      g.textAlign = 'left';
      const width = g.measureText(label).width + size;
      const left = Math.min(tripCanvas.width - width, x + radius + 6);
      g.fillStyle = 'rgb(11 14 20 / 0.85)';
      g.fillRect(left, y - size, width, size * 2);
      g.fillStyle = '#f8fafc';
      g.fillText(label, left + size / 2, y + 1);
    }

    ctx.onFrame((dt) => {
      if (ctx.params.play) {
        if (time >= duration) {
          held += dt;
          if (held >= HOLD_S) {
            held = 0;
            time = 0;
          }
        } else {
          time = Math.min(duration, time + dt * Number(ctx.params.speed));
        }
      }
      sinceReport += dt;
      if (sinceReport >= REPORT_S) report();

      // The static canvases are redrawn only when what they show changes.
      const cellsKey = `${cellCanvas.revision}:${step()}:${ctx.params.cells}`;
      if (cellsKey !== cellsDrawn) {
        drawCells();
        cellsDrawn = cellsKey;
      }
      const routesKey = `${routeCanvas.revision}:${ctx.params.trips}:${ctx.params.routes}`;
      if (routesKey !== routesDrawn) {
        drawRoutes();
        routesDrawn = routesKey;
      }
      drawTrips();
    });

    return {
      update(changed) {
        if (changed.includes('opacity')) for (const canvas of [cellCanvas, routeCanvas, tripCanvas]) canvas.setOpacity(ctx.params.opacity);
        if (changed.includes('progress')) {
          const mine = sent.indexOf(ctx.params.progress);
          if (mine >= 0) sent.splice(0, mine + 1);
          else {
            // Someone moved the time: follow them.
            time = (ctx.params.progress / 100) * duration;
            held = 0;
            sent.length = 0;
          }
        }
        if (changed.includes('play') && ctx.params.play && time >= duration) time = 0;
        sinceReport = Infinity;
      },
    };
  },

  panel(ctx, el) {
    el.innerHTML = `
      <style>
        .mobility-panel { display: grid; gap: 12px; font-variant-numeric: tabular-nums; }
        .mobility-head { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; }
        .mobility-clock { font-size: 2rem; font-weight: 600; }
        .mobility-title { opacity: 0.8; text-align: right; }
        .mobility-groups { display: grid; gap: 8px; }
        .mobility-group { display: grid; grid-template-columns: auto 1fr auto; gap: 4px 10px; align-items: center; }
        .mobility-dot { width: 12px; height: 12px; border-radius: 50%; }
        .mobility-bar { grid-column: 1 / -1; height: 8px; border-radius: 4px; background: rgb(255 255 255 / 0.12); overflow: hidden; }
        .mobility-bar i { display: block; height: 100%; }
        .mobility-ramp { height: 10px; border-radius: 5px; background: ${cssGradient(CELL_COLOURS)}; }
        .mobility-ticks { display: flex; justify-content: space-between; font-size: 0.8rem; opacity: 0.7; margin-top: 4px; }
        .mobility-caption { font-size: 0.8rem; opacity: 0.7; margin-bottom: 4px; }
      </style>
      <div class="mobility-panel">
        <div class="mobility-head"><span class="mobility-clock"></span><span class="mobility-title"></span></div>
        <div class="mobility-groups"></div>
        <div class="mobility-cells"><div class="mobility-caption"></div><div class="mobility-ramp"></div><div class="mobility-ticks"><span></span><span></span></div></div>
      </div>`;
    const time = el.querySelector<HTMLElement>('.mobility-clock')!;
    const title = el.querySelector<HTMLElement>('.mobility-title')!;
    const groups = el.querySelector<HTMLElement>('.mobility-groups')!;
    const legend = el.querySelector<HTMLElement>('.mobility-cells')!;
    const caption = el.querySelector<HTMLElement>('.mobility-caption')!;
    const [low, high] = el.querySelectorAll<HTMLElement>('.mobility-ticks span');

    function update() {
      const shared = ctx.shared;
      time.textContent = shared.seconds === undefined ? '' : clock(shared.seconds);
      time.title = shared.duration === undefined ? '' : `of ${clock(shared.duration)}`;
      title.textContent = shared.title ?? '';
      const list: { label: string; color: string; arrived: number; total: number }[] = shared.groups ?? [];
      groups.hidden = !ctx.params.trips;
      // Rows are rebuilt only when the groups change, so the bars can animate.
      if (groups.children.length !== list.length) {
        groups.replaceChildren(
          ...list.map(() => {
            const row = document.createElement('div');
            row.className = 'mobility-group';
            row.innerHTML = '<span class="mobility-dot"></span><span class="mobility-label"></span><span class="mobility-count"></span><div class="mobility-bar"><i></i></div>';
            return row;
          }),
        );
      }
      list.forEach((group, i) => {
        const row = groups.children[i] as HTMLElement;
        row.querySelector<HTMLElement>('.mobility-dot')!.style.background = group.color;
        row.querySelector<HTMLElement>('.mobility-label')!.textContent = group.label;
        row.querySelector<HTMLElement>('.mobility-count')!.textContent = `${group.arrived} of ${group.total} arrived`;
        const bar = row.querySelector<HTMLElement>('.mobility-bar i')!;
        bar.style.background = group.color;
        bar.style.width = `${group.total > 0 ? (group.arrived / group.total) * 100 : 0}%`;
      });
      const cells = shared.cells as { label: string | null; unit: string; min: number; max: number; step: string } | null | undefined;
      legend.hidden = !cells || !ctx.params.cells;
      if (cells) {
        caption.textContent = [cells.label, cells.step].filter(Boolean).join(' · ');
        low!.textContent = `${cells.min} ${cells.unit}`.trim();
        high!.textContent = `${cells.max}+ ${cells.unit}`.trim();
      }
    }
    update();
    return { update };
  },
});
