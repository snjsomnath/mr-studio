// The model surface: what a layer may do to the digital twin of the physical model.
// Contract in docs/contracts/model.md; change them together.
import type { Colormap } from './colormap.ts';
import type { FieldOverlay, FieldOverlayStyle } from './layer.ts';
import type { FieldFrame } from './types.ts';

export type SurfaceKind = 'ground' | 'roof' | 'wall';

/** A point in the site's local frame: metres east and north of the site origin, and up from the site datum. */
export type ModelPoint = [east: number, north: number, up: number];

/**
 * Picks surfaces of the twin. Every condition given must hold; an empty query is everything.
 * Buildings are named by the `id` of their footprint feature (or its `properties.id`), and
 * by their position in the footprints file when they have neither.
 */
export interface SurfaceQuery {
  kind?: SurfaceKind | SurfaceKind[];
  building?: string | string[];
  /** Buildings whose footprint has this property: equal to a value, one of several, or inside a range. */
  attribute?: { name: string; equals?: unknown; in?: unknown[]; min?: number; max?: number };
  /** Surfaces within `radius_m` of a point on the ground plan. */
  within?: { east: number; north: number; radius_m: number };
}

export interface SurfaceMaterial {
  /** The surface's own colour, which lights then shade. CSS colour. */
  color?: string;
  /** Light the surface gives off whatever the lighting, such as lit windows. CSS colour. */
  emissive?: string;
  /** 0 hides the surface, 1 is solid. */
  opacity?: number;
}

interface LightBase {
  /** CSS colour. Default white. */
  color?: string;
  /** 1 lights a white surface that faces the light fully. Default 1. */
  intensity?: number;
  /** Whether the twin casts shadows in this light. Default true for the sun, false otherwise. */
  shadows?: boolean;
}

export interface SunLight extends LightBase {
  type: 'sun';
  /** Compass bearing of the sun, clockwise from north, degrees. */
  azimuth: number;
  /** Angle above the horizon, degrees. At or below 0 the sun gives no light. */
  altitude: number;
  /** Light from the whole sky, so shade is not black. */
  sky?: { color?: string; intensity?: number };
}

export interface PointLight extends LightBase {
  type: 'point';
  position: ModelPoint;
  /** How far the light reaches, in metres. It is even up close and fades out towards this distance. Default 30. */
  range_m?: number;
}

export interface SpotLight extends LightBase {
  type: 'spot';
  position: ModelPoint;
  /** What the light points at. */
  target: ModelPoint;
  /** Full width of the cone, degrees. Default 60. */
  angle_deg?: number;
  /** How soft the cone's edge is, 0 (hard) to 1. Default 0.3. */
  softness?: number;
  range_m?: number;
}

export type ModelLight = SunLight | PointLight | SpotLight;

export interface LightHandle<L extends ModelLight = ModelLight> {
  /** Changes some of the light's properties. Cheap enough to call every frame. */
  set(patch: Partial<Omit<L, 'type'>>): void;
  remove(): void;
}

export interface ModelHit {
  position: ModelPoint;
  kind: SurfaceKind;
  /** The building the surface belongs to, if any. */
  building?: string;
}

export type ModelFieldStyle = FieldOverlayStyle & {
  /** Which surfaces take the field. Default ground and roof. A wall shows the value of the cell at its foot. */
  on?: SurfaceKind[];
};

/** What a layer may do to the twin. Everything added is removed with the layer. */
export interface ModelHandle {
  /** True when a projector calibration is in use; false on a flat table or screen, where the twin is seen from straight above. */
  readonly calibrated: boolean;
  /** Paints a kernel field on the twin. */
  addField(id: string, style: ModelFieldStyle & { colormap: Colormap }): FieldOverlay;
  /** Lights the twin. With any light on, unlit surfaces are dark, as on the physical model. */
  addLight<L extends ModelLight>(light: L): LightHandle<L>;
  /**
   * Sharp sun shadows over the table's extent, as a field frame to draw with a map field: 1 where the sun reaches the
   * ground or a roof, 0 in shade, about 0.3 m per pixel. It comes from a GPU shadow map of the buildings' real
   * footprints raised to their roofs, the ground and any imported model, so edges stay crisp at any table size, unlike
   * a kernel field's cells. Resolves to null where there is no twin; use the kernel's field instead. `onChange` is
   * called when the mask for the same sun would come out differently (the table's quality changed), so the layer
   * can ask again; the latest call's callback is the one kept.
   */
  sunShadowMask(sun: { azimuth: number; altitude: number }, onChange?: () => void): Promise<FieldFrame | null>;
  /** Changes how the picked surfaces look. A later call wins where two overlap. */
  setMaterial(target: SurfaceQuery, material: SurfaceMaterial): void;
  /** Dims everything except the picked surfaces. `null` ends the focus. */
  focus(region: SurfaceQuery | null, options?: { dim?: number }): void;
  /**
   * Where a point of the table image meets the twin. `x` and `y` are fractions of the
   * image from its top left corner; the ray runs through the projector's camera.
   */
  pick(x: number, y: number): ModelHit | null;
}

// ---- The twin's wire form -------------------------------------------------

export const SURFACE_KINDS: SurfaceKind[] = ['ground', 'roof', 'wall'];

export interface TwinMesh {
  /** x east, y north, z up, in metres. Three per vertex. */
  positions: Float32Array;
  /** Unit normals scaled to -127..127. Three per vertex. */
  normals: Int8Array;
  /** Index into `SURFACE_KINDS`, per vertex. */
  kinds: Uint8Array;
  /** 0 for none, otherwise the footprint feature's position in the site's buildings file plus one. */
  buildings: Uint32Array;
  indices: Uint32Array;
  minZ: number;
  maxZ: number;
}

const TWIN_HEADER_LEN = 32;

/** Parses the twin served at `/api/model`. Layout in docs/contracts/model.md. */
export function parseTwin(buffer: ArrayBuffer): TwinMesh {
  if (buffer.byteLength < TWIN_HEADER_LEN) throw new Error('twin mesh is too short');
  const view = new DataView(buffer);
  const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (magic !== 'MRSM' || view.getUint16(4, true) !== 1) throw new Error('not a version 1 twin mesh');
  const vertices = view.getUint32(8, true);
  const indices = view.getUint32(12, true);
  const expected = TWIN_HEADER_LEN + vertices * 20 + indices * 4;
  if (buffer.byteLength !== expected) throw new Error(`twin mesh is ${buffer.byteLength} bytes, expected ${expected}`);
  let offset = TWIN_HEADER_LEN;
  const positions = new Float32Array(buffer, offset, vertices * 3);
  offset += vertices * 12;
  const packed = new Uint8Array(buffer, offset, vertices * 4);
  offset += vertices * 4;
  const normals = new Int8Array(vertices * 3);
  const kinds = new Uint8Array(vertices);
  for (let i = 0; i < vertices; i++) {
    // Bytes above 127 are negative components.
    for (let c = 0; c < 3; c++) normals[i * 3 + c] = (packed[i * 4 + c]! << 24) >> 24;
    kinds[i] = packed[i * 4 + 3]!;
  }
  const buildings = new Uint32Array(buffer, offset, vertices);
  offset += vertices * 4;
  return {
    positions,
    normals,
    kinds,
    buildings,
    indices: new Uint32Array(buffer, offset, indices),
    minZ: view.getFloat32(16, true),
    maxZ: view.getFloat32(20, true),
  };
}
