# Model surface contract

MR Studio projects onto a physical 3D model. The table surface used to draw a flat map seen from straight above.
The model surface adds the third dimension: the app holds a digital twin of the physical model and renders it from the projector's real position, so light lands on the right roof, wall and patch of ground.

Status: the core is built. The twin, the renderer, the projector camera, calibration and the first five `ctx.model` calls work and are tested. What is still planned is marked **planned** below.

## The twin

One mesh per site, in the site's local frame: x east, y north, z up from the site datum, in metres, with the site origin at the centre.

- Default: generated from the scene the engine already has (`mrs_engine::TwinMesh`). The `dtm` becomes a smooth ground sheet, every solid cell of the `dsm` a flat piece of roof, and every height step between neighbouring cells a wall. Neighbouring pieces of the same height are merged. No extra data is needed, so every site gets a twin.
- **Planned**: a mesh file in the site package (`scene.model: { path: "data/model.glb" }`) when the physical model was printed or milled from one. The scene rasters are then baked from the same mesh, so the kernels and the twin always agree.

Every vertex knows its kind (`ground`, `roof`, `wall`), its normal, and the building it belongs to. A building's number is its footprint feature's position in the site's buildings file plus one, and 0 means none. A surface point's cell in the scene grid follows from its position, which is what lets a kernel field, computed on the grid, be painted on the right surface.

A wall that runs at an angle to the grid is a staircase of cell edges. Its normals are those of the facade it stands for, so it shades as one plane.

The host builds the twin once at start and serves it at `GET /api/model`. Little endian:

| Offset | Type | Meaning |
| --- | --- | --- |
| 0 | 4 bytes | `MRSM` |
| 4 | u16 | version, 1 |
| 6 | u16 | reserved |
| 8 | u32 | vertex count `V` |
| 12 | u32 | index count `I` |
| 16 | f32 | lowest z |
| 20 | f32 | highest z |
| 24 | 8 bytes | reserved |
| 32 | f32 × 3V | positions |
| | 4 bytes × V | per vertex: normal as three i8 (× 127), then the kind as u8 (0 ground, 1 roof, 2 wall) |
| | u32 × V | building number |
| | u32 × I | triangle indices, counter-clockwise seen from outside |

`parseTwin` in the SDK reads it.

## The projector

Calibration gives the projector a camera: position, orientation, field of view and lens shift, relative to the model.
The table surface renders the twin through that camera with three.js, on a canvas over the flat map.

- **Flat** (no calibration, and always on the dev surface unless its address has `?projector`): the camera looks straight down and matches the flat map pixel for pixel, so flat tables and screens keep working unchanged.
- **Projector** (the `table` surface, once a calibration is saved): the camera is the solved one. A projector that shows its image through a mirror is recognised and handled.

Calibration is stored per machine and site, by the host, in the site folder's `calibration.json` under the `projector` key. Other keys in that file (the flat table's `table` view) are left alone.

```jsonc
{
  "projector": {
    "version": 1,
    "matrix": [/* 12 numbers: the 3 x 4 projection, row by row, local metres to image pixels */],
    "image": { "width": 1920, "height": 1080 },        // the image size the matrix was solved for
    "pairs": [{ "model": [-500, 300, 14], "image": [212.5, 96], "label": "The top left corner of the model's base" }],
    "error_px": 1.3,                                    // how far the solved camera is from the markers, on average
    "camera": {                                         // the same camera in plain terms, for people
      "position": [-150, -700, 650], "heading_deg": 12.4, "pitch_deg": 42.1,
      "fov_deg": { "horizontal": 66.2, "vertical": 38.4 }, "lens_shift": { "x": 0, "y": 0.025 }, "mirrored": false
    },
    "saved_at": "2026-11-14T15:00:00Z"
  }
}
```

Only `matrix` and `image` are needed to render; the rest is for the tool and for people. Image coordinates are pixels from the top left corner of the table surface, y down. The view scales with the window, so the window must keep the shape it had when it was calibrated.

### The calibration tool

The tool runs on the table surface, because the person must see the projector's light on the model. It opens with `?calibrate` in the address, with Shift+C on the surface, or when any controller sends the `calibration.mode` request (this is how the desktop shell's calibration tab starts it).

1. The tool proposes ten corners: the four corners of the model's base and six roof corners chosen to be far apart and at different heights. It names each one and rings it on a plan.
2. The person moves a projected marker (click, drag or arrow keys) until its light sits on that corner of the physical model. A corner that cannot be found is skipped.
3. From six placed corners on, the camera is solved after every change (`solveProjector` in the SDK: a direct linear transform, then a refinement that measures the error in pixels). The twin is shown through the solved camera, lit plainly, so the person sees at once whether it lands on the model.
4. Save sends `calibration.set`. Every surface hears about it and the table switches to the new camera.

The corners must not all lie in one plane, which is why the tool mixes roofs with the base.

**Planned**: two projectors (for example one from each side, to reach walls a single projector cannot) as two cameras on the same twin with a blend mask; a four-corner keystone for flat tables with no model.

## What layers get

`ctx.model`, next to `ctx.map`. A layer that ignores it still works: whatever it draws through `ctx.map` is laid over the twin's ground and roofs automatically.

```ts
interface ModelHandle {
  // True when a projector calibration is in use; false on a flat table or screen.
  readonly calibrated: boolean;
  // Paint a kernel field on the twin. `on` picks which surfaces take it; the default is ground and roof.
  // A wall shows the value of the grid cell at its foot.
  addField(id: string, style: FieldStyle & { colormap: Colormap; on?: ('ground' | 'roof' | 'wall')[] }): FieldOverlay;
  // Light the twin: a sun, or point and spot lights such as street lamps and lit windows.
  addLight<L extends SunLight | PointLight | SpotLight>(light: L): LightHandle<L>;
  // Change how surfaces look: colour, emission or opacity. A later call wins where two overlap.
  setMaterial(target: SurfaceQuery, material: { color?: string; emissive?: string; opacity?: number }): void;
  // Dim everything except a region: the spotlight for storytelling. `null` ends it.
  focus(region: SurfaceQuery | null, options?: { dim?: number }): void;
  // Where a point of the table image meets the twin. x and y are fractions of the image from its top left corner.
  pick(x: number, y: number): { position: [number, number, number]; kind: 'ground' | 'roof' | 'wall'; building?: string } | null;
}

// Picks surfaces. Every condition given must hold; an empty query is everything.
interface SurfaceQuery {
  kind?: SurfaceKind | SurfaceKind[];
  building?: string | string[];        // footprint feature `id`, or `properties.id`, or its position in the file
  attribute?: { name: string; equals?: unknown; in?: unknown[]; min?: number; max?: number };   // a footprint property
  within?: { east: number; north: number; radius_m: number };
}

interface SunLight   { type: 'sun'; azimuth: number; altitude: number; color?: string; intensity?: number; shadows?: boolean;
                       sky?: { color?: string; intensity?: number } }
interface PointLight { type: 'point'; position: [number, number, number]; color?: string; intensity?: number; range_m?: number; shadows?: boolean }
interface SpotLight  { type: 'spot'; position: [number, number, number]; target: [number, number, number]; angle_deg?: number;
                       softness?: number; color?: string; intensity?: number; range_m?: number; shadows?: boolean }
interface LightHandle<L> { set(patch: Partial<L>): void; remove(): void }
```

Everything added through `ctx.model` is removed with the layer, as with `ctx.map`.

How it behaves:

- An intensity of 1 lights a white surface that faces the light fully. Positions are in the local frame.
- The sun's shadows come from the renderer's shadow map of the twin, so they fall on walls and roofs as well as the ground. Trees are not part of the twin; their shade stays a kernel field.
- With any light on, or any material set, the twin is drawn solid and unlit surfaces are dark, as on the physical model. With neither, the twin is invisible and only its fields show, so a layer that uses none of this looks as it did.
- With no light on, a `color` shows as the surface's own light, so colouring buildings works on its own.
- `within` is exact for `focus`. For `setMaterial` it is tested at the mesh's vertices, so it suits whole buildings better than circles on the ground.
- Colours are any CSS colour.
- Without a twin (an old host, or a device with no WebGL) `addField` draws on the flat map and the other calls do nothing.

**Planned**: `addObject(object: PhantomMesh | WaterSurface | ParticleSystem | ClipPlane): ObjectHandle` for things that are not part of the physical model: a proposed building, water, particles, a cut plane.

## How the mixed reality features map onto it

| Feature | Uses | State |
| --- | --- | --- |
| Relight the model (sun, night, street lighting) | `addLight`, twin normals, the renderer's shadow maps | Built; the sunlight layer's "Light the 3D model" uses it |
| Paint the walls (sun on facades, heat, noise, age) | `addField` with `on: ['wall']`, `setMaterial`; kernels extended to vertical surfaces | Surface side built; kernels on walls planned |
| Make the model move (water, wind, snow, fog, sea level) | `addObject` with water and particles, driven by `stormwater` and `wind` fields | Planned |
| X-ray and time machine | `setMaterial` opacity, `addObject` clip plane, dated datasets | Opacity built |
| Phantom buildings | `addObject` phantom mesh, also added to the engine scene so shadows and wind respond | Planned |
| Tangible input (pointer or marker as a person) | `pick`, the table pointer block, `isovist` kernel, street view on the TV | `pick` built |
| Spotlight storytelling | `focus`, guided tours driving it through the host | `focus` built |
| Phones as lenses | the same twin and camera maths in the phone surface, aligned by a marker on the table | Maths in the SDK (`projector.ts`, `parseTwin`) |

## Rules

1. The twin is core. Layers never load meshes or build geometry for the site themselves.
2. Kernels stay on the grid. The twin maps grid results to surfaces; it does not compute.
3. A layer must look right on a flat table too. `ctx.model` degrades to the flat view when there is no calibration.
4. The physical model is the display. Phantom objects are marked as such in the manifest so a presenter knows what is projected and what is real.
5. A layer's own elements (`ctx.map.addElement`) are drawn flat over the image. Through a calibrated projector they do not follow the model, so anything that must land on a surface goes through `ctx.model` or a field.
