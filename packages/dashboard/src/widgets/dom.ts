/** Creates an element with a class and optional text. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Sets text only when it changed, so an unchanged value costs nothing. */
export function setText(node: HTMLElement, text: string): void {
  if (node.textContent !== text) node.textContent = text;
}

/** The CSS colour of a data slot, 1 to 6. */
export function slotColor(slot: unknown, fallback = 1): string {
  const n = Number.isInteger(slot) && (slot as number) >= 1 && (slot as number) <= 6 ? slot : fallback;
  return `var(--mrs-data-${n})`;
}
