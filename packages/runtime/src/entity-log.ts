// A log on the controller (#602): the layers under a picked well or borehole, from the top down,
// as one coloured column with each layer's depth and material beside it. The rows come from
// another dataset of the table (`EntitySet.log`); the table itself only marks the picked point.
//
// Depths are drawn in proportion, but no layer is drawn thinner than a line of text: a metre of
// fill above 140 m of rock still reads.

import { formatDecimal, loadSiteData, logLayers, materialColour } from '@mrstudio/sdk';
import type { EntityLog, LogLayer, SiteInfo } from '@mrstudio/sdk';

import { say, t } from './i18n.ts';

type Collection = Parameters<typeof logLayers>[0];

const loaded = new Map<string, Promise<Collection>>();

function logData(site: SiteInfo, log: EntityLog): Promise<Collection> {
  const key = JSON.stringify([site.data?.[log.dataset], log.dataset]);
  let data = loaded.get(key);
  if (!data) {
    data = loadSiteData<Collection>(site, log.dataset).catch((error) => {
      console.warn(`log '${log.dataset}': ${error.message}`);
      loaded.delete(key);
      return { features: [] };
    });
    loaded.set(key, data);
  }
  return data;
}

/** A material as it reads: "FYLLN.+JORD" becomes "Fylln. + jord". */
export function materialWords(material: string): string {
  const spaced = material.replace(/\s*\+\s*/g, ' + ').replace(/\s*,\s*/g, ', ').trim();
  const lower = spaced === spaced.toUpperCase() ? spaced.toLowerCase() : spaced;
  return lower.replace(/^./, (c) => c.toUpperCase());
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Draws the layers of one log into `box`. */
export function drawLog(box: HTMLElement, layers: LogLayer[], log: EntityLog): void {
  const unit = log.unit ?? 'm';
  const depth = (v: number) => `${formatDecimal(v, Number.isInteger(v) ? 0 : 1)} ${unit}`;
  const title = el('h4', 'entity-log-title', say(log.title ?? 'Layers'));
  if (layers.length === 0) {
    box.replaceChildren(title, el('p', 'entity-log-empty', t('No layers are recorded here.')));
    return;
  }
  const bottom = layers[layers.length - 1]!.to;
  const grid = el('div', 'entity-log-grid');
  // Each layer is a row: thick layers take more room, thin ones at least a line.
  grid.style.gridTemplateRows = layers.map((l) => `minmax(1.75rem, ${Math.max(1, l.to - l.from).toFixed(1)}fr)`).join(' ');
  for (const layer of layers) {
    const swatch = el('div', 'entity-log-swatch');
    swatch.style.background = materialColour(layer.material);
    const words = el('div', 'entity-log-words');
    words.append(el('span', 'entity-log-depth', depth(layer.from)), el('span', 'entity-log-material', materialWords(layer.material)));
    if (layer.note) words.append(el('span', 'entity-log-note', layer.note));
    grid.append(swatch, words);
  }
  const foot = el('div', 'entity-log-bottom', t('Bottom at {depth}', { depth: depth(bottom) }));
  box.replaceChildren(title, grid, foot);
}

/** A log box for one entity set: `show(id)` draws the picked one's layers, `show(null)` hides it. */
export function entityLog(site: SiteInfo, log: EntityLog): { element: HTMLElement; show(id: string | null): void } {
  const box = el('section', 'entity-log');
  box.hidden = true;
  let shown: string | null = null;
  return {
    element: box,
    show(id) {
      if (id === shown) return;
      shown = id;
      if (id === null) {
        box.hidden = true;
        return;
      }
      void logData(site, log).then((data) => {
        if (shown !== id) return;
        drawLog(box, logLayers(data, log, id), log);
        box.hidden = false;
      });
    },
  };
}
