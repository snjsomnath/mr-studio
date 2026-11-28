// Rows of the table's datasets for panels that reduce them (#670). A panel asks for a dataset by
// name; the first ask starts reading it (in the data worker, when there is one) and the panel
// shows nothing until it arrives. Once it has, every view that asked is told to draw again.

import { rowsInWorker } from '@mrstudio/sdk';
import type { DataRow } from '@mrstudio/sdk';

type Entry = { rows?: readonly DataRow[]; failed?: string };
const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();

/** Where a dataset is served: its path in site.json `data`, or a file in the site folder. */
export function panelDataUrl(name: string, data: Readonly<Record<string, unknown>> | undefined): string | null {
  const path = data?.[name];
  if (typeof path === 'string') return `/site/${path}`;
  if (/\.(csv|geojson|json)$/i.test(name) && !name.includes('..')) return `/site/${name.replace(/^\/+/, '')}`;
  return null;
}

/** A dataset's rows, or undefined while it loads, when it failed, or when there is no such dataset. */
export function panelRows(name: string, data: Readonly<Record<string, unknown>> | undefined): readonly DataRow[] | undefined {
  const url = panelDataUrl(name, data);
  if (!url) return undefined;
  const entry = entries.get(url);
  if (entry) return entry.rows;
  entries.set(url, {});
  void (async () => {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`${url}: ${response.status}`);
      const rows = await rowsInWorker(await response.arrayBuffer(), /\.csv$/i.test(url));
      entries.set(url, { rows });
    } catch (error) {
      const message = (error as Error).message || String(error);
      entries.set(url, { failed: message });
      console.warn(`[panels] the dataset '${name}' could not be read: ${message}`);
    }
    for (const listener of listeners) listener();
  })();
  return undefined;
}

/** Calls back when a dataset has been read, so views can draw their panels again. */
export function onPanelRows(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Forgets read datasets, after the author brought in a new version of one. */
export function forgetPanelRows(): void {
  entries.clear();
  for (const listener of listeners) listener();
}
