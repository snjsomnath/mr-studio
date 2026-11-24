// Entities on the table and the controller (#279). A layer declares `entities` in layer.json;
// this file loads each set's features, picks one where the table is tapped and marks the picked
// one, and the ones whose values were changed, on the table. No layer code takes part.

import { entityFeatures, entityOverrides, loadSiteData, pickEntity } from '@mrstudio/sdk';
import type { CanvasOverlay, Connection, EntityFeature, EntitySet, MapHandle, Position, SiteInfo, TablePointer } from '@mrstudio/sdk';

import type { Store } from './store.ts';

/** Each set's features, loaded once per page and dataset. */
const loaded = new Map<string, Promise<EntityFeature[]>>();

export function loadEntities(site: SiteInfo, set: EntitySet): Promise<EntityFeature[]> {
  const key = JSON.stringify([site.data?.[set.dataset], set.key, set.label, set.group]);
  let features = loaded.get(key);
  if (!features) {
    features = loadSiteData<Parameters<typeof entityFeatures>[0]>(site, set.dataset)
      .then((collection) => entityFeatures(collection, set))
      .catch((error) => {
        console.warn(`entities '${set.id}': ${error.message}`);
        loaded.delete(key);
        return [];
      });
    loaded.set(key, features);
  }
  return features;
}

/** A press shorter and smaller than this is a tap, which picks. */
const TAP_MS = 450;
const TAP_M = 4;

/**
 * Picking and marking for one running layer with entities: a tap on the table picks the entity
 * under it for every surface (`layer.select`), and a canvas outlines the picked one and marks the
 * ones with changed values.
 */
export function entitiesOnTable(options: {
  layer: string;
  sets: EntitySet[];
  store: Store;
  connection: Connection;
  map: MapHandle;
  pointer: TablePointer;
  onFrame(callback: () => void): void;
}): void {
  const { layer, sets, store, connection } = options;
  const features = new Map<string, EntityFeature[]>();
  for (const set of sets) void loadEntities(store.state.site, set).then((list) => features.set(set.id, list));

  const presses = new Map<string, { at: [number, number]; time: number }>();
  options.pointer.on((sample) => {
    if (sample.phase === 'down') presses.set(sample.id, { at: sample.point, time: sample.time });
    if (sample.phase !== 'up') return;
    const press = presses.get(sample.id);
    presses.delete(sample.id);
    if (!press || (sample.time - press.time) * 1000 > TAP_MS) return;
    if (Math.hypot(sample.point[0] - press.at[0], sample.point[1] - press.at[1]) > TAP_M) return;
    for (const set of sets) {
      const hit = pickEntity(features.get(set.id) ?? [], sample.lonLat as Position);
      if (!hit) continue;
      const now = store.state.layers[layer]?.selection;
      if (now?.set !== set.id || now.id !== hit.id) {
        connection.request('layer.select', { layer, set: set.id, id: hit.id }).catch((error) => console.warn(`[${layer}] ${error.message}`));
      }
      return;
    }
  });

  const canvas: CanvasOverlay = options.map.addCanvas('entities');
  let drawn = '';
  let pulse = 0;
  options.onFrame(() => {
    const state = store.state.layers[layer];
    if (!state) return;
    const selection = state.selection ?? null;
    const changed = sets.map((set) => Object.keys(entityOverrides(state.params, set.id)));
    const key = JSON.stringify([canvas.revision, canvas.width, selection, changed, features.size]);
    // The picked one breathes, so the eye finds it; the rest is redrawn only when it changes.
    pulse = (pulse + 1 / 60) % 2;
    if (key === drawn && !selection) return;
    drawn = key;
    canvas.clear();
    const g = canvas.context;
    const trace = (feature: EntityFeature) => {
      const geometry = feature.geometry;
      g.beginPath();
      const path = (points: Position[], close: boolean) => {
        points.forEach((p, i) => {
          const [x, y] = canvas.project(p);
          if (i === 0) g.moveTo(x, y);
          else g.lineTo(x, y);
        });
        if (close) g.closePath();
      };
      switch (geometry.type) {
        case 'Point': {
          const [x, y] = canvas.project(geometry.coordinates);
          g.arc(x, y, Math.max(6, 4 * canvas.pixelsPerMetre), 0, Math.PI * 2);
          break;
        }
        case 'LineString':
          path(geometry.coordinates, false);
          break;
        case 'MultiLineString':
          for (const line of geometry.coordinates) path(line, false);
          break;
        case 'Polygon':
          for (const ring of geometry.coordinates) path(ring, true);
          break;
        case 'MultiPolygon':
          for (const polygon of geometry.coordinates) for (const ring of polygon) path(ring, true);
          break;
      }
    };
    sets.forEach((set, n) => {
      const list = features.get(set.id) ?? [];
      const marked = new Set(changed[n]);
      g.setLineDash([6, 5]);
      g.lineWidth = 2;
      g.strokeStyle = 'rgba(255, 209, 102, 0.9)';
      for (const feature of list) {
        if (!marked.has(feature.id) || (selection?.set === set.id && selection.id === feature.id)) continue;
        trace(feature);
        g.stroke();
      }
      g.setLineDash([]);
      const picked = selection?.set === set.id ? list.find((f) => f.id === selection.id) : undefined;
      if (!picked) return;
      const glow = 0.5 + 0.5 * Math.cos(pulse * Math.PI);
      trace(picked);
      if (picked.geometry.type.endsWith('Polygon') || picked.geometry.type === 'Point') {
        g.fillStyle = `rgba(255, 255, 255, ${0.12 + 0.12 * glow})`;
        g.fill('evenodd');
      }
      g.shadowColor = 'rgba(255, 255, 255, 0.9)';
      g.shadowBlur = 8 + 10 * glow;
      g.lineWidth = 3.5;
      g.strokeStyle = '#ffffff';
      g.stroke();
      g.shadowBlur = 0;
    });
  });
}
