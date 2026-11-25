// Lines as a walking network in longitude and latitude (#484): a node at every line end and every
// vertex lines share, so a long street becomes one edge per block. CoolPaths routes along it. It is
// built in the SDK's data worker from the file and kept until the file changes (see
// site-geometry.ts, `readWalkNetwork`); this module is the building and the packing, with no DOM.

export type LonLat = [lon: number, lat: number];

export interface WalkEdge {
  u: number;
  v: number;
  length: number;
  coordinates: LonLat[];
}

export interface WalkNetwork<E extends WalkEdge = WalkEdge> {
  nodes: LonLat[];
  edges: E[];
  /** Edge indices at each node. */
  adjacency: number[][];
}

type Distance = (a: readonly number[], b: readonly number[]) => number;

interface LineFeature {
  geometry?: { type?: string; coordinates?: unknown } | null;
}

/**
 * Builds the network from GeoJSON lines. Lines meet where they share a vertex,
 * which is how street data is drawn; a node is made at every line end and every
 * shared vertex, so a long street becomes one edge per block.
 */
export function buildWalkNetwork(geojson: { features?: LineFeature[] }, distance: Distance): WalkNetwork {
  const lines: LonLat[][] = [];
  for (const feature of geojson.features ?? []) {
    const geometry = feature.geometry;
    const parts = geometry?.type === 'LineString' ? [geometry.coordinates] : geometry?.type === 'MultiLineString' ? (geometry.coordinates as unknown[]) : [];
    for (const part of parts) {
      const line = (part as number[][]).filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1])).map((p): LonLat => [p[0]!, p[1]!]);
      if (line.length >= 2) lines.push(line);
    }
  }
  // About 0.1 m: vertices closer than that are the same place.
  const key = (p: LonLat) => `${p[0].toFixed(6)},${p[1].toFixed(6)}`;
  const uses = new Map<string, number>();
  for (const line of lines) {
    line.forEach((p, i) => uses.set(key(p), (uses.get(key(p)) ?? 0) + (i === 0 || i === line.length - 1 ? 2 : 1)));
  }
  const network: WalkNetwork = { nodes: [], edges: [], adjacency: [] };
  const ids = new Map<string, number>();
  const node = (p: LonLat) => {
    let id = ids.get(key(p));
    if (id === undefined) {
      id = network.nodes.push(p) - 1;
      ids.set(key(p), id);
      network.adjacency.push([]);
    }
    return id;
  };
  for (const line of lines) {
    let start = 0;
    for (let i = 1; i < line.length; i++) {
      if (uses.get(key(line[i]!))! < 2) continue;
      const coordinates = line.slice(start, i + 1);
      start = i;
      let length = 0;
      for (let k = 1; k < coordinates.length; k++) length += distance(coordinates[k - 1]!, coordinates[k]!);
      const [u, v] = [node(coordinates[0]!), node(coordinates[coordinates.length - 1]!)];
      if (u === v || !(length > 0)) continue;
      const edge = network.edges.push({ u, v, length, coordinates }) - 1;
      network.adjacency[u]!.push(edge);
      network.adjacency[v]!.push(edge);
    }
  }
  return network;
}

/** A walking network as typed arrays, to move between the data worker and the page. */
export interface PackedWalkNetwork {
  nodes: Float64Array;
  u: Uint32Array;
  v: Uint32Array;
  length: Float64Array;
  /** Where each edge's coordinates start in `coords`, in points; one more entry than edges. */
  starts: Uint32Array;
  coords: Float64Array;
}

export function packWalkNetwork(network: WalkNetwork): PackedWalkNetwork {
  const n = network.edges.length;
  const points = network.edges.reduce((sum, e) => sum + e.coordinates.length, 0);
  const packed: PackedWalkNetwork = {
    nodes: new Float64Array(network.nodes.length * 2),
    u: new Uint32Array(n),
    v: new Uint32Array(n),
    length: new Float64Array(n),
    starts: new Uint32Array(n + 1),
    coords: new Float64Array(points * 2),
  };
  network.nodes.forEach(([lon, lat], i) => {
    packed.nodes[i * 2] = lon;
    packed.nodes[i * 2 + 1] = lat;
  });
  let at = 0;
  network.edges.forEach((e, i) => {
    packed.u[i] = e.u;
    packed.v[i] = e.v;
    packed.length[i] = e.length;
    packed.starts[i] = at;
    for (const [lon, lat] of e.coordinates) {
      packed.coords[at * 2] = lon;
      packed.coords[at * 2 + 1] = lat;
      at++;
    }
  });
  packed.starts[n] = at;
  return packed;
}

export function walkNetworkBuffers(packed: PackedWalkNetwork): ArrayBuffer[] {
  return [packed.nodes, packed.u, packed.v, packed.length, packed.starts, packed.coords].map((a) => a.buffer as ArrayBuffer);
}

/**
 * Unpacks into fresh nodes and edges, so a layer can mark its own copy (CoolPaths keeps each
 * edge's sun and PET on it). `extra` adds a layer's own fields to every edge.
 */
export function unpackWalkNetwork<X extends object = Record<never, never>>(packed: PackedWalkNetwork, extra?: () => X): WalkNetwork<WalkEdge & X> {
  const nodes: LonLat[] = [];
  const adjacency: number[][] = [];
  for (let i = 0; i < packed.nodes.length; i += 2) {
    nodes.push([packed.nodes[i]!, packed.nodes[i + 1]!]);
    adjacency.push([]);
  }
  const edges: (WalkEdge & X)[] = [];
  for (let i = 0; i < packed.u.length; i++) {
    const coordinates: LonLat[] = [];
    for (let k = packed.starts[i]!; k < packed.starts[i + 1]!; k++) coordinates.push([packed.coords[k * 2]!, packed.coords[k * 2 + 1]!]);
    const [u, v] = [packed.u[i]!, packed.v[i]!];
    edges.push({ u, v, length: packed.length[i]!, coordinates, ...(extra?.() as X) });
    adjacency[u]!.push(i);
    adjacency[v]!.push(i);
  }
  return { nodes, edges, adjacency };
}
