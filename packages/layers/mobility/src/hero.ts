// Mobility's hero on the controller (#76): the trips' clock, with ▶ and a band to scrub
// through them. The facts count who has arrived so far, a group at a time.
import { timelineHero } from '@mrstudio/sdk';
import type { PanelContext, PanelHandlers } from '@mrstudio/sdk';

type Params = { play: boolean; progress: number };
type Group = { label: string; arrived: number; total: number };

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

export function mobilityHero(ctx: PanelContext<Params>, el: HTMLElement): PanelHandlers {
  const duration = () => Number(ctx.shared.duration) || 0;
  const at = (progress: number) => (progress / 100) * duration();
  /** With no trips, the map of values' steps stand for the time (#486). */
  const steps = () => (Array.isArray(ctx.shared.steps) && ctx.shared.steps.length > 0 ? (ctx.shared.steps as string[]) : null);
  const stepAt = (progress: number, list: string[]) => Math.min(list.length - 1, Math.max(0, Math.floor((progress / 100) * list.length)));
  const stepName = (progress: number, list: string[]) => {
    const i = stepAt(progress, list);
    return list[i] || ctx.say('Step {at} of {all}', { at: i + 1, all: list.length });
  };
  const hero = timelineHero(
    el,
    {
      label: steps() ? ctx.say('Steps of the map') : ctx.say('Time of the trips'),
      min: 0,
      max: 100,
      step: 0.5,
      // While playing, the table's clock is finer than the progress it reports.
      value: () => (ctx.params.play && duration() > 0 && ctx.shared.seconds !== undefined ? (Number(ctx.shared.seconds) / duration()) * 100 : ctx.params.progress),
      set: (progress) => ctx.setParams({ progress, play: false }),
      ticks: [0, 25, 50, 75, 100],
      tick: (progress) => {
        const list = steps();
        return list ? stepName(Math.min(99.9, progress), list) : duration() > 0 ? clock(at(progress)) : `${progress}%`;
      },
      format: (progress) => {
        const list = steps();
        if (list) return stepName(Math.min(99.9, progress), list);
        return duration() > 0 ? ctx.say('{at} of {all}', { at: clock(at(progress)), all: clock(duration()) }) : `${progress}%`;
      },
      playing: () => ctx.params.play,
      play: (play) => ctx.setParams({ play }),
      // The clock counts minutes and seconds since the trips began.
      readout: (progress) => {
        const list = steps();
        if (list) {
          const cells = ctx.shared.cells as { label: string | null } | null | undefined;
          return { value: stepName(Math.min(99.9, progress), list), line: cells?.label ? ctx.say(cells.label) : '' };
        }
        const line = ctx.say(ctx.shared.title || 'Trips under way');
        return duration() > 0 ? { value: clock(at(progress)), unit: 'min', line } : { value: `${Math.round(progress)}%`, line };
      },
      facts: () => ((ctx.shared.groups ?? []) as Group[]).map((g) => ({ label: ctx.say(g.label), value: ctx.say('{at} of {all}', { at: g.arrived, all: g.total }) })),
      sky: (progress) => {
        // The backdrop warms as the trips play out, from early blue to late amber.
        const t = Math.min(1, Math.max(0, progress / 100));
        return [`hsl(${222 - t * 18} 55% 16%)`, `hsl(${212 - t * 30} 50% 26%)`, `hsl(${200 - t * 165} 55% ${34 + t * 8}%)`];
      },
      lit: () => ({ from: 0, to: ctx.params.progress, colors: ['#7cc7ff', '#ffc857'] }),
    },
    ctx.onCleanup,
  );
  return { update: hero.update };
}
