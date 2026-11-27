import { SPRITE_FLOATS } from '@mrstudio/sdk';
import type { SiteInfo, SpriteImage, SpriteOverlay, SpriteStyle } from '@mrstudio/sdk';
import type { CustomLayerInterface, CustomRenderMethodInput, Map as MapLibreMap } from 'maplibre-gl';

import { link, matrixAt, mercatorExtent } from './field-overlay.ts';

// Many small pictures stamped on the graphics card in one instanced draw (#609), as deck.gl's
// IconLayer does: the layer hands over a buffer of positions each frame, nothing is drawn on the
// processor and no picture of the whole table is uploaded. Positions are in table metres and are
// placed on the extent's parallelogram, as the flow overlay places its cells.

const VERTEX = `#version 300 es
uniform mat4 u_matrix;
uniform vec2 u_size;      // table size in metres
uniform vec2 u_origin;    // top left corner, relative to the extent's centre
uniform vec2 u_right;     // top left to top right
uniform vec2 u_down;      // top left to bottom left
uniform float u_opacity;
in vec2 a_corner;         // -0.5 to 0.5
in vec4 a_box;            // centre x, y and width, height, in metres
in vec2 a_turn;           // cos and sin of the angle
in vec4 a_uv;             // the picture's rectangle in the atlas
in float a_alpha;
out vec2 v_uv;
out float v_alpha;
out vec2 v_table;         // 0 to 1 inside the table
void main() {
  vec2 local = a_corner * a_box.zw;
  vec2 p = a_box.xy + vec2(local.x * a_turn.x - local.y * a_turn.y, local.x * a_turn.y + local.y * a_turn.x);
  vec2 uv = p / u_size;
  v_table = uv;
  gl_Position = u_matrix * vec4(u_origin + uv.x * u_right + uv.y * u_down, 0.0, 1.0);
  v_uv = mix(a_uv.xy, a_uv.zw, a_corner + 0.5);
  v_alpha = a_alpha * u_opacity;
}`;

const FRAGMENT = `#version 300 es
precision mediump float;
uniform sampler2D u_atlas;
in vec2 v_uv;
in float v_alpha;
in vec2 v_table;
out vec4 color;
void main() {
  // Nothing outside the table, as a drawing is cut at its edges.
  if (any(lessThan(v_table, vec2(0.0))) || any(greaterThan(v_table, vec2(1.0)))) discard;
  color = texture(u_atlas, v_uv) * v_alpha;   // the atlas is premultiplied, as MapLibre blends
}`;

/** Floats per sprite on the graphics card: box (4), turn (2), uv (4), alpha (1). */
const GPU_FLOATS = 11;
/** Transparent pixels around each picture in the atlas, so smaller mip levels do not bleed. */
const PAD = 4;
const ATLAS_WIDTH = 2048;

interface Packed {
  canvas: HTMLCanvasElement;
  /** Per picture: u0, v0, u1, v1. */
  uv: Float32Array;
}

/** Packs pictures into rows of one atlas. */
export function packAtlas(images: SpriteImage[]): Packed {
  const width = Math.min(ATLAS_WIDTH, Math.max(64, ...images.map((image) => image.width + PAD * 2)));
  const places: [number, number][] = [];
  let x = 0;
  let y = 0;
  let row = 0;
  for (const image of images) {
    const w = image.width + PAD * 2;
    const h = image.height + PAD * 2;
    if (x + w > width) {
      x = 0;
      y += row;
      row = 0;
    }
    places.push([x + PAD, y + PAD]);
    x += w;
    row = Math.max(row, h);
  }
  const height = Math.max(1, y + row);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const g = canvas.getContext('2d')!;
  const uv = new Float32Array(images.length * 4);
  images.forEach((image, i) => {
    const [px, py] = places[i]!;
    g.drawImage(image, px, py);
    uv.set([px / width, py / height, (px + image.width) / width, (py + image.height) / height], i * 4);
  });
  return { canvas, uv };
}

export class MapSpriteOverlay implements SpriteOverlay, CustomLayerInterface {
  readonly id: string;
  readonly type = 'custom' as const;
  readonly renderingMode = '2d' as const;

  private map: MapLibreMap;
  private gl: WebGL2RenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private corner: WebGLBuffer | null = null;
  private instances: WebGLBuffer | null = null;
  private texture: WebGLTexture | null = null;
  private uniforms: Record<string, WebGLUniformLocation | null> = {};
  private centre: [number, number];
  private corners: [number, number][];
  private size: [number, number];
  private atlas: Packed;
  private atlasDirty = true;
  private data = new Float32Array(0);
  private count = 0;
  private dataDirty = false;
  private opacity: number;
  private add: boolean;
  private gain = 1;

  constructor(map: MapLibreMap, id: string, site: SiteInfo, images: SpriteImage[], style: SpriteStyle = {}) {
    this.map = map;
    this.id = id;
    this.opacity = style.opacity ?? 1;
    this.add = style.blend === 'add';
    this.size = [site.extent.width_m, site.extent.height_m];
    const extent = mercatorExtent(site);
    this.centre = extent.centre;
    this.corners = extent.corners;
    this.atlas = packAtlas(images);
  }

  set(sprites: Float32Array, count = Math.floor(sprites.length / SPRITE_FLOATS)): void {
    const n = Math.min(count, Math.floor(sprites.length / SPRITE_FLOATS));
    if (this.data.length < n * GPU_FLOATS) this.data = new Float32Array(Math.max(n * GPU_FLOATS, this.data.length * 2));
    const out = this.data;
    const uv = this.atlas.uv;
    const pictures = uv.length / 4;
    let k = 0;
    for (let i = 0; i < n; i++) {
      const s = i * SPRITE_FLOATS;
      const alpha = sprites[s + 6]!;
      const image = sprites[s + 5]! | 0;
      if (!(alpha > 0) || image < 0 || image >= pictures) continue;
      const angle = sprites[s + 4]!;
      out[k] = sprites[s]!;
      out[k + 1] = sprites[s + 1]!;
      out[k + 2] = sprites[s + 2]!;
      out[k + 3] = sprites[s + 3]!;
      out[k + 4] = angle ? Math.cos(angle) : 1;
      out[k + 5] = angle ? Math.sin(angle) : 0;
      out[k + 6] = uv[image * 4]!;
      out[k + 7] = uv[image * 4 + 1]!;
      out[k + 8] = uv[image * 4 + 2]!;
      out[k + 9] = uv[image * 4 + 3]!;
      out[k + 10] = Math.min(1, alpha);
      k += GPU_FLOATS;
    }
    this.count = k / GPU_FLOATS;
    this.dataDirty = true;
    this.map.triggerRepaint();
  }

  /** Whether a sprite covers the point (table metres) within `radius`, for a click on the map (#425). The outer part of its box, mostly soft edge, does not count. */
  hit(x: number, y: number, radius: number): boolean {
    if (this.opacity * this.gain <= 0) return false;
    const d = this.data;
    for (let k = 0; k < this.count * GPU_FLOATS; k += GPU_FLOATS) {
      if (d[k + 10]! < 0.1) continue;
      const dx = x - d[k]!;
      const dy = y - d[k + 1]!;
      const cos = d[k + 4]!;
      const sin = d[k + 5]!;
      if (Math.abs(dx * cos + dy * sin) <= d[k + 2]! * 0.45 + radius && Math.abs(-dx * sin + dy * cos) <= d[k + 3]! * 0.45 + radius) return true;
    }
    return false;
  }

  setImages(images: SpriteImage[]): void {
    this.atlas = packAtlas(images);
    this.atlasDirty = true;
    this.map.triggerRepaint();
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
    for (const name of ['u_matrix', 'u_size', 'u_origin', 'u_right', 'u_down', 'u_opacity', 'u_atlas']) this.uniforms[name] = gl.getUniformLocation(program, name);
    this.vao = gl.createVertexArray();
    this.corner = gl.createBuffer();
    this.instances = gl.createBuffer();
    this.texture = gl.createTexture();
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.corner);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, 0.5]), gl.STATIC_DRAW);
    const corner = gl.getAttribLocation(program, 'a_corner');
    gl.enableVertexAttribArray(corner);
    gl.vertexAttribPointer(corner, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instances);
    const stride = GPU_FLOATS * 4;
    for (const [name, size, offset] of [
      ['a_box', 4, 0],
      ['a_turn', 2, 4],
      ['a_uv', 4, 6],
      ['a_alpha', 1, 10],
    ] as const) {
      const at = gl.getAttribLocation(program, name);
      gl.enableVertexAttribArray(at);
      gl.vertexAttribPointer(at, size, gl.FLOAT, false, stride, offset * 4);
      gl.vertexAttribDivisor(at, 1);
    }
    gl.bindVertexArray(null);
    this.atlasDirty = true;
    this.dataDirty = true;
  }

  onRemove(): void {
    const gl = this.gl;
    if (!gl) return;
    gl.deleteProgram(this.program);
    gl.deleteVertexArray(this.vao);
    gl.deleteBuffer(this.corner);
    gl.deleteBuffer(this.instances);
    gl.deleteTexture(this.texture);
    this.gl = null;
  }

  render(_context: WebGLRenderingContext | WebGL2RenderingContext, options: CustomRenderMethodInput): void {
    const gl = this.gl;
    if (!gl || !this.program || this.count === 0) return;
    const opacity = this.opacity * this.gain;
    if (opacity <= 0) return;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    if (this.atlasDirty) {
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.atlas.canvas);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.atlasDirty = false;
    }
    const [tl, tr, , bl] = this.corners as [[number, number], [number, number], [number, number], [number, number]];
    gl.useProgram(this.program);
    gl.uniformMatrix4fv(this.uniforms.u_matrix!, false, matrixAt(options, this.centre));
    gl.uniform2f(this.uniforms.u_size!, this.size[0], this.size[1]);
    gl.uniform2f(this.uniforms.u_origin!, tl[0], tl[1]);
    gl.uniform2f(this.uniforms.u_right!, tr[0] - tl[0], tr[1] - tl[1]);
    gl.uniform2f(this.uniforms.u_down!, bl[0] - tl[0], bl[1] - tl[1]);
    gl.uniform1f(this.uniforms.u_opacity!, Math.min(1, opacity));
    gl.uniform1i(this.uniforms.u_atlas!, 0);
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instances);
    if (this.dataDirty) {
      gl.bufferData(gl.ARRAY_BUFFER, this.data.subarray(0, this.count * GPU_FLOATS), gl.DYNAMIC_DRAW);
      this.dataDirty = false;
    }
    gl.enable(gl.BLEND);
    if (this.add) gl.blendFunc(gl.ONE, gl.ONE);
    else gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.count);
    gl.bindVertexArray(null);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }
}
