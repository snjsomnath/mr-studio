import { lut } from '@mrstudio/sdk';
import type { Colormap, FieldFrame, FieldOverlay, FieldOverlayStyle, ModelFieldStyle, SiteInfo, SurfaceKind } from '@mrstudio/sdk';
import * as THREE from 'three';

/** GLSL shared by every pass that reads the scene grid: a twin point's place in a field texture. */
export const GRID_GLSL = /* glsl */ `
uniform vec2 uGridRotation; // cos and sin of the grid's bearing
uniform vec2 uGridSize;     // extent in metres
uniform float uCell;        // cell size in metres
// A local east/north position to field texture coordinates, row 0 at the top.
vec2 gridUv(vec2 local) {
  float right = local.x * uGridRotation.x - local.y * uGridRotation.y;
  float up = local.x * uGridRotation.y + local.y * uGridRotation.x;
  return vec2(right / uGridSize.x + 0.5, 0.5 - up / uGridSize.y);
}`;

export function gridUniforms(site: SiteInfo): Record<string, THREE.IUniform> {
  const r = (site.grid.rotation_deg * Math.PI) / 180;
  return {
    uGridRotation: { value: new THREE.Vector2(Math.cos(r), Math.sin(r)) },
    uGridSize: { value: new THREE.Vector2(site.grid.width * site.grid.cell_m, site.grid.height * site.grid.cell_m) },
    uCell: { value: site.grid.cell_m },
  };
}

const VERTEX = /* glsl */ `
attribute float kind;
varying vec2 vLocal;
varying float vKind;
uniform float uCell;
void main() {
  vKind = kind;
  // A wall shows the cell at its foot: half a cell out along its normal.
  vLocal = position.xy + (kind > 1.5 ? normal.xy * uCell * 0.5 : vec2(0.0));
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const FRAGMENT = /* glsl */ `
precision highp float;
${GRID_GLSL}
uniform sampler2D uField;
uniform sampler2D uPrevious;
uniform float uMix;      // 1 shows uField, 0 shows uPrevious
uniform sampler2D uLut;
uniform vec2 uRange;     // offset and scale that take a texel to 0..1
uniform float uOpacity;
uniform float uGain;      // the layer's intensity: below 1 fades, above 1 brightens
uniform vec2 uSoften;    // blur radius in texture coordinates, 0 for none
uniform vec3 uKinds;     // 1 where ground, roof and wall take the field
varying vec2 vLocal;
varying float vKind;

float value(vec2 uv) {
  float now = texture2D(uField, uv).r;
  return uMix < 1.0 ? mix(texture2D(uPrevious, uv).r, now, uMix) : now;
}

void main() {
  float on = vKind < 0.5 ? uKinds.x : (vKind < 1.5 ? uKinds.y : uKinds.z);
  if (on < 0.5) discard;
  vec2 uv = gridUv(vLocal);
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) discard;
  float v = value(uv);
  if (uSoften.x > 0.0) {
    // A 3 x 3 Gaussian over bilinear taps, as on the flat table.
    vec2 d = uSoften;
    float edges = value(uv + vec2(d.x, 0.0)) + value(uv - vec2(d.x, 0.0)) + value(uv + vec2(0.0, d.y)) + value(uv - vec2(0.0, d.y));
    float corners = value(uv + d) + value(uv - d) + value(uv + vec2(d.x, -d.y)) + value(uv + vec2(-d.x, d.y));
    v = v * 0.25 + edges * 0.125 + corners * 0.0625;
  }
  float t = clamp((v - uRange.x) * uRange.y, 0.0, 1.0);
  vec4 c = texture2D(uLut, vec2(t * (255.0 / 256.0) + 0.5 / 256.0, 0.5));
  float a = clamp(c.a * uOpacity * uGain, 0.0, 1.0);
  gl_FragColor = vec4(min(c.rgb * max(1.0, uGain), 1.0) * a, a); // premultiplied
}`;

/** Blending for passes that write premultiplied colour over what is already there. */
export function premultipliedOver(material: THREE.Material): void {
  material.transparent = true;
  material.blending = THREE.CustomBlending;
  material.blendEquation = THREE.AddEquation;
  material.blendSrc = THREE.OneFactor;
  material.blendDst = THREE.OneMinusSrcAlphaFactor;
  material.blendSrcAlpha = THREE.OneFactor;
  material.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
  material.depthWrite = false;
  material.depthFunc = THREE.LessEqualDepth;
  // Drawn on the same triangles as the base pass; the offset keeps it from fighting with them.
  material.polygonOffset = true;
  material.polygonOffsetFactor = -1;
  material.polygonOffsetUnits = -1;
}

function dataTexture(data: Uint8Array | Float32Array | null, width: number, height: number, float: boolean): THREE.DataTexture {
  const texture = new THREE.DataTexture(data, width, height, THREE.RedFormat, float ? THREE.FloatType : THREE.UnsignedByteType);
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.unpackAlignment = 1;
  texture.needsUpdate = true;
  return texture;
}

/**
 * One engine field painted on the twin's surfaces. The frame becomes a single-channel
 * texture and the colormap a lookup texture, so a new frame is one upload and restyling is free.
 */
export class ModelFieldOverlay implements FieldOverlay {
  readonly mesh: THREE.Mesh;
  /** The layer that added the field. */
  readonly layer: string;
  private hasFrame = false;
  private hidden = false;
  private material: THREE.ShaderMaterial;
  private field: THREE.DataTexture;
  private previous: THREE.DataTexture;
  private lutTexture: THREE.DataTexture;
  private style: Required<Pick<FieldOverlayStyle, 'opacity' | 'smooth' | 'soften' | 'glide'>>;
  private float = false;
  private glideStart = 0;
  private readonly floatLinear: boolean;
  private readonly invalidate: () => void;
  private readonly detach: (overlay: ModelFieldOverlay) => void;

  constructor(
    layer: string,
    geometry: THREE.BufferGeometry,
    site: SiteInfo,
    style: ModelFieldStyle & { colormap: Colormap },
    hooks: { floatLinear: boolean; invalidate: () => void; detach: (overlay: ModelFieldOverlay) => void },
  ) {
    this.layer = layer;
    this.floatLinear = hooks.floatLinear;
    this.invalidate = hooks.invalidate;
    this.detach = hooks.detach;
    this.style = { opacity: style.opacity ?? 1, smooth: style.smooth ?? true, soften: style.soften ?? 0, glide: style.glide ?? 0 };
    this.field = dataTexture(new Uint8Array(1), 1, 1, false);
    this.previous = dataTexture(new Uint8Array(1), 1, 1, false);
    this.lutTexture = new THREE.DataTexture(lut(style.colormap), 256, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
    this.lutTexture.magFilter = this.lutTexture.minFilter = THREE.LinearFilter;
    this.lutTexture.needsUpdate = true;
    const on: SurfaceKind[] = style.on ?? ['ground', 'roof'];
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      uniforms: {
        ...gridUniforms(site),
        uField: { value: this.field },
        uPrevious: { value: this.previous },
        uMix: { value: 1 },
        uLut: { value: this.lutTexture },
        uRange: { value: new THREE.Vector2(0, 1) },
        uOpacity: { value: this.style.opacity },
        uGain: { value: 1 },
        uSoften: { value: new THREE.Vector2(0, 0) },
        uKinds: { value: new THREE.Vector3(on.includes('ground') ? 1 : 0, on.includes('roof') ? 1 : 0, on.includes('wall') ? 1 : 0) },
      },
    });
    premultipliedOver(this.material);
    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.frustumCulled = false;
    // Nothing to show until the first frame arrives.
    this.mesh.visible = false;
  }

  set(frame: FieldFrame): void {
    const float = frame.data instanceof Float32Array;
    const image = this.field.image as { width: number; height: number };
    const sameShape = this.hasFrame && image.width === frame.width && image.height === frame.height && this.float === float;
    if (sameShape && this.style.glide > 0 && !float) {
      // Ease from what was shown to the new frame. The old target becomes the starting point.
      [this.field, this.previous] = [this.previous, this.field];
      this.material.uniforms.uPrevious!.value = this.previous;
      this.glideStart = performance.now();
      this.material.uniforms.uMix!.value = 0;
    } else {
      this.material.uniforms.uMix!.value = 1;
    }
    const target = this.field.image as { width: number; height: number; data: unknown };
    if (target.width === frame.width && target.height === frame.height && this.field.type === (float ? THREE.FloatType : THREE.UnsignedByteType)) {
      target.data = frame.data;
      this.field.needsUpdate = true;
    } else {
      this.field.dispose();
      this.field = dataTexture(frame.data, frame.width, frame.height, float);
    }
    this.material.uniforms.uField!.value = this.field;
    this.float = float;
    // Quantised frames already span 0..1; exact frames are scaled by their range in the shader.
    const span = frame.max - frame.min;
    (this.material.uniforms.uRange!.value as THREE.Vector2).set(float ? frame.min : 0, float ? (span > 0 ? 1 / span : 0) : 1);
    this.hasFrame = true;
    this.mesh.visible = !this.hidden;
    this.restyle();
  }

  setStyle(style: FieldOverlayStyle): void {
    if (style.colormap) {
      (this.lutTexture.image as { data: unknown }).data = lut(style.colormap);
      this.lutTexture.needsUpdate = true;
    }
    if (style.opacity !== undefined) this.style.opacity = style.opacity;
    if (style.smooth !== undefined) this.style.smooth = style.smooth;
    if (style.soften !== undefined) this.style.soften = style.soften;
    if (style.glide !== undefined) this.style.glide = style.glide;
    this.restyle();
  }

  /** The layer's intensity, set by the runtime from host state. Not part of the layer API. */
  setGain(gain: number): void {
    this.material.uniforms.uGain!.value = gain;
    this.invalidate();
  }

  /** Hides the field without losing its frame, while another tool has the surface to itself. */
  setHidden(hidden: boolean): void {
    this.hidden = hidden;
    this.mesh.visible = this.hasFrame && !hidden;
  }

  remove(): void {
    this.detach(this);
    this.material.dispose();
    this.field.dispose();
    this.previous.dispose();
    this.lutTexture.dispose();
  }

  /** Advances the glide. Returns true while it is still moving. */
  tick(now: number): boolean {
    const mix = this.material.uniforms.uMix!;
    if (mix.value >= 1) return false;
    const elapsed = (now - this.glideStart) / 1000;
    mix.value = elapsed > this.style.glide * 4 ? 1 : 1 - Math.exp(-elapsed / this.style.glide);
    return mix.value < 1;
  }

  private restyle(): void {
    const u = this.material.uniforms;
    u.uOpacity!.value = this.style.opacity;
    const image = this.field.image as { width: number; height: number };
    // Float textures cannot be filtered on every device, so exact fields may be drawn cell by cell and unsoftened.
    const filterable = !this.float || this.floatLinear;
    const filter = this.style.smooth && filterable ? THREE.LinearFilter : THREE.NearestFilter;
    for (const texture of [this.field, this.previous]) {
      if (texture.magFilter !== filter) {
        texture.magFilter = texture.minFilter = filter;
        texture.needsUpdate = true;
      }
    }
    const soften = filterable ? this.style.soften * 0.75 : 0;
    (u.uSoften!.value as THREE.Vector2).set(soften / image.width, soften / image.height);
    this.invalidate();
  }
}
