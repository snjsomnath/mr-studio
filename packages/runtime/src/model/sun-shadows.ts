import type { SunShadows, TwinMesh } from '@mrstudio/sdk';
import * as THREE from 'three';

import { cssColor } from './colour.ts';

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
/** Caps sit this far over the roofs, so they draw over the twin's steps. */
const CAP_M = 0.05;

/**
 * Sun shadows on the twin, seen from above (#133). The twin is built from the scene's cells, so its walls are
 * staircases and the shadows they cast are too. Here the buildings cast from their real footprints, raised to the
 * roof heights the twin has, and everything else the twin holds (the ground, an imported model) casts as it is.
 * Until the footprints have loaded, the whole twin casts.
 * A GPU shadow map makes the edges as sharp as the map's texels: about 0.35 m over a 1.2 km table at 4096.
 *
 * Ground and roofs are painted in the light's colour, and a shadow material lays the shade over what the sun
 * cannot reach, so the result keeps the flat, two-tone look of the 2D table.
 */
export class SunShadowPass {
  readonly objects: THREE.Object3D[];
  private readonly light = new THREE.DirectionalLight(0xffffff, 1);
  private readonly lit: THREE.Mesh;
  private readonly shadow: THREE.Mesh;
  private readonly litMaterial = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false });
  private readonly shadowMaterial = new THREE.ShadowMaterial({ transparent: true, depthWrite: false });
  private readonly casterMaterial = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, side: THREE.DoubleSide });
  // The ground casts from its back faces only, so it shades the far side of a hill but never speckles itself.
  private readonly groundCasterMaterial = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, shadowSide: THREE.BackSide });
  private readonly prisms = new THREE.Mesh(new THREE.BufferGeometry(), this.casterMaterial);
  private readonly rest: THREE.Mesh;
  private readonly capLit = new THREE.Mesh(new THREE.BufferGeometry(), this.litMaterial);
  private readonly capShadow = new THREE.Mesh(this.capLit.geometry, this.shadowMaterial);
  private spec: SunShadows;
  private readonly geometry: THREE.BufferGeometry;
  private readonly twin: TwinMesh;
  private readonly centre: THREE.Vector3;
  private readonly radius: number;
  private readonly surfaces: THREE.BufferGeometry;

  constructor(geometry: THREE.BufferGeometry, twin: TwinMesh, centre: THREE.Vector3, radius: number, maxTextureSize: number, spec: SunShadows) {
    this.geometry = geometry;
    this.twin = twin;
    this.centre = centre;
    this.radius = radius;
    this.spec = { ...spec };
    for (const material of [this.litMaterial, this.shadowMaterial]) {
      // Drawn on the twin's own triangles, over the map draped on it and under any field.
      material.polygonOffset = true;
      material.polygonOffsetFactor = -1;
      material.polygonOffsetUnits = -1;
    }
    this.casterMaterial.shadowSide = THREE.DoubleSide;

    // Seen from above, walls are slivers at the edges of the picture. They take the light's colour, like the roofs
    // they belong to, but no shade: a wall's shadow acne would hatch the table.
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
    this.surfaces = surfaces;

    this.lit = new THREE.Mesh(geometry, this.litMaterial);
    this.lit.renderOrder = 2;
    this.lit.frustumCulled = false;
    this.shadow = new THREE.Mesh(surfaces, this.shadowMaterial);
    this.shadow.renderOrder = 3;
    this.shadow.frustumCulled = false;
    this.shadow.receiveShadow = true;

    // Until footprints arrive, the whole twin casts; afterwards, everything but the buildings that have prisms.
    this.rest = new THREE.Mesh(geometry, this.groundCasterMaterial);
    this.rest.castShadow = true;
    this.rest.frustumCulled = false;
    this.prisms.castShadow = true;
    this.capLit.renderOrder = 4;
    this.capShadow.renderOrder = 5;
    this.capShadow.receiveShadow = true;
    for (const cap of [this.capLit, this.capShadow]) cap.frustumCulled = false;
    this.prisms.frustumCulled = false;

    const light = this.light;
    light.castShadow = true;
    const size = maxTextureSize >= 4096 ? 4096 : 2048;
    light.shadow.mapSize.set(size, size);
    const camera = light.shadow.camera;
    camera.left = camera.bottom = -radius;
    camera.right = camera.top = radius;
    camera.near = radius * 0.5;
    camera.far = radius * 3.5;
    camera.updateProjectionMatrix();
    light.shadow.bias = -0.0002;
    light.shadow.normalBias = 0;
    // Real penumbras are a few decimetres for buildings; PCF's soft edge is about that.
    light.shadow.radius = 1.5;
    light.target.position.copy(centre);

    this.objects = [this.light, this.light.target, this.lit, this.shadow, this.rest, this.prisms, this.capLit, this.capShadow];
    this.apply();
  }

  private shown = true;

  /** Hides the pass while another layer has the surface to itself. */
  setShown(shown: boolean): void {
    this.shown = shown;
    this.apply();
  }

  set(patch: Partial<SunShadows>): void {
    Object.assign(this.spec, patch);
    this.apply();
  }

  /**
   * Builds the buildings' casters: open walls on their footprints, up to the roofs the twin has. Every ray from
   * the ground outside a building to the sun that passes through it crosses a wall, so walls alone cast the whole
   * shadow, and with no lid there is nothing over a roof to speckle it at a low sun. The twin's roofs are stepped at
   * its cells, so each footprint also gets a cap at roof height, which the table shows with the real outline.
   */
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

    const vertices: number[] = [];
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
          vertices.push(ax, ay, z0, bx, by, z0, bx, by, z1, ax, ay, z0, bx, by, z1, ax, ay, z1);
        }
      }
    }
    const capGeometry = new THREE.BufferGeometry();
    capGeometry.setAttribute('position', new THREE.Float32BufferAttribute(caps, 3));
    capGeometry.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(caps.length).map((_, i) => (i % 3 === 2 ? 1 : 0)), 3));
    this.capLit.geometry.dispose();
    this.capLit.geometry = this.capShadow.geometry = capGeometry;
    const prisms = new THREE.BufferGeometry();
    prisms.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    this.prisms.geometry.dispose();
    this.prisms.geometry = prisms;

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
    if (this.rest.geometry !== this.geometry) this.rest.geometry.dispose();
    this.rest.geometry = rest;
  }

  dispose(): void {
    this.surfaces.dispose();
    this.prisms.geometry.dispose();
    this.capLit.geometry.dispose();
    if (this.rest.geometry !== this.geometry) this.rest.geometry.dispose();
    for (const material of [this.litMaterial, this.shadowMaterial, this.casterMaterial, this.groundCasterMaterial]) material.dispose();
    this.light.shadow.map?.dispose();
    this.light.dispose();
  }

  private apply(): void {
    const { azimuth, altitude, light, shade, opacity = 1 } = this.spec;
    const up = altitude > 0.5;
    const a = (azimuth * Math.PI) / 180;
    const h = (Math.max(altitude, 0.5) * Math.PI) / 180;
    const direction = new THREE.Vector3(Math.sin(a) * Math.cos(h), Math.cos(a) * Math.cos(h), Math.sin(h));
    this.light.position.copy(this.centre).addScaledVector(direction, this.radius * 2);
    this.light.castShadow = up && this.shown;
    this.light.visible = this.lit.visible = this.capLit.visible = this.shown;
    cssColor(up ? light : shade, this.litMaterial.color);
    this.litMaterial.opacity = opacity;
    cssColor(shade, this.shadowMaterial.color);
    this.shadowMaterial.opacity = opacity;
    this.shadow.visible = this.capShadow.visible = up && this.shown;
  }
}
