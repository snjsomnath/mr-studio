// The widget registry. A widget is a kind of panel content with a schema for its
// props, the sizes it may take, and a rule for what it costs in reads. Everything
// here except `mount` is plain data, so an editor can list widgets, draw a form
// for a widget's props and refuse a drop the rules do not allow.

import type { PanelSize } from '@mrstudio/sdk';

/** One prop of a widget. `kind` decides both validation and the editor's field. */
export type PropSpec = (
  | { kind: 'text'; max: number }
  | { kind: 'number'; min?: number; max?: number }
  /** A number or a short string, shown as the widget's value. */
  | { kind: 'value' }
  | { kind: 'boolean' }
  | { kind: 'enum'; options: string[] }
  /** A named colour ramp from `@mrstudio/sdk`. */
  | { kind: 'colormap' }
  /** A categorical colour slot of the theme, 1 to 6. */
  | { kind: 'slot' }
  /** A list of numbers, such as a series' values. Always live. */
  | { kind: 'numbers'; maxLength: number }
  /** A list of objects with their own props. `max` is the most items the widget draws. */
  | { kind: 'list'; max: number; item: Record<string, PropSpec> }
) & {
  /** Shown in the editor. */
  label: string;
  required?: boolean;
  /** May be `{ "bind": "shared.x" }` instead of a literal. */
  bindable?: boolean;
  default?: unknown;
};

export interface WidgetHandle {
  /** Draws the resolved props. Called on every change, so it must be cheap. */
  update(props: Record<string, any>): void;
  destroy?(): void;
}

/** What a widget gets when it is mounted. */
export interface WidgetEnv {
  size: PanelSize;
  /** For `custom` only: hands the element to the layer's `panel` function. */
  custom?: (el: HTMLElement) => { update?(): void } | void;
}

export interface WidgetDefinition {
  type: string;
  name: string;
  description: string;
  /** The sizes it may take, smallest first. */
  sizes: PanelSize[];
  props: Record<string, PropSpec>;
  /** Stricter limits on a list prop for a size, such as fewer bars in a `wide` panel. */
  listMax?: (prop: string, size: PanelSize) => number | undefined;
  /** What the panel costs: the number of separate things a visitor has to read. */
  reads(props: Record<string, any>, size: PanelSize): number;
  /** Builds the widget inside a panel body. Only called in a browser. */
  mount(el: HTMLElement, env: WidgetEnv): WidgetHandle;
}

export class WidgetRegistry {
  private widgets = new Map<string, WidgetDefinition>();

  register(widget: WidgetDefinition): this {
    if (this.widgets.has(widget.type)) throw new Error(`widget '${widget.type}' is already registered`);
    this.widgets.set(widget.type, widget);
    return this;
  }

  get(type: string): WidgetDefinition | undefined {
    return this.widgets.get(type);
  }

  list(): WidgetDefinition[] {
    return [...this.widgets.values()];
  }

  /** The registry as JSON: what an editor needs for its palette and its forms. */
  describe(): { type: string; name: string; description: string; sizes: PanelSize[]; props: Record<string, PropSpec> }[] {
    return this.list().map(({ type, name, description, sizes, props }) => ({ type, name, description, sizes, props }));
  }
}

/** Declares a widget. */
export function defineWidget(widget: WidgetDefinition): WidgetDefinition {
  return widget;
}
