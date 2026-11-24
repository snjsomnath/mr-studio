// Model runs: a site layer whose numbers come from a service (#278), with buildings a visitor
// changes one by one (#279).
//
// The service (services/model/server.py) is started by MR Studio with the table. Moving the
// slider asks it for a result (`post`); the primary button starts a long optimisation (`job`)
// whose progress shows on the controller as `busy`. If the model is down, the host gives the
// last answer to the same question, and the layer says so.
//
// The buildings are `entities` in layer.json: a tap on one picks it, and the controller shows
// its own controls (in the community, solar on the roof) with no code here. The layer only
// reads the values (`ctx.entity`) and asks the model again once they settle (`entities`).
import { defineLayer, entityFeatures, loadSiteData, withAlpha } from '@mrstudio/sdk';
import type { EntityFeature, LayerManifest, Position } from '@mrstudio/sdk';

import manifest from '../layer.json';
import { gridLink } from './grid-link.ts';

interface Params {
  share: number;
  days: string;
}

interface Result {
  buildings: { id: string; in: boolean; use_kw: number; own_kw: number; shared_kw: number; import_kw: number }[];
}

type State = 'idle' | 'running' | 'done';
const sum = (list: Result['buildings'], key: 'use_kw' | 'own_kw' | 'shared_kw' | 'import_kw') => list.reduce((total, b) => total + b[key], 0);

/** The middle of a building: the average of its outer ring's corners. */
function middle(feature: EntityFeature): Position {
  const g = feature.geometry;
  const ring = g.type === 'Polygon' ? g.coordinates[0] : g.type === 'MultiPolygon' ? g.coordinates[0]?.[0] : undefined;
  if (!ring?.length) return g.type === 'Point' ? g.coordinates : [0, 0];
  const corners = ring.slice(0, -1);
  return [corners.reduce((s, p) => s + p[0], 0) / corners.length, corners.reduce((s, p) => s + p[1], 0) / corners.length];
}

export default defineLayer<Params>({
  manifest: manifest as unknown as LayerManifest,
  // Its own widget (#353): the panels below name it `grid-link`.
  widgets: [gridLink],

  async table(ctx) {
    const model = ctx.service('model');
    const canvas = ctx.map.addCanvas('model-runs');
    let result: Result | undefined;
    let asked = 0;
    let running: { cancel(): void } | undefined;
    // The third scenario is the optimiser's best share: not run until the button is pressed (#281).
    let best: { state: State; import_kw?: number } = { state: 'idle' };

    // The buildings the visitor changes, as layer.json's entity set names them.
    const set = (manifest as unknown as LayerManifest).entities![0]!;
    const buildings = entityFeatures(await loadSiteData(ctx.site, set.dataset), set);
    const at = new Map(buildings.map((b) => [b.id, middle(b)] as const));

    // What the compare and balance panels bind to: three scenarios of grid import, and where the power came from and went.
    const summary = (list: Result['buildings']) => {
      const use = sum(list, 'use_kw');
      const scenarios = [
        { label: ctx.say('As today'), value: Math.round(use), state: 'done' as State },
        { label: ctx.say('This plan'), value: Math.round(sum(list, 'import_kw')), state: 'done' as State },
        { label: ctx.say('Best share'), value: best.import_kw, state: best.state },
      ];
      const inside = list.filter((b) => b.in);
      return {
        scenarios,
        sources: [
          { label: ctx.say('Own solar'), value: Math.round(sum(list, 'own_kw')), slot: 1 },
          { label: ctx.say('Shared solar'), value: Math.round(sum(list, 'shared_kw')), slot: 2 },
          { label: ctx.say('Grid'), value: Math.round(sum(list, 'import_kw')), slot: 4 },
        ],
        uses: [
          { label: ctx.say('In the community'), value: Math.round(sum(inside, 'use_kw')), slot: 3 },
          { label: ctx.say('Outside it'), value: Math.round(use - sum(inside, 'use_kw')), slot: 5 },
        ],
        self_sufficiency: use > 0 ? 1 - sum(list, 'import_kw') / use : null,
        // The sound bed in layer.json follows this (#282): a hiss and a hum that load up with the grid.
        import_kw: Math.round(sum(list, 'import_kw')),
      };
    };

    const ask = async () => {
      const mine = ++asked;
      ctx.publish({ busy: { label: 'Asking the model' } });
      try {
        const answer = await model.post<Result>('run', {
          share: ctx.params.share,
          buildings: buildings.map((b) => ({ id: b.id, ...ctx.entity(set.id, b.id) })),
        });
        if (mine !== asked) return;
        result = answer.value;
        const list = result.buildings;
        const total = sum(list, 'import_kw');
        if (best.state === 'done' && best.import_kw === undefined) best.import_kw = Math.round(total);
        ctx.publish({
          busy: null,
          import_kw: Math.round(total),
          source: answer.cached ? ctx.say('Last answer, model offline') : ctx.say('From the model'),
          ...summary(list),
        });
      } catch {
        if (mine === asked) ctx.publish({ busy: null, source: ctx.say('The model is not answering') });
      }
    };

    ctx.onFrame(() => {
      canvas.clear();
      if (!result) return;
      const g = canvas.context;
      for (const building of result.buildings) {
        const middle = at.get(building.id);
        if (!middle) continue;
        const [x, y] = canvas.project(middle);
        // Area for power: a circle of about 2 m of radius per square root of a kilowatt.
        const r = Math.sqrt(Math.max(0, building.import_kw)) * 2 * canvas.pixelsPerMetre;
        g.fillStyle = withAlpha('#ff8a5c', 0.35);
        g.strokeStyle = withAlpha('#ffb84d', 0.95);
        g.lineWidth = 3;
        g.beginPath();
        g.arc(x, y, r, 0, Math.PI * 2);
        g.fill();
        g.stroke();
      }
    });
    ctx.onCleanup(() => running?.cancel());

    await ask();
    return {
      update(changed) {
        if (changed.includes('share')) void ask();
      },
      // A building was changed on the controller: once the slider has been still for
      // layer.json's `debounce_ms`, the model is asked again, once.
      entities() {
        void ask();
      },
      action(id) {
        if (id !== 'optimise' || running) return;
        const days = Number(ctx.params.days);
        best = { state: 'running' };
        if (result) ctx.publish({ busy: { label: ctx.say('Optimising {days} days', { days }), progress: 0 }, ...summary(result.buildings) });
        else ctx.publish({ busy: { label: ctx.say('Optimising {days} days', { days }), progress: 0 } });
        const job = model.job<{ best_share: number; saving_sek: number }>('optimise', { days }, {
          onProgress: (p) => ctx.publish({ busy: { label: p.message ?? ctx.say('Optimising'), progress: p.progress } }),
        });
        running = job;
        job.result
          .then((answer) => {
            // The best share's import is known once the model has run at it, after the share moves.
            best = { state: 'done' };
            ctx.publish({ busy: null, saving: answer.value.saving_sek, best: ctx.say('Best share {share} %', { share: Math.round(answer.value.best_share * 100) }) });
            ctx.setParams({ share: answer.value.best_share });
          })
          .catch(() => {
            best = { state: 'idle' };
            ctx.publish({ busy: null, best: ctx.say('The optimiser did not finish'), ...(result ? summary(result.buildings) : {}) });
          })
          .finally(() => (running = undefined));
      },
    };
  },
});
