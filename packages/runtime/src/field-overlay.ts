import { lut } from '@mrstudio/sdk';
import type { Colormap, FieldFrame, FieldOverlay, FieldOverlayStyle, SiteInfo } from '@mrstudio/sdk';
import maplibregl from 'maplibre-gl';
import type { CustomLayerInterface, CustomRenderMethodInput, Map as MapLibreMap } from 'maplibre-gl';

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
in vec2 v_uv;
out vec4 color;
void main() {
  float t = clamp((texture(u_field, v_uv).r - u_range.x) * u_range.y, 0.0, 1.0);
  vec4 c = texture(u_lut, vec2(t * (255.0 / 256.0) + 0.5 / 256.0, 0.5));
  float a = c.a * u_opacity;
  color = vec4(c.rgb * a, a);   // premultiplied, as MapLibre blends
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
  private smooth: boolean;
  private hasFrame = false;
  /** Mercator position of the extent's centre. Vertices are relative to it to keep float precision. */
  private centre: [number, number];
  private corners: [number, number][];

  constructor(map: MapLibreMap, id: string, site: SiteInfo, style: FieldOverlayStyle & { colormap: Colormap }) {
    this.map = map;
    this.id = id;
    this.colormap = style.colormap;
    this.opacity = style.opacity ?? 1;
    this.smooth = style.smooth ?? true;
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
    for (const name of ['u_matrix', 'u_field', 'u_lut', 'u_range', 'u_opacity']) this.uniforms[name] = gl.getUniformLocation(program, name);

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
    this.gl = null;
  }

  render(_context: WebGLRenderingContext | WebGL2RenderingContext, options: CustomRenderMethodInput): void {
    const gl = this.gl;
    if (!gl || !this.program) return;
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    if (this.pending) {
      this.upload(gl, this.pending);
      this.pending = null;
    }
    if (!this.hasFrame) return;
    if (this.lutDirty) {
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
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.fieldTexture);
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
