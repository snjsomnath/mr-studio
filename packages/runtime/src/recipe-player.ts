// Draws a custom layer from its recipe (site.md, Custom layers). A custom layer has no
// code of its own: its manifest carries the recipe under `custom`, and this player loads
// each data entry, styles it with the SDK's look blocks (`compileLook`) and the table's
// palette, and runs its motion. When the recipe is saved again (the layer builder saves as
// the author edits) the player restyles in place without starting over, so the preview on
// the table stays live and nothing replays unless the data changed.

import {
  boundFilters,
  boundOverrides,
  filterShapes,
  canvasSurface,
  compileLook,
  ease,
  metresPerTableMm,
  motionFor,
  parseCsv,
  SoundStage,
  hearsSound,
  networkFiles,
  placeFiles,
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

const tables = new Map<string, Promise<Record<string, unknown>[]>>();
/** Loads a CSV table (activity, flows, links for place motions), cached. */
export function loadTable(url: string): Promise<Record<string, unknown>[]> {
  let table = tables.get(url);
  if (!table) {
    table = fetch(url).then(async (response) => {
      if (!response.ok) throw new Error(`${url}: ${response.status}`);
      return parseCsv(await response.text()) as Record<string, unknown>[];
    });
    table.catch(() => tables.delete(url));
    tables.set(url, table);
  }
  return table;
}

/** A site dataset by name, or a file in the site folder by path. */
function siteFile(name: string, site: Pick<SiteInfo, 'data'>): string | null {
  return dataUrl({ id: name, dataset: name }, site) ?? (/\.[a-z0-9]+$/i.test(name) ? `/site/${name}` : null);
}

/** Forgets a loaded file, after the author brought in a new version of it. */
export function forgetData(url?: string): void {
  if (url) {
    files.delete(url);
    tables.delete(url);
  } else {
    files.clear();
    tables.clear();
  }
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
      /** Street networks that crowds walk on, by dataset name. */
      let streets = new Map<string, Shapes>();
      /** Place motions' other files (streets, buildings, targets, CSV tables), by name. */
      let extraShapes = new Map<string, Shapes>();
      let extraTables = new Map<string, Record<string, unknown>[]>();
      const placeNeeds = () => {
        const datasets = new Set<string>();
        const csvs = new Set<string>();
        for (const m of recipe.motion ?? []) {
          if (m.block !== 'place') continue;
          const { datasets: d, tables: t } = placeFiles(m.props ?? {});
          Object.values(d).forEach((name) => datasets.add(name!));
          Object.values(t).forEach((name) => csvs.add(name!));
        }
        // A network's links are a table or lines, its series a table, its streets lines (#280).
        for (const m of recipe.motion ?? []) {
          if (m.block !== 'network') continue;
          const f = networkFiles(m.props ?? {});
          if (f.links) (isTable(f.links) ? csvs : datasets).add(f.links);
          if (f.series) csvs.add(f.series);
          if (f.streets) datasets.add(f.streets);
        }
        return { datasets: [...datasets], csvs: [...csvs] };
      };
      const isTable = (name: string) => /\.csv$/i.test(siteFile(name, ctx.site) ?? '');
      const networks = () => [...new Set((recipe.motion ?? []).filter((m) => m.block === 'gravity').map((m) => String(m.props?.network ?? 'roads')))];
      let looks: CompiledLook[] = [];
      // Sounds play on the table itself; the editor's preview shows the rings silently unless
      // the author asked to listen there (#150).
      const sounds = new SoundStage({ audible: hearsSound() });
      ctx.onCleanup(() => sounds.stop());
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
        const nextStreets = new Map<string, Shapes>();
        await Promise.all(
          networks().map(async (name) => {
            const url = dataUrl({ id: name, dataset: name }, ctx.site);
            if (!url) return console.warn(`[custom ${recipe.name}] the site has no '${name}' dataset for a crowd to walk on`);
            try {
              nextStreets.set(name, readShapes(await loadData(url), frame));
            } catch (error) {
              console.warn(`[custom ${recipe.name}] ${name}: ${(error as Error).message}`);
            }
          }),
        );
        const needs = placeNeeds();
        const nextExtra = new Map<string, Shapes>();
        const nextTables = new Map<string, Record<string, unknown>[]>();
        await Promise.all([
          ...needs.datasets.map(async (name) => {
            const url = siteFile(name, ctx.site);
            if (!url) return console.warn(`[custom ${recipe.name}] the site has no '${name}' dataset`);
            try {
              nextExtra.set(name, readShapes(await loadData(url), frame));
            } catch (error) {
              console.warn(`[custom ${recipe.name}] ${name}: ${(error as Error).message}`);
            }
          }),
          ...needs.csvs.map(async (name) => {
            const url = siteFile(name, ctx.site);
            if (!url) return;
            try {
              nextTables.set(name, await loadTable(url));
            } catch (error) {
              console.warn(`[custom ${recipe.name}] ${name}: ${(error as Error).message}`);
            }
          }),
        ]);
        shapes = next;
        streets = nextStreets;
        extraShapes = nextExtra;
        extraTables = nextTables;
        styleKey = '';
      };

      // Restyles when the recipe, the control values or the palette changed; reloads only when the data did.
      const refresh = () => {
        const nextData = JSON.stringify([recipe.data ?? [], networks(), placeNeeds()]);
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
        // "Show only" on the controller (#38): the features each look keeps.
        const filters = boundFilters(recipe, ctx.params);
        looks = (recipe.look ?? [])
          .map((block) => {
            const motion = motionFor(recipe, block.id, overrides.motion);
            if (motion.gravity) motion.gravity = { ...motion.gravity, streets: streets.get(String(motion.gravity.network ?? 'roads')) };
            if (motion.sound) motion.sound = { ...motion.sound, stage: sounds };
            // Through time (#95): the controller's Play and When hold the sweep where it is put.
            if (motion.timeline) motion.timeline = { ...motion.timeline, position: () => (ctx.params.time_play === false ? Number(ctx.params.time_at) / 100 : null) };
            if (motion.network) {
              const f = networkFiles(motion.network);
              motion.network = {
                ...motion.network,
                inputs: {
                  linkShapes: f.links ? extraShapes.get(f.links) : null,
                  linkRows: f.links ? extraTables.get(f.links) : null,
                  series: f.series ? extraTables.get(f.series) : null,
                  streets: f.streets ? extraShapes.get(f.streets) : null,
                },
                position: () => clock.position,
              };
            }
            if (motion.place) {
              const { datasets, tables: csvs } = placeFiles(motion.place);
              const shapesOf = (name?: string) => (name ? extraShapes.get(name) : undefined);
              const tableOf = (name?: string) => (name ? extraTables.get(name) : undefined);
              motion.place = {
                ...motion.place,
                frame,
                extras: { streets: shapesOf(datasets.streets), buildings: shapesOf(datasets.buildings), targets: shapesOf(datasets.targets) },
                tables: { activity: tableOf(csvs.activity), flows: tableOf(csvs.flows), links: tableOf(csvs.links) },
              };
            }
            return compileLook(block, filterShapes((block.data && shapes.get(block.data)) || EMPTY, filters[block.id]), palette, mm, motion, overrides.look[block.id]);
          })
          .filter((look): look is CompiledLook => look !== null);
        if (!(recipe.motion ?? []).some((m) => m.block === 'sound')) sounds.stop();
      };

      const stop = watch(() => {
        recipe = current()?.custom ?? recipe;
        refresh();
      });
      ctx.onCleanup(stop);
      refresh();
      await loading;
      refresh();

      // ---- Sounds on points (#150): cards on the controller, taps, and steps that play one ----
      type Card = { id: string; label: string; colour: string; at: [number, number]; playing: boolean };
      const cards = (): (Card & { look: CompiledLook; point: number; xy: readonly [number, number] })[] =>
        looks.flatMap((look) =>
          (look.sounds?.list() ?? []).map((c) => ({
            id: `${look.id}/${c.point}`,
            label: c.label,
            colour: c.colour,
            at: frame.toLonLat(c.at).map((v) => Math.round(v * 1e6) / 1e6) as [number, number],
            playing: c.playing,
            look,
            point: c.point,
            xy: c.at,
          })),
        );
      /** A step or the controller asked for a sound by name or id; it plays once the sounds are loaded. */
      let wanted = String(ctx.params.play ?? '').trim();
      const playWanted = () => {
        if (!wanted) return;
        const key = wanted.toLowerCase();
        const hit = cards().find((c) => c.id === wanted || c.label.toLowerCase() === key);
        if (!hit) return;
        hit.look.sounds!.cue(hit.point);
        wanted = '';
      };
      /** The sound nearest a place on the table, within `reach` metres. */
      const nearest = (xy: readonly number[], reach: number) => {
        let best: ReturnType<typeof cards>[number] | null = null;
        let bestDistance = reach;
        for (const c of cards()) {
          const d = Math.hypot(c.xy[0] - xy[0]!, c.xy[1] - xy[1]!);
          if (d <= bestDistance) {
            best = c;
            bestDistance = d;
          }
        }
        return best;
      };
      // A tap on a sound point on the table plays it; it goes through the host so every view hears of it.
      const hasSoundTool = () => (current()?.tools ?? []).some((t) => t.id === 'sound');
      ctx.pointer.on((sample) => {
        if (sample.phase !== 'down' || !hasSoundTool()) return;
        const reach = Math.max(8, metresPerTableMm(ctx.site) * 8);
        const hit = nearest(sample.point, reach);
        if (hit) ctx.sendTool('sound', { type: 'Point', coordinates: hit.at }).catch(() => {});
      });
      let published = '';
      let sincePublish = Infinity;

      // ---- A network's play head (#280): one for the layer, paused and scrubbed from the controller ----
      const clock = { position: 0, playing: ctx.params.network_play !== false };
      const networkOf = () => looks.find((look) => look.network)?.network;
      const stepSeconds = () => Number((recipe.motion ?? []).find((m) => m.block === 'network')?.props?.step_s) || 2;
      const seek = () => {
        const at = Number(ctx.params.network_at);
        const steps = networkOf()?.steps ?? 1;
        if (Number.isFinite(at)) clock.position = Math.min(steps - 1e-6, Math.max(0, (at / 100) * steps));
      };
      if (Number(ctx.params.network_at) > 0) seek();
      let shownStep = -1;
      let shownTime: string | null = null;

      ctx.onFrame((dt) => {
        time += dt;
        refresh();
        const network = networkOf();
        if (network && clock.playing) clock.position = (clock.position + dt / stepSeconds()) % Math.max(1, network.steps);
        // The time the table shows, for the controller, ribbons and dashboards to bind to.
        const step = network ? Math.floor(clock.position) : -1;
        if (step !== shownStep) {
          shownStep = step;
          ctx.publish({ network_time: network ? (network.labels[step] ?? '') || null : null, network_step: network ? step : null, network_steps: network ? network.steps : null });
        }
        // The year or date on show, for the controller's Now panel (#95).
        const timed = looks.find((look) => look.timeLabel);
        const label = timed ? timed.timeLabel!(time) : null;
        if (label !== shownTime) {
          shownTime = label;
          ctx.publish({ time_label: label });
        }
        sounds.audible = hearsSound();
        const view = surface.begin(time);
        const alpha = recipe.enter === 'fade' ? ease(time / FADE_S) : 1;
        for (const look of looks) look.draw(view, time, alpha);
        playWanted();
        sincePublish += dt;
        if (sincePublish >= 0.25) {
          sincePublish = 0;
          const list = cards().map(({ id, label, colour, at, playing }) => ({ id, label, colour, at, playing }));
          const text = JSON.stringify(list);
          if (text !== published) {
            published = text;
            ctx.publish({ sounds: list.length ? list : null });
          }
        }
      });
      return {
        update: (changed) => {
          if (changed.includes('play')) wanted = String(ctx.params.play ?? '').trim();
          if (changed.includes('network_play')) clock.playing = ctx.params.network_play !== false;
          if (changed.includes('network_at')) seek();
          refresh();
        },
        tool: (input) => {
          if (input.tool !== 'sound') return;
          const geometry = input.geometry as { type?: string; coordinates?: number[] } | null;
          if (geometry?.type !== 'Point' || !Array.isArray(geometry.coordinates)) return;
          // A card sends its own point; a phone's tap may land a little off, so take the nearest within 40 m.
          const hit = nearest(frame.toTable([geometry.coordinates[0]!, geometry.coordinates[1]!]), 40);
          hit?.look.sounds!.cue(hit.point);
        },
      };
    },
  };
}
