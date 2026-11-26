// The controller screen's rails fit their buttons (#576). A rail with more buttons than its
// height first draws them smaller, then tighter; when even that is not enough the list scrolls
// and fades at the edge that has more, so a visitor can tell that more buttons are there.

/** How a rail is drawn, from roomy to tight. */
const STEPS = ['', 'compact', 'tight'] as const;

/**
 * Keeps `rail` (an `aside.controller`) fitting: sets `data-fit` on it and `is-more-below` /
 * `is-more-above` on its `cards` list while buttons are out of sight.
 */
export function fitRail(rail: HTMLElement, cards: HTMLElement): void {
  let busy = false;
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
    let step = 0;
    rail.dataset.fit = STEPS[step];
    while (overflowing() && step < STEPS.length - 1) {
      step += 1;
      rail.dataset.fit = STEPS[step];
    }
    if (!rail.dataset.fit) delete rail.dataset.fit;
    edges();
    busy = false;
  };
  cards.addEventListener('scroll', edges, { passive: true });
  new ResizeObserver(() => fit()).observe(rail);
  // Buttons come and go as layers are added, moved or hidden.
  new MutationObserver(() => requestAnimationFrame(fit)).observe(cards, { childList: true });
  requestAnimationFrame(fit);
}
