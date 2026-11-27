// Adding to the table from the editor (#540): data, media and files of Your place, and the New
// layer gallery (#59). Moved from editor.ts as functions of the one editor state; no change in
// behaviour.
import type { MediaKind } from '@mrstudio/sdk';
import { el, layerButton } from '../controls.ts';
import { customFromDataset, datasetShapes, describeShapes, layerFromImport, newCustomLayer, vectorDatasets } from './builder.ts';
import { openGallery } from './gallery.ts';
import type { GallerySection } from './gallery.ts';
import { ACCEPT, kindOf, mediaChanged, mediaItems, routeOf } from '../media.ts';
import type { MediaItem } from '../media.ts';
import { Importer } from './importer.ts';
import { closeDialog, openDialog } from './dialogs.ts';
import { add, addChecked } from './file-keys.ts';
import type { Editor } from './editor.ts';
import { sideFile } from './editor.ts';

/** Adds the layer `use`, set to these params, and opens it (Media's Show on the table). */
export async function addWith(ed: Editor, use: string, params: Record<string, unknown>): Promise<void> {
  const manifest = ed.store.manifests.find((m) => m.id === use);
  if (!manifest) return;
  closeDialog(ed);
  // Saved with the scene (scene.set), not only shown (layer.set), so the file stays after a reload.
  const id = await add(ed, manifest);
  if (id) await ed.send('scene.set', { layer: id, params });
}

/**
 * Add media (#306): any file, sent where it belongs. Map data, tables, rasters and drawings go
 * through the importer of Add data (#71), which names them as datasets; pictures, video and
 * sounds are kept as they came; a 3D model is placed in the guide's Your place. Answers what
 * was added, once it is listed, or null. A dataset brought in reloads the editor, which comes
 * back on the Media tab.
 */
export function addMedia(ed: Editor, kinds?: readonly MediaKind[]): Promise<MediaItem | null> {
  return new Promise((resolve) => {
    const routes = new Set((kinds?.length ? kinds : (['map', 'table', 'raster', 'drawing', 'picture', 'video', 'sound', 'model'] as MediaKind[])).map((k) => (k === 'picture' || k === 'video' ? 'media' : k === 'sound' ? 'sound' : k === 'model' ? 'model' : 'dataset')));
    // A video for a Video walk may also come in as a dataset.
    if (kinds?.includes('video')) routes.add('media');
    const accept = [...routes].flatMap((r) => ACCEPT[r as keyof typeof ACCEPT]);
    const input = el('input');
    // A picture can come with its side file (overlay.png and overlay.json), which places it on the map (#52).
    if (routes.has('media') && !accept.includes('.json')) accept.push('.json');
    Object.assign(input, { type: 'file', accept: accept.join(','), multiple: !routes.has('model') });
    input.addEventListener('cancel', () => resolve(null));
    input.addEventListener('change', () => {
      const files = [...(input.files ?? [])];
      if (files.length === 0) return resolve(null);
      void takeMedia(ed, files).then(resolve, (error: Error) => {
        ed.setSaved(error.message);
        resolve(null);
      });
    });
    input.click();
  });
}

/** Brings files in, one after another; answers the last one added. */
export async function takeMedia(ed: Editor, files: File[]): Promise<MediaItem | null> {
  let last: MediaItem | null = null;
  // A side file that says where a picture lies (`{"image": "overlay.png", "bounds": {...}}`, #52)
  // is not a dataset: the picture is placed on the map by it, as a Picture layer.
  const placing = new Map<File, string>();
  for (const side of files.filter((f) => /\.json$/i.test(f.name))) {
    const text = await side.text().catch(() => '');
    const parsed = sideFile(text);
    const b = parsed?.bounds;
    if (!b || ![b.west, b.south, b.east, b.north].every((v) => Number.isFinite(Number(v)))) continue;
    const pictures = files.filter((f) => routeOf(f.name) === 'media' && kindOf(f.name) === 'picture');
    const picture = pictures.find((f) => f.name === parsed?.image) ?? (pictures.length === 1 ? pictures[0] : undefined);
    if (!picture) continue;
    placing.set(picture, [b.west, b.south, b.east, b.north].map(Number).join(', '));
    files = files.filter((f) => f !== side);
  }
  for (const file of files) {
    const route = routeOf(file.name);
    if (route === 'dataset') {
      addData(ed, file);
      return null;
    }
    if (route === 'model') {
      // A model is set on the ground and fitted to the buildings: Insert › 3D model's dialog.
      openDialog(ed, 'model');
      ed.history.notify('Place the 3D model', 'Choose its file again here: it is set on the ground and fitted to the buildings.');
      return null;
    }
    if (!route) throw new Error(`${file.name} is not a kind of file MR Studio takes.`);
    const answer = await fetch(`/api/data/${route === 'sound' ? 'sounds' : 'media'}?name=${encodeURIComponent(file.name)}`, { method: 'POST', body: file });
    const page = (await answer.json().catch(() => ({}))) as { path?: string; error?: string };
    if (!answer.ok || !page.path) throw new Error(page.error ?? `${file.name} could not be added.`);
    mediaChanged();
    last = (await mediaItems()).find((i) => i.path === page.path) ?? { kind: kindOf(page.path), path: page.path };
    const bounds = placing.get(file);
    const media = bounds ? ed.store.manifests.find((m) => m.id === 'media') : undefined;
    if (bounds && media) {
      const id = await add(ed, media);
      if (id) await ed.send('scene.set', { layer: id, params: { file: page.path, bounds } });
      ed.history.notify(`Placed ${file.name} on the map`, 'By the edges in its side file. Change them under the layer’s More settings.');
    } else ed.history.notify(`Added ${file.name}`, 'It is in View › Media library, and every list of the editor offers it.');
  }
  return last;
}

/** The Add data dialog: the same importer as "Your place", with the kind of data left to the author. */
export function addData(ed: Editor, file?: File, replace?: string): void {
  const dialog = el('dialog', 'im-dialog');
  dialog.ariaLabel = 'Add data';
  const head = el('header', 'im-dialog-head');
  const close = el('button', 'ed-icon-button', '×');
  close.type = 'button';
  close.ariaLabel = 'Close';
  close.addEventListener('click', () => dialog.close());
  head.append(el('h2', undefined, 'Add data'), close);
  /** Adds the layer that shows a file just brought in, set to that file. */
  const showWith = async (id: string, params: Record<string, unknown>) => {
    const manifest = ed.store.manifests.find((m) => m.id === id);
    if (manifest) {
      const added = await add(ed, manifest);
      if (added) await ed.send('scene.set', { layer: added, params });
    }
    dialog.close();
  };
  const importer = new Importer({
    site: () => ed.store.state.site,
    hold: (on) => ed.hold(on),
    cancel: () => dialog.close(),
    // Coloured as it came in (#94): the data gets a layer of its own on the table.
    showAs: async (layer) => {
      await layerFromImport(ed.builderHost(), layer);
      dialog.close();
    },
    // A plan drawing (#193): a Masterplan layer that reveals it phase by phase.
    showPlan: (dataset) => showWith('plan', { dataset }),
    // A video (#194): a Video walk that plays it on the controller.
    showVideo: (dataset) => showWith('walkthrough', { video: dataset }),
  });
  dialog.append(head, el('p', 'wz-lead', 'Bring a file into the table, or fetch it from OpenStreetMap. It is copied into the table and stays on this computer.'), importer.element);
  // From Add media: the file is already chosen, and its kind guessed from its name.
  if (file) importer.takeFile(file);
  // From the Data list (#52): a new file under the same name.
  if (replace) importer.replacing(replace);
  dialog.addEventListener('close', () => dialog.remove());
  ed.shell.append(dialog);
  dialog.showModal();
}

/** Brings in the file for `target` (buildings, ground, a 3D model…): its row of Your place, in the media library. */
export function bringIn(ed: Editor, target: string): void {
  if (ed.wizard) {
    ed.wizard.bringIn(target);
    return;
  }
  openDialog(ed, 'media');
  ed.mediaTab.bringIn(target);
}
/** The New layer gallery (#59), the one place a layer is made. */
export function gallery(ed: Editor, start?: GallerySection, into?: { id: string; name: string }): void {
  const host = ed.builderHost();
  openGallery(
    {
      store: ed.store,
      shell: ed.shell,
      into,
      addPreset: async (use, params) => {
        // Saved with the table, as the Format pane saves a layer's settings.
        const manifest = ed.store.manifest(use);
        const id = manifest ? await add(ed, manifest) : null;
        if (id) await ed.send('scene.set', { layer: id, params });
      },
      add: (manifest, parent) => addChecked(ed, manifest, parent),
      lifeInto: () => {
        const { kind } = ed.context;
        const openId = kind === 'layer' ? (ed.context as { id: string }).id : undefined;
        const opened = openId ? ed.store.state.layers[openId] : undefined;
        const manifest = opened && ed.store.manifest(opened.layer);
        if (!openId || !opened || !manifest || manifest.sequence) return { name: 'the map at rest' };
        return { id: openId, name: layerButton(openId, manifest, opened).name };
      },
      bringIn: (target) => bringIn(ed, target),
      addData: () => addData(ed),
      newCustom: () => newCustomLayer(host, ed.shell),
      fromDataset: (name) => customFromDataset(host, name),
      datasets: () => vectorDatasets(ed.store),
      shapes: (name) => datasetShapes(ed.store, name),
      describe: describeShapes,
      extent: () => ({ width: ed.store.state.site.extent.width_m, height: ed.store.state.site.extent.height_m }),
    },
    start,
  );
}
