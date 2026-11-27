// The controller screen's rails fit their buttons (#576). A rail with more buttons than its
// height first draws them smaller, then tighter; when even that is not enough the list scrolls
// and fades at the edge that has more, so a visitor can tell that more buttons are there.

/**
 * What a rail holds and how many of its buttons it shows without scrolling, at its tightest.
 * Posted to the page that embeds the controller (the editor), which warns the author (#614).
 * The controller is laid out in units of the screen, so the editor's live preview fits as many
 * buttons as the 46-inch TV beside the table does.
 */
export interface RailFit {
  type: 'mrs-rail-fit';
  side: 'left' | 'right';
  buttons: number;
  fits: number;
  /** The names on the buttons out of sight, top to bottom. */
  hidden: string[];
}

/** How a rail is drawn, from roomy to tight. */
const STEPS = [null, 'compact', 'tight'] as const;

/**
 * Keeps `rail` (an `aside.controller`) fitting: sets `data-fit` on it and `is-more-below` /
 * `is-more-above` on its `cards` list while buttons are out of sight.
 */
export function fitRail(rail: HTMLElement, cards: HTMLElement, side: 'left' | 'right' = 'left'): void {
  let busy = false;
  let told = '';
  // Counted at the top of the list, so scrolling does not change it.
  const tell = () => {
    // A controller out of sight (its frame hidden in the editor) has no size to measure.
    if (cards.clientHeight === 0 || rail.getClientRects().length === 0) return;
    const buttons = [...cards.querySelectorAll<HTMLElement>('.layer-button-card')];
    const top = cards.getBoundingClientRect().top - cards.scrollTop;
    const bottom = cards.clientHeight - parseFloat(getComputedStyle(cards).paddingBottom || '0');
    const shown = (b: HTMLElement) => b.getBoundingClientRect().bottom - top <= bottom + 1;
    const fits = buttons.filter(shown).length;
    const hidden = buttons.filter((b) => !shown(b)).map((b) => b.querySelector('.layer-button-name')?.textContent?.trim() ?? '');
    rail.dataset.buttons = String(buttons.length);
    rail.dataset.fits = String(fits);
    const report: RailFit = { type: 'mrs-rail-fit', side, buttons: buttons.length, fits, hidden };
    const key = JSON.stringify(report);
    if (key === told || window.parent === window) return;
    told = key;
    window.parent.postMessage(report, location.origin);
  };
  const overflowing = () => cards.scrollHeight > cards.clientHeight + 1;
  const edges = () => {
    const more = overflowing();
    cards.classList.toggle('is-more-below', more && cards.scrollTop + cards.clientHeight < cards.scrollHeight - 4);
    cards.classList.toggle('is-more-above', more && cards.scrollTop > 4);
  };
  const fit = () => {
    if (busy) return;
    busy = true;
    // Start roomy and tighten one step at a time while the buttons do not fit.
    // Roomy is no attribute at all: an empty `data-fit` still matches the CSS's `[data-fit]`, so
    // the roomy rail was measured drawn compact and a cut-off rail stayed roomy (#614).
    let step = 0;
    delete rail.dataset.fit;
    while (overflowing() && step < STEPS.length - 1) {
      step += 1;
      rail.dataset.fit = STEPS[step] as string;
    }
    edges();
    tell();
    busy = false;
  };
  cards.addEventListener('scroll', edges, { passive: true });
  // The rail, and the list in it: the list shrinks when the core buttons and the join panel
  // arrive under it after the layer buttons, which left the left rail cut off untightened (#614).
  const resized = new ResizeObserver(() => fit());
  resized.observe(rail);
  resized.observe(cards);
  // Buttons come and go as layers are added, moved or hidden.
  new MutationObserver(() => requestAnimationFrame(fit)).observe(cards, { childList: true });
  requestAnimationFrame(fit);
  // The editor asks again when it starts listening after the controller has drawn.
  window.addEventListener('message', (event) => {
    if (event.source === window.parent && (event.data as { type?: string } | null)?.type === 'mrs-rail-fit?') {
      told = '';
      tell();
    }
  });
}
