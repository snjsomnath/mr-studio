// __NAME__: a site layer with its own code (docs/contracts/layer.md, "Site layers").
//
// Table: a click or tap on the table places a ring, and every view of the table gets it,
// because the pick goes through the host (`ctx.sendTool`). The controller's primary button
// pulses the centre. Controller: a stat panel bound to what the table publishes, and one
// custom panel drawn here.
//
// Build with `mrstudio layer build` (or `npm run build` in this folder); the app loads
// dist/index.js. Commit dist/ so the table's computer needs no Node.
import { defineLayer, withAlpha } from '@mrstudio/sdk';
import type { LayerManifest, ToolGeometry } from '@mrstudio/sdk';

import manifest from '../layer.json';

interface Params {
  color: string;
  size: number;
}

interface Ring {
  lonLat: [number, number];
  born: number;
}

/** Seconds a ring takes to grow and fade. */
const LIFE_S = 2.4;

export default defineLayer<Params>({
  manifest: manifest as LayerManifest,

  async table(ctx) {
    const canvas = ctx.map.addCanvas('rings');
    const rings: Ring[] = [];
    let now = 0;
    let count = 0;

    const add = (lonLat: [number, number]) => {
      rings.push({ lonLat, born: now });
      count += 1;
      ctx.publish({ rings: count, last: lonLat });
    };

    // A press on the table: send it on as a tool input, so the projector and the editor both draw it.
    ctx.pointer.on((sample) => {
      if (sample.phase !== 'down') return;
      const point: ToolGeometry = { type: 'Point', coordinates: sample.lonLat };
      void ctx.sendTool('ring', point);
    });

    ctx.onFrame((dt) => {
      now += dt;
      while (rings.length && now - rings[0]!.born > LIFE_S) rings.shift();
      const g = canvas.context;
      canvas.clear();
      for (const ring of rings) {
        const t = (now - ring.born) / LIFE_S;
        const [x, y] = canvas.project(ring.lonLat);
        g.strokeStyle = withAlpha(ctx.params.color, 1 - t);
        g.lineWidth = 5;
        g.beginPath();
        g.arc(x, y, ctx.params.size * canvas.pixelsPerMetre * t, 0, Math.PI * 2);
        g.stroke();
      }
    });

    return {
      tool(input) {
        if (input.geometry.type === 'Point') add(input.geometry.coordinates as [number, number]);
      },
      action(id) {
        if (id !== 'burst') return;
        // The middle of the table: the mean of its four corners.
        const corners = ctx.site.corners;
        const mean = (i: 0 | 1) => corners.reduce((sum, c) => sum + c[i], 0) / corners.length;
        add([mean(0), mean(1)]);
      },
    };
  },

  // The custom panel on the controller: it reads what the table published.
  panel(ctx, el) {
    const line = document.createElement('p');
    el.append(line);
    const draw = () => {
      const last = ctx.shared.last as [number, number] | undefined;
      line.textContent = last ? `${last[1].toFixed(5)}, ${last[0].toFixed(5)}` : 'Tap the table';
    };
    draw();
    return { update: draw };
  },
});
