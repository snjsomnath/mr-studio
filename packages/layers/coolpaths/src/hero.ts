// Cool paths' hero on the controller (#76): the time of day, which is what moves the shade.
// The sky follows the sun, the band at the foot lights the hours of daylight, and the facts
// say how much heat (PET times metres) the coolest walk saves at that moment.
import { formatHour, sunPosition, timelineHero, zonedTimeToUtc } from '@mrstudio/sdk';
import type { HeroFact, PanelContext, PanelHandlers } from '@mrstudio/sdk';

type Params = { date: string; hour: number; play: boolean };
type Walk = { length: number; sun: number; heat: number; pet: number } | null;
type Shared = { ready?: boolean; sunUp?: boolean; shortest?: Walk; coolest?: Walk; same?: boolean };

/** The sky for a sun height: night, golden hour or day (as Sunlight's). */
function sky(altitude: number): [string, string, string] {
  if (altitude < -6) return ['#05070f', '#16224a', '#2b3866'];
  if (altitude < 0) return ['#151a3d', '#6b4e86', '#f2a46b'];
  if (altitude < 10) return ['#2a4f9e', '#a9b6d8', '#f7a96a'];
  return ['#1f5fc7', '#5c99e3', '#b9d4f2'];
}

export function coolpathsHero(ctx: PanelContext<Params>, el: HTMLElement): PanelHandlers {
  const altitude = (hour: number) => {
    const { lat, lon } = ctx.site.origin;
    return sunPosition(Date.parse(zonedTimeToUtc(ctx.params.date, hour, ctx.site.timezone)), lat, lon).altitude;
  };
  // Sunrise and sunset, worked out again only when the day changes.
  let day = '';
  let daylight: { from: number; to: number } | null = null;
  const lit = () => {
    if (day !== ctx.params.date) {
      day = ctx.params.date;
      const up = Array.from({ length: 97 }, (_, i) => i / 4).filter((hour) => altitude(hour) > 0);
      daylight = up.length ? { from: up[0]!, to: up.at(-1)! } : null;
    }
    return daylight ? { ...daylight, colors: ['#ffb35c', '#ffe08a'] as [string, string] } : null;
  };
  const date = () => new Date(`${ctx.params.date}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', timeZone: 'UTC' });
  const facts = (): HeroFact[] => {
    const s = ctx.shared as Shared;
    if (!s.ready) return [{ label: 'The walks', value: 'Working out…' }];
    if (!s.shortest || !s.coolest) return [];
    const feels = { label: 'Feels like', value: `${s.shortest.pet.toFixed(1)} °C PET` };
    if (s.sunUp === false) return [{ label: 'The sun', value: 'is down' }, feels];
    if (s.same || s.shortest.heat <= s.coolest.heat) return [{ label: 'The coolest walk', value: 'is the shortest' }, feels];
    const saved = Math.round((1 - s.coolest.heat / Math.max(1, s.shortest.heat)) * 100);
    const further = s.coolest.length - s.shortest.length;
    return [
      { label: 'Coolest walk', value: `${saved}% less heat` },
      { label: 'For', value: further > 0 ? `${further} m more` : 'no extra walk' },
    ];
  };
  const hero = timelineHero(
    el,
    {
      label: 'Time of day',
      min: 0,
      max: 24,
      step: 0.25,
      value: () => ctx.params.hour,
      set: (hour) => ctx.setParams({ hour, play: false }),
      ticks: [0, 3, 6, 9, 12, 15, 18, 21, 24],
      tick: (hour) => String(hour).padStart(2, '0'),
      format: formatHour,
      playing: () => ctx.params.play,
      play: (play) => ctx.setParams({ play }),
      readout: (hour) => ({ value: formatHour(hour), line: date() }),
      facts,
      sky: (hour) => sky(altitude(hour)),
      lit,
    },
    ctx.onCleanup,
  );
  return { update: hero.update };
}
