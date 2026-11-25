// Field walk (#445): visitors walk the place the table shows and mark spots from their phones,
// each with a photo or a sound. On the table every spot is a dot in its walker's colour, each
// walker's spots joined faintly in the order they were taken; sound spots ripple. No words.
// The controller's hero shows the spot on show large, or plays its sound, and picks another.
//
// The phones send spots to the host (field.add / field.part, crates/mrs-host/src/field.rs). The
// host bumps the state param `revision` when the list changes, and every view fetches it again.
// The spot on show is the state param `shown`, so the table, the controller and the editor agree.
import { defineLayer, tableFrame } from '@mrstudio/sdk';
import type { CanvasOverlay, LayerManifest } from '@mrstudio/sdk';

import manifest from '../layer.json';
import { fieldHero } from './hero.ts';
import { fetchWalk, nearest, tracks } from './spots.ts';
import type { Spot, Track } from './spots.ts';

export interface Params {
  trails: boolean;
  opacity: number;
  shown: string;
  revision: number;
}

/** Sizes in metres on the ground, kept at least so many pixels so they read on a small table. */
const DOT_M = 6;
const MIN_DOT_PX = 9;
/** A tap within this many metres of a spot picks it. */
const REACH_M = 18;
/** Seconds a new spot takes to arrive on the table. */
const ARRIVE_S = 0.9;

export default defineLayer<Params>({
  manifest: manifest as LayerManifest,

  async table(ctx) {
    const frame = tableFrame(ctx.site);
    const canvas: CanvasOverlay = ctx.map.addCanvas('fieldwalk');
    canvas.setOpacity(ctx.params.opacity);

    let spots: Spot[] = [];
    let walks: Track[] = [];
    /** When each spot was first seen here, in seconds of this view's clock, so new ones arrive. */
    const arrived = new Map<string, number>();
    let clock = 0;
    let loading = 0;
    let first = true;

    async function load() {
      const mine = ++loading;
      const walk = await fetchWalk();
      if (mine !== loading) return;
      spots = walk.spots;
      walks = tracks(spots);
      // On opening, the walks arrive one after another in the order they were taken; later, only new spots.
      const order = walks.flatMap((t) => t.spots);
      order.forEach((spot, i) => {
        if (!arrived.has(spot.id)) arrived.set(spot.id, clock + (first ? Math.min(i * 0.08, 3) : 0));
      });
      first = false;
      ctx.publish({ spots: spots.length, walkers: walks.length });
    }
    await load();

    // A tap on a spot puts it on show on the controller.
    ctx.pointer.on((sample) => {
      if (sample.phase !== 'down') return;
      const hit = nearest(spots, sample.point, REACH_M, (s) => frame.toTable([s.lon, s.lat]) as [number, number]);
      if (hit) ctx.setParams({ shown: hit.id });
    });

    ctx.onFrame((dt) => {
      clock += dt;
      const g = canvas.context;
      const px = canvas.pixelsPerMetre;
      const dot = Math.max(MIN_DOT_PX, DOT_M * px);
      canvas.clear();
      const shown = ctx.params.shown;
      const anyShown = shown !== '' && spots.some((s) => s.id === shown);

      for (const track of walks) {
        const points = track.spots.map((s) => canvas.project([s.lon, s.lat]));
        const grown = track.spots.map((s) => grow(clock - (arrived.get(s.id) ?? clock)));
        // The walk: a faint dashed line through the spots that have arrived.
        if (ctx.params.trails && points.length > 1) {
          g.save();
          g.strokeStyle = track.colour;
          g.globalAlpha = anyShown ? 0.18 : 0.35;
          g.lineWidth = Math.max(1.5, 0.35 * dot);
          g.setLineDash([dot * 0.9, dot * 0.7]);
          g.lineCap = 'round';
          g.beginPath();
          let started = false;
          points.forEach(([x, y], i) => {
            if (grown[i]! <= 0) return;
            if (started) g.lineTo(x, y);
            else g.moveTo(x, y);
            started = true;
          });
          g.stroke();
          g.restore();
        }
        track.spots.forEach((spot, i) => {
          const k = grown[i]!;
          if (k <= 0) return;
          const [x, y] = points[i]!;
          const on = spot.id === shown;
          const dim = anyShown && !on ? 0.45 : 1;
          const r = dot * k * (on ? 1.5 : 1);
          g.save();
          g.globalAlpha = dim;
          // Glow.
          const glow = g.createRadialGradient(x, y, 0, x, y, r * 3);
          glow.addColorStop(0, withAlpha(track.colour, 0.55));
          glow.addColorStop(1, withAlpha(track.colour, 0));
          g.fillStyle = glow;
          g.beginPath();
          g.arc(x, y, r * 3, 0, Math.PI * 2);
          g.fill();
          // A sound ripples outwards, twice a cycle.
          if (spot.kind === 'sound') {
            for (const offset of [0, 0.5]) {
              const t = (clock / 2.4 + offset + i * 0.13) % 1;
              g.strokeStyle = withAlpha(track.colour, 0.7 * (1 - t));
              g.lineWidth = Math.max(1, 0.18 * dot);
              g.beginPath();
              g.arc(x, y, r * (1.2 + 2.6 * t), 0, Math.PI * 2);
              g.stroke();
            }
          }
          // The dot: a photo is a solid dot with a light rim, a sound a ring with a centre.
          g.fillStyle = track.colour;
          g.beginPath();
          g.arc(x, y, r, 0, Math.PI * 2);
          g.fill();
          g.lineWidth = Math.max(1, 0.22 * dot);
          g.strokeStyle = spot.kind === 'photo' ? 'rgb(255 255 255 / 0.9)' : 'rgb(10 12 20 / 0.85)';
          g.beginPath();
          g.arc(x, y, spot.kind === 'photo' ? r : r * 0.55, 0, Math.PI * 2);
          g.stroke();
          // The spot on show breathes.
          if (on) {
            const breath = 0.5 + 0.5 * Math.sin(clock * 3);
            g.strokeStyle = `rgb(255 255 255 / ${0.55 + 0.4 * breath})`;
            g.lineWidth = Math.max(2, 0.3 * dot);
            g.beginPath();
            g.arc(x, y, r * (1.7 + 0.35 * breath), 0, Math.PI * 2);
            g.stroke();
          }
          g.restore();
        });
      }
    });

    return {
      update(changed) {
        if (changed.includes('revision')) void load();
        if (changed.includes('opacity')) canvas.setOpacity(ctx.params.opacity);
      },
    };
  },

  hero: (ctx, el) => fieldHero(ctx, el),
});

/** 0 before a spot arrives, then grows to a little over 1 and settles at 1. */
function grow(age: number): number {
  if (age <= 0) return 0;
  const t = Math.min(1, age / ARRIVE_S);
  return 1 + 0.25 * Math.sin(Math.PI * t) - (1 - t) ** 3;
}

function withAlpha(hex: string, alpha: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return `rgb(255 255 255 / ${alpha})`;
  const n = parseInt(m[1]!, 16);
  return `rgb(${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255} / ${alpha})`;
}
