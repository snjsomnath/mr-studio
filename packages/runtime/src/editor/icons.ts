/**
 * The editor's icons: 24 unit line drawings, shown at 16 px in panels and 20 px
 * on the ribbon's large buttons. A layer names its icon in `layer.json`; names
 * this set does not have fall back to `layers`.
 */
const PATHS: Record<string, string> = {
  // The Media tab (#306).
  sound: 'M4 9h4l5-4v14l-5-4H4zM16.500 9a4 4 0 0 1 0 6M19 6.500a7.500 7.500 0 0 1 0 11',
  // The table's ribbon (#231): the model with a strip along its front edge.
  ribbon: 'M4 4h16v11H4zM4 17.500h16v2.500H4z',
  muted: 'M4 9h4l5-4v14l-5-4H4zM16 9l5 6M21 9l-5 6',
  // Share by email (#372): an arrow leaving a tray.
  share: 'M12 15V4M8 8l4-4 4 4M5 12v7a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-7',
  // The status bar's engine item (#713): a chip when simulations use the graphics card, a clock when they run slower.
  chip: 'M7 7h10v10H7zM10 10h4v4h-4zM9 4v3M12 4v3M15 4v3M9 17v3M12 17v3M15 17v3M4 9h3M4 12h3M4 15h3M17 9h3M17 12h3M17 15h3',
  clock: 'M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18ZM12 7v5l3 2',
  // Operator mode (#394): a padlock.
  lock: 'M6 11h12v9H6zM8.500 11V8a3.500 3.500 0 0 1 7 0v3',
  folder: 'M3 6a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z',
  globe: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM3 12h18M12 3c2.500 2.500 3.500 5.500 3.500 9s-1 6.500-3.500 9c-2.500-2.500-3.500-5.500-3.500-9s1-6.500 3.500-9Z',
  search: 'M10.500 4a6.500 6.500 0 1 0 0 13 6.500 6.500 0 0 0 0-13ZM15.500 15.500 20 20',
  table2: 'M4 5h16v14H4zM4 10h16M4 15h16M10 5v14',
  file: 'M6 3h8l4 4v14H6zM14 3v4h4',
  chevron: 'M6 9l6 6 6-6',
  back: 'M15 6l-6 6 6 6',
  plan: 'M4 4h16v16H4zM4 11h6v9M10 15h10M14 4v6h6',
  magnifier: 'M10.500 4a6.500 6.500 0 1 0 0 13 6.500 6.500 0 0 0 0-13ZM15.300 15.300 20 20M7.500 9a3.500 3.500 0 0 1 3-2',
  swipe: 'M4 5h16v14H4zM12 3v18M8 12l-2 0M7 10.500 5.500 12 7 13.500M16 12h2M17 10.500l1.500 1.500-1.500 1.500',
  video: 'M3 6h12v12H3zM15 10l6-3v10l-6-3M7 10l4 2-4 2z',
  layers: 'M12 3 3 8l9 5 9-5-9-5ZM3 12l9 5 9-5M3 16l9 5 9-5',
  home: 'M4 11l8-7 8 7M6 10v10h12V10M10 20v-6h4v6',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  moon: 'M20 14.500A8 8 0 1 1 9.500 4a6.500 6.500 0 0 0 10.500 10.500Z',
  map: 'M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2ZM9 4v14M15 6v14',
  sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.4 1.4M17.6 17.6 19 19M5 19l1.4-1.4M17.6 6.4 19 5',
  wind: 'M3 9h11a3 3 0 1 0-3-3M3 13h15a3 3 0 1 1-3 3M3 17h6',
  droplet: 'M12 3c3.500 4.500 6 8 6 11a6 6 0 0 1-12 0c0-3 2.500-6.500 6-11ZM9.500 15a2.500 2.500 0 0 0 2.500 2.500',
  lightbulb: 'M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5c.7.7 1 1.5 1 2.5h6c0-1 .3-1.800 1-2.500A6 6 0 0 0 12 3Z',
  car: 'M5 11l1.500-4.500h11L19 11M4 11h16v6H4zM7 17v2M17 17v2M7.500 14h.01M16.500 14h.01',
  tram: 'M7 4h10a1 1 0 0 1 1 1v11H6V5a1 1 0 0 1 1-1ZM6 11h12M9 16l-2 4M15 16l2 4M9.500 13.500h.01M14.500 13.500h.01M9 2h6',
  tree: 'M12 3a5 5 0 0 0-4.500 7.200A4 4 0 0 0 9 18h6a4 4 0 0 0 1.500-7.800A5 5 0 0 0 12 3ZM12 12v9',
  images: 'M7 7h13v11H7zM4 15V4h12M7 15l3.500-3.500 3 3 2.500-2.500L20 16',
  pencil: 'M4 20l4-1L19 8l-3-3L5 16zM14 7l3 3',
  footprints: 'M8 4c1.700 0 2.500 2 2.500 4.500S9.500 13 8 13s-2.500-2-2.500-4.500S6.300 4 8 4ZM6 16h4v1.500a2 2 0 0 1-4 0zM16 8c1.700 0 2.500 2 2.500 4.500S17.500 17 16 17s-2.500-2-2.500-4.500S14.300 8 16 8ZM14 19.500h4',
  route: 'M6 16a2.500 2.500 0 1 0 0 5 2.500 2.500 0 0 0 0-5ZM18 3a2.500 2.500 0 1 0 0 5 2.500 2.500 0 0 0 0-5ZM8.500 18.500H15a3.500 3.500 0 0 0 0-7H9a3.500 3.500 0 0 1 0-7h6.500',
  cube: 'M12 3 4 7.500v9L12 21l8-4.500v-9L12 3ZM4 7.500l8 4.500 8-4.500M12 12v9',
  blocks: 'M4 13h7v7H4zM13 13h7v7h-7zM8.500 4h7v7h-7z',
  phone: 'M8 3h8a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1ZM11 18h2',
  tv: 'M3 7h18v12H3zM8 3l4 4 4-4',
  'tv-off': 'M3 7h18v12H3zM8 3l4 4 4-4M4 20 20 6',
  table: 'M3 6h18v12H3zM7 10h10v4H7z',
  play: 'M7 5l12 7-12 7z',
  stop: 'M6 6h12v12H6z',
  pause: 'M8 5v14M16 5v14',
  previous: 'M15 5l-7 7 7 7',
  next: 'M9 5l7 7-7 7',
  eye: 'M2 12s3.600-6 10-6 10 6 10 6-3.600 6-10 6S2 12 2 12ZM12 14.500a2.500 2.500 0 1 0 0-5 2.500 2.500 0 0 0 0 5Z',
  'eye-off': 'M4 4l16 16M9.900 5.300A10.500 10.500 0 0 1 12 5c6.400 0 10 7 10 7a17 17 0 0 1-3 3.800M6.200 6.800C3.500 8.600 2 12 2 12s3.600 7 10 7a10 10 0 0 0 4.200-.900',
  up: 'M12 19V5M6 11l6-6 6 6',
  down: 'M12 5v14M6 13l6 6 6-6',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v5M14 11v5',
  check: 'M5 12.500l4.500 4.500L19 7.500',
  alert: 'M12 4 2.500 20h19L12 4ZM12 10v5M12 17.500h.01',
  code: 'M8 7l-5 5 5 5M16 7l5 5-5 5',
  reset: 'M4 12a8 8 0 1 0 2.300-5.700M4 4v4h4',
  info: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM12 11v6M12 7.500h.01',
  fullscreen: 'M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5',
  overscan: 'M3 5h18v14H3zM8 9 6 12l2 3M16 9l2 3-2 3M10 8l2-1.500L14 8M10 16l2 1.500 2-1.500',
  people: 'M9 11a3.500 3.500 0 1 0 0-7 3.500 3.500 0 0 0 0 7ZM2.500 20a6.500 6.500 0 0 1 13 0M16 4.300a3.500 3.500 0 0 1 0 6.400M18 14.200A6.500 6.500 0 0 1 21.500 20',
  point: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6ZM12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16Z',
  'map-pin': 'M12 21s-7-6.200-7-11.500a7 7 0 0 1 14 0C19 14.800 12 21 12 21ZM12 7a2.500 2.500 0 1 0 0 5 2.500 2.500 0 0 0 0-5Z',
  line: 'M4 18c4 0 4-12 8-12s4 12 8 12',
  polygon: 'M5 7l6-3 8 4-2 10-11 2z',
  brush: 'M14 4l6 6-8 8-6-6zM6 12l-2 6 6-2',
  sparkle: 'M12 3l1.800 5.200L19 10l-5.200 1.800L12 17l-1.800-5.200L5 10l5.200-1.800zM19 16l.8 2.200L22 19l-2.200.8L19 22l-.8-2.200L16 19l2.200-.8z',
  pointer: 'M6 3l12 9-5 1 3 6-2 1-3-6-4 3z',
  eyedropper: 'M15 4l5 5-2 2-5-5zM13 6l-8 8v3h3l8-8M4 20l1-3',
  palette: 'M12 3a9 9 0 0 0 0 18c1.100 0 1.500-.8 1.500-1.500 0-.8-.5-1.200-.5-2 0-.8.7-1.500 1.500-1.500H17a4 4 0 0 0 4-4c0-5-4-9-9-9ZM7.500 11h.01M10 7.500h.01M14.500 7.500h.01M17 11h.01',
  contrast: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM12 3v18M12 7h5M12 11h7M12 15h6',
  crosshair: 'M12 5a7 7 0 1 0 0 14 7 7 0 0 0 0-14ZM12 2v5M12 17v5M2 12h5M17 12h5',
  bars: 'M4 5h16v14H4zM8 5v14M12 5v14M16 5v14',
  settings: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6ZM12 2v3M12 19v3M2 12h3M19 12h3M4.900 4.900l2.100 2.100M17 17l2.100 2.100M4.900 19.100 7 17M17 7l2.100-2.100',
  save: 'M5 4h11l3 3v13H5zM8 4v5h7V4M8 20v-6h8v6',
  undo: 'M9 14 4 9l5-5M4 9h10.500a5.500 5.500 0 0 1 0 11H11',
  redo: 'M15 14l5-5-5-5M20 9H9.500a5.500 5.500 0 0 0 0 11H13',
  close: 'M6 6l12 12M18 6 6 18',
};

/** Every icon this set draws; any other name is drawn as `layers`. */
export const ICON_NAMES = Object.keys(PATHS);

/** Icons an author can give a layer's button. */
export const LAYER_ICONS = ['sun', 'wind', 'droplet', 'route', 'footprints', 'tram', 'car', 'tree', 'lightbulb', 'images', 'pencil', 'map', 'magnifier', 'swipe', 'blocks', 'layers', 'home', 'eye', 'play'];

const NS = 'http://www.w3.org/2000/svg';

/** An icon by name, `size` px square, drawn in the current text colour. */
export function icon(name: string | undefined, size = 16): SVGSVGElement {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.5');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', PATHS[name ?? ''] ?? PATHS.layers!);
  svg.append(path);
  return svg;
}
