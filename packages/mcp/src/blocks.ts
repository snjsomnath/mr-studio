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
    id: 'sprites', group: 'visual', name: 'Moving sprites',
    description: 'Many small pictures (lights, vehicles, people, crowns) stamped by the graphics card each frame; the fast way to animate thousands of things on the table.',
    usage: "ctx.map.addSprites(id, images, { blend: 'add' }) then sprites.set(buffer) with SPRITE_FLOATS numbers per sprite",
    detect: 'interface SpriteOverlay',
    unlocks: ['Traffic and transit', 'Flowing street lights', 'Crowds'],
  },
  {
    id: 'strokes', group: 'visual', name: 'Moving lines',
    description: 'Lines that change every frame (trails behind vehicles, wakes), each with a width and alpha per point, drawn by the graphics card.',
    usage: 'ctx.map.addStrokes(id) then strokes.set([{ points, colour, width, alpha }])',
    detect: 'interface StrokeOverlay',
    unlocks: ['Transit trails', 'Ferry wakes', 'Tracks behind moving things'],
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
    usage: 'pathHeads(paths, time) from @mrstudio/sdk; Traffic, Public transport and Street life use it',
    detect: 'AnimatedPaths|addPaths\\(|export function pathHeads',
    unlocks: ['Traffic', 'Public transport', 'Ambient cars, people'],
  },
  {
    id: 'choropleth', group: 'visual', name: 'Choropleth',
    description: 'Polygons from a dataset filled by a property through a colormap, with a legend.',
    usage: "a custom layer's Look block: zones coloured by a column, with class breaks (save_custom_layer)",
    detect: 'addChoropleth|Choropleth|export function paintScale',
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

  {
    id: 'marks', group: 'visual', name: 'Marks, icons and arrows',
    description: 'Point shapes (circle, square, diamond, triangle, ring, icon), a built-in icon set, and arrows at line ends or along lines.',
    usage: "the custom layer builder's Look block (save_custom_layer), or traceShape/fillIcon/arrowMarks from @mrstudio/sdk",
    detect: 'export function traceShape',
  },
  {
    id: 'place-motions', group: 'visual', name: 'Place motions',
    description: 'A gallery of 22 looping animations for places (pulses, circular waves, cultural gravity, lit blocks) driven by a table of places.',
    usage: "a custom layer's Motion block, or placeMotion(id) from @mrstudio/sdk",
    detect: 'export const PLACE_MOTIONS',
  },
  {
    id: 'network-flows', group: 'visual', name: 'Network of flows',
    description: 'Nodes joined by links whose flows follow a time series (#280): links widen and carry travelling lights as busy as the flow, rings travel out of nodes that give and into nodes that take, gauges fill from a level series, and links without a line of their own follow the streets. One shared play head walks the series; the controller gets Play and Time. Fits energy communities, district heating, stormwater pipes and commuter flows.',
    usage: "a custom layer's 'network' motion on a points look (props links, series, streets, flow, gauge, step_s, width_mm, heads, speed_mm, rings, gauges; save_custom_layer), or networkData + networkLook from @mrstudio/sdk. Data: links CSV from,to; series CSV time,id or from,to, flow, level; or, with no series, a list of flows on each link named by flow (e.g. flow_hourly: [3,5,2]) plays one step each. The builder's 'Energy network' test data shows the shape",
    detect: 'export function networkData',
    unlocks: ['Energy communities (ECOM, #192)', 'District heating and pipe networks', 'Commuter flows between places'],
  },
  {
    id: 'team-widgets', group: 'visual', name: 'Team widgets',
    description: "A layer package's own kinds of dashboard panel (#353), held to the core widgets' contract: sizes, labelled props, bindings to published values, theme tokens and an honest read cost in the density budget. Known on the site as <layer>/<type>.",
    usage: "defineWidget from @mrstudio/sdk, listed in the layer module's widgets; panels name it by type (own layer) or <layer>/<type> (TV pages). checkWidget says what is wrong. See docs/contracts/dashboard.md, Adding a widget",
    detect: 'export function defineWidget',
    unlocks: ['Panels no core widget covers, such as an energy community grid link', 'Trying a widget in one site before it moves into core'],
  },
  {
    id: 'sound-voices', group: 'visual', name: 'Sound voices',
    description: 'A sound bed of up to four slow voices (filtered noise, a hum with harmonics, a tone) declared in layer.json, whose level and colour follow published values or controls (#282). One level ceiling for the whole bed, slow glides, table only, muted by the controller Sound switch.',
    usage: "layer.json 'sound': [{ id, kind noise|hum|tone, level, centre, width, frequency, harmonics, glide_s }], each value a number or { bind: 'shared.<key>' or 'params.<id>', from, to, curve }. Or VoiceBed from @mrstudio/sdk. See docs/contracts/layer.md, Sound voices",
    detect: 'export class VoiceBed',
    unlocks: ['Hearing grid import in an energy community (ECOM, #192)', 'Traffic noise that follows a scenario', 'Calm ambient beds for exhibitions'],
  },
  {
    id: 'palette', group: 'visual', name: 'Table palette',
    description: "The table's named colour slots (accent, warm, cool, categories) that every layer and the custom builder colour from, with a warning for colours a projector washes out.",
    usage: "site.json 'palette' (update_site), resolvePalette(site.palette) in a layer",
    detect: 'export const PALETTE_SLOTS',
  },
  {
    id: 'custom-layer', group: 'visual', name: 'Custom layer recipe',
    description: "A layer made without code: data, look (points, lines, zones, rasters coloured by data), motion and interaction blocks, saved in the site and played by the runtime.",
    usage: "save_custom_layer, then add_layer with use 'custom:<id>' (docs/contracts/site.md, Custom layers)",
    detect: 'export function compileLook',
  },
  {
    id: 'expressions', group: 'data', name: 'Safe expressions',
    description: "A small formula language in JSON (#669), no code: work out a value from a feature's columns or the layer's live values (\"kWh per m²\", \"newer than the year on the slider\"), pick a colour by thresholds, or keep only some features. Panels take { \"expr\": [...] } wherever a value can be bound; custom layer looks take 'columns' and 'where'.",
    usage: "panel props { \"expr\": [\"/\", [\"bind\", \"shared.kwh\"], [\"bind\", \"site.area\"]] }; look props columns { name: expr } and where: expr (docs/contracts/expressions.md); evaluateExpression() in a layer",
    detect: 'export function compileExpression',
  },
  {
    id: 'dataset-panels', group: 'data', name: 'Panels from a dataset',
    description: "A TV or controller panel that reads a table dataset (CSV or GeoJSON) and reduces it (#670), with no layer and no code: a sum, average, min, max, count or the latest value, filtered by an expression, grouped into a list for bars, a list or a donut, and following the shared play head through a time column.",
    usage: "panel props { \"data\": \"energy\", \"sum\": \"kwh\", \"where\": expr, \"group_by\": \"building\", \"time\": \"hour\", \"at\": [\"bind\", \"params.hour\"] } (docs/contracts/dashboard.md, Panels from a dataset); runDataQuery() in a layer",
    detect: 'export function runDataQuery',
  },
  {
    id: 'raster-look', group: 'visual', name: 'Raster look with Dig',
    description: 'A GeoTIFF of values (soil depth, rock surface, noise) coloured by value on the table grid, with cut-offs a slider moves so the ground peels away, and a glow along the cut.',
    usage: "a custom layer look block 'raster' on a data:<name> GeoTIFF; bind a range control to look.<id>.hide_below",
    detect: 'export function rasterPicture',
  },
  {
    id: 'entity-log', group: 'interaction', name: 'Log of layers on the controller',
    description: "Tap a well or borehole and the controller draws its layers top down from another dataset, coloured by material (clay, sand, rock).",
    usage: "tap-info props.log { data, key, from, to, material, note } (docs/contracts/site.md)",
    detect: 'export function logLayers',
  },
  {
    id: 'category-schemes', group: 'visual', name: 'Category colour schemes',
    description: 'Colour schemes for categories (land use, building kinds) that match the table palette.',
    usage: 'categoryScheme(name) / schemeFor(values) from @mrstudio/sdk',
    detect: 'export function categoryScheme',
  },
  {
    id: 'hero', group: 'visual', name: 'Controller hero',
    description: "The big picture at the top of a layer's controller stage: a timeline, a compass dial, a speed band.",
    usage: "timelineHero(el, ...) in a layer's panel; layer.json 'hero'",
    detect: 'export function timelineHero',
  },
  {
    id: 'ribbons', group: 'visual', name: 'Table ribbons',
    description: "At-a-glance strips in the projector's blank space around the model, on any side, sized from the table and the projector.",
    usage: "site.json 'table.ribbons' and 'table.front' (update_site); panels as for the TV",
    detect: 'export function ribbonBands',
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
    usage: 'liveSource(url, { every_s }) from @mrstudio/sdk; keys for services such as Västtrafik are set in the app under Sources and keys, and the host signs the requests',
    detect: 'LiveFeed|openFeed\\(|export function liveSource',
    unlocks: ['Public transport', 'Live city pulse'],
  },
  {
    id: 'service', group: 'data', name: 'Service gateway',
    description: "A model or API beside the table (a Python optimiser in its own venv) or elsewhere, started and kept running by the host (#278): quick calls, long jobs with progress, and the last answer kept for when it is down.",
    usage: "site.json 'services' (run or url); in the layer, requires.services and ctx.service(id).get/post/job; publish 'busy' while it works (samples/service-example)",
    detect: 'export function serviceClient',
    unlocks: ['Energy and solar flows (ECOM generalised)', 'Flood or noise models run on demand', 'Street-level walk-through'],
  },

  {
    id: 'site-model', group: 'data', name: '3D model of the place',
    description: "An imported model (OBJ, glTF, STL) placed on the site and snapped to the buildings; the engine casts its shadows, the table stays 2D.",
    usage: "the editor's Your place step; parseTwin from @mrstudio/sdk reads the model's surfaces",
    detect: 'export function parseTwin',
  },
  {
    id: 'engine-probe', group: 'data', name: 'Point questions to a kernel',
    description: 'Ask a kernel about one spot (how many sun hours here, in each season) without streaming a whole field.',
    usage: "ctx.engine.probe(kernel, params, [lon, lat])",
    detect: 'probe<T',
  },
  {
    id: 'street-network', group: 'data', name: 'Street network',
    description: 'OSM streets as a graph by road class, for routing walkers, cyclists, cars and buses, and points along streets.',
    usage: 'new StreetGraph(lines) from @mrstudio/sdk',
    detect: 'export class StreetGraph',
  },
  {
    id: 'thermal-comfort', group: 'data', name: 'Thermal comfort (PET)',
    description: 'Physiological equivalent temperature from sun, shade, wind and air temperature, with its colour scale and words.',
    usage: 'pet(...), petColormap(), petFeeling(value) from @mrstudio/sdk',
    detect: 'export function pet\\(',
  },
  {
    id: 'view-analysis', group: 'data', name: 'Isovist and view',
    description: 'What a person standing at a spot can see, from the site buildings and tree crowns, and the green share of the view.',
    usage: 'viewScene(buildings), isovist(scene, ...) from @mrstudio/sdk',
    detect: 'export function isovist\\(',
  },

  // Interaction
  {
    id: 'controls', group: 'interaction', name: 'Generated controls',
    description: 'range, select, toggle, date, color, text and action controls declared in layer.json; the TV and phone UIs are generated from them.',
    usage: "layer.json 'controls'; set 'phone': true to let phones change one",
    detect: 'interface RangeControl',
  },
  {
    id: 'entities', group: 'interaction', name: 'Entity inspector',
    description: "Things on the table a visitor picks and changes one by one (#279), such as the buildings of an energy community: a tap on the table picks one, the controller shows its own controls under its name, with Back to default and Apply to all of a group. The host checks and keeps the values; no layer code for the picking or the controls.",
    usage: "layer.json 'entities' (id, dataset, key, label, group, name, controls, debounce_ms); read with ctx.entity(set, id), react in the table's entities(changed) handler; ctx.selection / ctx.select for the pick",
    detect: 'export function entityValues',
    unlocks: ['Energy and solar flows (ECOM generalised)', 'Per-building scenarios and what-ifs'],
  },
  {
    id: 'controller-stage', group: 'interaction', name: 'Controller stage and map',
    description: "A layer's own app in the controller's centre (#283): a map of the site in the table's orientation with its buildings and streets, where taps become points, routes or areas sent to the table as tool inputs, and buttons press named actions that start animations on the table. Routes can follow the streets (StreetGraph.route).",
    usage: "layer.json stage: { panels: [...], controls? } for a no-code stage of dashboard panels (map, control, gauge, team widgets; #357), or stage: 'custom' and 'actions'; the module's stage(ctx, el) with controllerMap(el, ctx, { mode, points, onPick, onDraw, draw }); ctx.sendTool and ctx.action reach the table's tool() and action() handlers (samples/controller-map-example)",
    detect: 'export function controllerMap',
    unlocks: ['Custom map apps on the controller', 'Route and journey planners'],
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
    id: 'step-transitions', group: 'interaction', name: 'Step transitions',
    description: 'How a slideshow or sequence moves from one step to the next: a cut, a fade or a dip to black, with its length.',
    usage: "set_steps with 'transition' on the sequence or a step; stepTransition(steps, index) from @mrstudio/sdk",
    detect: 'export function stepTransition',
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
    description: 'A mouse or touch pick on the table map (or in the editor) that reaches the layer as a point, driving a person marker, view cone or route end.',
    usage: "layer.json 'tools' with a point tool; picks on the table reach the layer through ctx.sendTool (Cool paths and Isovist use it)",
    detect: 'TablePointer|onPointer\\(',
    unlocks: ['Isovist and view sheds', 'Street-level walk-through', 'Acoustic listener', 'Walk and cycle isochrones'],
  },

  {
    id: 'sound', group: 'interaction', name: 'Sound',
    description: 'Sound cards on the controller, a step that plays a sound, and soundscapes mixed from the view.',
    usage: 'SoundStage and Soundscape from @mrstudio/sdk; sound files in site data',
    detect: 'export class SoundStage',
  },
  {
    id: 'languages', group: 'interaction', name: 'Languages',
    description: "Visitors switch between English and Swedish; the site's own words are translated in site.json.",
    usage: "site.json 'branding.languages' and 'branding.translations'; a layer's words in its locales/ folder",
    detect: 'export function setLanguage',
  },
  {
    id: 'guided-tour', group: 'interaction', name: 'Guided tour',
    description: "A slideshow of layers with presenter notes on each step, driven from the guide's phone; visitors never see the notes.",
    usage: "set_steps with a sequence whose steps carry 'notes'",
    detect: "guide's phone",
  },
  {
    id: 'attract-loop', group: 'interaction', name: 'Attract loop and idle reset',
    description: 'While nobody touches the controller, the table loops through its layers; after a quiet spell it goes back home.',
    usage: "layer.json 'attract' and the scene's buttons; nothing to code",
    detect: 'export class AttractLoop',
  },

  // TV
  {
    id: 'tv-panels', group: 'tv', name: 'TV panels',
    description: 'Declarative dashboard panels (stat, gauge, bars, list for a short ranking, donut for shares of a whole, media for a picture or video, legend, compare for scenarios side by side, balance for where a quantity comes from and goes to, control for one of the layer sliders, toggles, choices or buttons on a panel, map for the site map where a tap picks an entity or sends a point, series, ramp, timeline, text) on a 12 by 6 grid with a density budget; chip and wide panels also go in the table ribbon.',
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
