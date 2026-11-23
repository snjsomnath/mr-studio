import { SURFACE_KINDS, decomposeProjector, parseTwin, projectorMatrices } from '@mrstudio/sdk';
import type {
  Colormap,
  DisplayQuality,
  FieldFrame,
  FieldOverlay,
  LightHandle,
  ModelFieldStyle,
  ModelHandle,
  ModelHit,
  ModelLight,
  ModelPoint,
  PointLight,
  ProjectorCalibration,
  SiteInfo,
  SpotLight,
  SunLight,
  SurfaceMaterial,
  SurfaceQuery,
  TwinMesh,
} from '@mrstudio/sdk';
import type { Map as MapLibreMap } from 'maplibre-gl';
import * as THREE from 'three';

import { cssColor } from './colour.ts';
import { ModelFieldOverlay, premultipliedOver } from './field.ts';
import { SunMask, type Footprint } from './sun-shadows.ts';
import { pixelRatio, shadowDetail } from '../quality.ts';

const DRAPE_VERTEX = /* glsl */ `
attribute float kind;
varying vec2 vLocal;
varying float vKind;
void main() {
  vLocal = position.xy;
  vKind = kind;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

// The flat map (basemap and whatever layers drew through ctx.map), laid over the twin from straight above.
// It is a picture of the plan, so it goes on the ground and the roofs and leaves the walls alone.
const DRAPE_FRAGMENT = /* glsl */ `
precision highp float;
uniform sampler2D uMap;
uniform mat3 uMapFromLocal; // local metres to map texture coordinates
varying vec2 vLocal;
varying float vKind;
void main() {
  if (vKind > 1.5) discard;
  vec2 uv = (uMapFromLocal * vec3(vLocal, 1.0)).xy;
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) discard;
  gl_FragColor = texture2D(uMap, uv); // already premultiplied
}`;

const FOCUS_VERTEX = /* glsl */ `
attribute float focusMask;
varying float vMask;
varying vec2 vLocal;
void main() {
  vMask = focusMask;
  vLocal = position.xy;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

// Black laid over everything outside the focus, so it dims the twin and whatever is under it alike.
const FOCUS_FRAGMENT = /* glsl */ `
precision highp float;
uniform vec4 uWithin; // east, north, radius; w is 1 when in use
uniform float uDim;
varying float vMask;
varying vec2 vLocal;
void main() {
  float inside = vMask;
  if (uWithin.w > 0.5) inside *= 1.0 - smoothstep(uWithin.z * 0.85, uWithin.z, distance(vLocal, uWithin.xy));
  gl_FragColor = vec4(0.0, 0.0, 0.0, (1.0 - inside) * (1.0 - uDim));
}`;

interface BuildingInfo {
  id: string;
  properties: Record<string, unknown>;
  /** Polygons in local metres, each its outer ring then holes. */
  polygons: [number, number][][][];
}

interface LightEntry {
  layer: string;
  spec: ModelLight;
  objects: THREE.Object3D[];
  apply(): void;
}

interface MaterialEntry {
  layer: string;
  query: SurfaceQuery;
  material: SurfaceMaterial;
}

interface FocusEntry {
  layer: string;
  query: SurfaceQuery;
  dim: number;
}

/** WGS84 to the site's local metres, the same tangent plane the host uses. */
function tangentPlane(origin: { lon: number; lat: number }) {
  const A = 6_378_137;
  const E2 = 0.006_694_379_990_14;
  const phi = (origin.lat * Math.PI) / 180;
  const s = 1 - E2 * Math.sin(phi) ** 2;
  const perDegLon = ((A / Math.sqrt(s)) * Math.cos(phi) * Math.PI) / 180;
  const perDegLat = (((A * (1 - E2)) / s ** 1.5) * Math.PI) / 180;
  return {
    toLonLat: (east: number, north: number): [number, number] => [origin.lon + east / perDegLon, origin.lat + north / perDegLat],
    toLocal: (lon: number, lat: number): [number, number] => [(lon - origin.lon) * perDegLon, (lat - origin.lat) * perDegLat],
  };
}


const asArray = <T>(value: T | T[] | undefined): T[] | undefined => (value === undefined ? undefined : Array.isArray(value) ? value : [value]);

/**
 * The model surface: the site's digital twin, rendered with three.js through the projector's
 * camera, on a canvas over the flat map. Without a calibration the camera looks straight down
 * and matches the map exactly, so a flat table or a screen shows what it always did.
 */
export class ModelView {
  readonly twin: TwinMesh;
  readonly canvas: HTMLCanvasElement;
  private readonly site: SiteInfo;
  private readonly map: MapLibreMap;
  private readonly container: HTMLElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.Camera();
  private readonly geometry = new THREE.BufferGeometry();
  private readonly base: THREE.Mesh;
  private readonly baseMaterial: THREE.MeshLambertMaterial;
  private readonly drape: THREE.Mesh;
  private readonly drapeMaterial: THREE.ShaderMaterial;
  private readonly mapTexture: THREE.CanvasTexture;
  private readonly focusMesh: THREE.Mesh;
  private readonly focusMaterial: THREE.ShaderMaterial;
  private readonly centre: THREE.Vector3;
  private readonly radius: number;
  private readonly fields = new Set<ModelFieldOverlay>();
  private readonly lights = new Set<LightEntry>();
  private materials: MaterialEntry[] = [];
  private focuses: FocusEntry[] = [];
  private buildings: BuildingInfo[] | null = null;
  private sunMask: SunMask | null = null;
  private quality: DisplayQuality = 'good';
  /** Each layer's callback for when its sun mask would come out differently. */
  private sunMaskChanged = new Map<string, () => void>();
  private buildingsLoaded: Promise<void> = Promise.resolve();
  private saved: ProjectorCalibration | null = null;
  /** `undefined` follows the saved calibration; anything else replaces it, as the calibration tool does while it works. */
  private override: ProjectorCalibration | null | undefined = undefined;
  private followSaved = false;
  private mirrored = false;
  private draped = false;
  private dirty = true;
  private fieldOrder = 10;
  private calibrationListeners = new Set<() => void>();
  /** Each layer's intensity (0 to 2), as the host holds it. It scales the layer's fields and lights. */
  private intensities = new Map<string, number>();
  /** When set, only this layer's lights and fields show. */
  private solo: string | null = null;

  /** Loads the twin from the host and sets the view up over `container`. Throws when there is no twin or no WebGL. */
  static async create(container: HTMLElement, site: SiteInfo, map: MapLibreMap): Promise<ModelView> {
    const response = await fetch('/api/model');
    if (!response.ok) throw new Error(`the host has no twin (${response.status})`);
    const view = new ModelView(container, site, map, parseTwin(await response.arrayBuffer()));
    view.buildingsLoaded = view.loadBuildings();
    return view;
  }

  private constructor(container: HTMLElement, site: SiteInfo, map: MapLibreMap, twin: TwinMesh) {
    this.container = container;
    this.site = site;
    this.map = map;
    this.twin = twin;

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'table-model';
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, alpha: true, antialias: true });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.append(this.canvas);

    const vertices = twin.kinds.length;
    const g = this.geometry;
    g.setAttribute('position', new THREE.BufferAttribute(twin.positions, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(twin.normals, 3, true));
    g.setAttribute('kind', new THREE.BufferAttribute(twin.kinds, 1));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(vertices * 4).fill(1), 4));
    g.setAttribute('aEmissive', new THREE.BufferAttribute(new Float32Array(vertices * 3), 3));
    g.setAttribute('focusMask', new THREE.BufferAttribute(new Uint8Array(vertices), 1, true));
    g.setIndex(new THREE.BufferAttribute(twin.indices, 1));
    g.computeBoundingSphere();
    this.centre = g.boundingSphere!.center.clone();
    this.radius = Math.max(1, g.boundingSphere!.radius);

    // The base pass: the twin's own surfaces, shaded by whatever lights layers add.
    this.baseMaterial = new THREE.MeshLambertMaterial({ vertexColors: true, alphaTest: 0.004 });
    this.baseMaterial.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('void main() {', 'attribute vec3 aEmissive;\nvarying vec3 vEmissive;\nvoid main() {\n  vEmissive = aEmissive;')
      shader.fragmentShader = shader.fragmentShader
        .replace('void main() {', 'varying vec3 vEmissive;\nvoid main() {')
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n  totalEmissiveRadiance += vEmissive;');
    };
    this.base = new THREE.Mesh(g, this.baseMaterial);
    this.base.castShadow = true;
    this.base.receiveShadow = true;
    this.base.frustumCulled = false;
    this.scene.add(this.base);

    this.mapTexture = new THREE.CanvasTexture(map.getCanvas());
    this.mapTexture.flipY = false;
    this.mapTexture.premultiplyAlpha = true;
    this.mapTexture.generateMipmaps = false;
    this.mapTexture.minFilter = this.mapTexture.magFilter = THREE.LinearFilter;
    this.mapTexture.colorSpace = THREE.NoColorSpace;
    this.drapeMaterial = new THREE.ShaderMaterial({
      vertexShader: DRAPE_VERTEX,
      fragmentShader: DRAPE_FRAGMENT,
      uniforms: { uMap: { value: this.mapTexture }, uMapFromLocal: { value: new THREE.Matrix3() } },
    });
    premultipliedOver(this.drapeMaterial);
    this.drape = new THREE.Mesh(g, this.drapeMaterial);
    this.drape.frustumCulled = false;
    this.drape.renderOrder = 1;
    this.scene.add(this.drape);

    this.focusMaterial = new THREE.ShaderMaterial({
      vertexShader: FOCUS_VERTEX,
      fragmentShader: FOCUS_FRAGMENT,
      uniforms: { uWithin: { value: new THREE.Vector4() }, uDim: { value: 0.15 } },
    });
    premultipliedOver(this.focusMaterial);
    this.focusMesh = new THREE.Mesh(g, this.focusMaterial);
    this.focusMesh.frustumCulled = false;
    this.focusMesh.renderOrder = 1000;
    this.focusMesh.visible = false;
    this.scene.add(this.focusMesh);

    this.camera.matrixAutoUpdate = false;
    new ResizeObserver(() => this.resize()).observe(container);
    map.on('move', () => this.updateCamera());
    map.on('resize', () => this.updateCamera());
    // The map's drawing buffer only holds its picture during this event, so the copy is taken here.
    map.on('render', () => {
      if (!this.draped) return;
      this.mapTexture.needsUpdate = true;
      this.renderer.initTexture(this.mapTexture);
      this.invalidate();
    });
    this.resize();
    this.refreshMode();
    requestAnimationFrame(this.frame);
  }

  // ---- Calibration and camera ---------------------------------------------

  /** True when a projector calibration decides the view, false when the twin is seen from straight above. */
  get calibrated(): boolean {
    return this.activeCalibration() !== null;
  }

  /** The calibration the host holds for this machine and site. */
  get savedCalibration(): ProjectorCalibration | null {
    return this.saved;
  }

  /** Sets the saved calibration and whether this surface follows it (the projected table does; previews do not). */
  setCalibration(calibration: ProjectorCalibration | null, follow = this.followSaved): void {
    this.saved = calibration;
    this.followSaved = follow;
    this.cameraChanged();
  }

  /** Replaces the view's camera while a tool works on it. `undefined` goes back to the saved calibration. */
  setCalibrationOverride(calibration: ProjectorCalibration | null | undefined): void {
    this.override = calibration;
    this.cameraChanged();
  }

  onCalibrationChange(listener: () => void): () => void {
    this.calibrationListeners.add(listener);
    return () => this.calibrationListeners.delete(listener);
  }

  /** Where a model point lands on the surface, in CSS pixels from its top left corner. Null when it is behind the camera. */
  project(point: ModelPoint): [number, number] | null {
    const clip = new THREE.Vector4(point[0], point[1], point[2], 1).applyMatrix4(this.camera.matrixWorldInverse).applyMatrix4(this.camera.projectionMatrix);
    if (clip.w <= 0) return null;
    const x = (clip.x / clip.w + 1) / 2;
    const y = (1 - clip.y / clip.w) / 2;
    return [(this.mirrored ? 1 - x : x) * this.container.clientWidth, y * this.container.clientHeight];
  }

  private activeCalibration(): ProjectorCalibration | null {
    if (this.override !== undefined) return this.override;
    return this.followSaved ? this.saved : null;
  }

  private cameraChanged(): void {
    this.updateCamera();
    this.refreshMode();
    for (const listener of this.calibrationListeners) listener();
  }

  /** The flat map's own view as an affine map from local metres to its CSS pixels. */
  private mapAffine(): [number, number, number, number, number, number] {
    const plane = tangentPlane(this.site.origin);
    const at = (east: number, north: number) => this.map.project(plane.toLonLat(east, north));
    const [o, e, n] = [at(0, 0), at(100, 0), at(0, 100)];
    return [(e.x - o.x) / 100, (n.x - o.x) / 100, o.x, (e.y - o.y) / 100, (n.y - o.y) / 100, o.y];
  }

  private updateCamera(): void {
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    const [a, b, c, d, e, f] = this.mapAffine();
    (this.drapeMaterial.uniforms.uMapFromLocal!.value as THREE.Matrix3).set(a / width, b / width, c / width, d / height, e / height, f / height, 0, 0, 1);

    const calibration = this.activeCalibration();
    const camera = this.camera;
    if (calibration) {
      const lens = decomposeProjector(calibration.matrix, calibration.image);
      const distance = Math.hypot(lens.position[0] - this.centre.x, lens.position[1] - this.centre.y, lens.position[2] - this.centre.z);
      const near = Math.max(distance - this.radius, distance * 0.01, 0.05);
      const { view, projection } = projectorMatrices(lens, calibration.image, near, distance + this.radius);
      camera.matrix.fromArray(view).invert();
      camera.projectionMatrix.fromArray(projection);
      this.mirrored = lens.mirrored;
    } else {
      // Straight down, pixel for pixel what the flat map shows. Higher is nearer.
      const low = this.twin.minZ - 1;
      const range = this.twin.maxZ + 1 - low;
      camera.matrix.identity();
      camera.projectionMatrix.set(
        (2 * a) / width, (2 * b) / width, 0, (2 * c) / width - 1,
        (-2 * d) / height, (-2 * e) / height, 0, 1 - (2 * f) / height,
        0, 0, -2 / range, (this.twin.maxZ + 1 + low) / range,
        0, 0, 0, 1,
      );
      this.mirrored = false;
    }
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
    camera.updateMatrixWorld(true);
    this.canvas.style.transform = this.mirrored ? 'scaleX(-1)' : '';
    this.invalidate();
  }

  private resize(): void {
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    this.renderer.setPixelRatio(pixelRatio(this.quality));
    this.renderer.setSize(width, height, false);
    this.updateCamera();
  }

  /**
   * Decides how the twin and the flat map share the surface. While nothing lights or recolours
   * the twin and the camera is straight above, the map shows as it is and the twin only adds to
   * it. Otherwise the map is laid over the twin as a texture, so it follows the camera too.
   */
  private refreshMode(): void {
    const lit = this.lights.size > 0 || this.materials.length > 0 || this.solo !== null;
    this.baseMaterial.colorWrite = lit;
    const draped = lit || this.calibrated;
    if (draped !== this.draped) {
      this.draped = draped;
      this.drape.visible = draped;
      this.map.getCanvas().style.opacity = draped ? '0' : '';
      this.container.classList.toggle('is-draped', draped);
      if (draped) this.map.triggerRepaint();
    }
    const shown = (layer: string) => this.solo === null || this.solo === layer;
    this.drape.visible = this.draped && this.solo === null;
    for (const field of this.fields) field.setHidden(!shown(field.layer));
    for (const light of this.lights) for (const object of light.objects) object.visible = shown(light.layer);
    this.focusMesh.visible = this.focuses.length > 0 && this.solo === null;
    this.container.classList.toggle('is-projector', this.calibrated);
    this.invalidate();
  }

  /** How finely the table is drawn (#134): the model's pixel density and the sun shadows' detail. */
  setQuality(quality: DisplayQuality): void {
    if (quality === this.quality) return;
    this.quality = quality;
    this.resize();
    this.sunMask?.dispose();
    this.sunMask = null;
    for (const changed of this.sunMaskChanged.values()) changed();
    this.invalidate();
  }

  /** Gives the surface to one layer: everything other layers added, and the flat map, is hidden until `null`. */
  setSolo(layer: string | null): void {
    this.solo = layer;
    this.refreshMode();
  }

  /** Applies a layer's intensity to the fields and lights it has added and will add. */
  setIntensity(layer: string, intensity: number): void {
    this.intensities.set(layer, intensity);
    for (const field of this.fields) if (field.layer === layer) field.setGain(intensity);
    for (const light of this.lights) if (light.layer === layer) light.apply();
    this.invalidate();
  }

  // ---- Rendering -----------------------------------------------------------

  invalidate(): void {
    this.dirty = true;
  }

  private frame = (now: number): void => {
    for (const field of this.fields) if (field.tick(now)) this.dirty = true;
    if (this.dirty) {
      this.dirty = false;
      this.renderer.render(this.scene, this.camera);
    }
    requestAnimationFrame(this.frame);
  };

  // ---- Buildings and surface queries ---------------------------------------

  private async loadBuildings(): Promise<void> {
    if (!this.site.data.buildings) return;
    try {
      const response = await fetch(`/site/${this.site.data.buildings}`);
      const collection = (await response.json()) as {
        features?: { id?: unknown; properties?: Record<string, unknown> | null; geometry?: { type?: string; coordinates?: unknown } | null }[];
      };
      const plane = tangentPlane(this.site.origin);
      const local = (ring: number[][]) => ring.map(([lon, lat]) => plane.toLocal(lon!, lat!));
      const polygonsOf = (geometry: { type?: string; coordinates?: unknown } | null | undefined): [number, number][][][] => {
        if (geometry?.type === 'Polygon') return [(geometry.coordinates as number[][][]).map(local)];
        if (geometry?.type === 'MultiPolygon') return (geometry.coordinates as number[][][][]).map((polygon) => polygon.map(local));
        return [];
      };
      this.buildings = (collection.features ?? []).map((feature, index) => ({
        id: String(feature.id ?? feature.properties?.id ?? index),
        properties: feature.properties ?? {},
        polygons: polygonsOf(feature.geometry),
      }));
      this.applyMaterials();
      this.applyFocus();
      this.sunMask?.setFootprints(this.footprints());
    } catch (error) {
      console.warn('building footprints could not be read; buildings are known by number only', error);
    }
  }

  /** The buildings' footprints, in the form sun shadows take them. */
  private footprints(): Footprint[] {
    // A ring repeats its first point at the end; casters do not need it twice.
    const open = (ring: [number, number][]) => (ring.length > 1 && ring[0]![0] === ring.at(-1)![0] && ring[0]![1] === ring.at(-1)![1] ? ring.slice(0, -1) : ring);
    return (this.buildings ?? []).flatMap((building, index) => building.polygons.map((rings) => ({ number: index + 1, rings: rings.map(open) })));
  }

  private buildingId(number: number): string | undefined {
    if (number === 0) return undefined;
    return this.buildings?.[number - 1]?.id ?? String(number - 1);
  }

  /** The building numbers a query allows, or null when it does not ask about buildings. */
  private buildingNumbers(query: SurfaceQuery): Set<number> | null {
    const ids = asArray(query.building);
    const attribute = query.attribute;
    if (!ids && !attribute) return null;
    const wanted = ids ? new Set(ids.map(String)) : null;
    const numbers = new Set<number>();
    const count = this.buildings?.length ?? this.twin.buildings.reduce((max, b) => Math.max(max, b), 0);
    for (let number = 1; number <= count; number++) {
      if (wanted && !wanted.has(this.buildingId(number)!)) continue;
      if (attribute) {
        const value = this.buildings?.[number - 1]?.properties[attribute.name];
        if (value === undefined || value === null) continue;
        if (attribute.equals !== undefined && value !== attribute.equals) continue;
        if (attribute.in && !attribute.in.includes(value)) continue;
        const n = Number(value);
        if (attribute.min !== undefined && !(n >= attribute.min)) continue;
        if (attribute.max !== undefined && !(n <= attribute.max)) continue;
      }
      numbers.add(number);
    }
    return numbers;
  }

  /** Calls `visit` for every vertex a query picks. `within` is tested at the vertex unless `skipWithin`. */
  private select(query: SurfaceQuery, visit: (vertex: number) => void, skipWithin = false): void {
    const kinds = asArray(query.kind)?.map((kind) => SURFACE_KINDS.indexOf(kind));
    const numbers = this.buildingNumbers(query);
    const within = skipWithin ? undefined : query.within;
    const { kinds: kindOf, buildings, positions } = this.twin;
    for (let i = 0; i < kindOf.length; i++) {
      if (kinds && !kinds.includes(kindOf[i]!)) continue;
      if (numbers && !numbers.has(buildings[i]!)) continue;
      if (within && Math.hypot(positions[i * 3]! - within.east, positions[i * 3 + 1]! - within.north) > within.radius_m) continue;
      visit(i);
    }
  }

  private applyMaterials(): void {
    const color = this.geometry.getAttribute('color') as THREE.BufferAttribute;
    const emissive = this.geometry.getAttribute('aEmissive') as THREE.BufferAttribute;
    const colors = color.array as Float32Array;
    const glow = emissive.array as Float32Array;
    colors.fill(1);
    glow.fill(0);
    // With no light on, a surface's colour could not be seen, so it shows as its own light instead.
    const unlit = this.lights.size === 0;
    const explicit = unlit ? new Float32Array(glow.length) : null;
    let transparent = false;
    const c = new THREE.Color();
    for (const entry of this.materials) {
      const { color: paint, emissive: light, opacity } = entry.material;
      const rgb = paint === undefined ? null : cssColor(paint, c).toArray();
      const lightRgb = light === undefined ? null : cssColor(light, c).toArray();
      if (opacity !== undefined && opacity < 1) transparent = true;
      this.select(entry.query, (i) => {
        if (rgb) {
          colors.set(rgb, i * 4);
          explicit?.set(rgb, i * 3);
        }
        if (lightRgb) glow.set(lightRgb, i * 3);
        if (opacity !== undefined) colors[i * 4 + 3] = opacity;
      });
    }
    if (explicit) for (let i = 0; i < glow.length; i++) glow[i]! += explicit[i]!;
    color.needsUpdate = true;
    emissive.needsUpdate = true;
    if (this.baseMaterial.transparent !== transparent) {
      this.baseMaterial.transparent = transparent;
      this.baseMaterial.needsUpdate = true;
    }
    this.refreshMode();
  }

  private applyFocus(): void {
    const focus = this.focuses[this.focuses.length - 1];
    this.focusMesh.visible = focus !== undefined && this.solo === null;
    if (focus) {
      const mask = this.geometry.getAttribute('focusMask') as THREE.BufferAttribute;
      (mask.array as Uint8Array).fill(0);
      this.select(focus.query, (i) => ((mask.array as Uint8Array)[i] = 255), true);
      mask.needsUpdate = true;
      const within = focus.query.within;
      (this.focusMaterial.uniforms.uWithin!.value as THREE.Vector4).set(within?.east ?? 0, within?.north ?? 0, within?.radius_m ?? 0, within ? 1 : 0);
      this.focusMaterial.uniforms.uDim!.value = focus.dim;
    }
    this.invalidate();
  }

  // ---- Lights --------------------------------------------------------------

  private makeLight(layer: string, spec: ModelLight): LightEntry {
    // A facing white surface reflects a light of intensity pi as full white.
    const strength = (value: number | undefined) => (value ?? 1) * Math.PI * (this.intensities.get(layer) ?? 1);
    const point = (p: ModelPoint) => new THREE.Vector3(p[0], p[1], p[2]);
    let entry: LightEntry;
    if (spec.type === 'sun') {
      const light = new THREE.DirectionalLight();
      const sky = new THREE.HemisphereLight();
      sky.position.set(0, 0, 1);
      const size = this.renderer.capabilities.maxTextureSize >= 4096 ? 4096 : 2048;
      light.shadow.mapSize.set(size, size);
      const shadowCamera = light.shadow.camera;
      shadowCamera.left = shadowCamera.bottom = -this.radius;
      shadowCamera.right = shadowCamera.top = this.radius;
      shadowCamera.near = this.radius * 0.98;
      shadowCamera.far = this.radius * 3.02;
      shadowCamera.updateProjectionMatrix();
      light.shadow.bias = -0.0004;
      // Walls at an angle to the grid are staircases of cell edges. Sampling the shadow a cell and a half out along the
      // shading normal clears the steps, so such a wall is lit as the plane it stands for.
      light.shadow.normalBias = this.site.grid.cell_m * 1.6;
      light.target.position.copy(this.centre);
      entry = {
        layer,
        spec,
        objects: [light, light.target, sky],
        apply: () => {
          const sun = entry.spec as SunLight;
          const azimuth = (sun.azimuth * Math.PI) / 180;
          const altitude = (sun.altitude * Math.PI) / 180;
          const direction = new THREE.Vector3(Math.sin(azimuth) * Math.cos(altitude), Math.cos(azimuth) * Math.cos(altitude), Math.sin(altitude));
          light.position.copy(this.centre).addScaledVector(direction, this.radius * 2);
          // The sun fades out as it crosses the horizon rather than switching off.
          const up = Math.min(1, Math.max(0, (sun.altitude + 0.5) / 1.5));
          cssColor(sun.color ?? '#ffffff', light.color);
          light.intensity = strength(sun.intensity) * up;
          light.castShadow = sun.shadows ?? true;
          cssColor(sun.sky?.color ?? '#ffffff', sky.color);
          sky.groundColor.copy(sky.color).multiplyScalar(0.35);
          sky.intensity = sun.sky ? strength(sun.sky.intensity) : 0;
        },
      };
    } else if (spec.type === 'point') {
      const light = new THREE.PointLight();
      light.decay = 0;
      entry = {
        layer,
        spec,
        objects: [light],
        apply: () => {
          const lamp = entry.spec as PointLight;
          light.position.copy(point(lamp.position));
          cssColor(lamp.color ?? '#ffffff', light.color);
          light.intensity = strength(lamp.intensity);
          light.distance = lamp.range_m ?? 30;
          light.castShadow = lamp.shadows ?? false;
        },
      };
    } else {
      const light = new THREE.SpotLight();
      light.decay = 0;
      entry = {
        layer,
        spec,
        objects: [light, light.target],
        apply: () => {
          const spot = entry.spec as SpotLight;
          light.position.copy(point(spot.position));
          light.target.position.copy(point(spot.target));
          cssColor(spot.color ?? '#ffffff', light.color);
          light.intensity = strength(spot.intensity);
          light.distance = spot.range_m ?? 30;
          light.angle = (((spot.angle_deg ?? 60) / 2) * Math.PI) / 180;
          light.penumbra = spot.softness ?? 0.3;
          light.castShadow = spot.shadows ?? false;
        },
      };
    }
    entry.apply();
    return entry;
  }

  // ---- What layers get -----------------------------------------------------

  /** The `ctx.model` of one layer. Everything added through it is registered with `track` for removal. */
  handle(layer: string, track: (cleanup: () => void) => void): ModelHandle {
    const view = this;
    let cleanupRegistered = false;
    // Materials and focus belong to the layer as a whole; one cleanup clears them.
    const own = () => {
      if (cleanupRegistered) return;
      cleanupRegistered = true;
      track(() => {
        view.materials = view.materials.filter((entry) => entry.layer !== layer);
        view.focuses = view.focuses.filter((entry) => entry.layer !== layer);
        view.applyMaterials();
        view.applyFocus();
      });
    };
    return {
      get calibrated() {
        return view.calibrated;
      },
      addField: (_id: string, style: ModelFieldStyle & { colormap: Colormap }): FieldOverlay => {
        const overlay = new ModelFieldOverlay(layer, view.geometry, view.site, style, {
          floatLinear: view.renderer.extensions.has('OES_texture_float_linear'),
          invalidate: () => view.invalidate(),
          detach: (removed) => {
            view.fields.delete(removed);
            view.scene.remove(removed.mesh);
            view.invalidate();
          },
        });
        overlay.mesh.renderOrder = view.fieldOrder++;
        overlay.setGain(view.intensities.get(layer) ?? 1);
        view.fields.add(overlay);
        view.scene.add(overlay.mesh);
        view.refreshMode();
        track(() => overlay.remove());
        return overlay;
      },
      addLight: <L extends ModelLight>(light: L): LightHandle<L> => {
        const entry = view.makeLight(layer, { ...light });
        const wasUnlit = view.lights.size === 0;
        view.lights.add(entry);
        view.scene.add(...entry.objects);
        if (wasUnlit) view.applyMaterials();
        else view.refreshMode();
        let removed = false;
        const remove = () => {
          if (removed) return;
          removed = true;
          view.lights.delete(entry);
          view.scene.remove(...entry.objects);
          for (const object of entry.objects) (object as Partial<THREE.Light>).dispose?.();
          if (view.lights.size === 0) view.applyMaterials();
          else view.refreshMode();
        };
        track(remove);
        return {
          set: (patch) => {
            Object.assign(entry.spec, patch);
            entry.apply();
            view.invalidate();
          },
          remove,
        };
      },
      sunShadowMask: async (sun: { azimuth: number; altitude: number }, onChange?: () => void): Promise<FieldFrame | null> => {
        if (onChange) {
          if (!view.sunMaskChanged.has(layer)) track(() => view.sunMaskChanged.delete(layer));
          view.sunMaskChanged.set(layer, onChange);
        }
        await view.buildingsLoaded;
        if (!view.sunMask) {
          const plane = tangentPlane(view.site.origin);
          const corners = view.site.corners.map(([lon, lat]) => plane.toLocal(lon, lat));
          view.sunMask = new SunMask(view.renderer, view.geometry, view.twin, corners, shadowDetail(view.quality));
          if (view.buildings) view.sunMask.setFootprints(view.footprints());
        }
        return view.sunMask.render(sun.azimuth, sun.altitude);
      },
      setMaterial: (target: SurfaceQuery, material: SurfaceMaterial): void => {
        own();
        view.materials.push({ layer, query: target, material });
        view.applyMaterials();
      },
      focus: (region: SurfaceQuery | null, options?: { dim?: number }): void => {
        own();
        view.focuses = view.focuses.filter((entry) => entry.layer !== layer);
        if (region) view.focuses.push({ layer, query: region, dim: Math.min(1, Math.max(0, options?.dim ?? 0.15)) });
        view.applyFocus();
      },
      pick: (x: number, y: number): ModelHit | null => view.pick(x, y),
    };
  }

  /** Where a point of the surface image meets the twin. `x` and `y` are fractions from the top left corner. */
  pick(x: number, y: number): ModelHit | null {
    const ndcX = (this.mirrored ? 1 - x : x) * 2 - 1;
    const ndcY = 1 - y * 2;
    const unproject = (z: number) => new THREE.Vector3(ndcX, ndcY, z).applyMatrix4(this.camera.projectionMatrixInverse).applyMatrix4(this.camera.matrixWorld);
    const from = unproject(-1);
    const raycaster = new THREE.Raycaster(from, unproject(1).sub(from).normalize());
    const hit = raycaster.intersectObject(this.base, false)[0];
    if (!hit?.face) return null;
    const vertex = hit.face.a;
    return {
      position: [hit.point.x, hit.point.y, hit.point.z],
      kind: SURFACE_KINDS[this.twin.kinds[vertex]!] ?? 'ground',
      building: this.buildingId(this.twin.buildings[vertex]!),
    };
  }
}
