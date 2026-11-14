# Layer roadmap

Every layer on this list is built the same way (principle 7 in ARCHITECTURE.md): a kernel in the engine when there is something heavy to compute, shared building blocks from the SDK for visuals, data and interaction, and a short layer package that composes them. Nothing here is a one-off.

The columns say what each layer reuses. A kernel or block in **bold** is new with that layer; everything else already exists or arrives with an earlier layer.

Building blocks referred to below:

- **Visual**: field overlay (soft edges, gliding frames, colormaps), particles, flow lines, markers and rings, choropleth, extruded or lit buildings, legend, chart, table decoration.
- **Data**: site scene (terrain, buildings, trees), site datasets (GeoJSON, rasters), live feed, service (Python behind the gateway), kernel stream.
- **Interaction**: time control (date, hour, play), table pointer (person marker, magnifier), phone tools (point, line, polygon), scenario switch.

Status: only sunlight is built. Wind is next, and the kernels after it start once wind has proved the pattern for iterative simulations.

## Climate

| Layer | Kernel | Blocks |
| --- | --- | --- |
| Sun and shadow | `sunlight` (built) | field overlay, time control, table decoration (sun path), chart |
| Wind comfort | **`wind`** (lattice Boltzmann) | field overlay, **particles**, legend, phone tools (draw obstacles) |
| Rain and stormwater | **`stormwater`** (flow routing, ponding) | field overlay, particles, time control |
| Urban heat and thermal comfort | **`thermal`**, reading `sunlight` and `wind` | field overlay, time control, legend |
| Facade daylight | `sunlight` extended to vertical surfaces | lit buildings, legend |
| Air quality plumes | **`plume`** (advection on the `wind` field) | field overlay, particles, phone tools (place a source) |
| Snow drift | **`drift`** (deposition on the `wind` field) | field overlay, time control |
| Flood futures (sea level, cloudburst) | `stormwater` with a water level or rain scenario | field overlay, scenario switch, time control |

## Perception

| Layer | Kernel | Blocks |
| --- | --- | --- |
| Isovist and view sheds | **`isovist`** (ray cast over the scene) | field overlay, table pointer (person marker), phone tools |
| Street-level walk-through | none; a street view service | table pointer (person marker), TV panel media |
| Traffic noise | **`noise`** (propagation with building screening) | field overlay, site datasets (roads), legend |
| Acoustic listener | `noise` sampled at a point | table pointer, audio output |

## Movement

| Layer | Kernel | Blocks |
| --- | --- | --- |
| Traffic | none | **animated paths**, site datasets (roads) |
| Public transport | none | animated paths, live feed or timetable dataset, markers |
| Walk and cycle isochrones | **`isochrone`** (cost distance on the grid or network) | field overlay, table pointer, phone tools |
| Mobility flows | none | flow lines, site datasets |

## City life

| Layer | Kernel | Blocks |
| --- | --- | --- |
| Ambient cars, people | none | animated paths, markers |
| Building lights | none | lit buildings, time control |
| Trees | none | markers, site scene (trees) |
| Day, night and seasons | `sunlight` for the light | time control, field overlay |
| Biodiversity corridors | `isochrone` with a habitat cost | field overlay, flow lines |
| Live city pulse | none | live feed, markers and rings |
| Social layers (surveys, phone pins) | none | phone tools, markers, choropleth |
| Night light and light pollution | none, or `isovist` from light sources | field overlay, lit buildings |

## Base

| Layer | Kernel | Blocks |
| --- | --- | --- |
| Dark and light maps | none | basemap style |
| Terrain | none | field overlay on the scene's `dtm` |
| Building heights and age | none | choropleth, legend |
| Green and blue areas | none | choropleth |
| Time machine (1900 to future) | none | time control over dated datasets, scenario switch |

## Storytelling

| Layer | Kernel | Blocks |
| --- | --- | --- |
| Slideshow | none | TV panel media |
| Guided tours | none | a script that drives other layers' params through the host |
| Scenario compare | none | scenario switch, split view |
| Annotations | none | phone tools, markers |

## Analysis

| Layer | Kernel | Blocks |
| --- | --- | --- |
| CoolPaths | `isochrone` with a cost from `thermal` and `sunlight` | flow lines, table pointer |
| Energy and solar flows (ECOM generalised) | `sunlight` for roof potential; a service for the energy model | flow lines, chart, choropleth |
| Carbon and materials | none | choropleth, chart |
| What-if sandbox | every kernel, by editing the scene | phone tools (add or remove buildings and trees), scenario switch |

## What this adds up to

About forty layers need eight new kernels (`wind`, `stormwater`, `thermal`, `plume`, `drift`, `isovist`, `noise`, `isochrone`) and around a dozen blocks. Several kernels feed others: `plume` and `drift` read the wind field, `thermal` reads sun and wind, and CoolPaths reads thermal. That is why the engine keeps one scene and lets a kernel take another kernel's field as input, which is the one engine feature this roadmap still needs.
