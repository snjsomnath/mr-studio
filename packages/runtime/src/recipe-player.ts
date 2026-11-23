// Draws a custom layer from its recipe (site.md, Custom layers). A custom layer has no
// code of its own: its manifest carries the recipe under `custom`, and this player loads
// each data entry, styles it with the SDK's look blocks (`compileLook`) and the table's
// palette, and runs its motion. When the recipe is saved again (the layer builder saves as
// the author edits) the player restyles in place without starting over, so the preview on
// the table stays live and nothing replays unless the data changed.

import {
  boundOverrides,
  canvasSurface,
  compileLook,
  ease,
  metresPerTableMm,
  motionFor,
  parseCsv,
  readShapes,
  resolvePalette,
  tableFrame,
} from '@mrstudio/sdk';
import type { CompiledLook, CustomLayer, GeoJsonCollection, LayerManifest, LayerModule, RecipeData, Shapes, SiteInfo, TableContext } from '@mrstudio/sdk';

const EMPTY: Shapes = { areas: [], paths: [], spots: [] };
/** Seconds a layer takes to fade in when its recipe says `enter: fade` (M4). */
const FADE_S = 0.8;

/** Loaded files, by URL, so restyling and reopening do not fetch again. */
const files = new Map<string, Promise<GeoJsonCollection>>();

/** Where a data entry's file is served, or null for map services (drawn by the WMS layer, not here). */
export function dataUrl(data: RecipeData, site: Pick<SiteInfo, 'data'>): string | null {
  if (data.dataset) {
    const path = site.data?.[data.dataset];
    return typeof path === 'string' ? `/site/${path}` : null;
  }
  if (data.path) return `/site/${data.path}`;
  return null;
}

/** A CSV of points becomes GeoJSON points, from its longitude and latitude columns. */
function csvPoints(text: string): GeoJsonCollection {
  const rows = parseCsv(text);
  const keys = Object.keys(rows[0] ?? {});
  const find = (names: string[]) => keys.find((k) => names.includes(k.toLowerCase()));
  const lon = find(['lon', 'lng', 'long', 'longitude', 'x']);
  const lat = find(['lat', 'latitude', 'y']);
  if (!lon || !lat) throw new Error('a CSV of points needs longitude and latitude columns (lon, lat)');
  return {
    type: 'FeatureCollection',
    features: rows
      .filter((row) => Number.isFinite(Number(row[lon])) && Number.isFinite(Number(row[lat])))
      .map((row) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [Number(row[lon]), Number(row[lat])] }, properties: row })),
  };
}

/** Loads one data entry as GeoJSON, cached. */
export function loadData(url: string): Promise<GeoJsonCollection> {
  let file = files.get(url);
  if (!file) {
    file = fetch(url).then(async (response) => {
      if (!response.ok) throw new Error(`${url}: ${response.status}`);
      if (/\.csv$/i.test(url)) return csvPoints(await response.text());
      const parsed = (await response.json()) as GeoJsonCollection;
      if (parsed?.type !== 'FeatureCollection' || !Array.isArray(parsed.features)) throw new Error(`${url} is not GeoJSON`);
      return parsed;
    });
    file.catch(() => files.delete(url));
    files.set(url, file);
  }
  return file;
}

/** Forgets a loaded file, after the author brought in a new version of it. */
export function forgetData(url?: string): void {
  if (url) files.delete(url);
  else files.clear();
}

/**
 * The table side of a custom layer. `current` reads the layer's manifest as it is now;
 * `watch` calls back when it is saved again.
 */
export function recipeModule(current: () => LayerManifest | undefined, watch: (callback: () => void) => () => void): LayerModule {
  return {
    manifest: current()!,
    async table(ctx: TableContext) {
      const frame = tableFrame(ctx.site);
      const surface = canvasSurface(ctx.map.addElement(), frame);
      let recipe: CustomLayer = current()?.custom ?? { name: '' };
      let shapes = new Map<string, Shapes>();
      let looks: CompiledLook[] = [];
      let dataKey = '';
      let styleKey = '';
      let time = 0;
      let loading: Promise<void> | null = null;

      const loadAll = async () => {
        const next = new Map<string, Shapes>();
        await Promise.all(
          (recipe.data ?? []).map(async (data) => {
            const url = dataUrl(data, ctx.site);
            if (!url) return;
            try {
              next.set(data.id, readShapes(await loadData(url), frame));
            } catch (error) {
              console.warn(`[custom ${recipe.name}] ${data.id}: ${(error as Error).message}`);
            }
          }),
        );
        shapes = next;
        styleKey = '';
      };

      // Restyles when the recipe, the control values or the palette changed; reloads only when the data did.
      const refresh = () => {
        const nextData = JSON.stringify(recipe.data ?? []);
        if (nextData !== dataKey) {
          dataKey = nextData;
          loading = loadAll().then(() => {
            loading = null;
          });
          return;
        }
        if (loading) return;
        const key = JSON.stringify([recipe.look, recipe.motion, recipe.controls, ctx.params, ctx.site.palette]);
        if (key === styleKey) return;
        styleKey = key;
        const palette = resolvePalette(ctx.site.palette);
        const mm = metresPerTableMm(ctx.site);
        const overrides = boundOverrides(recipe, ctx.params);
        looks = (recipe.look ?? [])
          .map((block) => compileLook(block, (block.data && shapes.get(block.data)) || EMPTY, palette, mm, motionFor(recipe, block.id, overrides.motion), overrides.look[block.id]))
          .filter((look): look is CompiledLook => look !== null);
      };

      const stop = watch(() => {
        recipe = current()?.custom ?? recipe;
        refresh();
      });
      ctx.onCleanup(stop);
      refresh();
      await loading;
      refresh();

      ctx.onFrame((dt) => {
        time += dt;
        refresh();
        const view = surface.begin(time);
        const alpha = recipe.enter === 'fade' ? ease(time / FADE_S) : 1;
        for (const look of looks) look.draw(view, time, alpha);
      });
      return {
        update: () => refresh(),
      };
    },
  };
}
