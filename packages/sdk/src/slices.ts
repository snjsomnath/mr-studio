// Drawing a lot without stopping the table (#483): a long drawing written as a generator that
// yields every so often runs a few milliseconds a frame, then says it is done. Map data, the
// base map and Building lights use it for datasets of thousands of shapes (#263).

/** Above about this many shapes, a layer's drawing is better spread over frames. */
export const SLICE_FROM = 3000;

/** Pauses a drawing generator every `every` calls: `if (pause()) yield;`. */
export function pauseEvery(every = 50): () => boolean {
  let n = 0;
  return () => ++n % every === 0;
}

/**
 * Runs `steps` for `budgetMs` milliseconds a frame until it finishes, then calls `done`. Returns
 * a function that stops it, for when the drawing is asked for again or the layer closes. Where
 * there are no frames (tests, a page in the background), it runs to the end at once.
 */
export function inSlices(steps: Iterator<unknown>, done: () => void, budgetMs = 6): () => void {
  let stopped = false;
  let frame = 0;
  const run = () => {
    if (stopped) return;
    const until = performance.now() + budgetMs;
    let step = steps.next();
    while (!step.done && performance.now() < until) step = steps.next();
    if (step.done) {
      stopped = true;
      done();
    } else frame = requestAnimationFrame(run);
  };
  if (typeof requestAnimationFrame === 'undefined') {
    while (!steps.next().done);
    done();
    return () => {};
  }
  run();
  return () => {
    stopped = true;
    cancelAnimationFrame(frame);
  };
}

/** Runs a drawing generator to the end at once. */
export function drainSteps(steps: Iterator<unknown>): void {
  while (!steps.next().done);
}
