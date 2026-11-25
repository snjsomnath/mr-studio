import { CUE_SECONDS, cuePoints, drawCue, tableFrame } from '@mrstudio/sdk';

import { ANIMALS } from './avatars.ts';
import type { CanvasOverlay, CueTarget, Point, Rgba, SiteInfo, ToolGeometry, View } from '@mrstudio/sdk';

import type { TableView } from './table.ts';

/** A CSS colour as RGBA, for the few forms a phone's colour comes in. White when it cannot be read. */
export function rgba(colour: string | undefined): Rgba {
  const hex = colour?.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)?.[1];
  if (hex) {
    const full = hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex;
    return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16), 1];
  }
  const rgb = colour?.match(/^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), 1];
  return [255, 255, 255, 1];
}

/** A tool's geometry in table metres, as a cue target. */
export function cueTarget(site: Pick<SiteInfo, 'origin' | 'extent'>, geometry: ToolGeometry): CueTarget {
  const frame = tableFrame(site);
  const at = (p: readonly number[]): Point => frame.toTable([p[0]!, p[1]!]);
  switch (geometry.type) {
    case 'Point':
      return { point: at(geometry.coordinates) };
    case 'LineString':
      return { line: geometry.coordinates.map(at) };
    case 'Polygon':
      return { area: (geometry.coordinates[0] ?? []).map(at) };
  }
}

/**
 * Plays attention cues (#105) above every layer of the table view. The canvas exists only
 * while a cue plays, so a table at rest draws nothing extra.
 */
export class Cues {
  private playing: { target: CueTarget; colour: Rgba; started: number; animal?: string }[] = [];
  private canvas: CanvasOverlay | null = null;
  private frame: ReturnType<typeof tableFrame>;
  private readonly view: TableView;

  constructor(view: TableView) {
    this.view = view;
    this.frame = tableFrame(view.site);
  }

  /** `avatar` is the phone's animal (#423): it shows small inside the pulse, never a name. */
  play(geometry: ToolGeometry, colour?: string, avatar?: string): void {
    const animal = avatar ? ANIMALS[avatar]?.emoji : undefined;
    this.playing.push({ target: cueTarget(this.view.site, geometry), colour: rgba(colour), started: performance.now(), animal });
    if (!this.canvas) {
      this.canvas = this.view.topCanvas('attention-cue');
      requestAnimationFrame(this.draw);
    }
  }

  /**
   * The phone's animal on a disc of its colour, where the cue lands (a line's or area's middle).
   * It pops in, holds, and fades with the pulse; a few centimetres across on the table.
   */
  private animal(view: View, target: CueTarget, emoji: string, colour: Rgba, age: number): void {
    const points = cuePoints(target);
    if (points.length === 0) return;
    let [x, y] = [0, 0];
    for (const [px, py] of points) [x, y] = [x + px / points.length, y + py / points.length];
    const at = view.toPx([x, y]);
    const t = age / CUE_SECONDS;
    const grow = Math.min(1, t / 0.15);
    const fade = t < 0.7 ? 1 : Math.max(0, 1 - (t - 0.7) / 0.3);
    const radius = Math.max(14, Math.min(40, view.scale * 14)) * (0.6 + 0.4 * grow);
    const pen = view.pen;
    pen.save();
    pen.globalAlpha = fade;
    pen.fillStyle = `rgba(${colour[0]}, ${colour[1]}, ${colour[2]}, 0.95)`;
    pen.beginPath();
    pen.arc(at[0], at[1], radius, 0, Math.PI * 2);
    pen.fill();
    pen.font = `${Math.round(radius * 1.25)}px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif`;
    pen.textAlign = 'center';
    pen.textBaseline = 'middle';
    pen.fillText(emoji, at[0], at[1] + radius * 0.06);
    pen.restore();
  }

  private draw = (now: number): void => {
    const canvas = this.canvas;
    if (!canvas) return;
    canvas.clear();
    const frame = this.frame;
    const view: View = {
      pen: canvas.context,
      scale: canvas.pixelsPerMetre,
      time: now / 1000,
      detail: 1,
      toPx: (point) => canvas.project(frame.toLonLat(point)),
    };
    this.playing = this.playing.filter((cue) => {
      const age = (now - cue.started) / 1000;
      const on = drawCue(view, cue.target, age, { colour: cue.colour, frame: { width: frame.width, height: frame.height } });
      if (on && cue.animal) this.animal(view, cue.target, cue.animal, cue.colour, age);
      return on;
    });
    if (this.playing.length > 0) requestAnimationFrame(this.draw);
    else {
      canvas.remove();
      this.canvas = null;
    }
  };
}
