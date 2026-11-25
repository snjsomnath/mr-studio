import { colormaps, controllerMap, entityFeatures, entityValues, loadSiteData, propertyAt } from '@mrstudio/sdk';
import type { ColourBy, ControllerMap, EntityFeature, EntitySet, Params, Position } from '@mrstudio/sdk';

import { defineWidget } from '../registry.ts';
import { TEXT } from '../rules.ts';
import { h, setText } from './dom.ts';

type Ring = readonly Position[];
type Geo = { type: string; coordinates?: unknown; geometry?: Geo; features?: Geo[]; geometries?: Geo[] };

/** Every geometry in a FeatureCollection, Feature, GeometryCollection or geometry. */
function geometries(geo: Geo | undefined, out: Geo[] = []): Geo[] {
  if (!geo || typeof geo !== 'object') return out;
  if (geo.type === 'FeatureCollection') for (const f of geo.features ?? []) geometries(f, out);
  else if (geo.type === 'Feature') geometries(geo.geometry, out);
  else if (geo.type === 'GeometryCollection') for (const g of geo.geometries ?? []) geometries(g, out);
  else out.push(geo);
  return out;
}

/** The rings and lines of a geometry, with whether they close. */
function paths(geo: Geo): { ring: Ring; closed: boolean }[] {
  const c = geo.coordinates as any;
  switch (geo.type) {
    case 'Polygon':
      return (c as Ring[]).map((ring) => ({ ring, closed: true }));
    case 'MultiPolygon':
      return (c as Ring[][]).flat().map((ring) => ({ ring, closed: true }));
    case 'LineString':
      return [{ ring: c as Ring, closed: false }];
    case 'MultiLineString':
      return (c as Ring[]).map((ring) => ({ ring, closed: false }));
    default:
      return [];
  }
}

function points(geo: Geo): Position[] {
  if (geo.type === 'Point') return [geo.coordinates as Position];
  if (geo.type === 'MultiPoint') return geo.coordinates as Position[];
  return [];
}

function inside([x, y]: Position, ring: Ring): boolean {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

/** A feature the map colours by data (#374): its id, its own properties and its shape. */
interface Coloured {
  id: string;
  props: Record<string, unknown>;
  geometry: Geo;
}

/** The value a colour rule reads for one feature. */
export function valueOf(by: ColourBy, f: Coloured, set: EntitySet | undefined, params: Params | undefined, shared: Record<string, unknown> | undefined): unknown {
  if (by.property) return propertyAt(f.props, by.property);
  if (by.entity) return set ? entityValues(set, params, f.id)[by.entity] : undefined;
  if (by.shared) {
    const map = shared?.[by.shared];
    return map && typeof map === 'object' ? (map as Record<string, unknown>)[f.id] : undefined;
  }
  return undefined;
}

function rgb(css: string): [number, number, number] | null {
  const hex = css.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)?.[1];
  if (!hex) return null;
  const full = hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex;
  return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)];
}

const DEFAULT_RAMP = ['#2d2a6b', '#2f7f8f', '#f2d94e'];

/** The colour of a number between `min` and `max` along a ramp: a named colormap or a list of hex colours. */
export function rampColour(ramp: ColourBy['ramp'], t: number): string {
  const at = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0));
  if (typeof ramp === 'string' && ramp in colormaps) {
    const stops = colormaps[ramp as keyof typeof colormaps].stops;
    let i = 0;
    while (i < stops.length - 2 && at > stops[i + 1]![0]) i++;
    const [p0, r0, g0, b0] = stops[i]!;
    const [p1, r1, g1, b1] = stops[i + 1]!;
    const k = p1 > p0 ? (at - p0) / (p1 - p0) : 0;
    return `rgb(${Math.round(r0 + (r1 - r0) * k)} ${Math.round(g0 + (g1 - g0) * k)} ${Math.round(b0 + (b1 - b0) * k)})`;
  }
  const colours = (Array.isArray(ramp) ? ramp : DEFAULT_RAMP).map(rgb).filter((c): c is [number, number, number] => c !== null);
  if (colours.length === 0) return DEFAULT_RAMP[0]!;
  if (colours.length === 1) return `rgb(${colours[0]!.join(' ')})`;
  const x = at * (colours.length - 1);
  const i = Math.min(colours.length - 2, Math.floor(x));
  const k = x - i;
  const [a, b] = [colours[i]!, colours[i + 1]!];
  return `rgb(${a.map((v, j) => Math.round(v + (b[j]! - v) * k)).join(' ')})`;
}

/**
 * Colours for every feature under a rule: numbers along the ramp, anything else by category.
 * `slot(n)` is the theme's data colour n. Features without a value get none.
 */
export function colourFeatures(by: ColourBy, values: unknown[], slot: (n: number) => string): (string | undefined)[] {
  const numbers = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  const numeric = numbers.length > 0 && numbers.length === values.filter((v) => v !== undefined && v !== null && v !== '').length && !by.categories;
  if (numeric) {
    const min = by.min ?? Math.min(...numbers);
    const max = by.max ?? Math.max(...numbers);
    return values.map((v) => (typeof v === 'number' && Number.isFinite(v) ? rampColour(by.ramp, max > min ? (v - min) / (max - min) : 0.5) : undefined));
  }
  const seen: string[] = [];
  return values.map((v) => {
    if (v === undefined || v === null || v === '') return undefined;
    const key = typeof v === 'boolean' ? (v ? 'true' : 'false') : String(v);
    const given = by.categories?.[key];
    if (typeof given === 'string') return given;
    if (typeof given === 'number') return slot(given);
    if (by.categories) return undefined;
    if (!seen.includes(key)) seen.push(key);
    return slot((seen.indexOf(key) % 6) + 1);
  });
}

/** The entity under a tap: one whose area holds it, else the nearest point or line within `reach` pixels. */
export function entityAt(features: readonly EntityFeature[], at: Position, project: (p: Position) => [number, number], reach = 24): EntityFeature | undefined {
  for (const f of features) if (paths(f.geometry as Geo).some(({ ring, closed }) => closed && inside(at, ring))) return f;
  const [tx, ty] = project(at);
  let best: EntityFeature | undefined;
  let bestD = reach;
  for (const f of features) {
    const geo = f.geometry as Geo;
    const near = [...points(geo), ...paths(geo).flatMap(({ ring }) => ring)];
    for (const p of near) {
      const [x, y] = project(p);
      const d = Math.hypot(x - tx, y - ty);
      if (d < bestD) {
        bestD = d;
        best = f;
      }
    }
  }
  return best;
}

/**
 * The site's map as a panel (#355): its datasets in the theme's data colours, the table's outline, a
 * layer's published shapes on top, and taps that pick one of the layer's entities or send a point to
 * one of its tools, so the table answers. No code: the same map a layer's own stage gets from
 * `controllerMap`.
 */
export const map = defineWidget({
  type: 'map',
  name: 'Map',
  description: "The site's map: chosen datasets, the table's outline, shapes a layer publishes, features coloured by data, and taps that pick a layer's entity or send a point to its tool.",
  sizes: ['wide', 'tall', 'block', 'hero'],
  example: { data: [{ name: 'roads', slot: 2 }], hint: 'Tap a building' },
  props: {
    data: { kind: 'list', max: 4, label: 'Datasets', item: { name: { kind: 'text', max: 40, label: 'Dataset', required: true }, slot: { kind: 'slot', label: 'Colour' } } },
    shapes: { kind: 'geojson', label: 'Shapes on top (bind to what the layer publishes)', bindable: true },
    entities: { kind: 'text', max: 40, label: 'Entity set a tap picks' },
    tool: { kind: 'text', max: 40, label: 'Point tool a tap sends to' },
    tap_action: { kind: 'text', max: 40, label: 'Named action a tap presses' },
    zoom: { kind: 'boolean', label: 'Drag and pinch to zoom' },
    hint: { kind: 'text', max: TEXT.caption, label: 'Line under the map', bindable: true },
    fill_by: { kind: 'colourBy', label: 'Fill by data' },
    stroke_by: { kind: 'colourBy', label: 'Outline by data' },
    labels: { kind: 'text', max: 40, label: 'Label each feature with this property' },
  },
  // The map is one read; each dataset, the shapes and the hint one more.
  reads: (props) => 1 + (Array.isArray(props.data) ? props.data.length : 0) + (props.shapes ? 1 : 0) + (props.hint ? 1 : 0) + (props.fill_by ? 1 : 0) + (props.stroke_by ? 1 : 0),
  mount(el, env) {
    const box = h('div', 'mrs-map');
    const area = h('div', 'mrs-map-area');
    const hint = h('p', 'mrs-caption mrs-map-hint');
    // Back to the table's frame after a pan or zoom (#374).
    const reset = h('button', 'mrs-map-reset', 'Reset') as HTMLButtonElement;
    reset.type = 'button';
    reset.hidden = true;
    box.append(area, reset, hint);
    el.append(box);
    reset.addEventListener('click', () => drawn?.resetView());
    // controllerMap reads the controller's colour names; here they are the dashboard's.
    for (const [name, token] of [['--text', '--mrs-text'], ['--muted', '--mrs-muted'], ['--line', '--mrs-line'], ['--accent', '--mrs-accent'], ['--card', '--mrs-panel']]) area.style.setProperty(name!, `var(${token})`);
    const layer = env.layer;
    if (!layer) {
      box.append(h('p', 'mrs-caption', 'A map panel needs its layer.'));
      return { update() {} };
    }
    const cleanups: (() => void)[] = [];
    let current: Record<string, any> = {};
    let shapes: Geo[] = [];
    let features: EntityFeature[] = [];
    let loadedSet = '';
    /** The features coloured by data (#374), and where they came from. */
    let coloured: Coloured[] = [];
    let colouredFrom = '';
    let colourKey = '';
    let fills: (string | undefined)[] = [];
    let strokes: (string | undefined)[] = [];
    let drawn: ControllerMap | undefined;
    let key = '';

    const colour = (slot: unknown, n: number) => getComputedStyle(el).getPropertyValue(`--mrs-data-${Number.isInteger(slot) ? slot : n}`).trim() || '#8aa';

    const build = () => {
      drawn?.remove();
      for (const c of cleanups.splice(0)) c();
      area.replaceChildren();
      const painted = colouring() ? colourSource()?.dataset : undefined;
      const data = (current.data as { name: string; slot?: number }[] | undefined)?.filter((d) => layer.site.data?.[d.name] && d.name !== painted) ?? undefined;
      drawn = controllerMap(area, { site: layer.site, onCleanup: (c) => cleanups.push(c) }, {
        data: data?.map((d, i) => {
          const c = colour(d.slot, i + 1);
          return { name: d.name, fill: `color-mix(in srgb, ${c} 45%, transparent)`, stroke: c };
        }),
        mode: layer.touch && (current.entities || current.tool || current.tap_action) ? 'pick' : 'none',
        zoom: current.zoom === true,
        onView: (moved) => {
          reset.hidden = !moved;
        },
        onPick: (at) => {
          if (!layer.touch) return;
          if (current.entities) {
            const hit = entityAt(features, at, (p) => drawn!.project(p));
            layer.select(current.entities, hit ? hit.id : null);
          } else if (current.tool) void layer.sendTool(current.tool, { type: 'Point', coordinates: at }).catch(() => {});
          else if (current.tap_action) void layer.action(current.tap_action).catch(() => {});
        },
        draw: (g, m) => {
          const accent = getComputedStyle(el).getPropertyValue('--mrs-accent').trim() || '#ffc857';
          paint(g, m);
          const picked = layer.selection && layer.selection.set === current.entities ? layer.selection.id : null;
          g.lineJoin = 'round';
          for (const f of features) {
            const on = f.id === picked;
            // Coloured features already show their outline.
            if (!on && coloured.length) continue;
            g.strokeStyle = on ? accent : getComputedStyle(el).getPropertyValue('--mrs-muted').trim();
            g.fillStyle = on ? `color-mix(in srgb, ${accent} 55%, transparent)` : 'transparent';
            g.lineWidth = on ? 3 : 1;
            for (const { ring, closed } of paths(f.geometry as Geo)) {
              g.beginPath();
              ring.forEach((p, i) => (i ? g.lineTo(...m.project(p)) : g.moveTo(...m.project(p))));
              if (closed) {
                g.closePath();
                g.fill();
              }
              g.stroke();
            }
          }
          g.strokeStyle = accent;
          g.fillStyle = accent;
          g.lineWidth = 3;
          for (const geo of shapes) {
            for (const { ring, closed } of paths(geo)) {
              g.beginPath();
              ring.forEach((p, i) => (i ? g.lineTo(...m.project(p)) : g.moveTo(...m.project(p))));
              if (closed) g.closePath();
              g.stroke();
            }
            for (const p of points(geo)) {
              g.beginPath();
              g.arc(...m.project(p), 5, 0, Math.PI * 2);
              g.fill();
            }
          }
        },
      });
    };

    const colouring = () => Boolean(current.fill_by || current.stroke_by);
    const entitySet = (): EntitySet | undefined => (current.entities ? layer.manifest?.entities?.find((s) => s.id === current.entities) : undefined);
    /** What the colour rules colour: the entity set's features, else a dataset. */
    const colourSource = (): { dataset: string; set?: EntitySet } | undefined => {
      const set = entitySet();
      if (set) return { dataset: set.dataset, set };
      const by = (current.fill_by ?? current.stroke_by) as ColourBy | undefined;
      const name = by?.dataset ?? (current.data as { name: string }[] | undefined)?.[0]?.name;
      return name && layer.site.data?.[name] ? { dataset: name } : undefined;
    };
    const loadColoured = () => {
      const source = colouring() ? colourSource() : undefined;
      const from = source ? `${source.dataset}|${source.set?.id ?? ''}` : '';
      if (from === colouredFrom) return;
      colouredFrom = from;
      coloured = [];
      colourKey = '';
      if (!source) return;
      void loadSiteData(layer.site, source.dataset)
        .then((collection) => {
          if (colouredFrom !== from) return;
          const list = ((collection as { features?: { id?: unknown; properties?: Record<string, unknown> | null; geometry?: Geo | null }[] }).features ?? []);
          const set = source.set;
          coloured = list.flatMap((f, index) => {
            if (!f.geometry) return [];
            const props = f.properties ?? {};
            const key = set ? (set.key === '#' ? index + 1 : propertyAt(props, set.key)) : (props.id ?? f.id ?? index + 1);
            return typeof key === 'string' || typeof key === 'number' ? [{ id: String(key), props, geometry: f.geometry }] : [];
          });
          recolour(true);
        })
        .catch((error) => console.warn(`map panel: colouring '${source.dataset}'`, error));
    };
    const slot = (n: number) => getComputedStyle(el).getPropertyValue(`--mrs-data-${n}`).trim() || '#8aa';
    /** Works the colours out again when the rule, the entity values or the published values change. */
    const recolour = (force = false) => {
      const set = entitySet();
      const params = layer.params;
      const shared = layer.shared;
      const fill = current.fill_by as ColourBy | undefined;
      const stroke = current.stroke_by as ColourBy | undefined;
      const read = (by: ColourBy | undefined) => (by ? coloured.map((f) => valueOf(by, f, set, params, shared)) : []);
      const next = JSON.stringify([fill, stroke, read(fill), read(stroke)]);
      if (!force && next === colourKey) return;
      colourKey = next;
      fills = fill ? colourFeatures(fill, read(fill), slot) : [];
      strokes = stroke ? colourFeatures(stroke, read(stroke), slot) : [];
      drawn?.redraw();
    };
    const paint = (g: CanvasRenderingContext2D, m: ControllerMap) => {
      if (coloured.length === 0) return;
      const muted = getComputedStyle(el).getPropertyValue('--mrs-muted').trim() || '#889';
      g.save();
      g.lineJoin = 'round';
      coloured.forEach((f, i) => {
        const fill = fills[i];
        const stroke = strokes[i] ?? (fill ? undefined : muted);
        g.fillStyle = fill ? `color-mix(in srgb, ${fill} 80%, transparent)` : 'transparent';
        g.strokeStyle = stroke ?? fill ?? muted;
        g.lineWidth = strokes[i] ? 3 : 1;
        for (const { ring, closed } of paths(f.geometry)) {
          g.beginPath();
          ring.forEach((p, j) => (j ? g.lineTo(...m.project(p)) : g.moveTo(...m.project(p))));
          if (closed) {
            g.closePath();
            if (fill) g.fill();
          } else if (fill) {
            g.strokeStyle = fill;
            g.lineWidth = 3;
          }
          g.stroke();
        }
        for (const p of points(f.geometry)) {
          g.beginPath();
          g.arc(...m.project(p), 6, 0, Math.PI * 2);
          g.fillStyle = fill ?? muted;
          g.fill();
          if (strokes[i]) g.stroke();
        }
      });
      // Labels: the controller is where words live (#374); at most 60, so the map stays readable.
      if (typeof current.labels === 'string' && current.labels) {
        const text = getComputedStyle(el).getPropertyValue('--mrs-text').trim() || '#fff';
        g.font = '600 13px Inter, system-ui, sans-serif';
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.fillStyle = text;
        for (const f of coloured.slice(0, 60)) {
          const label = f.props[current.labels];
          if (label === undefined || label === null || label === '') continue;
          const all = [...points(f.geometry), ...paths(f.geometry).flatMap(({ ring }) => ring)];
          if (all.length === 0) continue;
          const [x, y] = all.reduce(([sx, sy], p) => { const [px, py] = m.project(p); return [sx + px / all.length, sy + py / all.length]; }, [0, 0]);
          g.fillText(String(label), x, y);
        }
      }
      g.restore();
    };

    const loadEntities = (set: string | undefined) => {
      if (set === loadedSet) return;
      loadedSet = set ?? '';
      features = [];
      const spec = set ? layer.manifest?.entities?.find((s) => s.id === set) : undefined;
      if (!spec) return;
      void loadSiteData(layer.site, spec.dataset)
        .then((collection) => {
          if (loadedSet !== set) return;
          features = entityFeatures(collection as Parameters<typeof entityFeatures>[0], spec);
          drawn?.redraw();
        })
        .catch((error) => console.warn(`map panel: entity set '${set}'`, error));
    };

    let lastPick = '';
    return {
      update(props) {
        current = props;
        const next = JSON.stringify([props.data, props.entities, props.tool, props.tap_action, props.zoom, colouring() ? colourSource()?.dataset : null]);
        if (next !== key) {
          key = next;
          build();
        }
        loadEntities(props.entities);
        loadColoured();
        recolour();
        const nextShapes = geometries(props.shapes as Geo | undefined);
        const pick = JSON.stringify(layer.selection);
        if (nextShapes.length !== shapes.length || props.shapes !== undefined || pick !== lastPick) {
          shapes = nextShapes;
          lastPick = pick;
          drawn?.redraw();
        }
        setText(hint, props.hint ?? '');
        hint.hidden = !props.hint;
      },
      destroy() {
        drawn?.remove();
        for (const c of cleanups.splice(0)) c();
      },
    };
  },
});
