/**
 * The editor's icons: 24 unit line drawings, shown at 16 px in panels and 20 px
 * on the ribbon's large buttons. A layer names its icon in `layer.json`; names
 * this set does not have fall back to `layers`.
 */
const PATHS: Record<string, string> = {
  layers: 'M12 3 3 8l9 5 9-5-9-5ZM3 12l9 5 9-5M3 16l9 5 9-5',
  home: 'M4 11l8-7 8 7M6 10v10h12V10M10 20v-6h4v6',
  plus: 'M12 5v14M5 12h14',
  grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  moon: 'M20 14.500A8 8 0 1 1 9.500 4a6.500 6.500 0 0 0 10.500 10.500Z',
  map: 'M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2ZM9 4v14M15 6v14',
  sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.4 1.4M17.6 17.6 19 19M5 19l1.4-1.4M17.6 6.4 19 5',
  wind: 'M3 9h11a3 3 0 1 0-3-3M3 13h15a3 3 0 1 1-3 3M3 17h6',
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
  table: 'M3 6h18v12H3zM7 10h10v4H7z',
  play: 'M7 5l12 7-12 7z',
  stop: 'M6 6h12v12H6z',
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
};

/** Icons an author can give a layer's button. */
export const LAYER_ICONS = ['sun', 'wind', 'route', 'footprints', 'tram', 'car', 'tree', 'lightbulb', 'images', 'pencil', 'map', 'blocks', 'layers', 'home', 'eye', 'play'];

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
