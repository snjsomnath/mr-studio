import { FlowField, lut, Tracers } from '@mrstudio/sdk';
import type { Colormap, FieldFrame, FlowOverlay, FlowOverlayStyle, SiteInfo } from '@mrstudio/sdk';
import type { CustomLayerInterface, CustomRenderMethodInput, Map as MapLibreMap } from 'maplibre-gl';

import { link, matrixAt, mercatorExtent } from './field-overlay.ts';

// Positions arrive in field cells and are placed on the extent's parallelogram.
const VERTEX = `#version 300 es
uniform mat4 u_matrix;
uniform vec2 u_size;      // field size in cells
uniform vec2 u_origin;    // top left corner, relative to the extent's centre
uniform vec2 u_right;     // top left to top right
uniform vec2 u_down;      // top left to bottom left
in vec2 a_position;
in vec4 a_color;
out vec4 v_color;
void main() {
  v_color = a_color;
  vec2 uv = a_position / u_size;
  gl_Position = u_matrix * vec4(u_origin + uv.x * u_right + uv.y * u_down, 0.0, 1.0);
}`;

const FRAGMENT = `#version 300 es
precision mediump float;
in vec4 v_color;
out vec4 color;
void main() {
  color = vec4(v_color.rgb * v_color.a, v_color.a);   // premultiplied, as MapLibre blends
}`;

/** Bytes per vertex: two float32 for the position, four uint8 for the colour. */
const STRIDE = 12;
/** Seconds the drawn field keeps easing towards a new frame. */
const SETTLE_SECONDS = 1.5;

const MODES = {
  // Trail length in seconds, half-width as a share of the field's longer side, and whether the tail tapers.
  ribbons: { trail: 0.8, width: 0.0016, taper: true },
  particles: { trail: 0.12, width: 0.0022, taper: false },
} as const;

/**
 * Draws a vector field as tracers with trails. Tracers are advected on the CPU
 * (a few hundred points) and drawn as one batch of triangles, so the cost does
 * not depend on the size of the table or of the field.
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
  private settle = 0;
  private last = 0;
  private vertices = new ArrayBuffer(0);
  private floats = new Float32Array(0);
  private bytes = new Uint8Array(0);
  private indices = new Uint32Array(0);
  private readonly velocity: [number, number] = [0, 0];

  constructor(map: MapLibreMap, id: string, site: SiteInfo, style: FlowOverlayStyle & { colormap: Colormap }) {
    this.map = map;
    this.id = id;
    this.style = { mode: 'ribbons', count: 500, rate: 0.04, opacity: 1, max: undefined, ...style };
    this.table = lut(this.style.colormap);
    const extent = mercatorExtent(site);
    this.centre = extent.centre;
    this.corners = extent.corners;
  }

  set(u: FieldFrame, v: FieldFrame): void {
    this.target = FlowField.fromFrames(u, v);
    this.frameMax = Math.max(Math.abs(u.max), Math.abs(v.max)) || 1;
    const field = this.field;
    if (!field || field.width !== u.width || field.height !== u.height) {
      this.field = FlowField.fromFrames(u, v);
      this.tracers = null;
    }
    this.settle = SETTLE_SECONDS;
    this.map.triggerRepaint();
  }

  setStyle(style: FlowOverlayStyle): void {
    const previous = this.style;
    this.style = { ...previous, ...style };
    if (style.colormap) this.table = lut(style.colormap);
    if (this.style.count !== previous.count) this.tracers = null;
    if (this.tracers) this.tracers.trailSeconds = MODES[this.style.mode].trail;
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
    const color = gl.getAttribLocation(program, 'a_color');
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, STRIDE, 0);
    gl.enableVertexAttribArray(color);
    gl.vertexAttribPointer(color, 4, gl.UNSIGNED_BYTE, true, STRIDE, 8);
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

    if (this.settle > 0) {
      field.blendTowards(this.target, dt);
      this.settle -= dt;
    }
    const mode = MODES[this.style.mode];
    if (!this.tracers) this.tracers = new Tracers(field, { count: Math.max(0, Math.round(this.style.count)), trailSeconds: mode.trail });
    const longer = Math.max(field.width, field.height);
    this.tracers.update(dt, this.style.rate * longer);
    const count = this.build(field, this.tracers, mode.width * longer, mode.taper);

    if (count > 0) {
      const [tl, tr, , bl] = this.corners as [[number, number], [number, number], [number, number], [number, number]];
      gl.useProgram(this.program);
      gl.uniformMatrix4fv(this.uniforms.u_matrix!, false, matrixAt(options, this.centre));
      gl.uniform2f(this.uniforms.u_size!, field.width, field.height);
      gl.uniform2f(this.uniforms.u_origin!, tl[0], tl[1]);
      gl.uniform2f(this.uniforms.u_right!, tr[0] - tl[0], tr[1] - tl[1]);
      gl.uniform2f(this.uniforms.u_down!, bl[0] - tl[0], bl[1] - tl[1]);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.bindVertexArray(this.vao);
      gl.drawElements(gl.TRIANGLES, count, gl.UNSIGNED_INT, 0);
      gl.bindVertexArray(null);
    }
    // Tracers keep moving, so keep drawing.
    this.map.triggerRepaint();
  }

  /** Writes the trails as triangles and uploads them. Returns the number of indices. */
  private build(field: FlowField, tracers: Tracers, halfWidth: number, taper: boolean): number {
    const capacity = Tracers.capacity + 1;
    const points = tracers.count * capacity;
    if (this.floats.length < points * 2 * (STRIDE / 4)) {
      this.vertices = new ArrayBuffer(points * 2 * STRIDE);
      this.floats = new Float32Array(this.vertices);
      this.bytes = new Uint8Array(this.vertices);
      this.indices = new Uint32Array(points * 6);
    }
    const { floats, bytes, indices, table, velocity } = this;
    const scale = 255 / (this.style.max ?? this.frameMax);
    const opacity = this.style.opacity;
    const { trailX, trailY, start, length } = tracers;
    let vertex = 0;
    let index = 0;
    for (let i = 0; i < tracers.count; i++) {
      const n = length[i]!;
      if (n < 1) continue;
      const base = i * Tracers.capacity;
      const first = start[i]!;
      // The trail's recorded points, then the tracer's live position as the head.
      const total = n + 1;
      let px = 0;
      let py = 0;
      for (let j = 0; j < total; j++) {
        const slot = base + ((first + j) % Tracers.capacity);
        const x = j < n ? trailX[slot]! : tracers.x[i]!;
        const y = j < n ? trailY[slot]! : tracers.y[i]!;
        // Direction from the previous point to the next one, for the ribbon's sideways offset.
        const nextSlot = base + ((first + j + 1) % Tracers.capacity);
        const nx = j + 1 < n ? trailX[nextSlot]! : tracers.x[i]!;
        const ny = j + 1 < n ? trailY[nextSlot]! : tracers.y[i]!;
        let dx = nx - (j > 0 ? px : x);
        let dy = ny - (j > 0 ? py : y);
        const len = Math.hypot(dx, dy) || 1;
        dx /= len;
        dy /= len;
        const along = j / (total - 1);
        const w = halfWidth * (taper ? 0.15 + 0.85 * along : 1);
        field.sample(x, y, velocity);
        const k = Math.min(255, Math.round(Math.hypot(velocity[0], velocity[1]) * scale)) * 4;
        const alpha = Math.round(table[k + 3]! * opacity * along);
        for (const side of [-1, 1]) {
          floats[vertex * 3] = x - dy * w * side;
          floats[vertex * 3 + 1] = y + dx * w * side;
          const c = vertex * STRIDE + 8;
          bytes[c] = table[k]!;
          bytes[c + 1] = table[k + 1]!;
          bytes[c + 2] = table[k + 2]!;
          bytes[c + 3] = alpha;
          vertex++;
        }
        if (j > 0) {
          const v = vertex - 4;
          indices[index++] = v;
          indices[index++] = v + 1;
          indices[index++] = v + 2;
          indices[index++] = v + 1;
          indices[index++] = v + 3;
          indices[index++] = v + 2;
        }
        px = x;
        py = y;
      }
    }
    if (index === 0) return 0;
    const gl = this.gl!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Uint8Array(this.vertices, 0, vertex * STRIDE), gl.DYNAMIC_DRAW);
    gl.bindVertexArray(this.vao);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices.subarray(0, index), gl.DYNAMIC_DRAW);
    gl.bindVertexArray(null);
    return index;
  }
}
