import { drawCue, tableFrame } from '@mrstudio/sdk';
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
  private playing: { target: CueTarget; colour: Rgba; started: number }[] = [];
  private canvas: CanvasOverlay | null = null;
  private frame: ReturnType<typeof tableFrame>;
  private readonly view: TableView;

  constructor(view: TableView) {
    this.view = view;
    this.frame = tableFrame(view.site);
  }

  play(geometry: ToolGeometry, colour?: string): void {
    this.playing.push({ target: cueTarget(this.view.site, geometry), colour: rgba(colour), started: performance.now() });
    if (!this.canvas) {
      this.canvas = this.view.topCanvas('attention-cue');
      requestAnimationFrame(this.draw);
    }
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
    this.playing = this.playing.filter((cue) =>
      drawCue(view, cue.target, (now - cue.started) / 1000, { colour: cue.colour, frame: { width: frame.width, height: frame.height } }),
    );
    if (this.playing.length > 0) requestAnimationFrame(this.draw);
    else {
      canvas.remove();
      this.canvas = null;
    }
  };
}
