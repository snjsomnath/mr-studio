import { defineLayer, lonLatToTable, tableToLonLat } from '@mrstudio/sdk';
import type { LayerManifest, Position, Shape, SiteInfo, ToolGeometry } from '@mrstudio/sdk';

import manifest from '../layer.json';

interface Params {
  opacity: number;
}

/** A mark on the table and the phone that made it, if one did. */
interface Mark {
  shapes: Shape[];
  slot?: number;
  /** Words a phone added to it (#462): read on the controller, never drawn on the table. */
  words?: string;
  /** Who added them, for the controller: the phone's name, else its animal. */
  by?: string;
}

/** The last point of a mark's first shape, where its words ring sits. */
function endOf(shape: Shape | undefined): Position | null {
  const g = shape?.geometry;
  if (!g) return null;
  if (g.type === 'Point') return g.coordinates;
  if (g.type === 'LineString') return g.coordinates[g.coordinates.length - 1] ?? null;
  return g.coordinates[0]?.[0] ?? null;
}

/** The oldest marks are dropped beyond this many, so a long session stays light. */
const MOST = 200;

/**
 * The head of an arrow drawn along `line` (#335): a filled triangle at its end, pointing the
 * way the last part of the stroke went, about 4% of the table's width long.
 */
export function arrowHead(site: Pick<SiteInfo, 'corners' | 'extent'>, line: Position[]): ToolGeometry | null {
  const metres = line.map(([lon, lat]) => {
    const [u, v] = lonLatToTable(site, lon!, lat!);
    return [u * site.extent.width_m, v * site.extent.height_m] as const;
  });
  const tip = metres[metres.length - 1];
  if (!tip) return null;
  const length = site.extent.width_m * 0.04;
  // The direction from a point a head's length back along the stroke, so a wobble at the end does not turn it.
  let back = metres[0]!;
  for (let i = metres.length - 2; i >= 0; i--) {
    back = metres[i]!;
    if (Math.hypot(tip[0] - back[0], tip[1] - back[1]) >= length) break;
  }
  const [dx, dy] = [tip[0] - back[0], tip[1] - back[1]];
  const d = Math.hypot(dx, dy);
  if (d < 1e-6) return null;
  const [ux, uy] = [dx / d, dy / d];
  const at = (along: number, side: number): Position => {
    const x = tip[0] - ux * along - uy * side;
    const y = tip[1] - uy * along + ux * side;
    return tableToLonLat(site, x / site.extent.width_m, y / site.extent.height_m);
  };
  const a = at(0, 0);
  return { type: 'Polygon', coordinates: [[a, at(length, length * 0.55), at(length, -length * 0.55), a]] };
}

/**
 * Marks from phones, drawn on the table in each phone's colour: places, pen strokes, arrows,
 * routes and areas. A phone takes back its own last mark; the controller takes back the last.
 * It is also the reference for a layer with tools: declare them in layer.json, handle `tool`.
 */
export default defineLayer<Params>({
  manifest: manifest as LayerManifest,

  table(ctx) {
    const overlay = ctx.map.addShapes('marks', { opacity: ctx.params.opacity });
    /** A phone's place, keyed by its slot: dragging moves the mark instead of leaving a trail. */
    const places = new Map<number, Shape>();
    let marks: Mark[] = [];
    const show = () => {
      // A mark with words gets a small white ring at its end: the words themselves stay on the controller.
      const rings: Shape[] = marks
        .filter((mark) => mark.words)
        .map((mark) => endOf(mark.shapes[0]))
        .filter((at): at is Position => at !== null)
        .map((at) => ({ geometry: { type: 'Point', coordinates: at }, colour: '#ffffff' }));
      overlay.set([...marks.flatMap((mark) => mark.shapes), ...places.values(), ...rings]);
      const said = marks.filter((mark) => mark.words).slice(-2).reverse();
      ctx.publish({ count: marks.length + places.size, words: said.map((mark) => (mark.by ? `${mark.by}: ${mark.words}` : mark.words)).join(' · ') || null });
    };
    show();

    return {
      update(changed) {
        if (changed.includes('opacity')) overlay.setOpacity(ctx.params.opacity);
      },
      action(action, by, words) {
        if (action === 'comment') {
          // Words for this phone's last mark (#462); from the controller, for the last mark of all.
          const mark = [...marks].reverse().find((m) => !by || m.slot === by.slot);
          if (!mark || !words) return;
          mark.words = words;
          mark.by = by?.name || (by?.avatar ? by.avatar.replace(/^./, (c) => c.toUpperCase()) : undefined);
        } else if (action === 'clear') {
          marks = [];
          places.clear();
        } else if (action === 'undo') {
          // A phone takes back its own last mark, or its place when it has no other.
          let index = marks.length - 1;
          while (by && index >= 0 && marks[index]!.slot !== by.slot) index--;
          if (index >= 0) marks.splice(index, 1);
          else if (by) places.delete(by.slot);
        } else return;
        show();
      },
      tool(input) {
        const colour = input.participant?.colour;
        const slot = input.participant?.slot;
        const shape: Shape = { geometry: input.geometry, colour };
        if (input.tool === 'place' && slot !== undefined) {
          places.set(slot, shape);
        } else {
          const shapes = [shape];
          if (input.tool === 'arrow' && input.geometry.type === 'LineString') {
            const head = arrowHead(ctx.site, input.geometry.coordinates);
            if (head) shapes.push({ geometry: head, colour });
          }
          marks = [...marks, { shapes, slot }].slice(-MOST);
        }
        show();
      },
    };
  },
});
