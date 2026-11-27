// The rules of the editor's layer list (#58, #382, #606), apart from the editor (#540): which rows
// go under At rest, which go down the rails and which are items of a layer, what each row says,
// and where a copy goes. No DOM here, so the rules can be tested on their own; the editor builds
// the rows from what these answer.

import type { LayerManifest, LayerState } from '@mrstudio/sdk';

/** One layer of the scene, as the list sees it. */
export interface ListedLayer {
  id: string;
  manifest: LayerManifest;
  state: LayerState;
}

/** The scene's layers sorted into the list's parts. */
export interface ListParts<T extends ListedLayer> {
  /** Map life, the rows under At rest. */
  rest: T[];
  /** Layers with a button on the controller. */
  layers: T[];
  /** The items of one layer, in the scene's order: they show while it is open. */
  itemsOf(id: string): T[];
}

/** Sorts the scene into At rest, the layers and their items. `atRest` says what the map shows with no layer open. */
export function listParts<T extends ListedLayer>(instances: readonly T[], atRest: (manifest: LayerManifest, state: LayerState) => boolean): ListParts<T> {
  const top = instances.filter((i) => !i.state.parent);
  return {
    rest: top.filter((i) => atRest(i.manifest, i.state)),
    layers: top.filter((i) => !atRest(i.manifest, i.state)),
    itemsOf: (id) => instances.filter((i) => i.state.parent === id),
  };
}

/** A button down one rail of the controller. */
export interface RailSeat {
  id: string;
  side: 'left' | 'right';
}

/** The layers down each rail, in the controller's order; a button that is not a listed layer is left out. */
export function railsOf(seats: readonly RailSeat[], layers: readonly { id: string }[]): Record<'left' | 'right', string[]> {
  const listed = new Set(layers.map((l) => l.id));
  const out: Record<'left' | 'right', string[]> = { left: [], right: [] };
  for (const seat of seats) if (listed.has(seat.id)) out[seat.side].push(seat.id);
  return out;
}

/** Which stack an item of a glass or a reveal line is in (#606); nothing for an item of any other layer. */
export function stackWords(stacked: boolean, stack: number | undefined): string {
  if (!stacked) return '';
  return stack === 1 ? 'Stack 1 · surface' : 'Stack 2 · underneath';
}

/** What a dataset is, from its file: the row's icon and its kind. */
export function datasetKind(path: string): { icon: string; kind: string } {
  if (/\.geojson$/i.test(path)) return { icon: 'map', kind: 'Map data' };
  if (/\.json$/i.test(path)) return { icon: 'file', kind: 'Data' };
  if (/\.csv$/i.test(path)) return { icon: 'grid', kind: 'Table' };
  if (/\.tiff?$|\.f32$/i.test(path)) return { icon: 'contrast', kind: 'Raster' };
  if (/\.(mp4|mov|webm)$/i.test(path)) return { icon: 'video', kind: 'Video' };
  if (/\.svg$/i.test(path)) return { icon: 'plan', kind: 'Drawing' };
  return { icon: 'layers', kind: 'File' };
}

/** One row of the Data part of the list. */
export interface DatasetRow {
  /** The dataset's name in site.json. */
  name: string;
  path: string;
  label: string;
  detail: string;
  icon: string;
}

/** The table's datasets in name order. A file of Your place is shown by what it is, `known` says which. */
export function datasetRows(data: Readonly<Record<string, string>>, known: (name: string) => { name: string; icon?: string } | undefined): DatasetRow[] {
  return Object.keys(data)
    .sort((a, b) => a.localeCompare(b))
    .map((name) => {
      const path = data[name]!;
      const place = known(name);
      const { icon, kind } = datasetKind(path);
      return { name, path, label: place?.name ?? name, detail: `${kind} · ${path.split('/').pop()}`, icon: place?.icon ?? icon };
    });
}

/** What a layer's row says about its button: the row's tooltip, and the eye's name and tooltip. */
export function layerRowWords(name: string, side: 'left' | 'right', hidden: boolean): { title: string; eyeLabel: string; eyeTitle: string } {
  return {
    title: `${name}: a button on the ${side} of the controller${hidden ? ', hidden' : ''}. Set its side in the Format pane, double-click to rename, right-click for more.`,
    eyeLabel: `${name} on the controller`,
    eyeTitle: hidden
      ? 'Not on the controller or phones. The layer stays in the table. Click to show its button again.'
      : 'On the controller. Click to take its button off the controller and phones without removing the layer.',
  };
}

/** What a row under At rest says about its eye. */
export function restRowWords(name: string, active: boolean): { eyeLabel: string; eyeTitle: string } {
  return {
    eyeLabel: `${name} on the map at rest`,
    eyeTitle: active ? `${name} shows on the map when no layer is open. Click to turn it off.` : `${name} is off. Click to show it on the map at rest.`,
  };
}

/** Where a copy goes among its siblings, and its button. */
export interface CopyPlace {
  /** Its index in the scene, or in its layer's items. */
  index: number;
  /** A layer's copy gets its own button, named as a copy, just below it on the rail. */
  button?: LayerState['button'];
}

/**
 * Where a copy of a layer, a piece of map life or an item goes. A layer's copy goes below it on its
 * rail, which is just under it in the scene; map life or an item goes on top of what it copies.
 */
export function copyPlace(siblings: readonly string[], id: string, name: string, state: LayerState, ambient: boolean): CopyPlace {
  const below = !state.parent && !ambient;
  const index = siblings.indexOf(id) + (below ? 0 : 1);
  if (!below) return { index };
  const order = state.button?.order;
  return { index, button: { ...state.button, name: `${name} copy`.slice(0, 40), order: order !== undefined ? order + 0.5 : undefined } };
}
