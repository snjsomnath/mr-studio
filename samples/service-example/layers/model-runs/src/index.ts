// Model runs: a site layer whose numbers come from a service (#278).
//
// The service (services/model/server.py) is started by MR Studio with the table. Moving the
// slider asks it for a result (`post`); the primary button starts a long optimisation (`job`)
// whose progress shows on the controller as `busy`. If the model is down, the host gives the
// last answer to the same question, and the layer says so.
import { defineLayer, withAlpha } from '@mrstudio/sdk';
import type { LayerManifest } from '@mrstudio/sdk';

import manifest from '../layer.json';

interface Params {
  share: number;
  days: string;
}

interface Result {
  buildings: { id: number; import_kw: number }[];
}

export default defineLayer<Params>({
  manifest: manifest as LayerManifest,

  async table(ctx) {
    const model = ctx.service('model');
    const canvas = ctx.map.addCanvas('model-runs');
    let result: Result | undefined;
    let asked = 0;
    let running: { cancel(): void } | undefined;

    // Six places across the middle of the table, one per building the model returns.
    const corners = ctx.site.corners;
    const at = (i: number): [number, number] => {
      const t = (i + 0.5) / 6;
      const [tl, tr, br, bl] = corners;
      const top: [number, number] = [tl[0] + (tr[0] - tl[0]) * t, tl[1] + (tr[1] - tl[1]) * t];
      const bottom: [number, number] = [bl[0] + (br[0] - bl[0]) * t, bl[1] + (br[1] - bl[1]) * t];
      return [(top[0] + bottom[0]) / 2, (top[1] + bottom[1]) / 2];
    };

    const ask = async () => {
      const mine = ++asked;
      ctx.publish({ busy: { label: 'Asking the model' } });
      try {
        const answer = await model.post<Result>('run', { share: ctx.params.share });
        if (mine !== asked) return;
        result = answer.value;
        const total = result.buildings.reduce((sum, b) => sum + b.import_kw, 0);
        ctx.publish({
          busy: null,
          import_kw: Math.round(total),
          source: answer.cached ? ctx.say('Last answer, model offline') : ctx.say('From the model'),
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
        const [x, y] = canvas.project(at(building.id));
        // Area for power: a circle of about 5 m of radius per square root of a kilowatt.
        const r = Math.sqrt(building.import_kw) * 5 * canvas.pixelsPerMetre;
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
      action(id) {
        if (id !== 'optimise' || running) return;
        const days = Number(ctx.params.days);
        ctx.publish({ busy: { label: ctx.say('Optimising {days} days', { days }), progress: 0 } });
        const job = model.job<{ best_share: number; saving_sek: number }>('optimise', { days }, {
          onProgress: (p) => ctx.publish({ busy: { label: p.message ?? ctx.say('Optimising'), progress: p.progress } }),
        });
        running = job;
        job.result
          .then((answer) => {
            ctx.publish({ busy: null, saving: answer.value.saving_sek, best: ctx.say('Best share {share} %', { share: Math.round(answer.value.best_share * 100) }) });
            ctx.setParams({ share: answer.value.best_share });
          })
          .catch(() => ctx.publish({ busy: null, best: ctx.say('The optimiser did not finish') }))
          .finally(() => (running = undefined));
      },
    };
  },
});
