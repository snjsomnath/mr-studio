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
  /** GeoJSON: a FeatureCollection, a Feature or a geometry, usually bound to what a layer publishes. */
  | { kind: 'geojson' }
  /** How a map colours its features by data (#374): see `ColourBy`. */
  | { kind: 'colourBy' }
) & {
  /** Shown in the editor. */
  label: string;
  required?: boolean;
  /**
   * May be `{ "bind": "shared.x" }` instead of a literal. A `list` may always be bound as a whole
   * (#373): its items are checked against `item` as they arrive.
   */
  bindable?: boolean;
  default?: unknown;
};

export interface WidgetHandle {
  /** Draws the resolved props. Called on every change, so it must be cheap. */
  update(props: Record<string, any>): void;
  /**
   * Optional: fits what it draws to its box again, after the panel changed size (#681). A widget
   * whose content depends on its width (a headline number beside its unit) steps its type down
   * here, never below the smallest size allowed. The canvas calls it before it measures panels.
   */
  fit?(): void;
  destroy?(): void;
}

/** What a widget gets when it is mounted. */
export interface WidgetEnv {
  size: PanelSize;
  /**
   * For input widgets (#354): the layer's controls and named actions, to read and to change. Absent
   * for a panel with no layer (a site page panel without `layer`). Where a panel can't be touched
   * (the table's ribbon) `touch` is false: an input widget then shows the value and does nothing.
   */
  controls?: PanelControls;
  /**
   * The panel's layer (#355), for widgets that work with the site and the table: a map that picks
   * an entity or sends a point. Absent for a panel with no layer. `touch` is false where the panel
   * can't be touched.
   */
  layer?: PanelLayer;
  /** For `custom` only: hands the element to the layer's `panel` function. */
  custom?: (el: HTMLElement) => { update?(): void } | void;
  /**
   * A widget's own words in the visitors' language (#373): the layer's `locales`, then the site's,
   * then the runtime's; `{name}` is filled from `vars`. Absent outside the runtime: say the text as it is.
   */
  say?: (text: string, vars?: Record<string, string | number>) => string;
}

/** A layer's controls as a panel reaches them: the host checks every change as it does the controller's. */
export interface PanelControls {
  /** False where the panel can't be touched, such as the table's ribbon. */
  touch: boolean;
  /** A control of the layer (layer.json `controls`) or a named action (`actions`), by id. */
  find(id: string): import('./types.ts').Control | { type: 'action'; id: string; label?: string } | undefined;
  /** A control's value now. */
  value(id: string): unknown;
  /** Changes a control's value, as its controller control would. */
  set(id: string, value: unknown): void;
  /** Presses an action control or a named action. */
  press(id: string): void;
}

/** A panel's layer as a widget reaches it: the site, what is picked, and the ways to the table. */
export interface PanelLayer extends Pick<import('./layer.ts').PanelContext, 'site' | 'selection' | 'select' | 'sendTool' | 'action'> {
  readonly touch: boolean;
  /** The layer's manifest, in the visitors' language: its entity sets, tools and controls. */
  readonly manifest: import('./types.ts').LayerManifest | undefined;
  /** The layer's params now, entity values among them (#374: a map coloured by an entity value). */
  readonly params?: import('./types.ts').Params;
  /** What the layer published (#374: a map coloured by a shared value). */
  readonly shared?: Record<string, unknown>;
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
  /**
   * Made-up props for the Developer window's widget gallery (#358): plain values, no bindings.
   * A widget without one is shown with no props.
   */
  example?: Record<string, unknown>;
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
  if (w.example !== undefined && (typeof w.example !== 'object' || w.example === null || Array.isArray(w.example))) problems.push(`widget '${name}': example is an object of props`);
  return problems;
}

/**
 * How a map colours its features by data (#374): by a feature's property, an entity's value or
 * a value the layer publishes for each feature (`shared[key][id]`). Numbers follow `ramp` between
 * `min` and `max` (the data's own range when left out); anything else follows `categories`, a
 * value to a CSS colour or a data colour slot (1 to 6), or the data slots in turn.
 */
export interface ColourBy {
  property?: string;
  entity?: string;
  shared?: string;
  /** The dataset to colour when the map has no entity set: default its first dataset. */
  dataset?: string;
  /** A colour ramp's name from `colormaps`, or two or more CSS colours. Default dark blue to yellow. */
  ramp?: string | string[];
  categories?: Record<string, string | number>;
  min?: number;
  max?: number;
}

