import type { SiteInfo, SiteMesh } from '@mrstudio/sdk';

import { el } from '../controls.ts';
import { icon } from './icons.ts';
import './model-import.css';

/**
 * The "3D model" row of Your place (#56): a model of the physical table (STL, OBJ or GLB)
 * that gives the scene its heights for shadows, wind and the twin. The table itself stays
 * 2D, so the model is shown from above only: its height as light and dark, against the
 * table's outline and the building footprints, while the author sets its units, scale,
 * turn, up axis, mirror and place, or lets "Snap to buildings" fit it to the footprints.
 *
 * The file is read here for the preview and by the engine for the bake; the host keeps
 * the file as it is and writes the placement into `scene.mesh` (POST /api/data/model).
 */

export const MODEL_ROW = 'model';

type Up = 'z' | 'y';

/** Everything in `scene.mesh` the author sets here. */
export interface ModelPlacement {
  lon: number;
  lat: number;
  unit_m: number;
  bearing_deg: number;
  base_m: number;
  up: Up;
  mirror: boolean;
  extrude: boolean;
}

/** Ways a model file's numbers can be meant, as metres per unit. */
export interface UnitChoice {
  id: string;
  label: string;
  unit_m: number;
}

/** The model scale of the table, 1 : N, when the site has a physical table. */
export function modelScale(site: SiteInfo): number | null {
  const table = site.table;
  if (!table || !(table.width_cm > 0)) return null;
  return site.extent.width_m / (table.width_cm / 100);
}

export function unitChoices(site: SiteInfo): UnitChoice[] {
  const n = modelScale(site);
  const ratio = n ? `1 : ${Math.round(n).toLocaleString('en-GB').replace(/,/g, ' ')}` : '';
  const choices: UnitChoice[] = [];
  if (n) {
    choices.push(
      { id: 'model-mm', label: `Millimetres on the model (${ratio})`, unit_m: n / 1000 },
      { id: 'model-cm', label: `Centimetres on the model (${ratio})`, unit_m: n / 100 },
      { id: 'model-m', label: `Metres on the model (${ratio})`, unit_m: n },
    );
  }
  choices.push(
    { id: 'real-m', label: 'Metres, real size', unit_m: 1 },
    { id: 'real-mm', label: 'Millimetres, real size', unit_m: 0.001 },
    { id: 'real-ft', label: 'Feet, real size', unit_m: 0.3048 },
  );
  return choices;
}

/** The unit that makes a model `size` units across about as big as the table's ground. */
export function guessUnit(site: SiteInfo, size: number): UnitChoice {
  const target = Math.max(site.extent.width_m, site.extent.height_m);
  const choices = unitChoices(site);
  let best = choices[0]!;
  for (const choice of choices) if (Math.abs(Math.log((size * choice.unit_m) / target)) < Math.abs(Math.log((size * best.unit_m) / target))) best = choice;
  return best;
}

/** The up axis a file most likely has: a city model is much flatter than it is wide. */
export function guessUp(extent: [number, number, number], glb: boolean): Up {
  const [x, y, z] = extent;
  if (glb) return z < 0.5 * y && z < x ? 'z' : 'y';
  return y < 0.5 * z && y < x ? 'y' : 'z';
}

/** Tangent-plane metres east and north of the site origin, as the engine computes them (crates/mrs-site/src/projection.rs). */
export class Projection {
  private readonly lon0: number;
  private readonly lat0: number;
  readonly perLon: number;
  readonly perLat: number;

  constructor(origin: { lon: number; lat: number }) {
    const a = 6_378_137;
    const e2 = 0.00669437999014;
    const phi = (origin.lat * Math.PI) / 180;
    const s = 1 - e2 * Math.sin(phi) ** 2;
    this.perLat = ((a * (1 - e2)) / s ** 1.5) * (Math.PI / 180);
    this.perLon = (a / Math.sqrt(s)) * Math.cos(phi) * (Math.PI / 180);
    this.lon0 = origin.lon;
    this.lat0 = origin.lat;
  }

  toLocal(lon: number, lat: number): [number, number] {
    return [(lon - this.lon0) * this.perLon, (lat - this.lat0) * this.perLat];
  }

  toLonLat(east: number, north: number): { lon: number; lat: number } {
    return { lon: this.lon0 + east / this.perLon, lat: this.lat0 + north / this.perLat };
  }
}

/** A 2D affine map, as canvas takes it: (x, y) to (a x + c y + e, b x + d y + f). */
type Affine = [number, number, number, number, number, number];
const then = (outer: Affine, inner: Affine): Affine => [
  outer[0] * inner[0] + outer[2] * inner[1],
  outer[1] * inner[0] + outer[3] * inner[1],
  outer[0] * inner[2] + outer[2] * inner[3],
  outer[1] * inner[2] + outer[3] * inner[3],
  outer[0] * inner[4] + outer[2] * inner[5] + outer[4],
  outer[1] * inner[4] + outer[3] * inner[5] + outer[5],
];
const apply = (m: Affine, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const invert = (m: Affine): Affine => {
  const det = m[0] * m[3] - m[1] * m[2];
  const [a, b, c, d] = [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det];
  return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])];
};

/** The model's vertices in its own Z-up frame (up axis made Z, mirrored if asked), 9 numbers a triangle. */
export function orient(raw: Float32Array, up: Up, mirror: boolean): Float32Array {
  const out = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i += 3) {
    let [x, y, z] = [raw[i]!, raw[i + 1]!, raw[i + 2]!];
    if (up === 'y') [y, z] = [-z, y];
    out[i] = mirror ? -x : x;
    out[i + 1] = y;
    out[i + 2] = z;
  }
  return out;
}

/** The model seen from above: the highest surface in each cell, in model units. */
export interface Heightfield {
  width: number;
  height: number;
  /** Model units per cell. */
  cell: number;
  minX: number;
  maxY: number;
  minZ: number;
  maxZ: number;
  /** Row 0 is the model's +Y edge. NaN where nothing covers the cell. */
  top: Float32Array;
  /** Height above the ground around it, in model units; 0 on the ground. */
  above: Float32Array;
}

export function heightfield(local: Float32Array, cells = 480): Heightfield {
  let [minX, minY, minZ, maxX, maxY, maxZ] = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let i = 0; i < local.length; i += 3) {
    const [x, y, z] = [local[i]!, local[i + 1]!, local[i + 2]!];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  const cell = Math.max(maxX - minX, maxY - minY) / cells || 1;
  const width = Math.max(1, Math.ceil((maxX - minX) / cell));
  const height = Math.max(1, Math.ceil((maxY - minY) / cell));
  const top = new Float32Array(width * height).fill(NaN);
  for (let t = 0; t < local.length; t += 9) {
    const ax = (local[t]! - minX) / cell, ay = (maxY - local[t + 1]!) / cell, az = local[t + 2]!;
    const bx = (local[t + 3]! - minX) / cell, by = (maxY - local[t + 4]!) / cell, bz = local[t + 5]!;
    const cx = (local[t + 6]! - minX) / cell, cy = (maxY - local[t + 7]!) / cell, cz = local[t + 8]!;
    const area = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
    if (Math.abs(area) < 1e-12) continue;
    const c0 = Math.max(0, Math.ceil(Math.min(ax, bx, cx) - 0.5));
    const c1 = Math.min(width - 1, Math.floor(Math.max(ax, bx, cx) - 0.5));
    const r0 = Math.max(0, Math.ceil(Math.min(ay, by, cy) - 0.5));
    const r1 = Math.min(height - 1, Math.floor(Math.max(ay, by, cy) - 0.5));
    for (let r = r0; r <= r1; r++) {
      const y = r + 0.5;
      for (let c = c0; c <= c1; c++) {
        const x = c + 0.5;
        const wa = ((bx - x) * (cy - y) - (cx - x) * (by - y)) / area;
        const wb = ((cx - x) * (ay - y) - (ax - x) * (cy - y)) / area;
        const wc = 1 - wa - wb;
        if (wa < -1e-9 || wb < -1e-9 || wc < -1e-9) continue;
        const z = wa * az + wb * bz + wc * cz;
        const at = r * width + c;
        if (!(top[at]! >= z)) top[at] = z;
      }
    }
  }
  // The ground under a building is the lowest surface within a few percent of the model's width:
  // a minimum filter, then a maximum filter (an opening), so hills stay ground and roofs stand out.
  const radius = Math.max(2, Math.round(Math.max(width, height) / 40));
  const filled = Float32Array.from(top, (z) => (Number.isNaN(z) ? Infinity : z));
  const ground = morph(morph(filled, width, height, radius, Math.min), width, height, radius, Math.max);
  const above = new Float32Array(width * height);
  for (let i = 0; i < above.length; i++) above[i] = Number.isNaN(top[i]!) ? 0 : Math.max(0, top[i]! - (Number.isFinite(ground[i]!) ? ground[i]! : top[i]!));
  return { width, height, cell, minX, maxY, minZ, maxZ, top, above };
}

/** A square minimum or maximum filter, done as two passes. */
function morph(source: Float32Array, width: number, height: number, radius: number, pick: (a: number, b: number) => number): Float32Array {
  const pass = (from: Float32Array, horizontal: boolean): Float32Array => {
    const out = new Float32Array(from.length);
    const [outer, inner] = horizontal ? [height, width] : [width, height];
    for (let o = 0; o < outer; o++)
      for (let i = 0; i < inner; i++) {
        let value = from[horizontal ? o * width + i : i * width + o]!;
        for (let k = Math.max(0, i - radius); k <= Math.min(inner - 1, i + radius); k++) value = pick(value, from[horizontal ? o * width + k : k * width + o]!);
        out[horizontal ? o * width + i : i * width + o] = value;
      }
    return out;
  };
  return pass(pass(source, true), false);
}

/** Reads a model file into triangles (9 numbers each) in the file's own coordinates. */
export async function readModel(name: string, bytes: ArrayBuffer): Promise<Float32Array> {
  const extension = name.toLowerCase().split('.').pop();
  const THREE = await import('three');
  const fromObject = (root: import('three').Object3D): Float32Array => {
    root.updateMatrixWorld(true);
    const parts: Float32Array[] = [];
    const v = new THREE.Vector3();
    root.traverse((node) => {
      const mesh = node as import('three').Mesh;
      if (!mesh.isMesh || !mesh.geometry) return;
      const geometry = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry;
      const position = geometry.getAttribute('position');
      if (!position) return;
      const out = new Float32Array(position.count * 3);
      for (let i = 0; i < position.count; i++) {
        v.fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld);
        out.set([v.x, v.y, v.z], i * 3);
      }
      parts.push(out.subarray(0, Math.floor(position.count / 3) * 9));
    });
    const total = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const part of parts) {
      total.set(part, at);
      at += part.length;
    }
    return total;
  };
  let triangles: Float32Array;
  if (extension === 'stl') {
    const { STLLoader } = await import('three/examples/jsm/loaders/STLLoader.js');
    const geometry = new STLLoader().parse(bytes);
    triangles = (geometry.getAttribute('position').array as Float32Array).slice();
  } else if (extension === 'obj') {
    const { OBJLoader } = await import('three/examples/jsm/loaders/OBJLoader.js');
    triangles = fromObject(new OBJLoader().parse(new TextDecoder().decode(bytes)));
  } else if (extension === 'glb') {
    const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
    const gltf = await new GLTFLoader().parseAsync(bytes, '');
    triangles = fromObject(gltf.scene);
  } else throw new Error('use an STL, OBJ or GLB file');
  if (triangles.length < 9) throw new Error('the file has no triangles');
  for (const value of triangles) if (!Number.isFinite(value)) throw new Error('the file has coordinates that are not numbers');
  return triangles;
}

/** Building footprints as rings of local metres (east, north). */
type Rings = [number, number][][];

async function loadFootprints(site: SiteInfo, projection: Projection): Promise<Rings> {
  const path = site.data?.buildings;
  if (!path || !/\.(geo)?json$/i.test(path)) return [];
  const response = await fetch(`/site/${path}`);
  if (!response.ok) return [];
  const collection = (await response.json()) as { features?: { geometry?: { type: string; coordinates: unknown } | null }[] };
  const rings: Rings = [];
  for (const feature of collection.features ?? []) {
    const g = feature.geometry;
    if (!g) continue;
    const polygons = g.type === 'Polygon' ? [g.coordinates as number[][][]] : g.type === 'MultiPolygon' ? (g.coordinates as number[][][][]) : [];
    for (const polygon of polygons) for (const ring of polygon) rings.push(ring.map(([lon, lat]) => projection.toLocal(lon!, lat!)));
  }
  return rings;
}

/** What the importer needs from the window around it. */
export interface ModelHost {
  site(): SiteInfo;
}

/** The model being placed: the file, its triangles, and the heightfield for the current up axis and mirror. */
interface Loaded {
  name: string;
  /** The file to send, or null when the table already has it and only the placement changes. */
  file: File | null;
  raw: Float32Array;
  local: Float32Array;
  field: Heightfield;
  image: HTMLCanvasElement;
  /** What was guessed rather than read, for the report. */
  guessed: { unit: boolean; up: boolean };
}

const BUILDING_M = 2.5;

export class ModelImporter {
  readonly element = el('div', 'wz-place im mi');
  private loaded: Loaded | null = null;
  private placement: ModelPlacement | null = null;
  private unit: UnitChoice | null = null;
  /** Fine scale on top of the unit, as a factor (1 = 100 %). */
  private fine = 1;
  private busy = '';
  private failed = '';
  private note = '';
  private help = false;
  private footprints: Rings | null = null;
  private canvas: HTMLCanvasElement | null = null;
  /** The view of the preview, kept while a drag is under way so the picture does not slide. */
  private view: { centre: [number, number]; span: number } | null = null;
  private readonly host: ModelHost;

  constructor(host: ModelHost) {
    this.host = host;
    this.render();
  }

  /** Whether a model is being placed, which a redraw of the page around must keep. */
  get pending(): boolean {
    return this.loaded !== null || this.busy !== '';
  }

  private get projection(): Projection {
    return new Projection(this.host.site().origin);
  }

  render(): void {
    const site = this.host.site();
    const has = !!site.mesh;
    this.element.dataset.target = MODEL_ROW;
    const row = el('div', 'wz-choice');
    const badge = el('span', 'wz-badge');
    badge.append(icon('cube', 20));
    const words = el('div');
    const name = el('strong', undefined, '3D model');
    const ask = el('button', 'im-help');
    ask.type = 'button';
    ask.textContent = '?';
    ask.ariaLabel = 'What a 3D model file looks like';
    ask.setAttribute('aria-expanded', String(this.help));
    ask.addEventListener('click', () => {
      this.help = !this.help;
      this.render();
    });
    name.append(ask);
    words.append(name, el('p', undefined, 'The model on your table, so shadows and wind follow its real heights. STL, OBJ or GLB.'));
    const state = el('span', has ? 'wz-state is-have' : 'wz-state', has ? 'On the table' : 'Not yet');
    if (has) state.prepend(icon('check', 12));
    const actions = el('div', 'im-actions');
    const input = el('input');
    Object.assign(input, { type: 'file', accept: '.stl,.obj,.glb', hidden: true, ariaLabel: 'File for the 3D model' });
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (file) void this.open(file);
    });
    const choose = el('button', 'ed-button', has ? 'Replace' : 'Choose a file');
    choose.type = 'button';
    choose.addEventListener('click', () => input.click());
    actions.append(choose, input);
    if (has && !this.loaded) {
      const adjust = el('button', 'ed-button', 'Adjust placement');
      adjust.type = 'button';
      adjust.addEventListener('click', () => void this.reopen());
      actions.append(adjust);
    }
    words.append(actions);
    row.append(badge, words, state);
    const nodes: HTMLElement[] = [row];
    if (this.help)
      nodes.push(
        el(
          'pre',
          'im-example',
          'The 3D model your table is printed or milled from, or a city model of the same ground: ground and buildings as one surface. STL (binary or ASCII), OBJ, or a single-file GLB.\n\nIts units are guessed from its size and the table scale (a printed model is often in millimetres at 1 : 1000). Y-up exports (glTF, many modelling tools) can be turned upright with "Y is up".',
        ),
      );
    if (this.loaded || this.busy || this.failed) nodes.push(this.panel());
    this.element.replaceChildren(...nodes);
    if (this.canvas) this.draw();
  }

  private reset(): void {
    this.loaded = null;
    this.placement = null;
    this.unit = null;
    this.fine = 1;
    this.busy = '';
    this.failed = '';
    this.note = '';
    this.canvas = null;
    this.view = null;
    this.render();
  }

  /** A new file: read it, guess how it is meant, and centre it on the table. */
  private async open(file: File): Promise<void> {
    this.reset();
    this.busy = `Reading ${file.name}…`;
    this.render();
    try {
      const raw = await readModel(file.name, await file.arrayBuffer());
      const site = this.host.site();
      const extent = boxOf(raw);
      const up = guessUp([extent[3] - extent[0], extent[4] - extent[1], extent[5] - extent[2]], /\.glb$/i.test(file.name));
      const local = orient(raw, up, false);
      const field = heightfield(local);
      const size = Math.max(field.width, field.height) * field.cell;
      this.unit = guessUnit(site, size);
      this.fine = 1;
      const r = site.extent.rotation_deg;
      // Line the model's long side up with the table's long side.
      const tableLong = site.extent.width_m >= site.extent.height_m ? r + 90 : r;
      const bearing = normalise(tableLong - (field.width >= field.height ? 90 : 0));
      this.placement = { lon: site.origin.lon, lat: site.origin.lat, unit_m: this.unit.unit_m, bearing_deg: bearing, base_m: 0, up, mirror: false, extrude: !site.data?.buildings ? true : false };
      this.loaded = { name: file.name, file, raw, local, field, image: picture(field, this.placement.unit_m), guessed: { unit: true, up: up === 'y' || /\.glb$/i.test(file.name) } };
      this.centre();
      this.busy = '';
    } catch (error) {
      this.busy = '';
      this.failed = `${file.name} can't be read: ${(error as Error).message}.`;
    }
    this.render();
  }

  /** The table's own model, placed as it is, to adjust. */
  private async reopen(): Promise<void> {
    const site = this.host.site();
    const mesh = site.mesh;
    if (!mesh) return;
    this.reset();
    this.busy = 'Reading the model…';
    this.render();
    try {
      const response = await fetch(`/site/${mesh.path}`, { cache: 'no-store' });
      if (!response.ok) throw new Error(`the table answered ${response.status}`);
      const raw = await readModel(mesh.path, await response.arrayBuffer());
      this.placement = placementOf(mesh);
      const local = orient(raw, this.placement.up, this.placement.mirror);
      const field = heightfield(local);
      const choices = unitChoices(site);
      this.unit = choices.reduce((best, c) => (Math.abs(Math.log(mesh.unit_m / c.unit_m)) < Math.abs(Math.log(mesh.unit_m / best.unit_m)) ? c : best));
      this.fine = mesh.unit_m / this.unit.unit_m;
      this.loaded = { name: mesh.path.split('/').pop() ?? mesh.path, file: null, raw, local, field, image: picture(field, mesh.unit_m), guessed: { unit: false, up: false } };
      this.busy = '';
    } catch (error) {
      this.busy = '';
      this.failed = `The model could not be read: ${(error as Error).message}.`;
    }
    this.render();
  }

  /** Puts the middle of the model on the middle of the table. */
  private centre(): void {
    const { loaded, placement: p } = this;
    if (!loaded || !p) return;
    const f = loaded.field;
    const cx = f.minX + (f.width * f.cell) / 2;
    const cy = f.maxY - (f.height * f.cell) / 2;
    const [e, n] = rotate(cx * p.unit_m, cy * p.unit_m, p.bearing_deg);
    Object.assign(p, this.projection.toLonLat(-e, -n));
  }

  /** Re-reads the file's axes after "Y is up" or "Mirror" changed, keeping the model's middle where it was. */
  private reorient(): void {
    const { loaded, placement: p } = this;
    if (!loaded || !p) return;
    const middle = this.middleLocal();
    loaded.local = orient(loaded.raw, p.up, p.mirror);
    loaded.field = heightfield(loaded.local);
    loaded.image = picture(loaded.field, p.unit_m);
    this.moveMiddleTo(middle);
  }

  /** Where the model's middle is now, in local metres. */
  private middleLocal(): [number, number] {
    const { loaded, placement: p } = this;
    const f = loaded!.field;
    return this.modelToLocal(f.minX + (f.width * f.cell) / 2, f.maxY - (f.height * f.cell) / 2, p!);
  }

  private moveMiddleTo([e, n]: [number, number]): void {
    const { loaded, placement: p } = this;
    const f = loaded!.field;
    const [de, dn] = rotate((f.minX + (f.width * f.cell) / 2) * p!.unit_m, (f.maxY - (f.height * f.cell) / 2) * p!.unit_m, p!.bearing_deg);
    Object.assign(p!, this.projection.toLonLat(e - de, n - dn));
  }

  /** A point of the model (its own units, Z up) in local metres east and north of the site origin. */
  private modelToLocal(x: number, y: number, p: ModelPlacement): [number, number] {
    const [ae, an] = this.projection.toLocal(p.lon, p.lat);
    const [e, n] = rotate(x * p.unit_m, y * p.unit_m, p.bearing_deg);
    return [ae + e, an + n];
  }

  /** A scale or turn changed: the model turns and grows about its middle, not its file origin. */
  private aboutMiddle(change: () => void): void {
    const middle = this.middleLocal();
    change();
    this.placement!.unit_m = this.unit!.unit_m * this.fine;
    this.loaded!.image = picture(this.loaded!.field, this.placement!.unit_m);
    this.moveMiddleTo(middle);
    this.note = '';
    this.render();
  }

  private panel(): HTMLElement {
    const box = el('div', 'wz-report mi-panel');
    if (this.busy) {
      box.append(el('p', 'mi-busy', this.busy));
      if (!this.loaded) return box;
    }
    if (this.failed) box.append(el('p', 'wz-issue is-blocker', this.failed));
    const { loaded, placement: p } = this;
    if (!loaded || !p || !this.unit) {
      box.append(this.buttons(false));
      return box;
    }
    const site = this.host.site();

    // What the file is, and how it lands.
    const f = loaded.field;
    const triangles = loaded.raw.length / 9;
    const w = f.width * f.cell * p.unit_m;
    const h = f.height * f.cell * p.unit_m;
    const low = f.minZ * p.unit_m + p.base_m;
    const high = f.maxZ * p.unit_m + p.base_m;
    const tallest = largest(f.above) * p.unit_m;
    box.append(el('p', 'wz-summary', `${loaded.name}: ${count(triangles)} triangles, ${metres(w)} × ${metres(h)} m, ${metres(low)} to ${metres(high)} m high`));
    const issues: [string, string][] = [];
    if (loaded.guessed.unit) issues.push(['note', `Units guessed from the model's size: ${this.unit.label.toLowerCase()}. Change them below if it looks wrong.`]);
    if (loaded.guessed.up && p.up === 'y') issues.push(['note', 'The file looks Y-up, so it was turned upright. Untick "Y is up" if the preview looks like a side view.']);
    const cover = this.coverage();
    if (cover < 0.5) issues.push(['warning', `The model covers ${Math.round(cover * 100)} % of the table. Drag it into place, or check its units.`]);
    if ((f.maxZ - f.minZ) > 0.5 * Math.max(f.width, f.height) * f.cell)
      issues.push(['warning', `The model is ${metres((f.maxZ - f.minZ) * p.unit_m)} m tall and ${metres(Math.max(w, h))} m across, so this is probably a side view. Try ${p.up === 'y' ? 'unticking' : 'ticking'} "Y is up".`]);
    else if (tallest > 400) issues.push(['warning', `Its tallest building stands ${metres(tallest)} m above the ground. The units may be wrong.`]);
    if (this.note) issues.push(['note', this.note]);
    for (const [severity, text] of issues) box.append(el('p', `wz-issue is-${severity}`, text));

    // The picture: the model from above against the table and the footprints.
    const canvas = el('canvas', 'mi-canvas');
    canvas.tabIndex = 0;
    canvas.ariaLabel = 'The model from above on the table. Drag to move it; arrow keys nudge it by a metre, with Shift by ten.';
    this.canvas = canvas;
    this.bindDrag(canvas);
    const preview = el('div', 'im-preview mi-preview');
    const legend = el('div', 'mi-legend');
    legend.append(swatch('is-table', 'Your table'), swatch('is-footprint', 'Footprints'), swatch('is-model', 'Model, lighter is taller'));
    preview.append(canvas, legend);
    box.append(preview);
    if (this.footprints === null && site.data?.buildings) {
      this.footprints = [];
      void loadFootprints(site, this.projection).then((rings) => {
        this.footprints = rings;
        this.draw();
      });
    }

    // The settings, in the order an author fixes a model: units, axes, turn, scale, place.
    const form = el('div', 'mi-form');
    const units = el('select');
    units.ariaLabel = 'Units of the file';
    for (const choice of unitChoices(site)) units.append(new Option(choice.label, choice.id, false, choice.id === this.unit.id));
    units.addEventListener('change', () => {
      loaded.guessed.unit = false;
      this.aboutMiddle(() => {
        this.unit = unitChoices(site).find((c) => c.id === units.value) ?? this.unit;
      });
    });
    form.append(field('The file is in', units));

    const axes = el('div', 'mi-toggles');
    axes.append(
      toggle('Y is up', 'Swap Y and Z, for files exported Y-up (glTF, Blender, many modelling tools).', p.up === 'y', (on) => {
        p.up = on ? 'y' : 'z';
        loaded.guessed.up = false;
        this.reorient();
        this.render();
      }),
      toggle('Mirror', 'Flip the model left to right, for files exported mirrored.', p.mirror, (on) => {
        p.mirror = on;
        this.reorient();
        this.render();
      }),
    );
    form.append(field('Axes', axes));

    const turn = number(p.bearing_deg, 0.1, 'Turn in degrees, clockwise');
    turn.addEventListener('change', () => this.aboutMiddle(() => (p.bearing_deg = normalise(Number(turn.value) || 0))));
    const turnRow = el('div', 'mi-inline');
    const quarter = (by: number, text: string) => {
      const button = el('button', 'ed-button', text);
      button.type = 'button';
      button.title = `Turn ${Math.abs(by)}° ${by < 0 ? 'anticlockwise' : 'clockwise'}`;
      button.addEventListener('click', () => this.aboutMiddle(() => (p.bearing_deg = normalise(p.bearing_deg + by))));
      return button;
    };
    turnRow.append(turn, quarter(-90, '↺ 90°'), quarter(90, '↻ 90°'));
    form.append(field('Rotate, °', turnRow));

    const scale = number(Math.round(this.fine * 10000) / 100, 0.1, 'Scale in percent');
    scale.addEventListener('change', () => this.aboutMiddle(() => (this.fine = Math.max(0.01, Number(scale.value) || 100) / 100)));
    const scaleRow = el('div', 'mi-inline');
    scaleRow.append(scale, el('small', undefined, `= ${p.unit_m < 1 ? p.unit_m.toPrecision(4) : count(Math.round(p.unit_m * 1000) / 1000)} m per unit`));
    form.append(field('Scale, %', scaleRow));

    const base = number(p.base_m, 0.1, 'Height of the model\'s zero, in metres');
    base.addEventListener('change', () => {
      p.base_m = Number(base.value) || 0;
      this.render();
    });
    const baseRow = el('div', 'mi-inline');
    baseRow.append(base, el('small', undefined, site.data?.terrain ? 'Elevation of the file\'s zero, in the ground model\'s heights.' : 'Usually 0.'));
    form.append(field('Base height, m', baseRow));

    const place = el('div', 'mi-inline');
    const middle = el('button', 'ed-button', 'Centre on the table');
    middle.type = 'button';
    middle.addEventListener('click', () => {
      this.centre();
      this.note = '';
      this.render();
    });
    const snap = el('button', 'ed-button', 'Snap to buildings');
    snap.type = 'button';
    snap.disabled = !site.data?.buildings || !!this.busy;
    snap.title = site.data?.buildings ? 'Move, turn and scale the model a little so its buildings stand on the footprints.' : 'Bring in buildings first: the model is fitted to their footprints.';
    snap.addEventListener('click', () => void this.snap());
    place.append(middle, snap);
    form.append(field('Place', place, 'Drag the model in the picture. Arrow keys nudge it.'));

    if (site.data?.buildings) {
      const shape = el('label', 'mi-check');
      const box2 = el('input');
      Object.assign(box2, { type: 'checkbox', checked: !p.extrude });
      box2.addEventListener('change', () => (p.extrude = !box2.checked));
      shape.append(box2, el('span', undefined, 'The model gives the buildings their shape (the footprints are only drawn)'));
      form.append(shape);
    }
    box.append(form, this.buttons(true));
    return box;
  }

  private buttons(ready: boolean): HTMLElement {
    const actions = el('div', 'wz-report-actions');
    const site = this.host.site();
    const add = el('button', 'ed-button is-primary', this.loaded?.file === null ? 'Save the placement' : 'Add to the table');
    add.type = 'button';
    add.disabled = !ready || !!this.busy;
    add.addEventListener('click', () => void this.save());
    const cancel = el('button', 'ed-button', 'Cancel');
    cancel.type = 'button';
    cancel.addEventListener('click', () => this.reset());
    actions.append(add, cancel);
    if (site.mesh && this.loaded?.file === null) {
      const remove = el('button', 'ed-button mi-remove', 'Remove the model');
      remove.type = 'button';
      remove.disabled = !!this.busy;
      remove.addEventListener('click', () => void this.send(new URLSearchParams({ remove: '1' }), null));
      actions.append(remove);
    }
    return actions;
  }

  private async save(): Promise<void> {
    const p = this.placement;
    if (!p) return;
    const query = new URLSearchParams({
      lon: p.lon.toFixed(9),
      lat: p.lat.toFixed(9),
      unit_m: String(p.unit_m),
      bearing_deg: p.bearing_deg.toFixed(4),
      base_m: String(p.base_m),
      up: p.up,
      mirror: p.mirror ? '1' : '0',
    });
    if (this.host.site().data?.buildings) query.set('extrude', p.extrude ? '1' : '0');
    await this.send(query, this.loaded?.file ?? null);
  }

  private async send(query: URLSearchParams, file: File | null): Promise<void> {
    this.busy = file ? `Bringing in ${file.name} and rebuilding the scene…` : 'Rebuilding the scene…';
    this.failed = '';
    this.render();
    try {
      const response = await fetch(`/api/data/model?${query}`, {
        method: 'POST',
        headers: file ? { 'X-Filename': encodeURIComponent(file.name) } : {},
        body: file ?? '',
      });
      const answer = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) throw new Error(answer?.error ?? `the table answered ${response.status}`);
      // The host tells every surface the site changed, and the editor reloads with the model in.
      this.loaded = null;
      this.busy = '';
      this.render();
    } catch (error) {
      this.busy = '';
      this.failed = `The model was not saved: ${(error as Error).message}`;
      this.render();
    }
  }

  /** Share of the table the model covers, from its outline. */
  private coverage(): number {
    const { loaded, placement: p } = this;
    if (!loaded || !p) return 0;
    const site = this.host.site();
    const f = loaded.field;
    const r = (site.extent.rotation_deg * Math.PI) / 180;
    const [w, h] = [site.extent.width_m / 2, site.extent.height_m / 2];
    let inside = 0;
    const steps = 24;
    for (let i = 0; i < steps; i++)
      for (let j = 0; j < steps; j++) {
        const x = -w + ((i + 0.5) / steps) * 2 * w;
        const y = -h + ((j + 0.5) / steps) * 2 * h;
        // Table metres to local, then to the model's cells.
        const e = x * Math.cos(r) + y * Math.sin(r);
        const n = -x * Math.sin(r) + y * Math.cos(r);
        const [mx, my] = this.localToModel(e, n, p);
        const c = Math.floor((mx - f.minX) / f.cell);
        const row = Math.floor((f.maxY - my) / f.cell);
        if (c >= 0 && row >= 0 && c < f.width && row < f.height && !Number.isNaN(f.top[row * f.width + c]!)) inside++;
      }
    return inside / (steps * steps);
  }

  private localToModel(e: number, n: number, p: ModelPlacement): [number, number] {
    const [ae, an] = this.projection.toLocal(p.lon, p.lat);
    const [x, y] = rotate(e - ae, n - an, -p.bearing_deg);
    return [x / p.unit_m, y / p.unit_m];
  }

  /** Table metres (x along the table's width, y up it) to canvas pixels, and local metres to table metres. */
  private transforms(canvas: HTMLCanvasElement): { toPx: Affine; localToTable: Affine } {
    const site = this.host.site();
    const r = (site.extent.rotation_deg * Math.PI) / 180;
    const localToTable: Affine = [Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0];
    if (!this.view) {
      const [w, h] = [site.extent.width_m / 2, site.extent.height_m / 2];
      let [minX, minY, maxX, maxY] = [-w, -h, w, h];
      const { loaded, placement: p } = this;
      if (loaded && p) {
        const f = loaded.field;
        for (const [cx, cy] of [[0, 0], [f.width, 0], [f.width, f.height], [0, f.height]] as const) {
          const [e, n] = this.modelToLocal(f.minX + cx * f.cell, f.maxY - cy * f.cell, p);
          const [x, y] = apply(localToTable, e, n);
          [minX, minY, maxX, maxY] = [Math.min(minX, x), Math.min(minY, y), Math.max(maxX, x), Math.max(maxY, y)];
        }
      }
      // Never zoom out so far that the table is a speck.
      const cap = 3 * Math.max(w, h);
      [minX, minY, maxX, maxY] = [Math.max(minX, -cap), Math.max(minY, -cap), Math.min(maxX, cap), Math.min(maxY, cap)];
      this.view = { centre: [(minX + maxX) / 2, (minY + maxY) / 2], span: Math.max((maxX - minX) / canvas.width, (maxY - minY) / canvas.height) * 1.08 };
    }
    const { centre, span } = this.view;
    const s = 1 / span;
    const toPx: Affine = [s, 0, 0, -s, canvas.width / 2 - s * centre[0], canvas.height / 2 + s * centre[1]];
    return { toPx, localToTable };
  }

  private draw(): void {
    const canvas = this.canvas;
    const { loaded, placement: p } = this;
    if (!canvas || !loaded || !p) return;
    const ratio = window.devicePixelRatio || 1;
    const cssWidth = canvas.clientWidth || 420;
    const cssHeight = canvas.clientHeight || 280;
    if (canvas.width !== Math.round(cssWidth * ratio) || canvas.height !== Math.round(cssHeight * ratio)) {
      canvas.width = Math.round(cssWidth * ratio);
      canvas.height = Math.round(cssHeight * ratio);
      this.view = null;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const site = this.host.site();
    const { toPx, localToTable } = this.transforms(canvas);
    const localToPx = then(toPx, localToTable);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#0b0e14';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // The model: its picture's pixels to the model's units, to local metres, to the canvas.
    const f = loaded.field;
    const [ae, an] = this.projection.toLocal(p.lon, p.lat);
    const b = (p.bearing_deg * Math.PI) / 180;
    const u = p.unit_m;
    const modelToLocal: Affine = [u * Math.cos(b), -u * Math.sin(b), u * Math.sin(b), u * Math.cos(b), ae, an];
    const pixelToModel: Affine = [f.cell, 0, 0, -f.cell, f.minX, f.maxY];
    ctx.setTransform(...then(localToPx, then(modelToLocal, pixelToModel)));
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(loaded.image, 0, 0);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const line = (points: [number, number][], close: boolean) => {
      points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      if (close) ctx.closePath();
    };
    // Footprints over it, so a misfit shows as outlines beside the roofs.
    if (this.footprints?.length) {
      ctx.beginPath();
      for (const ring of this.footprints) line(ring.map(([e, n]) => apply(localToPx, e, n)), true);
      ctx.strokeStyle = 'rgba(143, 176, 255, 0.9)';
      ctx.lineWidth = Math.max(1, ratio * 0.8);
      ctx.stroke();
    }
    // The table's outline.
    const [w, h] = [site.extent.width_m / 2, site.extent.height_m / 2];
    ctx.beginPath();
    line(([[-w, -h], [w, -h], [w, h], [-w, h]] as [number, number][]).map(([x, y]) => apply(toPx, x, y)), true);
    ctx.setLineDash([6 * ratio, 4 * ratio]);
    ctx.strokeStyle = '#f3ad3d';
    ctx.lineWidth = 2 * ratio;
    ctx.stroke();
    ctx.setLineDash([]);
    // The model's outline, so it can be found when it lies off the table.
    ctx.beginPath();
    line(([[0, 0], [f.width, 0], [f.width, f.height], [0, f.height]] as [number, number][]).map(([cx, cy]) => {
      const [e, n] = this.modelToLocal(f.minX + cx * f.cell, f.maxY - cy * f.cell, p);
      return apply(localToPx, e, n);
    }), true);
    ctx.strokeStyle = 'rgba(232, 236, 244, 0.55)';
    ctx.lineWidth = ratio;
    ctx.stroke();
  }

  /** Dragging the picture moves the model; arrow keys nudge it. */
  private bindDrag(canvas: HTMLCanvasElement): void {
    let from: { x: number; y: number; e: number; n: number } | null = null;
    const toLocal = (dxPx: number, dyPx: number): [number, number] => {
      const { toPx, localToTable } = this.transforms(canvas);
      const ratio = canvas.width / (canvas.clientWidth || canvas.width);
      const back = invert(then(toPx, localToTable));
      const [e0, n0] = apply(back, 0, 0);
      const [e1, n1] = apply(back, dxPx * ratio, dyPx * ratio);
      return [e1 - e0, n1 - n0];
    };
    canvas.addEventListener('pointerdown', (event) => {
      const p = this.placement;
      if (!p) return;
      canvas.setPointerCapture(event.pointerId);
      const [e, n] = this.projection.toLocal(p.lon, p.lat);
      from = { x: event.clientX, y: event.clientY, e, n };
      canvas.classList.add('is-dragging');
    });
    canvas.addEventListener('pointermove', (event) => {
      const p = this.placement;
      if (!from || !p) return;
      const [de, dn] = toLocal(event.clientX - from.x, event.clientY - from.y);
      Object.assign(p, this.projection.toLonLat(from.e + de, from.n + dn));
      this.draw();
    });
    const end = () => {
      if (!from) return;
      from = null;
      canvas.classList.remove('is-dragging');
      this.note = '';
      this.view = null;
      this.render();
      this.canvas?.focus();
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    canvas.addEventListener('keydown', (event) => {
      const p = this.placement;
      const step = event.shiftKey ? 10 : 1;
      const by: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
      const move = by[event.key];
      if (!move || !p) return;
      event.preventDefault();
      // A metre on the table, whatever the zoom: px per metre from the view.
      const scale = 1 / (this.view?.span ?? 1) / (canvas.width / (canvas.clientWidth || canvas.width));
      const [de, dn] = toLocal(move[0] * scale, move[1] * scale);
      const [e, n] = this.projection.toLocal(p.lon, p.lat);
      Object.assign(p, this.projection.toLonLat(e + de, n + dn));
      this.draw();
    });
  }

  /** Fits the model's buildings to the footprints: a search over place, turn and scale near where it is now. */
  private async snap(): Promise<void> {
    const { loaded, placement: p } = this;
    if (!loaded || !p || !this.unit) return;
    this.busy = 'Fitting the model to the footprints…';
    this.render();
    await new Promise((resolve) => setTimeout(resolve, 30));
    try {
      const site = this.host.site();
      const rings = this.footprints?.length ? this.footprints : await loadFootprints(site, this.projection);
      this.footprints = rings;
      if (rings.length === 0) throw new Error('the table has no building footprints to fit to');
      const fit = fitToFootprints(loaded.field, rings, site, { ...p }, this.projection);
      const before = Math.round(fit.before * 100);
      const after = Math.round(fit.after * 100);
      if (fit.after < 0.25 || fit.after <= fit.before + 0.005) {
        this.note = fit.after <= fit.before + 0.005 ? `It already fits as well as it can (${before} % match).` : `No good fit nearby (${after} % match). Drag the model close to where it belongs, check its units and axes, and try again.`;
        if (fit.after > fit.before + 0.005) Object.assign(p, fit.placement);
      } else {
        Object.assign(p, fit.placement);
        this.note = `Snapped: the model and the footprints now match ${after} % (from ${before} %). Moved ${metres(fit.moved)} m, turned ${fit.turned.toFixed(2)}°, scaled ${((fit.placement.unit_m / (this.unit.unit_m * this.fine) - 1) * 100).toFixed(1)} %.`;
      }
      this.fine = p.unit_m / this.unit.unit_m;
      loaded.image = picture(loaded.field, p.unit_m);
    } catch (error) {
      this.note = `Could not snap: ${(error as Error).message}.`;
    }
    this.busy = '';
    this.view = null;
    this.render();
  }
}

export interface Fit {
  placement: ModelPlacement;
  before: number;
  after: number;
  moved: number;
  turned: number;
}

/**
 * Fits a model to building footprints. Both are sampled: points on the model's buildings
 * (cells standing `BUILDING_M` above their ground) should fall in a footprint, and points in
 * the footprints should fall on a model building. The score is the mean of the two shares,
 * so neither shrinking the model into one building nor growing it over everything pays.
 * A coarse search over place and turn, then a finer one over place, turn and scale.
 */
export function fitToFootprints(field: Heightfield, rings: Rings, site: SiteInfo, start: ModelPlacement, projection: Projection): Fit {
  // Footprints as a mask in local metres around the table.
  const half = Math.hypot(site.extent.width_m, site.extent.height_m) * 0.75;
  const cell = Math.max(0.5, (2 * half) / 1200);
  const size = Math.ceil((2 * half) / cell);
  const mask = rasterise(rings, size, cell, half);
  const inMask = (e: number, n: number) => {
    const c = Math.floor((e + half) / cell);
    const r = Math.floor((half - n) / cell);
    return c >= 0 && r >= 0 && c < size && r < size && mask[r * size + c] === 1;
  };

  // Points on the model's buildings, in model units.
  const tall = BUILDING_M / start.unit_m;
  const modelPoints: [number, number][] = [];
  const building = new Uint8Array(field.width * field.height);
  for (let i = 0; i < building.length; i++) if (field.above[i]! > tall) building[i] = 1;
  const cells: number[] = [];
  for (let i = 0; i < building.length; i++) if (building[i]) cells.push(i);
  const pick = (list: number[], n: number) => (list.length <= n ? list : Array.from({ length: n }, (_, k) => list[Math.floor(((k + 0.5) * list.length) / n)]!));
  for (const i of pick(cells, 3000)) modelPoints.push([field.minX + ((i % field.width) + 0.5) * field.cell, field.maxY - (Math.floor(i / field.width) + 0.5) * field.cell]);
  if (modelPoints.length < 20) throw new Error('the model has too few buildings standing above the ground to fit; check its units and axes');

  // Points in the footprints that lie on the table, in local metres.
  const r = (site.extent.rotation_deg * Math.PI) / 180;
  const [w, h] = [site.extent.width_m / 2, site.extent.height_m / 2];
  const footCells: number[] = [];
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const e = -half + ((i % size) + 0.5) * cell;
    const n = half - (Math.floor(i / size) + 0.5) * cell;
    const x = e * Math.cos(r) - n * Math.sin(r);
    const y = e * Math.sin(r) + n * Math.cos(r);
    if (Math.abs(x) <= w && Math.abs(y) <= h) footCells.push(i);
  }
  const footPoints: [number, number][] = pick(footCells, 3000).map((i) => [-half + ((i % size) + 0.5) * cell, half - (Math.floor(i / size) + 0.5) * cell]);

  type State = { e: number; n: number; b: number; u: number };
  const score = ({ e, n, b, u }: State): number => {
    const [s, c] = [Math.sin((b * Math.PI) / 180), Math.cos((b * Math.PI) / 180)];
    let hits = 0;
    for (const [x, y] of modelPoints) if (inMask(e + u * (x * c + y * s), n + u * (-x * s + y * c))) hits++;
    // The model covers only part of the table: footprints it does not reach are not counted against it.
    let found = 0;
    let reached = 0;
    for (const [fe, fn] of footPoints) {
      const [de, dn] = [(fe - e) / u, (fn - n) / u];
      const x = de * c - dn * s;
      const y = de * s + dn * c;
      const col = Math.floor((x - field.minX) / field.cell);
      const row = Math.floor((field.maxY - y) / field.cell);
      if (col < 0 || row < 0 || col >= field.width || row >= field.height) continue;
      reached++;
      if (building[row * field.width + col]) found++;
    }
    return (hits / modelPoints.length + (reached ? found / reached : 0)) / 2;
  };

  const [e0, n0] = projection.toLocal(start.lon, start.lat);
  let best: State = { e: e0, n: n0, b: start.bearing_deg, u: start.unit_m };
  const before = score(best);
  let bestScore = before;
  // Coarse: place on a grid, a few turns.
  const reach = Math.max(30, 0.06 * Math.max(site.extent.width_m, site.extent.height_m));
  const step = reach / 10;
  const origin = { ...best };
  for (const db of [-3, -1.5, 0, 1.5, 3])
    for (let i = -10; i <= 10; i++)
      for (let j = -10; j <= 10; j++) {
        const trial = { ...origin, e: origin.e + i * step, n: origin.n + j * step, b: origin.b + db };
        const value = score(trial);
        if (value > bestScore) [best, bestScore] = [trial, value];
      }
  // Fine: one parameter at a time, steps halving when nothing helps.
  let [dt, db, du] = [step / 2, 0.75, 0.02];
  for (let round = 0; round < 200 && (dt > 0.1 || db > 0.01 || du > 0.0005); round++) {
    let improved = false;
    const trials: State[] = [
      { ...best, e: best.e + dt },
      { ...best, e: best.e - dt },
      { ...best, n: best.n + dt },
      { ...best, n: best.n - dt },
      { ...best, b: best.b + db },
      { ...best, b: best.b - db },
      { ...best, u: best.u * (1 + du) },
      { ...best, u: best.u / (1 + du) },
    ];
    for (const trial of trials) {
      if (Math.abs(Math.log(trial.u / start.unit_m)) > 0.15) continue;
      const value = score(trial);
      if (value > bestScore + 1e-6) [best, bestScore, improved] = [trial, value, true];
    }
    if (!improved) [dt, db, du] = [dt / 2, db / 2, du / 2];
  }
  const placement = { ...start, ...projection.toLonLat(best.e, best.n), bearing_deg: normalise(best.b), unit_m: best.u };
  return { placement, before, after: bestScore, moved: Math.hypot(best.e - e0, best.n - n0), turned: best.b - start.bearing_deg };
}

/** Footprints filled into a square mask `size` cells across, centred on the site origin. */
function rasterise(rings: Rings, size: number, cell: number, half: number): Uint8Array {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.beginPath();
  for (const ring of rings)
    ring.forEach(([e, n], i) => {
      const [x, y] = [(e + half) / cell, (half - n) / cell];
      if (i) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
    });
  ctx.fillStyle = '#fff';
  ctx.fill('evenodd');
  const pixels = ctx.getImageData(0, 0, size, size).data;
  const mask = new Uint8Array(size * size);
  for (let i = 0; i < mask.length; i++) mask[i] = pixels[i * 4 + 3]! > 127 ? 1 : 0;
  return mask;
}

/** The heightfield as a picture: ground dark, buildings lighter the taller they stand, shaded from the north-west. */
function picture(field: Heightfield, unit_m: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = field.width;
  canvas.height = field.height;
  const ctx = canvas.getContext('2d')!;
  const image = ctx.createImageData(field.width, field.height);
  const tallest = Math.max(1e-9, largest(field.above));
  const { width, top, above } = field;
  for (let i = 0; i < top.length; i++) {
    const z = top[i]!;
    if (Number.isNaN(z)) continue;
    const metresAbove = above[i]! * unit_m;
    const left = top[i - 1] ?? z;
    const up = top[i - width] ?? z;
    // A light from the north-west: slopes facing it are lighter.
    const shade = Math.max(-1, Math.min(1, ((Number.isNaN(left) ? z : left) - z + ((Number.isNaN(up) ? z : up) - z)) / field.cell / 2));
    const t = metresAbove > BUILDING_M ? 0.45 + 0.55 * Math.sqrt(above[i]! / tallest) : 0;
    const base = t > 0 ? 70 + 185 * t : 46;
    const light = Math.max(0, Math.min(255, base - shade * 40));
    image.data.set(t > 0 ? [light, light, Math.min(255, light + 8), 255] : [light * 0.9, light, light * 1.15, 255], i * 4);
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

function largest(values: Float32Array): number {
  let most = -Infinity;
  for (const v of values) if (v > most) most = v;
  return most;
}

function boxOf(raw: Float32Array): [number, number, number, number, number, number] {
  const box: [number, number, number, number, number, number] = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let i = 0; i < raw.length; i += 3)
    for (let k = 0; k < 3; k++) {
      const v = raw[i + k]!;
      if (v < box[k]!) box[k] = v;
      if (v > box[k + 3]!) box[k + 3] = v;
    }
  return box;
}

export function placementOf(mesh: SiteMesh): ModelPlacement {
  return { lon: mesh.anchor.lon, lat: mesh.anchor.lat, unit_m: mesh.unit_m, bearing_deg: mesh.bearing_deg, base_m: mesh.base_m, up: mesh.up ?? 'z', mirror: !!mesh.mirror, extrude: mesh.extrude };
}

/** A vector in the model's turned frame (+Y along `bearing` degrees clockwise from north) as east and north. */
function rotate(x: number, y: number, bearing: number): [number, number] {
  const b = (bearing * Math.PI) / 180;
  return [x * Math.cos(b) + y * Math.sin(b), -x * Math.sin(b) + y * Math.cos(b)];
}

function normalise(degrees: number): number {
  const d = ((((degrees + 180) % 360) + 360) % 360) - 180;
  return Math.round(d * 10000) / 10000;
}

const count = (n: number) => n.toLocaleString('en-GB').replace(/,/g, ' ');
const metres = (n: number) => (Math.abs(n) >= 100 ? count(Math.round(n)) : (Math.round(n * 10) / 10).toString());

function field(label: string, control: HTMLElement, hint?: string): HTMLElement {
  const row = el('div', 'mi-field');
  row.append(el('span', 'mi-label', label), control);
  if (hint) row.append(el('small', 'mi-hint', hint));
  return row;
}

function number(value: number, step: number, label: string): HTMLInputElement {
  const input = el('input');
  Object.assign(input, { type: 'number', step: String(step), value: String(Math.round(value * 10000) / 10000), ariaLabel: label });
  return input;
}

function toggle(label: string, title: string, on: boolean, change: (on: boolean) => void): HTMLElement {
  const box = el('label', 'mi-check');
  box.title = title;
  const input = el('input');
  Object.assign(input, { type: 'checkbox', checked: on });
  input.addEventListener('change', () => change(input.checked));
  box.append(input, el('span', undefined, label));
  return box;
}

function swatch(kind: string, label: string): HTMLElement {
  const item = el('span', 'mi-key');
  item.append(el('i', kind), document.createTextNode(label));
  return item;
}
