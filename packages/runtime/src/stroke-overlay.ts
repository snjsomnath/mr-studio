import type { SiteInfo, Stroke, StrokeOverlay } from '@mrstudio/sdk';
import type { CustomLayerInterface, CustomRenderMethodInput, Map as MapLibreMap } from 'maplibre-gl';

import { link, matrixAt, mercatorExtent } from './field-overlay.ts';

// Lines that change every frame (trails behind vehicles), drawn by the graphics card (#609): each
// line is one triangle strip with its width and alpha per point, so a tapering trail is one strip
// with no overlaps, and nothing is drawn on the processor. Positions are table metres.

const VERTEX = `#version 300 es
uniform mat4 u_matrix;
uniform vec2 u_size;
uniform vec2 u_origin;
uniform vec2 u_right;
uniform vec2 u_down;
in vec2 a_position;
in float a_side;          // -1 or 1 across the line
in vec4 a_color;          // straight colour and alpha
out vec4 v_color;
out float v_side;
out vec2 v_table;
void main() {
  v_color = a_color;
  v_side = a_side;
  vec2 uv = a_position / u_size;
  v_table = uv;
  gl_Position = u_matrix * vec4(u_origin + uv.x * u_right + uv.y * u_down, 0.0, 1.0);
}`;

const FRAGMENT = `#version 300 es
precision mediump float;
uniform float u_opacity;
in vec4 v_color;
in float v_side;
in vec2 v_table;
out vec4 color;
void main() {
  if (any(lessThan(v_table, vec2(0.0))) || any(greaterThan(v_table, vec2(1.0)))) discard;
  // A soft last fifth on each side keeps thin lines smooth without multisampling.
  float a = v_color.a * u_opacity * clamp((1.0 - abs(v_side)) * 5.0, 0.0, 1.0);
  color = vec4(v_color.rgb * a, a);
}`;

/** Floats per vertex: position (2), side (1), colour (4). */
const FLOATS = 7;

/** A CSS hex or rgb() colour as 0..1 channels; anything else is white. */
const parsed = new Map<string, [number, number, number]>();
function rgb(colour: string): [number, number, number] {
  let found = parsed.get(colour);
  if (found) return found;
  found = [1, 1, 1];
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(colour.trim());
  if (hex) {
    const h = hex[1]!.length === 3 ? [...hex[1]!].map((c) => c + c).join('') : hex[1]!;
    found = [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255];
  } else {
    const m = /rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(colour);
    if (m) found = [Number(m[1]) / 255, Number(m[2]) / 255, Number(m[3]) / 255];
  }
  if (parsed.size > 256) parsed.clear();
  parsed.set(colour, found);
  return found;
}

export class MapStrokeOverlay implements StrokeOverlay, CustomLayerInterface {
  readonly id: string;
  readonly type = 'custom' as const;
  readonly renderingMode = '2d' as const;

  private map: MapLibreMap;
  private gl: WebGL2RenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private vertices: WebGLBuffer | null = null;
  private indices: WebGLBuffer | null = null;
  private uniforms: Record<string, WebGLUniformLocation | null> = {};
  private centre: [number, number];
  private corners: [number, number][];
  private size: [number, number];
  private data = new Float32Array(0);
  private index = new Uint32Array(0);
  private vertexCount = 0;
  private indexCount = 0;
  private dirty = false;
  private opacity: number;
  private gain = 1;

  constructor(map: MapLibreMap, id: string, site: SiteInfo, style: { opacity?: number } = {}) {
    this.map = map;
    this.id = id;
    this.opacity = style.opacity ?? 1;
    this.size = [site.extent.width_m, site.extent.height_m];
    const extent = mercatorExtent(site);
    this.centre = extent.centre;
    this.corners = extent.corners;
  }

  set(strokes: Stroke[]): void {
    let vertices = 0;
    let indices = 0;
    for (const stroke of strokes) {
      const n = stroke.points.length;
      if (n < 2) continue;
      vertices += n * 2;
      indices += (n - 1) * 6;
    }
    if (this.data.length < vertices * FLOATS) this.data = new Float32Array(vertices * FLOATS * 2);
    if (this.index.length < indices) this.index = new Uint32Array(indices * 2);
    const data = this.data;
    const index = this.index;
    let v = 0;
    let i = 0;
    for (const { points, colour, width, alpha } of strokes) {
      const n = points.length;
      if (n < 2) continue;
      const [r, g, b] = rgb(colour);
      for (let j = 0; j < n; j++) {
        const [x, y] = points[j]!;
        const [ax, ay] = points[j > 0 ? j - 1 : j]!;
        const [bx, by] = points[j < n - 1 ? j + 1 : j]!;
        let tx = bx - ax;
        let ty = by - ay;
        const length = Math.hypot(tx, ty) || 1;
        tx /= length;
        ty /= length;
        const half = (typeof width === 'number' ? width : (width[j] ?? 1)) / 2;
        const a = typeof alpha === 'number' ? alpha : (alpha[j] ?? 1);
        for (const side of [-1, 1]) {
          const f = v * FLOATS;
          data[f] = x - ty * half * side;
          data[f + 1] = y + tx * half * side;
          data[f + 2] = side;
          data[f + 3] = r;
          data[f + 4] = g;
          data[f + 5] = b;
          data[f + 6] = Math.max(0, Math.min(1, a));
          v++;
        }
        if (j > 0) {
          const q = v - 4;
          index[i++] = q;
          index[i++] = q + 1;
          index[i++] = q + 2;
          index[i++] = q + 1;
          index[i++] = q + 3;
          index[i++] = q + 2;
        }
      }
    }
    this.vertexCount = v;
    this.indexCount = i;
    this.dirty = true;
    this.map.triggerRepaint();
  }

  /** Whether a line passes within `radius` of the point (table metres), for a click on the map (#425). */
  hit(x: number, y: number, radius: number): boolean {
    if (this.opacity * this.gain <= 0) return false;
    const d = this.data;
    const index = this.index;
    // Each quad's first triangle is q, q+1, q+2: the two sides of one point and one side of the next.
    for (let i = 0; i < this.indexCount; i += 6) {
      const q = index[i]! * FLOATS;
      const r = index[i + 3]! * FLOATS; // q + 1
      const t = index[i + 2]! * FLOATS; // q + 2
      const u = index[i + 4]! * FLOATS; // q + 3
      if (Math.min(d[q + 6]!, d[t + 6]!) < 0.1) continue;
      const ax = (d[q]! + d[r]!) / 2;
      const ay = (d[q + 1]! + d[r + 1]!) / 2;
      const bx = (d[t]! + d[u]!) / 2;
      const by = (d[t + 1]! + d[u + 1]!) / 2;
      const half = Math.max(Math.hypot(d[q]! - d[r]!, d[q + 1]! - d[r + 1]!), Math.hypot(d[t]! - d[u]!, d[t + 1]! - d[u + 1]!)) / 2;
      const vx = bx - ax;
      const vy = by - ay;
      const f = Math.max(0, Math.min(1, ((x - ax) * vx + (y - ay) * vy) / (vx * vx + vy * vy || 1)));
      if (Math.hypot(x - ax - vx * f, y - ay - vy * f) <= half + radius) return true;
    }
    return false;
  }

  setOpacity(opacity: number): void {
    this.opacity = opacity;
    this.map.triggerRepaint();
  }

  /** The layer's intensity, set by the runtime from host state. Not part of the layer API. */
  setGain(gain: number): void {
    this.gain = Math.min(1, Math.max(0, gain));
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
    for (const name of ['u_matrix', 'u_size', 'u_origin', 'u_right', 'u_down', 'u_opacity']) this.uniforms[name] = gl.getUniformLocation(program, name);
    this.vao = gl.createVertexArray();
    this.vertices = gl.createBuffer();
    this.indices = gl.createBuffer();
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertices);
    const stride = FLOATS * 4;
    for (const [name, size, offset] of [
      ['a_position', 2, 0],
      ['a_side', 1, 2],
      ['a_color', 4, 3],
    ] as const) {
      const at = gl.getAttribLocation(program, name);
      gl.enableVertexAttribArray(at);
      gl.vertexAttribPointer(at, size, gl.FLOAT, false, stride, offset * 4);
    }
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indices);
    gl.bindVertexArray(null);
    this.dirty = true;
  }

  onRemove(): void {
    const gl = this.gl;
    if (!gl) return;
    gl.deleteProgram(this.program);
    gl.deleteVertexArray(this.vao);
    gl.deleteBuffer(this.vertices);
    gl.deleteBuffer(this.indices);
    this.gl = null;
  }

  render(_context: WebGLRenderingContext | WebGL2RenderingContext, options: CustomRenderMethodInput): void {
    const gl = this.gl;
    const opacity = this.opacity * this.gain;
    if (!gl || !this.program || this.indexCount === 0 || opacity <= 0) return;
    const [tl, tr, , bl] = this.corners as [[number, number], [number, number], [number, number], [number, number]];
    gl.useProgram(this.program);
    gl.uniformMatrix4fv(this.uniforms.u_matrix!, false, matrixAt(options, this.centre));
    gl.uniform2f(this.uniforms.u_size!, this.size[0], this.size[1]);
    gl.uniform2f(this.uniforms.u_origin!, tl[0], tl[1]);
    gl.uniform2f(this.uniforms.u_right!, tr[0] - tl[0], tr[1] - tl[1]);
    gl.uniform2f(this.uniforms.u_down!, bl[0] - tl[0], bl[1] - tl[1]);
    gl.uniform1f(this.uniforms.u_opacity!, Math.min(1, opacity));
    gl.bindVertexArray(this.vao);
    if (this.dirty) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.vertices);
      gl.bufferData(gl.ARRAY_BUFFER, this.data.subarray(0, this.vertexCount * FLOATS), gl.DYNAMIC_DRAW);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, this.index.subarray(0, this.indexCount), gl.DYNAMIC_DRAW);
      this.dirty = false;
    }
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_INT, 0);
    gl.bindVertexArray(null);
  }
}
