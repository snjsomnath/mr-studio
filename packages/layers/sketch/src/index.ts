import { defineLayer } from '@mrstudio/sdk';
import type { LayerManifest, Shape } from '@mrstudio/sdk';

import manifest from '../layer.json';

interface Params {
  opacity: number;
}

/** The oldest marks are dropped beyond this many, so a long session stays light. */
const MOST = 200;

/**
 * Marks from phones, drawn on the table in each phone's colour. It is also the
 * reference for a layer with tools: declare them in layer.json, handle `tool`.
 */
export default defineLayer<Params>({
  manifest: manifest as LayerManifest,

  table(ctx) {
    const overlay = ctx.map.addShapes('marks', { opacity: ctx.params.opacity });
    /** A phone's place, keyed by its slot: dragging moves the mark instead of leaving a trail. */
    const places = new Map<number, Shape>();
    let marks: Shape[] = [];
    const show = () => {
      overlay.set([...marks, ...places.values()]);
      ctx.publish({ count: marks.length + places.size });
    };
    show();

    return {
      update(changed) {
        if (changed.includes('opacity')) overlay.setOpacity(ctx.params.opacity);
      },
      action(action) {
        if (action !== 'clear') return;
        marks = [];
        places.clear();
        show();
      },
      tool(input) {
        const shape: Shape = { geometry: input.geometry, colour: input.participant?.colour };
        if (input.tool === 'place' && input.participant) places.set(input.participant.slot, shape);
        else marks = [...marks, shape].slice(-MOST);
        show();
      },
    };
  },

  panel(ctx, el) {
    const update = () => {
      const count = Number(ctx.shared.count ?? 0);
      el.textContent = count === 0 ? 'Nothing marked yet. Phones can place points, routes and areas.' : count === 1 ? '1 mark on the table' : `${count} marks on the table`;
    };
    update();
    return { update };
  },
});
