// The widget registry. A widget is a kind of panel content with a schema for its
// props, the sizes it may take, and a rule for what it costs in reads. Everything
// here except `mount` is plain data, so an editor can list widgets, draw a form
// for a widget's props and refuse a drop the rules do not allow.

import { checkWidget, teamWidgetType } from '@mrstudio/sdk';
import type { PanelSize, PropSpec, WidgetDefinition } from '@mrstudio/sdk';
export type { PropSpec, WidgetDefinition, WidgetEnv, WidgetHandle } from '@mrstudio/sdk';
export { defineWidget } from '@mrstudio/sdk';

export class WidgetRegistry {
  private widgets = new Map<string, WidgetDefinition>();

  register(widget: WidgetDefinition): this {
    if (this.widgets.has(widget.type)) throw new Error(`widget '${widget.type}' is already registered`);
    this.widgets.set(widget.type, widget);
    return this;
  }

  /**
   * Adds a layer package's own widgets (#353), as `<layer>/<type>`. A widget with problems is
   * skipped and its problems returned; a layer rebuilt while the app runs replaces its widgets.
   * A team widget that throws only breaks its own panel, as a core one would.
   */
  registerTeam(layer: string, widgets: readonly unknown[] | undefined): string[] {
    if (widgets === undefined) return [];
    if (!Array.isArray(widgets)) return [`layer '${layer}': widgets is a list made with defineWidget`];
    const problems: string[] = [];
    for (const widget of widgets) {
      const found = checkWidget(widget);
      if (found.length) {
        problems.push(...found.map((p) => `layer '${layer}': ${p}`));
        continue;
      }
      const def = widget as WidgetDefinition;
      const type = teamWidgetType(layer, def.type);
      this.widgets.set(type, { ...def, type, owner: layer });
    }
    return problems;
  }

  /**
   * The widget a panel names. A layer's own panels may name its team widgets without the
   * `<layer>/` part; core widgets win when both exist.
   */
  find(type: string, layer?: string): WidgetDefinition | undefined {
    return this.widgets.get(type) ?? (layer ? this.widgets.get(teamWidgetType(layer, type)) : undefined);
  }

  get(type: string): WidgetDefinition | undefined {
    return this.widgets.get(type);
  }

  list(): WidgetDefinition[] {
    return [...this.widgets.values()];
  }

  /** The registry as JSON: what an editor needs for its palette and its forms. */
  describe(): { type: string; name: string; description: string; sizes: PanelSize[]; props: Record<string, PropSpec>; owner?: string }[] {
    return this.list().map(({ type, name, description, sizes, props, owner }) => ({ type, name, description, sizes, props, ...(owner ? { owner } : {}) }));
  }
}
