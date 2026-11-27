import { lut, revealUniform } from '@mrstudio/sdk';
import type { Colormap, FieldFrame, FieldOverlay, FieldOverlayStyle, RevealShape, SiteInfo } from '@mrstudio/sdk';
import maplibregl from 'maplibre-gl';
import type { CustomLayerInterface, CustomRenderMethodInput, Map as MapLibreMap } from 'maplibre-gl';

/**
 * Where a revealing layer's item shows (#287), in GLSL: `revealed(m)` for a point `m` in table
 * metres, from `u_clipKind` and `u_clip` (see revealUniform in the SDK). Shared by every overlay
 * the runtime clips in its shader: fields, sprites and strokes (#619).
 */
export const CLIP_GLSL = `
uniform highp float u_clipKind; // 0 everywhere, 1 a circle, 2 one side of a line, 3 nowhere, 4 outside a circle
uniform highp vec3 u_clip;      // in table metres
bool revealed(highp vec2 m) {
  if (u_clipKind < 0.5) return true;
  if (u_clipKind > 2.5 && u_clipKind < 3.5) return false;
  if (u_clipKind > 3.5) return distance(m, u_clip.xy) > u_clip.z;
  if (u_clipKind < 1.5) return distance(m, u_clip.xy) <= u_clip.z;
  highp float c = u_clip.x < 0.5 ? m.x : m.y;
  return (c - u_clip.y) * u_clip.z >= 0.0;
}`;

const VERTEX = `#version 300 es
uniform mat4 u_matrix;
in vec2 a_position;
in vec2 a_uv;
out vec2 v_uv;
void main() {
  v_uv = a_uv;
  gl_Position = u_matrix * vec4(a_position, 0.0, 1.0);
}`;

const FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D u_field;
uniform sampler2D u_lut;
uniform vec2 u_range;   // offset and scale that take a texel to 0..1
uniform float u_opacity;
uniform float u_gain;    // the layer's intensity: below 1 fades, above 1 brightens
uniform vec2 u_soften;  // blur radius in texture coordinates, 0 for none
uniform vec2 u_extent;    // the table's width and height in metres
${CLIP_GLSL}
in vec2 v_uv;
out vec4 color;
void main() {
  if (!revealed(v_uv * u_extent)) discard;
  float v = texture(u_field, v_uv).r;
  if (u_soften.x > 0.0) {
    // A 3 x 3 Gaussian over bilinear taps: nine fetches give a wide, smooth edge.
    vec2 d = u_soften;
    float edges = texture(u_field, v_uv + vec2(d.x, 0.0)).r + texture(u_field, v_uv - vec2(d.x, 0.0)).r
                + texture(u_field, v_uv + vec2(0.0, d.y)).r + texture(u_field, v_uv - vec2(0.0, d.y)).r;
    float corners = texture(u_field, v_uv + d).r + texture(u_field, v_uv - d).r
                  + texture(u_field, v_uv + vec2(d.x, -d.y)).r + texture(u_field, v_uv + vec2(-d.x, d.y)).r;
    v = v * 0.25 + edges * 0.125 + corners * 0.0625;
  }
  float t = clamp((v - u_range.x) * u_range.y, 0.0, 1.0);
  vec4 c = texture(u_lut, vec2(t * (255.0 / 256.0) + 0.5 / 256.0, 0.5));
  float a = clamp(c.a * u_opacity * u_gain, 0.0, 1.0);
  color = vec4(min(c.rgb * max(1.0, u_gain), 1.0) * a, a);   // premultiplied, as MapLibre blends
}`;

// Eases the displayed field towards the newest frame: out = mix(shown, target, k).
const GLIDE_VERTEX = `#version 300 es
out vec2 v_uv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  v_uv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const GLIDE_FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D u_shown;
uniform sampler2D u_target;
uniform float u_k;
in vec2 v_uv;
out vec4 color;
void main() {
  color = vec4(mix(texture(u_shown, v_uv).r, texture(u_target, v_uv).r, u_k), 0.0, 0.0, 1.0);
}`;

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? 'shader failed to compile');
  return shader;
}

export function link(gl: WebGL2RenderingContext, vertex: string, fragment: string): WebGLProgram {
  const program = gl.createProgram()!;
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, vertex));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, fragment));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? 'program failed to link');
  return program;
}

/**
 * The site's extent in Mercator units: its centre, and its corners relative to the
 * centre (top left, top right, bottom right, bottom left) so they keep float precision.
 */
export function mercatorExtent(site: SiteInfo): { centre: [number, number]; corners: [number, number][] } {
  const mercator = site.corners.map(([lon, lat]) => maplibregl.MercatorCoordinate.fromLngLat({ lng: lon, lat }));
  const centre: [number, number] = [mercator.reduce((s, m) => s + m.x, 0) / 4, mercator.reduce((s, m) => s + m.y, 0) / 4];
  return { centre, corners: mercator.map((m) => [m.x - centre[0], m.y - centre[1]]) };
}

/** The map's projection matrix with the origin moved to `centre`, in double precision before it becomes float32. */
export function matrixAt(options: CustomRenderMethodInput, [cx, cy]: [number, number]): Float32Array {
  const m = options.defaultProjectionData?.mainMatrix ?? options.modelViewProjectionMatrix;
  const matrix = new Float32Array(m as ArrayLike<number>);
  for (let row = 0; row < 4; row++) matrix[12 + row] = m[row]! * cx + m[4 + row]! * cy + m[12 + row]!;
  return matrix;
}

/**
 * Draws one engine field over the site's extent. The frame becomes a single-channel
 * texture and the colormap a lookup texture, so recolouring and restyling cost nothing
 * on the CPU and a new frame is one texture upload.
 */
export class MapFieldOverlay implements FieldOverlay, CustomLayerInterface {
  readonly id: string;
  readonly type = 'custom' as const;
  readonly renderingMode = '2d' as const;

  private map: MapLibreMap;
  private gl: WebGL2RenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private fieldTexture: WebGLTexture | null = null;
  private lutTexture: WebGLTexture | null = null;
  private uniforms: Record<string, WebGLUniformLocation | null> = {};
  private pending: FieldFrame | null = null;
  private size: [number, number, boolean] = [0, 0, false];
  private range: [number, number] = [0, 1];
  private colormap: Colormap;
  private lutDirty = true;
  private opacity: number;
  private gain = 1;
  private smooth: boolean;
  private soften: number;
  private glide: number;
  private hasFrame = false;
  // Gliding: two textures hold the field as shown, and each pass eases one towards the target.
  private glideProgram: WebGLProgram | null = null;
  private glideUniforms: Record<string, WebGLUniformLocation | null> = {};
  private shown: [WebGLTexture | null, WebGLTexture | null] = [null, null];
  private framebuffer: WebGLFramebuffer | null = null;
  private shownSize: [number, number] = [0, 0];
  private shownValid = false;
  private lastUpload = 0;
  private lastGlide = 0;
  private settled = true;
  /** Mercator position of the extent's centre. Vertices are relative to it to keep float precision. */
  private centre: [number, number];
  private corners: [number, number][];
  private site: SiteInfo;

  constructor(map: MapLibreMap, id: string, site: SiteInfo, style: FieldOverlayStyle & { colormap: Colormap }) {
    this.map = map;
    this.site = site;
    this.id = id;
    this.colormap = style.colormap;
    this.opacity = style.opacity ?? 1;
    this.smooth = style.smooth ?? true;
    this.soften = style.soften ?? 0;
    this.glide = style.glide ?? 0;
    const extent = mercatorExtent(site);
    this.centre = extent.centre;
    this.corners = extent.corners;
  }

  set(frame: FieldFrame): void {
    this.pending = frame;
    this.map.triggerRepaint();
  }

  setStyle(style: FieldOverlayStyle): void {
    if (style.colormap) {
      this.colormap = style.colormap;
      this.lutDirty = true;
    }
    if (style.opacity !== undefined) this.opacity = style.opacity;
    if (style.smooth !== undefined) this.smooth = style.smooth;
    if (style.soften !== undefined) this.soften = style.soften;
    if (style.glide !== undefined) this.glide = style.glide;
    this.map.triggerRepaint();
  }

  private clip: RevealShape | null = null;

  /** Where the field shows, set by the runtime for the items of a revealing layer (#287). Not part of the layer API. */
  setClip(shape: RevealShape | null): void {
    this.clip = shape;
    this.map.triggerRepaint();
  }

  /** The layer's intensity, set by the runtime from host state. Not part of the layer API. */
  setGain(gain: number): void {
    this.gain = gain;
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
    for (const name of ['u_matrix', 'u_field', 'u_lut', 'u_range', 'u_opacity', 'u_gain', 'u_soften', 'u_clipKind', 'u_clip', 'u_extent']) this.uniforms[name] = gl.getUniformLocation(program, name);
    this.glideProgram = link(gl, GLIDE_VERTEX, GLIDE_FRAGMENT);
    for (const name of ['u_shown', 'u_target', 'u_k']) this.glideUniforms[name] = gl.getUniformLocation(this.glideProgram, name);
    this.shown = [gl.createTexture(), gl.createTexture()];
    this.framebuffer = gl.createFramebuffer();
    this.shownSize = [0, 0];
    this.shownValid = false;

    // Top left, top right, bottom left, bottom right: a triangle strip with matching texture coordinates.
    const [tl, tr, br, bl] = this.corners as [[number, number], [number, number], [number, number], [number, number]];
    const vertices = new Float32Array([...tl, 0, 0, ...tr, 1, 0, ...bl, 0, 1, ...br, 1, 1]);
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, 'a_position');
    const uv = gl.getAttribLocation(program, 'a_uv');
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(uv);
    gl.vertexAttribPointer(uv, 2, gl.FLOAT, false, 16, 8);
    gl.bindVertexArray(null);

    this.fieldTexture = gl.createTexture();
    this.lutTexture = gl.createTexture();
    this.lutDirty = true;
    this.size = [0, 0, false];
  }

  onRemove(): void {
    const gl = this.gl;
    if (!gl) return;
    gl.deleteProgram(this.program);
    gl.deleteVertexArray(this.vao);
    gl.deleteTexture(this.fieldTexture);
    gl.deleteTexture(this.lutTexture);
    gl.deleteProgram(this.glideProgram);
    gl.deleteTexture(this.shown[0]);
    gl.deleteTexture(this.shown[1]);
    gl.deleteFramebuffer(this.framebuffer);
    this.gl = null;
  }

  /** Offscreen work before the map draws: take the newest frame and ease the shown field towards it. */
  prerender(): void {
    const gl = this.gl;
    if (!gl || !this.glideProgram) return;
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    const now = performance.now();
    if (this.pending) {
      this.upload(gl, this.pending);
      this.pending = null;
      this.lastUpload = now;
      this.settled = false;
    }
    if (!this.gliding() || this.settled) return;

    const [width, height] = this.size;
    if (this.shownSize[0] !== width || this.shownSize[1] !== height) {
      for (const texture of this.shown) {
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, width, height, 0, gl.RED, gl.UNSIGNED_BYTE, null);
        for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, p, gl.LINEAR);
        for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T]) gl.texParameteri(gl.TEXTURE_2D, p, gl.CLAMP_TO_EDGE);
      }
      this.shownSize = [width, height];
      this.shownValid = false;
    }
    // Eight bits cannot hold the tail of an exponential, so the last pass lands exactly on the target.
    const finish = now - this.lastUpload > this.glide * 4000;
    const dt = Math.min(0.1, (now - this.lastGlide) / 1000);
    const k = !this.shownValid || finish ? 1 : 1 - Math.exp(-dt / this.glide);
    this.lastGlide = now;

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.shown[1], 0);
    gl.viewport(0, 0, width, height);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.STENCIL_TEST);
    gl.disable(gl.SCISSOR_TEST);
    gl.colorMask(true, true, true, true);
    gl.useProgram(this.glideProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.shown[0]);
    gl.uniform1i(this.glideUniforms.u_shown!, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.fieldTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.uniform1i(this.glideUniforms.u_target!, 1);
    gl.uniform1f(this.glideUniforms.u_k!, k);
    gl.bindVertexArray(null);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.shown.reverse();
    this.shownValid = true;
    this.settled = k === 1;
    if (!this.settled) this.map.triggerRepaint();
  }

  /** Gliding needs a renderable texture, which quantised frames have and exact ones may not. */
  private gliding(): boolean {
    return this.glide > 0 && this.hasFrame && !this.size[2];
  }

  render(_context: WebGLRenderingContext | WebGL2RenderingContext, options: CustomRenderMethodInput): void {
    const gl = this.gl;
    if (!gl || !this.program) return;
    if (!this.hasFrame) return;
    if (this.lutDirty) {
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.bindTexture(gl.TEXTURE_2D, this.lutTexture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, lut(this.colormap));
      for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, p, gl.LINEAR);
      for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T]) gl.texParameteri(gl.TEXTURE_2D, p, gl.CLAMP_TO_EDGE);
      this.lutDirty = false;
    }

    const matrix = matrixAt(options, this.centre);

    gl.useProgram(this.program);
    gl.uniformMatrix4fv(this.uniforms.u_matrix!, false, matrix);
    gl.uniform2f(this.uniforms.u_range!, this.range[0], this.range[1]);
    gl.uniform1f(this.uniforms.u_opacity!, this.opacity);
    gl.uniform1f(this.uniforms.u_gain!, this.gain);
    const clip = revealUniform(this.clip);
    gl.uniform1f(this.uniforms.u_clipKind!, clip.kind);
    gl.uniform3f(this.uniforms.u_clip!, ...clip.values);
    gl.uniform2f(this.uniforms.u_extent!, this.site.extent.width_m, this.site.extent.height_m);
    gl.activeTexture(gl.TEXTURE0);
    const gliding = this.gliding() && this.shownValid;
    gl.bindTexture(gl.TEXTURE_2D, gliding ? this.shown[0] : this.fieldTexture);
    const soften = this.size[2] ? 0 : this.soften * 0.75;
    gl.uniform2f(this.uniforms.u_soften!, soften / this.size[0], soften / this.size[1]);
    // Float textures cannot be filtered on every device, so exact fields are drawn cell by cell.
    const filter = this.smooth && !this.size[2] ? gl.LINEAR : gl.NEAREST;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.uniform1i(this.uniforms.u_field!, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.lutTexture);
    gl.uniform1i(this.uniforms.u_lut!, 1);
    gl.activeTexture(gl.TEXTURE0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
  }

  private upload(gl: WebGL2RenderingContext, frame: FieldFrame): void {
    const float = frame.data instanceof Float32Array;
    gl.bindTexture(gl.TEXTURE_2D, this.fieldTexture);
    const [internal, type] = float ? [gl.R32F, gl.FLOAT] : [gl.R8, gl.UNSIGNED_BYTE];
    if (this.size[0] !== frame.width || this.size[1] !== frame.height || this.size[2] !== float) {
      gl.texImage2D(gl.TEXTURE_2D, 0, internal, frame.width, frame.height, 0, gl.RED, type, frame.data);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.size = [frame.width, frame.height, float];
    } else {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, frame.width, frame.height, gl.RED, type, frame.data);
    }
    // Quantised frames already span 0..1; exact frames are scaled by their range in the shader.
    const span = frame.max - frame.min;
    this.range = float ? [frame.min, span > 0 ? 1 / span : 0] : [0, 1];
    this.hasFrame = true;
  }
}
