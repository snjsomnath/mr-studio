import type { FieldFrame, TwinMesh } from '@mrstudio/sdk';
import * as THREE from 'three';

/** A building's footprint in the site's local frame (x east, y north, metres): outer ring first, then holes. */
export interface Footprint {
  /** The twin's number for the building: its feature's position in the buildings file plus one. */
  number: number;
  rings: [number, number][][];
}

/** Walls stop this far under the roof they hold up, so a roof is never shaded by its own walls. */
const ROOF_CLEARANCE_M = 0.15;
/** And reach this far into the ground, so no light leaks under a wall on a slope. */
const FOOT_M = 1;
/** Caps sit this far over the roofs, so they cover the twin's steps. */
const CAP_M = 0.05;
/** Metres per pixel of the mask, and its largest side. */
const MASK_M = 0.3;
const MASK_MAX = 4096;

/**
 * Sharp sun shadows for the table (#133), as a mask the sunlight layer draws in its own map field, so the table's
 * layer order holds. The twin is built from the scene's cells, so its walls are staircases and the shadows they cast
 * are too. Here buildings cast from their real footprints, as open walls up to the roof heights the twin has: every
 * ray from the ground outside a building to the sun that passes through it crosses a wall, so walls cast the whole
 * shadow, and with no lid nothing over a roof speckles it at a low sun. The rest of the twin (the ground, an
 * imported model) casts from its back faces, so it shades the far side of a hill but never speckles itself.
 *
 * The mask is rendered straight down over the table's extent with a GPU shadow map: 1 in the sun, 0 in the shade,
 * and in between on slopes turned away from the sun, so hills shade their own far side (#145).
 */
export class SunMask {
  private readonly scene = new THREE.Scene();
  private readonly light = new THREE.DirectionalLight(0xffffff, 1);
  private readonly camera: THREE.OrthographicCamera;
  private readonly target: THREE.WebGLRenderTarget;
  private readonly width: number;
  private readonly height: number;
  private readonly pixels: Uint8Array;
  private readonly materials: THREE.Material[];
  private readonly geometries = new Set<THREE.BufferGeometry>();
  private readonly prisms: THREE.Mesh;
  private readonly rest: THREE.Mesh;
  private readonly cap: THREE.Mesh;
  private readonly lightCentre: THREE.Vector3;
  private readonly lightDistance: number;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly geometry: THREE.BufferGeometry;
  private readonly twin: TwinMesh;
  private revision = 0;

  /** `corners` are the table's corners in local metres: top left, top right, bottom right, bottom left. */
  constructor(renderer: THREE.WebGLRenderer, geometry: THREE.BufferGeometry, twin: TwinMesh, corners: [number, number][]) {
    this.renderer = renderer;
    this.geometry = geometry;
    this.twin = twin;
    const [tl, tr, , bl] = corners.map(([x, y]) => new THREE.Vector2(x, y));
    const across = tr!.clone().sub(tl!);
    const up = tl!.clone().sub(bl!);
    const widthM = across.length();
    const heightM = up.length();
    const centre = tr!.clone().add(bl!).multiplyScalar(0.5);
    const max = Math.min(MASK_MAX, renderer.capabilities.maxTextureSize);
    const scale = Math.min(1 / MASK_M, max / widthM, max / heightM);
    this.width = Math.max(1, Math.round(widthM * scale));
    this.height = Math.max(1, Math.round(heightM * scale));
    this.pixels = new Uint8Array(this.width * this.height * 4);
    this.target = new THREE.WebGLRenderTarget(this.width, this.height, { depthBuffer: true });

    if (!geometry.boundingSphere) geometry.computeBoundingSphere();
    const sphere = geometry.boundingSphere!;
    const radius = Math.max(1, sphere.radius);
    this.camera = new THREE.OrthographicCamera(-widthM / 2, widthM / 2, heightM / 2, -heightM / 2, 1, radius * 4 + 1000);
    this.camera.up.set(up.x, up.y, 0).normalize();
    this.camera.position.set(centre.x, centre.y, sphere.center.z + radius * 2 + 500);
    this.camera.lookAt(centre.x, centre.y, sphere.center.z);
    this.camera.updateMatrixWorld();

    const light = this.light;
    light.castShadow = true;
    const size = renderer.capabilities.maxTextureSize >= 4096 ? 4096 : 2048;
    light.shadow.mapSize.set(size, size);
    const shadowCamera = light.shadow.camera;
    shadowCamera.left = shadowCamera.bottom = -radius;
    shadowCamera.right = shadowCamera.top = radius;
    shadowCamera.near = radius * 0.5;
    shadowCamera.far = radius * 3.5;
    shadowCamera.updateProjectionMatrix();
    light.shadow.bias = -0.0002;
    light.shadow.normalBias = 0;
    light.target.position.copy(sphere.center);
    this.lightCentre = sphere.center.clone();
    this.lightDistance = radius * 2;

    const casterMaterial = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, side: THREE.DoubleSide, shadowSide: THREE.DoubleSide });
    const groundCasterMaterial = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, shadowSide: THREE.BackSide });
    // Receivers are lit by the sun alone, scaled so flat ground in the sun is white: a slope turned towards the sun
    // stays white, one turned away dims (a hillshade), and shadow is black.
    const sunMaterial = new THREE.MeshLambertMaterial({ color: 0xffffff });
    this.materials = [casterMaterial, groundCasterMaterial, sunMaterial];

    // Seen from straight above, walls have no area; only ground and roofs receive.
    const surfaces = new THREE.BufferGeometry();
    surfaces.setAttribute('position', geometry.getAttribute('position'));
    surfaces.setAttribute('normal', geometry.getAttribute('normal'));
    const flat: number[] = [];
    for (let t = 0; t < twin.indices.length; t += 3) {
      const a = twin.indices[t]!;
      const b = twin.indices[t + 1]!;
      const c = twin.indices[t + 2]!;
      if (twin.kinds[a] !== 2 || twin.kinds[b] !== 2 || twin.kinds[c] !== 2) flat.push(a, b, c);
    }
    surfaces.setIndex(flat);
    this.geometries.add(surfaces);

    const sun = new THREE.Mesh(surfaces, sunMaterial);
    sun.receiveShadow = true;
    // Until footprints arrive, the whole twin casts as it is.
    this.rest = new THREE.Mesh(geometry, groundCasterMaterial);
    this.rest.castShadow = true;
    this.prisms = new THREE.Mesh(new THREE.BufferGeometry(), casterMaterial);
    this.prisms.castShadow = true;
    // Caps over the roofs show each building's real outline, not the twin's steps. They draw after the twin.
    const capGeometry = new THREE.BufferGeometry();
    const cap = new THREE.Mesh(capGeometry, sunMaterial);
    cap.receiveShadow = true;
    cap.renderOrder = 1;
    this.cap = cap;
    this.geometries.add(this.prisms.geometry).add(capGeometry);
    for (const object of [sun, this.rest, this.prisms, cap]) object.frustumCulled = false;
    this.scene.add(light, light.target, sun, this.rest, this.prisms, cap);
  }

  /** Builds the buildings' casters and caps from their footprints and the roof heights in the twin. */
  setFootprints(footprints: Footprint[]): void {
    const { positions, kinds, buildings, indices } = this.twin;
    const roof = new Map<number, number>();
    const foot = new Map<number, number>();
    for (let v = 0; v < kinds.length; v++) {
      const n = buildings[v]!;
      if (n === 0) continue;
      const z = positions[v * 3 + 2]!;
      if (kinds[v] === 1) roof.set(n, Math.max(roof.get(n) ?? -Infinity, z));
      foot.set(n, Math.min(foot.get(n) ?? Infinity, z));
    }

    const walls: number[] = [];
    const caps: number[] = [];
    const raised = new Set<number>();
    for (const { number, rings } of footprints) {
      const top = roof.get(number);
      const bottom = foot.get(number);
      if (top === undefined || bottom === undefined || rings.length === 0 || rings[0]!.length < 3) continue;
      const z1 = top - ROOF_CLEARANCE_M;
      const z0 = Math.min(bottom, z1) - FOOT_M;
      raised.add(number);
      const contour = rings[0]!.map(([x, y]) => new THREE.Vector2(x, y));
      const holes = rings.slice(1).map((ring) => ring.map(([x, y]) => new THREE.Vector2(x, y)));
      const all = [contour, ...holes].flat();
      for (const triangle of THREE.ShapeUtils.triangulateShape(contour, holes)) {
        for (const corner of triangle) caps.push(all[corner]!.x, all[corner]!.y, top + CAP_M);
      }
      for (const ring of rings) {
        for (let i = 0; i < ring.length; i++) {
          const [ax, ay] = ring[i]!;
          const [bx, by] = ring[(i + 1) % ring.length]!;
          if (ax === bx && ay === by) continue;
          walls.push(ax, ay, z0, bx, by, z0, bx, by, z1, ax, ay, z0, bx, by, z1, ax, ay, z1);
        }
      }
    }
    const prisms = new THREE.BufferGeometry();
    prisms.setAttribute('position', new THREE.Float32BufferAttribute(walls, 3));
    this.replace(this.prisms, prisms);

    const capGeometry = new THREE.BufferGeometry();
    capGeometry.setAttribute('position', new THREE.Float32BufferAttribute(caps, 3));
    capGeometry.setAttribute('normal', new THREE.Float32BufferAttribute(Float32Array.from({ length: caps.length }, (_, i) => (i % 3 === 2 ? 1 : 0)), 3));
    this.replace(this.cap, capGeometry);

    // The rest of the twin casts as it is: the ground, and anything without a raised footprint.
    const kept: number[] = [];
    for (let t = 0; t < indices.length; t += 3) {
      const a = indices[t]!;
      if (raised.has(buildings[a]!) || raised.has(buildings[indices[t + 1]!]!) || raised.has(buildings[indices[t + 2]!]!)) continue;
      kept.push(a, indices[t + 1]!, indices[t + 2]!);
    }
    const rest = new THREE.BufferGeometry();
    rest.setAttribute('position', this.geometry.getAttribute('position'));
    rest.setIndex(kept);
    this.replace(this.rest, rest);
  }

  /** The mask for a sun position, over the table's extent: row 0 at the top, 255 in the sun, 0 in the shade. */
  render(azimuth: number, altitude: number): FieldFrame {
    const data = new Uint8Array(this.width * this.height);
    if (altitude > 0) {
      const a = (azimuth * Math.PI) / 180;
      const h = (altitude * Math.PI) / 180;
      const direction = new THREE.Vector3(Math.sin(a) * Math.cos(h), Math.cos(a) * Math.cos(h), Math.sin(h));
      this.light.position.copy(this.lightCentre).addScaledVector(direction, this.lightDistance);
      // Lambert gives flat ground sin(altitude) / π of the light; this makes it exactly white.
      this.light.intensity = Math.PI / Math.sin(h);

      const renderer = this.renderer;
      const previous = renderer.getRenderTarget();
      const clear = renderer.getClearColor(new THREE.Color());
      const clearAlpha = renderer.getClearAlpha();
      renderer.setRenderTarget(this.target);
      renderer.setClearColor(0xffffff, 1);
      renderer.clear();
      renderer.render(this.scene, this.camera);
      renderer.readRenderTargetPixels(this.target, 0, 0, this.width, this.height, this.pixels);
      renderer.setRenderTarget(previous);
      renderer.setClearColor(clear, clearAlpha);

      // The target's rows run bottom up.
      for (let y = 0; y < this.height; y++) {
        const from = (this.height - 1 - y) * this.width * 4;
        const to = y * this.width;
        for (let x = 0; x < this.width; x++) data[to + x] = this.pixels[from + x * 4]!;
      }
    }
    return { stream: -1, field: 0, width: this.width, height: this.height, revision: ++this.revision, min: 0, max: 1, progress: 1, data };
  }

  dispose(): void {
    for (const geometry of this.geometries) geometry.dispose();
    for (const material of this.materials) material.dispose();
    this.target.dispose();
    this.light.shadow.map?.dispose();
    this.light.dispose();
  }

  private replace(mesh: THREE.Mesh, geometry: THREE.BufferGeometry): void {
    if (this.geometries.delete(mesh.geometry)) mesh.geometry.dispose();
    mesh.geometry = geometry;
    this.geometries.add(geometry);
  }
}
