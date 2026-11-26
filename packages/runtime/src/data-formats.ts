/**
 * What a good file looks like, for each kind of data a table takes (#36). One place for the
 * words: the "?" on each Your place and Add data row, the MCP server's `mrstudio://data-formats`
 * and the guide's page (docs/guide/data-formats.md, checked against this list by a test) all
 * read them from here.
 *
 * `sample()` writes a small example file around the table's own centre, so an author can
 * download it, open it to see the shape, and bring it straight back in to see it on the table.
 */

export interface SampleFile {
  name: string;
  type: string;
  text: string;
}

export interface DataFormat {
  /** The dataset name in site.json `data` (and the importer's target). */
  dataset: string;
  name: string;
  /** The file types, as the import accepts them. */
  files: string;
  /** What a good file holds, with a short example. Plain text; a blank line starts the example. */
  example: string;
  /** A small example file around `origin`, or null where one cannot be written here (a GeoTIFF). */
  sample(origin: { lon: number; lat: number }): SampleFile | null;
}

/** Rounds coordinates to about 10 cm, so examples stay short. */
const at = (lon: number, lat: number): [number, number] => [Math.round(lon * 1e6) / 1e6, Math.round(lat * 1e6) / 1e6];

/** Metres east and north of `origin` as longitude and latitude. */
function offset(origin: { lon: number; lat: number }, east: number, north: number): [number, number] {
  const lon = origin.lon + east / (111_320 * Math.cos((origin.lat * Math.PI) / 180));
  const lat = origin.lat + north / 110_540;
  return at(lon, lat);
}

function geojson(name: string, features: object[]): SampleFile {
  const lines = features.map((f) => `    ${JSON.stringify(f)}`);
  return { name, type: 'application/geo+json', text: `{\n  "type": "FeatureCollection",\n  "features": [\n${lines.join(',\n')}\n  ]\n}\n` };
}

/** A rectangle of `w` by `h` metres whose south-west corner is `east`, `north` metres from the origin. */
function block(origin: { lon: number; lat: number }, east: number, north: number, w: number, h: number): [number, number][][] {
  const c = (x: number, y: number) => offset(origin, east + x, north + y);
  return [[c(0, 0), c(w, 0), c(w, h), c(0, h), c(0, 0)]];
}

export const DATA_FORMATS: DataFormat[] = [
  {
    dataset: 'buildings',
    name: 'Buildings',
    files: 'GeoJSON',
    example:
      'GeoJSON polygons, one per building, with a height in metres (height, höjd) or a number of storeys (building:levels, våningar). WGS84 or SWEREF99 are both fine.\n\n{ "type": "Feature",\n  "properties": { "height": 18 },\n  "geometry": { "type": "Polygon", "coordinates": [[[11.970, 57.690], …]] } }',
    sample: (o) =>
      geojson('example-buildings.geojson', [
        { type: 'Feature', properties: { height: 18 }, geometry: { type: 'Polygon', coordinates: block(o, -60, 10, 40, 25) } },
        { type: 'Feature', properties: { 'building:levels': 4 }, geometry: { type: 'Polygon', coordinates: block(o, 0, 10, 30, 30) } },
        { type: 'Feature', properties: { height: 9.5 }, geometry: { type: 'Polygon', coordinates: block(o, -30, -40, 50, 20) } },
      ]),
  },
  {
    dataset: 'terrain',
    name: 'Ground',
    files: 'GeoTIFF',
    example:
      'A GeoTIFF of ground heights in metres, such as a Lantmäteriet elevation model. It may be larger than the table and on a national grid; if it does not say which, you will be asked for its EPSG code (3006 for SWEREF99 TM).',
    sample: () => null,
  },
  {
    dataset: 'trees',
    name: 'Trees',
    files: 'GeoJSON or CSV',
    example: 'GeoJSON points, or a CSV with a row per tree: lat and lon (or x and y, or latitud and longitud), and a height if you have one.\n\nlat;lon;höjd\n57,7001;11,9701;9,5',
    sample: (o) => {
      const rows = [
        [-40, -5, 9.5],
        [-25, -5, 12],
        [-10, -5, 7],
        [5, -5, 11],
        [20, -5, 8.5],
      ].map(([e, n, h]) => {
        const [lon, lat] = offset(o, e!, n!);
        return `${lat};${lon};${h}`.replaceAll('.', ',');
      });
      return { name: 'example-trees.csv', type: 'text/csv', text: `lat;lon;höjd\n${rows.join('\n')}\n` };
    },
  },
  {
    dataset: 'water',
    name: 'Water',
    files: 'GeoJSON or GeoTIFF',
    example:
      'GeoJSON areas where there is water: a river, a lake, a harbour, the sea. Thermal comfort counts it as cool, stormwater lets the rain run into it, and the base map draws it. A GeoTIFF mask works too (water cells 1, land 0) in site.json under scene.water.\n\n{ "type": "Feature",\n  "properties": { "natural": "water" },\n  "geometry": { "type": "Polygon", "coordinates": [[[11.970, 57.690], [11.975, 57.690], [11.975, 57.688], [11.970, 57.690]]] } }',
    sample: (o) => geojson('example-water.geojson', [{ type: 'Feature', properties: { natural: 'water', water: 'river' }, geometry: { type: 'Polygon', coordinates: block(o, -80, -60, 160, 35) } }]),
  },
  {
    dataset: 'context',
    name: 'Buildings around',
    files: 'GeoJSON',
    example:
      'GeoJSON footprints around the table, reaching up to 500 m past its edge (scene.context.reach_m in site.json sets how far). The wind simulation puts them around the table, so wind arriving at the table has passed real buildings. Nothing is drawn. Footprints on the table itself are left to Buildings.\n\n{ "type": "Feature",\n  "properties": {},\n  "geometry": { "type": "Polygon", "coordinates": [[[11.955, 57.700], [11.956, 57.700], [11.956, 57.7005], [11.955, 57.7005], [11.955, 57.700]]] } }',
    sample: (o) => geojson('example-context.geojson', [-1, 1].flatMap((side) => [-120, -40, 40, 120].map((n) => ({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: block(o, side * 260 - 20, n, 40, 30) } })))),
  },
  {
    dataset: 'roads',
    name: 'Streets',
    files: 'GeoJSON',
    example:
      'GeoJSON lines along the middle of each street. An optional width in metres and a kind (street, primary…) help traffic look right.\n\n{ "type": "Feature",\n  "properties": { "width": 8 },\n  "geometry": { "type": "LineString", "coordinates": [[11.970, 57.690], [11.972, 57.691]] } }',
    sample: (o) =>
      geojson('example-streets.geojson', [
        { type: 'Feature', properties: { width: 12, highway: 'primary' }, geometry: { type: 'LineString', coordinates: [offset(o, -150, 0), offset(o, 150, 0)] } },
        { type: 'Feature', properties: { width: 8, highway: 'residential' }, geometry: { type: 'LineString', coordinates: [offset(o, 0, -100), offset(o, 0, 100)] } },
      ]),
  },
  {
    dataset: 'walkways',
    name: 'Walking paths',
    files: 'GeoJSON',
    example: 'GeoJSON lines along footpaths, pavements and squares people cross. Cool paths finds the shadiest way along them.',
    sample: (o) =>
      geojson('example-walkways.geojson', [
        { type: 'Feature', properties: { highway: 'footway' }, geometry: { type: 'LineString', coordinates: [offset(o, -120, 6), offset(o, 120, 6)] } },
        { type: 'Feature', properties: { highway: 'footway' }, geometry: { type: 'LineString', coordinates: [offset(o, 6, -90), offset(o, 6, 90)] } },
        { type: 'Feature', properties: { highway: 'path' }, geometry: { type: 'LineString', coordinates: [offset(o, -120, 6), offset(o, -60, 60), offset(o, 6, 90)] } },
      ]),
  },
  {
    dataset: 'trips',
    name: 'Trips',
    files: 'trips.json',
    example:
      'The Mobility layer\'s trips.json: journeys in groups to compare (on foot, by tram…), each a list of legs with a start and a duration in seconds and the [lon, lat] points it passes. See packages/layers/mobility/README.md.\n\n{ "format": 1,\n  "groups": [{ "id": "walk", "label": "On foot" }],\n  "trips": [{ "group": "walk", "legs": [\n    { "start": 0, "duration": 120, "coordinates": [[11.970, 57.690], [11.972, 57.691]] } ] }] }',
    sample: (o) => {
      const leg = (start: number, duration: number, points: [number, number][]) => ({ start, duration, coordinates: points.map(([e, n]) => offset(o, e, n)) });
      const trips = {
        format: 1,
        title: 'Getting to the corner',
        groups: [
          { id: 'walk', label: 'On foot', color: '#fb923c' },
          { id: 'bike', label: 'By bike', color: '#2dd4bf' },
        ],
        destination: { label: 'The corner', coordinates: offset(o, 0, 0) },
        trips: [
          { group: 'walk', legs: [leg(0, 180, [[-120, 6], [-60, 6], [0, 6]])] },
          { group: 'walk', legs: [leg(30, 150, [[6, -90], [6, -40], [6, 0]])] },
          { group: 'bike', legs: [leg(0, 45, [[-150, 0], [-75, 0], [0, 0]])] },
          { group: 'bike', legs: [leg(20, 40, [[0, 100], [0, 50], [0, 0]])] },
        ],
      };
      return { name: 'example-trips.json', type: 'application/json', text: `${JSON.stringify(trips, null, 2)}\n` };
    },
  },
];

export function dataFormat(dataset: string): DataFormat | undefined {
  return DATA_FORMATS.find((f) => f.dataset === dataset);
}
