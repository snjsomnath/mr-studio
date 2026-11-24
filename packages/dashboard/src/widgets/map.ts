import { controllerMap, entityFeatures, loadSiteData } from '@mrstudio/sdk';
import type { ControllerMap, EntityFeature, Position } from '@mrstudio/sdk';

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
  description: "The site's map: chosen datasets, the table's outline, shapes a layer publishes, and taps that pick a layer's entity or send a point to its tool.",
  sizes: ['wide', 'tall', 'block', 'hero'],
  example: { data: [{ name: 'roads', slot: 2 }], hint: 'Tap a building' },
  props: {
    data: { kind: 'list', max: 4, label: 'Datasets', item: { name: { kind: 'text', max: 40, label: 'Dataset', required: true }, slot: { kind: 'slot', label: 'Colour' } } },
    shapes: { kind: 'geojson', label: 'Shapes on top (bind to what the layer publishes)', bindable: true },
    entities: { kind: 'text', max: 40, label: 'Entity set a tap picks' },
    tool: { kind: 'text', max: 40, label: 'Point tool a tap sends to' },
    hint: { kind: 'text', max: TEXT.caption, label: 'Line under the map', bindable: true },
  },
  // The map is one read; each dataset, the shapes and the hint one more.
  reads: (props) => 1 + (Array.isArray(props.data) ? props.data.length : 0) + (props.shapes ? 1 : 0) + (props.hint ? 1 : 0),
  mount(el, env) {
    const box = h('div', 'mrs-map');
    const area = h('div', 'mrs-map-area');
    const hint = h('p', 'mrs-caption mrs-map-hint');
    box.append(area, hint);
    el.append(box);
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
    let drawn: ControllerMap | undefined;
    let key = '';

    const colour = (slot: unknown, n: number) => getComputedStyle(el).getPropertyValue(`--mrs-data-${Number.isInteger(slot) ? slot : n}`).trim() || '#8aa';

    const build = () => {
      drawn?.remove();
      for (const c of cleanups.splice(0)) c();
      area.replaceChildren();
      const data = (current.data as { name: string; slot?: number }[] | undefined)?.filter((d) => layer.site.data?.[d.name]) ?? undefined;
      drawn = controllerMap(area, { site: layer.site, onCleanup: (c) => cleanups.push(c) }, {
        data: data?.map((d, i) => {
          const c = colour(d.slot, i + 1);
          return { name: d.name, fill: `color-mix(in srgb, ${c} 45%, transparent)`, stroke: c };
        }),
        mode: layer.touch && (current.entities || current.tool) ? 'pick' : 'none',
        onPick: (at) => {
          if (!layer.touch) return;
          if (current.entities) {
            const hit = entityAt(features, at, (p) => drawn!.project(p));
            layer.select(current.entities, hit ? hit.id : null);
          } else if (current.tool) void layer.sendTool(current.tool, { type: 'Point', coordinates: at }).catch(() => {});
        },
        draw: (g, m) => {
          const accent = getComputedStyle(el).getPropertyValue('--mrs-accent').trim() || '#ffc857';
          const picked = layer.selection && layer.selection.set === current.entities ? layer.selection.id : null;
          g.lineJoin = 'round';
          for (const f of features) {
            const on = f.id === picked;
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
        const next = JSON.stringify([props.data, props.entities, props.tool]);
        if (next !== key) {
          key = next;
          build();
        }
        loadEntities(props.entities);
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
