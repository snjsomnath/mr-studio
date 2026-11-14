import { WidgetRegistry } from '../registry.ts';
import { bars } from './bars.ts';
import { custom } from './custom.ts';
import { ramp } from './ramp.ts';
import { series } from './series.ts';
import { stat } from './stat.ts';
import { text } from './text.ts';
import { timeline } from './timeline.ts';

export { bars, custom, ramp, series, stat, text, timeline };

/** The core widgets. Adding a widget is adding a definition here; nothing else in the runtime changes. */
export function coreWidgets(): WidgetRegistry {
  const registry = new WidgetRegistry();
  for (const widget of [stat, bars, series, ramp, timeline, text, custom]) registry.register(widget);
  return registry;
}
