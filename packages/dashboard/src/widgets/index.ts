import { WidgetRegistry } from '../registry.ts';
import { balance } from './balance.ts';
import { bars } from './bars.ts';
import { compare } from './compare.ts';
import { custom } from './custom.ts';
import { ramp } from './ramp.ts';
import { series } from './series.ts';
import { stat } from './stat.ts';
import { text } from './text.ts';
import { timeline } from './timeline.ts';

export { balance, bars, compare, custom, ramp, series, stat, text, timeline };
export { scenarioChange } from './compare.ts';
export type { ScenarioState } from './compare.ts';
export { selfSufficiency } from './balance.ts';

/** The core widgets. Adding a widget is adding a definition here; nothing else in the runtime changes. */
export function coreWidgets(): WidgetRegistry {
  const registry = new WidgetRegistry();
  for (const widget of [stat, bars, compare, balance, series, ramp, timeline, text, custom]) registry.register(widget);
  return registry;
}
