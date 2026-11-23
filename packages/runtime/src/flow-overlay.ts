import { clearSegment, FacadeGlow, facadeEdges, FlowField, lut, ribbonLight, smoothstep01 as smooth, Streamlines, Tracers } from '@mrstudio/sdk';
import type { Colormap, FieldFrame, FlowOverlay, FlowOverlayStyle, SiteInfo } from '@mrstudio/sdk';
import type { CustomLayerInterface, CustomRenderMethodInput, Map as MapLibreMap } from 'maplibre-gl';

import { link, matrixAt, mercatorExtent } from './field-overlay.ts';

// Ribbons and particles as ported from the Chalmers demo (interactive_map
// animations/cfd-visuals.js): steady streamlines with a light travelling along
// them, and fine specks with short soft tails. Widths are in screen pixels as in
// the demo, and every line is a triangle strip with a one-pixel feather on each
// side so thin lines stay smooth without multisampling.

// Positions arrive in field cells and are placed on the extent's parallelogram.
const VERTEX = `#version 300 es
uniform mat4 u_matrix;
uniform vec2 u_size;      // field size in cells
uniform vec2 u_origin;    // top left corner, relative to the extent's centre
uniform vec2 u_right;     // top left to top right
uniform vec2 u_down;      // top left to bottom left
in vec2 a_position;
in vec3 a_edge;           // signed distance from the centre line, half width and soft edge, in pixels
in vec4 a_color;
out vec4 v_color;
out vec3 v_edge;
void main() {
  v_color = a_color;
  v_edge = a_edge;
  vec2 uv = a_position / u_size;
  gl_Position = u_matrix * vec4(u_origin + uv.x * u_right + uv.y * u_down, 0.0, 1.0);
}`;

const FRAGMENT = `#version 300 es
precision mediump float;
in vec4 v_color;
in vec3 v_edge;
out vec4 color;
void main() {
  // A crisp line has a one-pixel antialiased edge; a soft one fades out over its soft width.
  float d = abs(v_edge.x);
  float cover = v_edge.z > 0.0 ? clamp((v_edge.y + v_edge.z - d) / v_edge.z, 0.0, 1.0) : clamp(v_edge.y + 0.5 - d, 0.0, 1.0);
  float a = v_color.a * cover;
  color = vec4(v_color.rgb * a, a);   // premultiplied, as MapLibre blends
}`;

/** Bytes per vertex: two float32 for the position, three for the edge, four uint8 for the colour. */
const STRIDE = 24;
/** Seconds the drawn field keeps easing towards a new frame. */
const SETTLE_SECONDS = 1.5;
/** Pixels of soft edge outside each line. */
const FEATHER = 1;

/** The demo's strokes: full widths in pixels and opacities. */
const LOOK = {
  ribbon: { width: 1.1, opacity: 0.48 },
  ribbonLight: { width: 0.8, grow: 1.25, opacity: 0.88 },
  particle: { width: 0.85, opacity: 0.9 },
  particleTip: { width: 0.75, grow: 0.8, length: 2 },
  /** The facade glow's three nested strokes: full width in pixels, opacity, colour. */
  facade: [
    [16, 0.28, [255, 159, 67]],
    [7, 0.6, [255, 194, 105]],
    [2, 1, [255, 245, 219]],
  ] as [number, number, [number, number, number]][],
  /** The two halo strokes fade out over most of their width instead of ending in a hard edge. */
  facadeSoft: [5, 2, 0],
  /** Seconds of path a particle's tail can show. */
  tailSeconds: 0.24,
} as const;
/** Speeds below this draw nothing: still air has no direction worth showing. */
const STILL = 0.08;
const GOLDEN = 0.61803398875;

/** Collects triangle strips into one vertex and index buffer. */
class Strips {
  floats = new Float32Array(0);
  bytes = new Uint8Array(0);
  indices = new Uint32Array(0);
  vertex = 0;
  index = 0;
  private px: number[] = [];
  private py: number[] = [];
  private pc: number[] = [];
  private pw: number[] = [];
  private ps: number[] = [];

  reset(): void {
    this.vertex = 0;
    this.index = 0;
  }

  /** Adds a point to the current line: position in cells, colour as 0xRRGGBBAA, half width in pixels. */
  point(x: number, y: number, rgba: number, half: number, soft = 0): void {
    this.px.push(x);
    this.py.push(y);
    this.pc.push(rgba);
    this.pw.push(half);
    this.ps.push(soft);
  }

  /** Makes the current line's two end points transparent, so it fades in and out, when it is long enough to. */
  fadeEnds(minimum: number): void {
    const n = this.pc.length;
    if (n < minimum) return;
    const clear = LITTLE ? 0x00ffffff : 0xffffff00;
    this.pc[0] = (this.pc[0]! & clear) >>> 0;
    this.pc[n - 1] = (this.pc[n - 1]! & clear) >>> 0;
  }

  /** Ends the current line and writes it as a strip. `cellsPerPixel` turns widths into cells. */
  end(cellsPerPixel: number): void {
    const { px, py, pc, pw, ps } = this;
    const n = px.length;
    if (n >= 2) {
      this.reserve(n * 2, (n - 1) * 6);
      const { floats, indices } = this;
      const words = new Uint32Array(floats.buffer);
      for (let j = 0; j < n; j++) {
        const a = j > 0 ? j - 1 : j;
        const b = j < n - 1 ? j + 1 : j;
        let tx = px[b]! - px[a]!;
        let ty = py[b]! - py[a]!;
        const len = Math.hypot(tx, ty) || 1;
        tx /= len;
        ty /= len;
        const outer = pw[j]! + (ps[j]! > 0 ? ps[j]! : FEATHER);
        const reach = outer * cellsPerPixel;
        for (const side of [-1, 1]) {
          const f = this.vertex * (STRIDE / 4);
          floats[f] = px[j]! - ty * reach * side;
          floats[f + 1] = py[j]! + tx * reach * side;
          floats[f + 2] = outer * side;
          floats[f + 3] = pw[j]!;
          floats[f + 4] = ps[j]!;
          words[f + 5] = pc[j]!;
          this.vertex++;
        }
        if (j > 0) {
          const v = this.vertex - 4;
          indices[this.index++] = v;
          indices[this.index++] = v + 1;
          indices[this.index++] = v + 2;
          indices[this.index++] = v + 1;
          indices[this.index++] = v + 3;
          indices[this.index++] = v + 2;
        }
      }
    }
    px.length = 0;
    py.length = 0;
    pc.length = 0;
    pw.length = 0;
    ps.length = 0;
  }

  private reserve(vertices: number, indices: number): void {
    if ((this.vertex + vertices) * (STRIDE / 4) > this.floats.length) {
      const grown = new Float32Array(Math.max(this.floats.length * 2, (this.vertex + vertices) * (STRIDE / 4) * 2));
      grown.set(this.floats);
      this.floats = grown;
      this.bytes = new Uint8Array(grown.buffer);
    }
    if (this.index + indices > this.indices.length) {
      const grown = new Uint32Array(Math.max(this.indices.length * 2, (this.index + indices) * 2));
      grown.set(this.indices);
      this.indices = grown;
    }
  }
}

/** Packs a colour so its bytes land in memory as r, g, b, a. */
const LITTLE = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
function rgba(r: number, g: number, b: number, a: number): number {
  const alpha = Math.max(0, Math.min(255, Math.round(a * 255)));
  return LITTLE ? ((alpha << 24) | (b << 16) | (g << 8) | r) >>> 0 : ((r << 24) | (g << 16) | (b << 8) | alpha) >>> 0;
}


/**
 * Draws a vector field as ribbons (steady streamlines with a travelling light) or
 * particles (fine specks with short tails). Both are traced on the CPU from a few
 * hundred seeds and drawn as one batch of triangles, so the cost does not depend
 * on the size of the table or of the field.
 */
export class MapFlowOverlay implements FlowOverlay, CustomLayerInterface {
  readonly id: string;
  readonly type = 'custom' as const;
  readonly renderingMode = '2d' as const;

  private map: MapLibreMap;
  private gl: WebGL2RenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private vertexBuffer: WebGLBuffer | null = null;
  private indexBuffer: WebGLBuffer | null = null;
  private uniforms: Record<string, WebGLUniformLocation | null> = {};
  private centre: [number, number];
  private corners: [number, number][];

  private style: Required<Omit<FlowOverlayStyle, 'max'>> & { max: number | undefined };
  private table: Uint8Array;
  private frameMax = 1;
  /** The latest frames, and the field being drawn, which eases towards them. */
  private target: FlowField | null = null;
  private field: FlowField | null = null;
  private tracers: Tracers | null = null;
  private lines: Streamlines | null = null;
  /** Building outlines in table metres, and the glow built from them once the field's size is known. */
  private facades: [number, number][][][] = [];
  private glow: FacadeGlow | null = null;
  private tableSize: [number, number];
  private settle = 0;
  private last = 0;
  /** Animation time in seconds, for the light travelling along the ribbons. */
  private time = 0;
  private readonly strips = new Strips();
  private readonly velocity: [number, number] = [0, 0];

  constructor(map: MapLibreMap, id: string, site: SiteInfo, style: FlowOverlayStyle & { colormap: Colormap }) {
    this.map = map;
    this.id = id;
    this.style = { mode: 'ribbons', count: 500, rate: 0.04, opacity: 1, max: undefined, facadeGlow: false, ...style };
    this.tableSize = [site.extent.width_m, site.extent.height_m];
    this.table = lut(this.style.colormap);
    const extent = mercatorExtent(site);
    this.centre = extent.centre;
    this.corners = extent.corners;
  }

  private gain = 1;

  /** The style's opacity times the layer's intensity (which only fades it). */
  private get alpha(): number {
    return (this.style.opacity ?? 1) * this.gain;
  }

  /** The layer's intensity, set by the runtime from host state. Not part of the layer API. */
  setGain(gain: number): void {
    this.gain = Math.min(1, Math.max(0, gain));
    this.map.triggerRepaint();
  }

  set(u: FieldFrame, v: FieldFrame): void {
    this.target = FlowField.fromFrames(u, v);
    this.frameMax = Math.max(Math.abs(u.max), Math.abs(v.max)) || 1;
    const field = this.field;
    if (!field || field.width !== u.width || field.height !== u.height) {
      this.field = FlowField.fromFrames(u, v);
      this.tracers = null;
      this.lines = null;
      this.glow = null;
    }
    this.settle = SETTLE_SECONDS;
    this.map.triggerRepaint();
  }

  setStyle(style: FlowOverlayStyle): void {
    const previous = this.style;
    this.style = { ...previous, ...style };
    if (style.colormap) this.table = lut(style.colormap);
    if (this.style.count !== previous.count) {
      this.tracers = null;
      this.lines = null;
    }
    this.map.triggerRepaint();
  }

  setFacades(polygons: [number, number][][][]): void {
    this.facades = polygons;
    this.glow = null;
    this.map.triggerRepaint();
  }

  remove(): void {
    if (this.map.getLayer(this.id)) this.map.removeLayer(this.id);
  }

  onAdd(_map: MapLibreMap, context: WebGLRenderingContext | WebGL2RenderingContext): void {
    const gl = context as WebGL2RenderingContext;
    this.gl = gl;
    const program = link(gl, VERTEX, FRAGMENT);
    this.program = program;
    for (const name of ['u_matrix', 'u_size', 'u_origin', 'u_right', 'u_down']) this.uniforms[name] = gl.getUniformLocation(program, name);
    this.vao = gl.createVertexArray();
    this.vertexBuffer = gl.createBuffer();
    this.indexBuffer = gl.createBuffer();
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
    const position = gl.getAttribLocation(program, 'a_position');
    const edge = gl.getAttribLocation(program, 'a_edge');
    const color = gl.getAttribLocation(program, 'a_color');
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, STRIDE, 0);
    gl.enableVertexAttribArray(edge);
    gl.vertexAttribPointer(edge, 3, gl.FLOAT, false, STRIDE, 8);
    gl.enableVertexAttribArray(color);
    gl.vertexAttribPointer(color, 4, gl.UNSIGNED_BYTE, true, STRIDE, 20);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
    gl.bindVertexArray(null);
    this.last = 0;
  }

  onRemove(): void {
    const gl = this.gl;
    if (!gl) return;
    gl.deleteProgram(this.program);
    gl.deleteVertexArray(this.vao);
    gl.deleteBuffer(this.vertexBuffer);
    gl.deleteBuffer(this.indexBuffer);
    this.gl = null;
  }

  render(_context: WebGLRenderingContext | WebGL2RenderingContext, options: CustomRenderMethodInput): void {
    const gl = this.gl;
    const field = this.field;
    if (!gl || !this.program || !field || !this.target) return;
    const now = performance.now();
    const dt = this.last ? Math.min(0.1, (now - this.last) / 1000) : 0;
    this.last = now;
    this.time += dt;

    if (this.settle > 0) {
      field.blendTowards(this.target, dt);
      this.settle -= dt;
      this.glow?.place();
    }
    const matrix = matrixAt(options, this.centre);
    const cellsPerPixel = 1 / Math.max(1e-6, this.pixelsPerCell(matrix, field));
    // Cells per second per field unit: the same pace as the demo's particles.
    const rate = this.style.rate * Math.max(field.width, field.height);
    const strips = this.strips;
    strips.reset();
    if (this.style.facadeGlow && this.facades.length > 0) {
      if (!this.glow) {
        // Table metres to field cells; the field covers the table, rows down as in table metres.
        const [w, h] = this.tableSize;
        const sx = field.width / w;
        const sy = field.height / h;
        const cells = this.facades.map((rings) => rings.map((ring) => ring.map(([x, y]) => [x * sx, y * sy] as [number, number])));
        this.glow = new FacadeGlow(field, facadeEdges(cells, field.width, field.height));
      }
      this.glow.update(dt);
      this.facadeGlow(this.glow, cellsPerPixel);
    }
    if (this.style.mode === 'particles') {
      if (!this.tracers) this.tracers = new Tracers(field, { count: Math.max(0, Math.round(this.style.count)), trailSeconds: LOOK.tailSeconds + 0.06 });
      this.tracers.update(dt, rate);
      this.particles(field, this.tracers, cellsPerPixel);
    } else {
      // The demo spends an eighth of the particle budget on ribbons.
      if (!this.lines) this.lines = new Streamlines(field, Math.max(1, Math.round(this.style.count / 8)));
      this.lines.update(dt, rate);
      this.ribbons(field, this.lines, cellsPerPixel);
    }

    if (strips.index > 0) {
      const [tl, tr, , bl] = this.corners as [[number, number], [number, number], [number, number], [number, number]];
      gl.useProgram(this.program);
      gl.uniformMatrix4fv(this.uniforms.u_matrix!, false, matrix);
      gl.uniform2f(this.uniforms.u_size!, field.width, field.height);
      gl.uniform2f(this.uniforms.u_origin!, tl[0], tl[1]);
      gl.uniform2f(this.uniforms.u_right!, tr[0] - tl[0], tr[1] - tl[1]);
      gl.uniform2f(this.uniforms.u_down!, bl[0] - tl[0], bl[1] - tl[1]);
      gl.bindVertexArray(this.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, strips.bytes.subarray(0, strips.vertex * STRIDE), gl.DYNAMIC_DRAW);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, strips.indices.subarray(0, strips.index), gl.DYNAMIC_DRAW);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.drawElements(gl.TRIANGLES, strips.index, gl.UNSIGNED_INT, 0);
      gl.bindVertexArray(null);
    }
    // Ribbons and particles keep moving, so keep drawing.
    this.map.triggerRepaint();
  }

  /** Screen pixels per field cell, from where the extent's corners land on the canvas. */
  private pixelsPerCell(matrix: Float32Array, field: FlowField): number {
    const canvas = this.map.getCanvas();
    const w = canvas.clientWidth || canvas.width;
    const h = canvas.clientHeight || canvas.height;
    const project = ([x, y]: [number, number]): [number, number] => {
      const cw = matrix[3]! * x + matrix[7]! * y + matrix[15]!;
      return [((matrix[0]! * x + matrix[4]! * y + matrix[12]!) / cw) * (w / 2), ((matrix[1]! * x + matrix[5]! * y + matrix[13]!) / cw) * (h / 2)];
    };
    const [tl, tr, , bl] = this.corners as [[number, number], [number, number], [number, number], [number, number]];
    const a = project(tl);
    const b = project(tr);
    const c = project(bl);
    return (Math.hypot(b[0] - a[0], b[1] - a[1]) / field.width + Math.hypot(c[0] - a[0], c[1] - a[1]) / field.height) / 2;
  }

  /** The field's speed at a point. */
  private speedAt(field: FlowField, x: number, y: number): number {
    field.sample(x, y, this.velocity);
    return Math.hypot(this.velocity[0], this.velocity[1]);
  }

  /** The colormap's colour for a speed, at the given opacity. */
  private colour(speed: number, alpha: number): number {
    const k = Math.min(255, Math.max(0, Math.round((speed / (this.style.max ?? this.frameMax)) * 255))) * 4;
    const t = this.table;
    return rgba(t[k]!, t[k + 1]!, t[k + 2]!, alpha * (t[k + 3]! / 255) * this.alpha);
  }

  /** Building faces in the wind glow warm, as three nested strokes for a soft halo. */
  private facadeGlow(glow: FacadeGlow, cellsPerPixel: number): void {
    const strips = this.strips;
    const { edges, intensity } = glow;
    const opacity = this.alpha;
    LOOK.facade.forEach(([width, strength, [r, g, b]], pass) => {
      const soft = LOOK.facadeSoft[pass]!;
      const half = Math.max(0.5, width / 2 - soft);
      let open = false;
      const close = () => {
        // Runs fade in and out at their ends rather than stopping square.
        strips.fadeEnds(4);
        strips.end(cellsPerPixel);
        open = false;
      };
      for (let e = 0; e < edges.length; e++) {
        const edge = edges[e]!;
        const level = intensity[e]!;
        if (level < 0.01) {
          if (open) close();
          continue;
        }
        const joined = open && edges[e - 1]!.bx === edge.ax && edges[e - 1]!.by === edge.ay;
        if (open && !joined) close();
        // Weaker exposure is lifted so faint faces still read, without lighting faces out of the wind.
        const colour = rgba(r, g, b, strength * Math.sqrt(level) * opacity);
        if (!open) strips.point(edge.ax, edge.ay, colour, half, soft);
        strips.point(edge.bx, edge.by, colour, half, soft);
        open = true;
      }
      if (open) close();
    });
  }

  /** Streamlines coloured by speed, with a soft white light travelling along each. */
  private ribbons(field: FlowField, lines: Streamlines, cellsPerPixel: number): void {
    const strips = this.strips;
    const opacity = this.alpha;
    const lightHalf = (light: number) => (LOOK.ribbonLight.width + LOOK.ribbonLight.grow * light) / 2;
    for (const line of lines.lines) {
      const points = line.points;
      // The line itself, broken wherever a piece would cross a building.
      for (let i = 0; i < points.length; i++) {
        const p = points[i]!;
        if (i > 0 && !clearSegment(field, points[i - 1]!.x, points[i - 1]!.y, p.x, p.y)) strips.end(cellsPerPixel);
        strips.point(p.x, p.y, this.colour(this.speedAt(field, p.x, p.y), p.alpha * p.endFade * LOOK.ribbon.opacity), LOOK.ribbon.width / 2);
      }
      strips.end(cellsPerPixel);
      // The light: only the lit stretches, each faded in and out over one step.
      let lit = false;
      for (let i = 0; i < points.length; i++) {
        const p = points[i]!;
        const blocked = i > 0 && !clearSegment(field, points[i - 1]!.x, points[i - 1]!.y, p.x, p.y);
        if (blocked && lit) {
          strips.end(cellsPerPixel);
          lit = false;
        }
        const light = p.alpha * p.endFade * ribbonLight(p.travel, this.time, line.id);
        if (light > 0.015) {
          if (!lit && i > 0 && !blocked) strips.point(points[i - 1]!.x, points[i - 1]!.y, rgba(255, 255, 255, 0), lightHalf(0));
          strips.point(p.x, p.y, rgba(255, 255, 255, light * LOOK.ribbonLight.opacity * opacity), lightHalf(light));
          lit = true;
        } else if (lit) {
          strips.point(p.x, p.y, rgba(255, 255, 255, 0), lightHalf(0));
          strips.end(cellsPerPixel);
          lit = false;
        }
      }
      strips.end(cellsPerPixel);
    }
  }

  /** Fine specks with short tails that fade towards the back, and a small white tip. */
  private particles(field: FlowField, tracers: Tracers, cellsPerPixel: number): void {
    const strips = this.strips;
    const history = LOOK.tailSeconds;
    const pixelsPerCell = 1 / cellsPerPixel;
    const half = LOOK.particle.width / 2;
    const { trailX, trailY, trailT, start, length, age } = tracers;
    const now = tracers.time;
    const cap = Tracers.capacity;
    for (let i = 0; i < tracers.count; i++) {
      const n = length[i]!;
      if (n < 1) continue;
      const hx = tracers.x[i]!;
      const hy = tracers.y[i]!;
      const speed = this.speedAt(field, hx, hy);
      if (speed < STILL) continue;
      // Stable variety in brightness and tail length, never random flicker.
      const variation = (i * GOLDEN) % 1;
      const brightness = 0.75 + 0.25 * variation;
      const tail = 18 + 16 * variation;
      const edge = Math.min(hx, field.width - hx, hy, field.height - hy) * pixelsPerCell;
      const visible = brightness * smooth(age[i]! / 0.22) * smooth(edge / 10) * smooth(speed / 0.3);
      if (visible <= 0.01) continue;
      const fade = (distance: number, t: number) => visible * Math.max(0, 1 - (now - t) / history) * Math.max(0, 1 - distance / tail) ** 1.5;

      // From the head back along the recorded path, newest point first.
      let bx = hx;
      let by = hy;
      let bt = now;
      let distance = 0;
      let tipX = hx;
      let tipY = hy;
      const base = i * cap;
      const first = start[i]!;
      strips.point(hx, hy, this.colour(speed, fade(0, now) * LOOK.particle.opacity), half);
      for (let j = n - 1; j >= 0; j--) {
        if (now - bt >= history || distance >= tail) break;
        const slot = base + ((first + j) % cap);
        const ax = trailX[slot]!;
        const ay = trailY[slot]!;
        const at = trailT[slot]!;
        const piece = Math.hypot(bx - ax, by - ay) * pixelsPerCell;
        if (piece < 1e-6) continue;
        // Cut the tail exactly where it runs out of length or time, so its end never jumps.
        const fraction = Math.max(0, Math.min(1, (tail - distance) / piece, (bt - (now - history)) / Math.max(1e-9, bt - at)));
        const cx = bx + (ax - bx) * fraction;
        const cy = by + (ay - by) * fraction;
        if (!clearSegment(field, cx, cy, bx, by)) break;
        if (distance < LOOK.particleTip.length) {
          const tip = Math.min(fraction, (LOOK.particleTip.length - distance) / piece);
          tipX = bx + (ax - bx) * tip;
          tipY = by + (ay - by) * tip;
        }
        distance += piece * fraction;
        strips.point(cx, cy, this.colour(speed, fade(distance, bt + (at - bt) * fraction) * LOOK.particle.opacity), half);
        if (fraction < 1) break;
        bx = ax;
        by = ay;
        bt = at;
      }
      strips.end(cellsPerPixel);
      if (tipX !== hx || tipY !== hy) {
        const tipHalf = (LOOK.particleTip.width + LOOK.particleTip.grow * visible) / 2;
        strips.point(hx, hy, rgba(255, 255, 255, visible * this.alpha), tipHalf);
        strips.point(tipX, tipY, rgba(255, 255, 255, 0), tipHalf);
        strips.end(cellsPerPixel);
      }
    }
  }
}
