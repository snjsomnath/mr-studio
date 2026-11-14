// The building blocks layers are composed from (principle 7 in docs/ARCHITECTURE.md).
// Each block names a pattern that proves it exists in the core source; the status is
// worked out from the code at load time, so this list never claims more than is built.

export type BlockGroup = 'visual' | 'data' | 'interaction' | 'tv';

export interface BlockDef {
  id: string;
  group: BlockGroup;
  name: string;
  description: string;
  /** How a layer uses it, once built. */
  usage: string;
  /** A regular expression matched against the SDK, runtime and dashboard sources. */
  detect: string;
  /** Roadmap layers that are waiting for it. */
  unlocks?: string[];
}

export const BLOCKS: BlockDef[] = [
  // Visual
  {
    id: 'field-overlay', group: 'visual', name: 'Field overlay',
    description: 'A kernel field drawn over the table with a colormap, soft edges and frames that glide in.',
    usage: "ctx.map.addField(id, { colormap, opacity, soften, glide }) then overlay.set(frame)",
    detect: 'addField\\(',
  },
  {
    id: 'colormaps', group: 'visual', name: 'Colormaps',
    description: 'Named colour ramps for fields and legends.',
    usage: "import { colormaps } from '@mrstudio/sdk'",
    detect: 'export const colormaps',
  },
  {
    id: 'table-decoration', group: 'visual', name: 'Table decoration',
    description: 'A layer-owned element covering the table for SVG or canvas drawings such as the sun path.',
    usage: 'ctx.map.addElement()',
    detect: 'addElement\\(',
  },
  {
    id: 'particles', group: 'visual', name: 'Particles and flow lines',
    description: 'Tracers that follow a vector field (wind, water), drawn as ribbons or dots.',
    usage: 'ctx.map.addFlow(...) with a FlowField built from u and v fields',
    detect: 'class Tracers|interface FlowOverlay',
    unlocks: ['Wind comfort', 'Air quality plumes', 'Rain and stormwater', 'Mobility flows'],
  },
  {
    id: 'canvas-overlay', group: 'visual', name: 'Canvas overlay',
    description: 'A projected canvas in site coordinates for custom drawing of geometry from site data.',
    usage: 'ctx.map.addCanvas(...)',
    detect: 'interface CanvasOverlay',
  },
  {
    id: 'shapes', group: 'visual', name: 'Shapes and markers',
    description: 'Points, lines and polygons in WGS84 drawn on the table, for pins, rings and phone drawings.',
    usage: 'ctx.map.addShapes(...)',
    detect: 'interface ShapeOverlay',
    unlocks: ['Annotations', 'Social layers (surveys, phone pins)', 'Live city pulse'],
  },
  {
    id: 'animated-paths', group: 'visual', name: 'Animated paths',
    description: 'Things moving along lines: cars, buses, people, from site data or generated paths.',
    usage: 'planned',
    detect: 'AnimatedPaths|addPaths\\(',
    unlocks: ['Traffic', 'Public transport', 'Ambient cars, people'],
  },
  {
    id: 'choropleth', group: 'visual', name: 'Choropleth',
    description: 'Polygons from a dataset filled by a property through a colormap, with a legend.',
    usage: 'planned',
    detect: 'addChoropleth|Choropleth',
    unlocks: ['Building heights and age', 'Green and blue areas', 'Carbon and materials'],
  },
  {
    id: 'lit-buildings', group: 'visual', name: 'Lit buildings',
    description: 'Light and colour on roofs and walls of the physical model, from the model surface.',
    usage: 'planned (ctx.model, docs/contracts/model.md)',
    detect: 'ctx\\.model|interface ModelHandle',
    unlocks: ['Building lights', 'Facade daylight', 'Night light and light pollution'],
  },
  {
    id: 'legend', group: 'visual', name: 'Legend',
    description: 'A colour ramp with units, on the table or as a TV panel.',
    usage: "TV: a 'ramp' panel; table: draw with cssGradient(colormap) in addElement()",
    detect: "cssGradient|type: 'ramp'",
  },

  // Data
  {
    id: 'site-scene', group: 'data', name: 'Site scene',
    description: 'Terrain, buildings and trees baked once to a grid and shared by every kernel.',
    usage: "site.json 'scene'; kernels read it, layers never do",
    detect: 'interface Grid',
  },
  {
    id: 'kernel-stream', group: 'data', name: 'Kernel stream',
    description: 'Open a kernel with params and receive its fields as frames.',
    usage: "await ctx.engine.open(kernel, params, fields)",
    detect: 'class EngineClient',
  },
  {
    id: 'site-datasets', group: 'data', name: 'Site datasets',
    description: 'GeoJSON or JSON files in the site folder, declared by the layer and loaded by name.',
    usage: "requires.data in layer.json, loadSiteData(ctx.site, name)",
    detect: 'export async function loadSiteData',
  },
  {
    id: 'projection', group: 'data', name: 'Site projection',
    description: 'Convert between WGS84, local metres and table coordinates.',
    usage: "siteProjection(ctx.site), tableToLonLat, lonLatToTable",
    detect: 'export function siteProjection|export function tableToLonLat',
  },
  {
    id: 'live-feed', group: 'data', name: 'Live feed',
    description: 'A polled or streamed external source (transit positions, sensors) relayed by the host.',
    usage: 'planned',
    detect: 'LiveFeed|openFeed\\(',
    unlocks: ['Public transport', 'Live city pulse'],
  },
  {
    id: 'service', group: 'data', name: 'Service gateway',
    description: 'A Python service declared in the manifest and reached through the host, for research models.',
    usage: "planned: requires.services in layer.json",
    detect: 'ctx\\.services|ServiceClient',
    unlocks: ['Energy and solar flows (ECOM generalised)', 'Street-level walk-through'],
  },

  // Interaction
  {
    id: 'controls', group: 'interaction', name: 'Generated controls',
    description: 'range, select, toggle, date, color, text and action controls declared in layer.json; the TV and phone UIs are generated from them.',
    usage: "layer.json 'controls'; set 'phone': true to let phones change one",
    detect: 'interface RangeControl',
  },
  {
    id: 'time-control', group: 'interaction', name: 'Time control',
    description: 'Date, hour and play controls with site-timezone conversion.',
    usage: "date + range(hour) + toggle(play) controls, zonedTimeToUtc(date, hour, ctx.site.timezone)",
    detect: 'export function zonedTimeToUtc',
  },
  {
    id: 'sun-position', group: 'interaction', name: 'Sun position',
    description: 'Azimuth and altitude of the sun for a time and place.',
    usage: "sunPosition(utcMs, lat, lon)",
    detect: 'export function sunPosition',
  },
  {
    id: 'scenario-switch', group: 'interaction', name: 'Scenario switch',
    description: 'A select control whose options swap the dataset or params a layer uses.',
    usage: "a 'select' control; the layer maps each option to data or params",
    detect: 'interface SelectControl',
  },
  {
    id: 'phone-tools', group: 'interaction', name: 'Phone tools',
    description: 'Tap a point, draw a line or polygon on a phone; the layer receives it in WGS84.',
    usage: "layer.json 'tools': [{ id, type: 'point' | 'line' | 'polygon', label }], handled in tool(input)",
    detect: 'export type ToolGeometry',
  },
  {
    id: 'table-pointer', group: 'interaction', name: 'Table pointer',
    description: 'A physical pointer or marker on the table driving a person marker, view cone or magnifier.',
    usage: 'planned',
    detect: 'TablePointer|onPointer\\(',
    unlocks: ['Isovist and view sheds', 'Street-level walk-through', 'Acoustic listener', 'Walk and cycle isochrones'],
  },

  // TV
  {
    id: 'tv-panels', group: 'tv', name: 'TV panels',
    description: 'Declarative dashboard panels (stat, bars, series, ramp, timeline, text) on a 12 by 6 grid with a density budget.',
    usage: "layer.json 'panels' or site.json 'tv.pages' (docs/contracts/dashboard.md)",
    detect: 'interface PanelSpec',
  },
  {
    id: 'tv-custom-panel', group: 'tv', name: 'Custom TV panel',
    description: 'A layer module may draw its own TV panel with panel(ctx, el).',
    usage: 'panel(ctx, el) in the layer module',
    detect: 'interface PanelHandlers',
  },
];
