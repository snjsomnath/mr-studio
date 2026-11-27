// A panel never needs scrolling and never hides what it holds (#681). Panels clip what does not
// fit, so a list cut short or a word pushed out of sight would otherwise go unnoticed. This
// measures a mounted panel and says what spills out of it. Text shortened on purpose with an
// ellipsis (a long name in a list row) is drawn to fit, so it is not counted.

/** How far past an edge a box may reach before it counts, in px: rounding and anti-aliasing. */
const SLACK = 2;

export interface Overflow {
  /** What spilled, such as `ul.mrs-list` or `p.mrs-caption`. */
  what: string;
  /** How far past the panel's edge it reaches, in px. */
  px: number;
  /** Which way: past the panel's `top`, `bottom`, `left` or `right` edge, or `inside` a box that clips it. */
  side: 'top' | 'bottom' | 'left' | 'right' | 'inside';
}

function describe(node: Element): string {
  const cls = typeof node.className === 'string' ? node.className.split(/\s+/).find((c) => c.startsWith('mrs-')) : undefined;
  return cls ? `${node.tagName.toLowerCase()}.${cls}` : node.tagName.toLowerCase();
}

const clips = (style: CSSStyleDeclaration) => style.overflowX !== 'visible' || style.overflowY !== 'visible';

/**
 * What spills out of `panel`, or null when everything fits. Two ways content is lost:
 * a box that reaches past the panel's edge (cut off by the panel), and a box that clips its own
 * content (a list taller than its body). Hidden and empty boxes are skipped.
 */
export function panelOverflow(panel: HTMLElement): Overflow | null {
  const frame = panel.getBoundingClientRect();
  if (frame.width === 0 || frame.height === 0) return null;
  let worst: Overflow | null = null;
  const note = (node: Element, px: number, side: Overflow['side']) => {
    if (px > SLACK && (!worst || px > worst.px)) worst = { what: describe(node), px: Math.round(px), side };
  };
  // The panel itself: content taller or wider than it is cut off at its edge.
  note(panel, panel.scrollHeight - panel.clientHeight, 'bottom');
  note(panel, panel.scrollWidth - panel.clientWidth, 'right');
  for (const node of panel.querySelectorAll('*')) {
    // Inside an SVG, the SVG's own box is what counts: a stroke may reach past a point.
    if (node instanceof SVGElement && !(node instanceof SVGSVGElement)) continue;
    const box = node.getBoundingClientRect();
    if (box.width === 0 && box.height === 0) continue;
    const style = getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden' || style.position === 'fixed') continue;
    note(node, frame.top - box.top, 'top');
    note(node, box.bottom - frame.bottom, 'bottom');
    note(node, frame.left - box.left, 'left');
    note(node, box.right - frame.right, 'right');
    if (node instanceof HTMLElement && clips(style)) {
      // Text cut short with an ellipsis is fitted on purpose: across with `text-overflow`, down
      // with a line clamp. The box itself must still sit inside the panel (checked above).
      const clamp = style.getPropertyValue('-webkit-line-clamp');
      const tall = clamp && clamp !== 'none' ? 0 : node.scrollHeight - node.clientHeight;
      const wide = style.textOverflow === 'ellipsis' ? 0 : node.scrollWidth - node.clientWidth;
      note(node, Math.max(tall, wide), 'inside');
    }
  }
  return worst;
}
