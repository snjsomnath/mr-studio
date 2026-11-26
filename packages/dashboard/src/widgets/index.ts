import { WidgetRegistry } from '../registry.ts';
import { balance } from './balance.ts';
import { bars } from './bars.ts';
import { compare } from './compare.ts';
import { control } from './control.ts';
import { custom } from './custom.ts';
import { donut } from './donut.ts';
import { gauge } from './gauge.ts';
import { legend } from './legend.ts';
import { list } from './list.ts';
import { map } from './map.ts';
import { media } from './media.ts';
import { ramp } from './ramp.ts';
import { series } from './series.ts';
import { stat } from './stat.ts';
import { text } from './text.ts';
import { timeline } from './timeline.ts';

export { balance, bars, compare, control, custom, donut, gauge, legend, list, map, media, ramp, series, stat, text, timeline };
export { scenarioChange } from './compare.ts';
export type { ScenarioState } from './compare.ts';
export { selfSufficiency } from './balance.ts';
export { entityAt } from './map.ts';
export { gaugeArc, gaugeShare } from './gauge.ts';
export { donutParts } from './donut.ts';
export { mediaUrl } from './media.ts';

/** The core widgets. Adding a widget is adding a definition here; nothing else in the runtime changes. */
export function coreWidgets(): WidgetRegistry {
  const registry = new WidgetRegistry();
  for (const widget of [stat, gauge, bars, list, donut, compare, balance, control, map, media, legend, series, ramp, timeline, text, custom]) registry.register(widget);
  return registry;
}
