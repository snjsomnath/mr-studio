// What the app's pages share at run time (#544): the Settings window (index.html) loads
// launcher.js first, and colour.js, calibration.js, updates.js and cli.js use its helpers.
// Each page's scripts hand each other functions through window.

/** An element of the page by id; which kind it is, the page's HTML says. */
declare const $: (id: string) => any;
/** A new element with properties and children. */
declare const el: <K extends keyof HTMLElementTagNameMap>(tag: K, props?: Record<string, unknown>, ...children: (Node | string)[]) => HTMLElementTagNameMap[K];
declare const invoke: Window['__TAURI__']['core']['invoke'];
declare function showError(message?: string): void;

interface Window {
  renderMarkdown(text: string): Node;
  loadUpdates(): void;
  loadCli(): void;
  loadLicence(): void;
  loadWhatsNew(): void;
  loadCalibration(): Promise<void>;
  // What the shell's scripts (src-tauri/src/*.js) put on the windows they go into.
  __mrsColour(settings: unknown): void;
  __mrsSize(size: number): void;
  __mrsTestCard(on: boolean): void;
  mrsShellControls?: HTMLElement;
  __MRS_EXIT_QUIET__?: boolean;
  /** The editor's licence reminder (#729), set by the shell. */
  __MRS_LICENCE_REMINDER__?: string | null;
}

// These pages query only HTML elements, so a query by selector gives an HTMLElement (the DOM
// library's default is the wider Element, which has no hidden, dataset or click).
interface ParentNode {
  querySelector<E extends Element = HTMLElement>(selectors: string): E | null;
  querySelectorAll<E extends Element = HTMLElement>(selectors: string): NodeListOf<E>;
}
