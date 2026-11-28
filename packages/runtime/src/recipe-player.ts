// Draws a custom layer from its recipe (site.md, Custom layers). A custom layer has no
// code of its own: its manifest carries the recipe under `custom`, and this player loads
// each data entry, styles it with the SDK's look blocks (`compileLook`) and the table's
// palette, and runs its motion. When the recipe is saved again (the layer builder saves as
// the author edits) the player restyles in place without starting over, so the preview on
// the table stays live and nothing replays unless the data changed.

import {
  applyLookExpressions,
  boundFilters,
  boundOverrides,
  filterShapes,
  mapSurface,
  compileLook,
  ease,
  metresPerTableMm,
  motionFor,
  parseCsv,
  SoundStage,
  hearsSound,
  networkFiles,
  placeFiles,
  placeStepTitles,
  rasterPicture,
  rasterProps,
  loadSiteField,
  lookLegend,
  readShapes,
  resolvePalette,
  tableFrame,
} from '@mrstudio/sdk';
import type { CompiledLook, CustomLayer, FieldFrame, FieldOverlay, GeoJsonCollection, LayerManifest, LegendItem, LayerModule, RecipeData, Shapes, SiteInfo, TableContext } from '@mrstudio/sdk';

const EMPTY: Shapes = { areas: [], paths: [], spots: [] };

/** A data entry that is a raster of values (#601): a GeoTIFF, drawn by a raster look. */
export function isRasterData(data: RecipeData, site: Pick<SiteInfo, 'data'>): boolean {
  const path = data.path ?? (data.dataset ? site.data?.[data.dataset] : undefined);
  return typeof path === 'string' && /\.tiff?$/i.test(path);
}
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
      const surface = mapSurface(ctx.map.addCanvas('drawing'), frame);
      let recipe: CustomLayer = current()?.custom ?? { name: '' };
      let shapes = new Map<string, Shapes>();
      /** Rasters of values on the table's grid (#601), by data entry id. */
      let fields = new Map<string, FieldFrame>();
      /** Each raster look's coloured field and the glow along its cut, by look id. */
      const rasters = new Map<string, { main: FieldOverlay; edge: FieldOverlay; key: string; legend: LegendItem[] }>();
      const fadeOf = () => (recipe.enter === 'fade' ? ease(time / FADE_S) : 1);
      /** Draws the raster looks again: only when their props, the palette or the data changed. */
      const drawRasters = (overrides: Record<string, Record<string, unknown>>) => {
        const palette = resolvePalette(ctx.site.palette);
        const wanted = new Set<string>();
        for (const block of recipe.look ?? []) {
          if (block.block !== 'raster') continue;
          const field = block.data ? fields.get(block.data) : undefined;
          if (!field) continue;
          wanted.add(block.id);
          let overlay = rasters.get(block.id);
          if (!overlay) {
            overlay = {
              main: ctx.map.addField(`raster-${block.id}`, { colormap: { stops: [[0, 0, 0, 0, 0], [1, 0, 0, 0, 0]] }, opacity: 0, smooth: false }),
              edge: ctx.map.addField(`raster-${block.id}-edge`, { colormap: { stops: [[0, 0, 0, 0, 0], [1, 0, 0, 0, 0]] }, opacity: 0, smooth: true, soften: 1.5 }),
              key: '',
              legend: [],
            };
            rasters.set(block.id, overlay);
          }
          const props = rasterProps(block.props, overrides[block.id]);
          const key = JSON.stringify([props, field.revision, field.width, field.height, ctx.site.palette]);
          if (key === overlay.key) continue;
          overlay.key = key;
          const picture = rasterPicture(field, props, palette);
          overlay.legend = picture.legend.map((row) => ({ ...row, id: `${block.id}-${row.id}` }));
          overlay.main.setStyle({ colormap: picture.colormap, opacity: props.opacity * fadeOf(), smooth: false });
          overlay.main.set(picture.frame);
          overlay.edge.setStyle({ colormap: picture.edgeColormap, opacity: picture.edge ? fadeOf() : 0 });
          if (picture.edge) overlay.edge.set(picture.edge);
        }
        for (const [id, overlay] of rasters) {
          if (wanted.has(id)) continue;
          overlay.main.remove();
          overlay.edge.remove();
          rasters.delete(id);
        }
      };
      /** Street networks that crowds walk on, by dataset name. */
      let streets = new Map<string, Shapes>();
      /** Place motions' other files (streets, buildings, targets, CSV tables), by name. */
      let extraShapes = new Map<string, Shapes>();
      let extraTables = new Map<string, Record<string, unknown>[]>();
      const placeNeeds = () => {
        const datasets = new Set<string>();
        const csvs = new Set<string>();
        // The controller may switch the motion (a bound select): the files follow the motion on show.
        const bound = boundOverrides(recipe, ctx.params).motion;
        for (const m of recipe.motion ?? []) {
          if (m.block !== 'place') continue;
          const { datasets: d, tables: t } = placeFiles({ ...(m.props ?? {}), ...(bound[m.id] ?? {}) });
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
      /** Where Next is in a place motion that steps (#341), and the time it got there. */
      const placeStage = { revealed: ctx.steps.revealed, since: 0 };
      let placeSteps = '';

      const loadAll = async () => {
        const next = new Map<string, Shapes>();
        const nextFields = new Map<string, FieldFrame>();
        await Promise.all(
          (recipe.data ?? []).map(async (data) => {
            // A raster of values (#601) comes from the host already laid on the table's grid.
            if (isRasterData(data, ctx.site)) {
              if (!data.dataset) return;
              try {
                const field = await loadSiteField(ctx.site, data.dataset);
                if (field) nextFields.set(data.id, field);
              } catch (error) {
                console.warn(`[custom ${recipe.name}] ${data.id}: ${(error as Error).message}`);
              }
              return;
            }
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
        fields = nextFields;
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
        const vars = { params: ctx.params as Record<string, unknown>, shared: ctx.shared as Record<string, unknown>, site: ctx.site as unknown as Record<string, unknown> };
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
                stage: () => placeStage,
              };
            }
            // A look's own worked-out columns and "where" rule (#669), then the controller's "show only".
            const own = applyLookExpressions((block.data && shapes.get(block.data)) || EMPTY, block.props, vars);
            return compileLook(block, filterShapes(own, filters[block.id]), palette, mm, motion, overrides.look[block.id]);
          })
          .filter((look): look is CompiledLook => look !== null);
        drawRasters(overrides.look);
        publishLegend();
        if (!(recipe.motion ?? []).some((m) => m.block === 'sound')) sounds.stop();
        // A place motion that steps: Next shows the places, then starts the motion (#341).
        const stepping = (recipe.motion ?? []).find((m) => m.block === 'place' && { ...m.props, ...overrides.motion[m.id] }.reveal === true);
        const titles = stepping ? placeStepTitles(String({ ...stepping.props, ...overrides.motion[stepping.id] }.motion ?? '')) : [];
        if (JSON.stringify(titles) !== placeSteps) {
          placeSteps = JSON.stringify(titles);
          ctx.steps.define(titles.length, titles);
        }
      };

      // The legend the looks give (#622), for a recipe written by hand or by a tool: one the
      // author saved in the recipe wins, and is already in the manifest.
      let legendKey = '';
      const publishLegend = () => {
        const rows = recipe.legend?.length
          ? []
          : lookLegend(
              (recipe.look ?? []).map((block) => ({
                block,
                rows: block.block === 'raster' ? (rasters.get(block.id)?.legend ?? []) : (looks.find((look) => look.id === block.id)?.legend ?? []),
              })),
            ).slice(0, 12);
        const key = JSON.stringify(rows);
        if (key === legendKey) return;
        legendKey = key;
        ctx.legend.set(rows);
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
          // The latest change announced (#338): its words stay on the controller until the next one.
          let note: string | null = null;
          for (let k = step; network && k >= 0 && note === null; k--) note = network.notes[k] ?? null;
          ctx.publish({ network_time: network ? (network.labels[step] ?? '') || null : null, network_step: network ? step : null, network_steps: network ? network.steps : null, network_note: note });
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
        // Rasters fade in with the rest; after that their style is left alone (#596).
        if (rasters.size && time - dt < FADE_S + 0.1) {
          const overrides = boundOverrides(recipe, ctx.params).look;
          for (const block of recipe.look ?? []) {
            const overlay = rasters.get(block.id);
            if (!overlay) continue;
            const props = rasterProps(block.props, overrides[block.id]);
            overlay.main.setStyle({ opacity: props.opacity * alpha });
            overlay.edge.setStyle({ opacity: props.edge_glow > 0 ? alpha : 0 });
          }
        }
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
        step: (revealed) => {
          if (revealed !== placeStage.revealed) Object.assign(placeStage, { revealed, since: time });
        },
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
