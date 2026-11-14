# Model surface contract (planned)

MR Studio projects onto a physical 3D model. The table surface today draws a flat map seen from straight above.
The model surface adds the third dimension: the app holds a digital twin of the physical model and renders it from the projector's real position, so light lands on the right roof, wall and patch of ground.

Status: planned. Nothing in this document is built. It is the contract the mixed reality features in ROADMAP.md are built against.

## The twin

One mesh per site, in the engine's frame (local metres, the site origin at the centre, z up from the site datum).

- Default: generated from the scene the engine already has. The `dsm` gives roofs and ground, and every height step between neighbouring cells becomes a wall. No extra data is needed, so every site gets a twin.
- Optional: a mesh file in the site package (`scene.model: { path: "data/model.glb" }`) when the physical model was printed or milled from one. The scene rasters are then baked from the same mesh, so the kernels and the twin always agree.

Every surface point knows its kind (`ground`, `roof`, `wall`), its normal, and its cell in the scene grid. That last link is what lets a kernel field, computed on the grid, be painted on the right surface.

## The projector

Calibration gives each projector a camera: position, orientation, field of view and lens shift, relative to the model.
The table surface renders the twin through that camera with three.js. With the camera straight above and far away this is exactly today's flat view, so flat tables and screens keep working unchanged.
Calibration is stored per machine and site (`calibration.json`), found by matching a handful of projected markers to known model corners.

Two projectors (for example one from each side, to reach walls a single projector cannot) are two cameras on the same twin with a blend mask.

## What layers get

`ctx.model`, next to `ctx.map`. A layer that ignores it still works: its fields are draped over the twin automatically.

```ts
interface ModelHandle {
  // Paint a kernel field on the twin. `on` picks which surfaces take it.
  addField(id: string, style: FieldStyle & { colormap: Colormap; on?: ('ground' | 'roof' | 'wall')[] }): FieldOverlay;
  // Light the twin: a sun, or point and spot lights such as street lamps and lit windows.
  addLight(light: SunLight | PointLight | SpotLight): LightHandle;
  // Change how surfaces look: colour or emission per building, per surface kind, or by a data attribute.
  setMaterial(target: SurfaceQuery, material: { color?: string; emissive?: string; opacity?: number }): void;
  // Things that are not part of the physical model: a proposed building, water, particles, a cut plane.
  addObject(object: PhantomMesh | WaterSurface | ParticleSystem | ClipPlane): ObjectHandle;
  // Dim everything except a region: the spotlight for storytelling.
  focus(region: SurfaceQuery | null): void;
  // Where a table point or a pointer ray meets the twin.
  pick(x: number, y: number): { position: [number, number, number]; kind: string; building?: string } | null;
}
```

Everything added through `ctx.model` is removed with the layer, as with `ctx.map`.

## How the mixed reality features map onto it

| Feature | Uses |
| --- | --- |
| Relight the model (sun, night, street lighting) | `addLight`, twin normals; shadows from the `sunlight` kernel or the renderer's own shadow maps |
| Paint the walls (sun on facades, heat, noise, age) | `addField` with `on: ['wall']`, `setMaterial`; kernels extended to vertical surfaces |
| Make the model move (water, wind, snow, fog, sea level) | `addObject` with water and particles, driven by `stormwater` and `wind` fields |
| X-ray and time machine | `setMaterial` opacity, `addObject` clip plane, dated datasets |
| Phantom buildings | `addObject` phantom mesh, also added to the engine scene so shadows and wind respond |
| Tangible input (pointer or marker as a person) | `pick`, the table pointer block, `isovist` kernel, street view on the TV |
| Spotlight storytelling | `focus`, guided tours driving it through the host |
| Phones as lenses | the same twin and camera maths in the phone surface, aligned by a marker on the table |

## Rules

1. The twin is core. Layers never load meshes or build geometry for the site themselves.
2. Kernels stay on the grid. The twin maps grid results to surfaces; it does not compute.
3. A layer must look right on a flat table too. `ctx.model` degrades to the flat view when there is no calibration.
4. The physical model is the display. Phantom objects are marked as such in the manifest so a presenter knows what is projected and what is real.
