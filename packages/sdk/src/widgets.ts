// Widgets (#353): the kinds of panel content the controller, the TV pages and the table's ribbon
// draw. The core ones live in @mrstudio/dashboard; a team's layer package can bring its own by
// exporting `widgets` from its module. Both follow one contract: the sizes a widget may take, a prop
// schema with a label on every prop (an editor draws its form from it), bindings to what layers
// publish, the theme's tokens, and an honest cost in reads against the density budget. A widget two
// teams have each written is a widget for core.

import type { PanelSize } from './types.ts';

/** One prop of a widget. `kind` decides both validation and the editor's field. */
export type PropSpec = (
  | { kind: 'text'; max: number }
  | { kind: 'number'; min?: number; max?: number }
  /** A number or a short string, shown as the widget's value. */
  | { kind: 'value' }
  | { kind: 'boolean' }
  | { kind: 'enum'; options: string[] }
  /** A colour ramp: a name from `@mrstudio/sdk`, or a ramp object (`{ stops }`) a layer publishes. */
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
  /** Set by the runtime on a team widget: the layer package it came from. */
  owner?: string;
}

/** Declares a widget. */
export function defineWidget(widget: WidgetDefinition): WidgetDefinition {
  return widget;
}

const SIZES: readonly PanelSize[] = ['chip', 'tile', 'wide', 'tall', 'block', 'hero', 'band', 'strip'];

/** The name a team widget is known by on the site: the layer's id, a slash, the widget's type. */
export function teamWidgetType(layer: string, type: string): string {
  return `${layer}/${type}`;
}

/** Why a widget definition can't be used, or an empty list. The runtime skips a widget with problems. */
export function checkWidget(widget: unknown): string[] {
  const w = widget as Partial<WidgetDefinition> | null;
  if (!w || typeof w !== 'object') return ['a widget is an object made with defineWidget'];
  const problems: string[] = [];
  const name = typeof w.type === 'string' ? w.type : '?';
  if (typeof w.type !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(w.type)) problems.push(`widget '${name}': type is lower-case letters, digits and dashes`);
  if (typeof w.name !== 'string' || !w.name.trim()) problems.push(`widget '${name}' needs a name`);
  if (typeof w.description !== 'string' || !w.description.trim()) problems.push(`widget '${name}' needs a description`);
  if (!Array.isArray(w.sizes) || w.sizes.length === 0 || !w.sizes.every((s) => SIZES.includes(s))) problems.push(`widget '${name}': sizes is a list of ${SIZES.join(', ')}`);
  if (typeof w.reads !== 'function') problems.push(`widget '${name}' needs reads(props, size): what it costs to read`);
  if (typeof w.mount !== 'function') problems.push(`widget '${name}' needs mount(el, env)`);
  if (!w.props || typeof w.props !== 'object') problems.push(`widget '${name}' needs props (an empty object when it has none)`);
  else for (const [key, spec] of Object.entries(w.props)) {
    if (!spec || typeof (spec as PropSpec).label !== 'string' || !(spec as PropSpec).label.trim()) problems.push(`widget '${name}': prop '${key}' needs a label, for the editor's form`);
  }
  return problems;
}
