import type { ModelPoint, SiteInfo, TwinMesh } from '@mrstudio/sdk';

/** A corner of the physical model that a person can find and point a marker at. */
export interface Landmark {
  point: ModelPoint;
  label: string;
}

const CORNERS: { name: string; right: number; up: number }[] = [
  { name: 'top left', right: -1, up: 1 },
  { name: 'top right', right: 1, up: 1 },
  { name: 'bottom right', right: 1, up: -1 },
  { name: 'bottom left', right: -1, up: -1 },
];

/** Table axes for a local point: metres to the right and up, as the table image is drawn. */
export function tableAxes(site: SiteInfo): (east: number, north: number) => [right: number, up: number] {
  const r = (site.grid.rotation_deg * Math.PI) / 180;
  const [cos, sin] = [Math.cos(r), Math.sin(r)];
  return (east, north) => [east * cos - north * sin, east * sin + north * cos];
}

/**
 * Proposes corners to calibrate against: the four corners of the model's base, and roof
 * corners of buildings chosen to be far apart and at different heights. A camera can only
 * be found from points that do not share one plane, which this mix guarantees.
 */
export function proposeLandmarks(twin: TwinMesh, site: SiteInfo, roofCorners = 6): Landmark[] {
  const axes = tableAxes(site);
  const at = (i: number): ModelPoint => [twin.positions[i * 3]!, twin.positions[i * 3 + 1]!, twin.positions[i * 3 + 2]!];
  const extreme = (vertices: number[], right: number, up: number): number => {
    let best = vertices[0]!;
    let bestScore = -Infinity;
    for (const i of vertices) {
      const [r, u] = axes(twin.positions[i * 3]!, twin.positions[i * 3 + 1]!);
      const score = r * right + u * up;
      if (score > bestScore) [best, bestScore] = [i, score];
    }
    return best;
  };

  const ground: number[] = [];
  const roofs = new Map<number, number[]>();
  for (let i = 0; i < twin.kinds.length; i++) {
    if (twin.kinds[i] === 0) ground.push(i);
    else if (twin.kinds[i] === 1) {
      // Without footprints every roof piece (four vertices) stands for itself.
      const key = twin.buildings[i] || -(Math.floor(i / 4) + 1);
      let list = roofs.get(key);
      if (!list) roofs.set(key, (list = []));
      list.push(i);
    }
  }

  const landmarks: Landmark[] = [];
  if (ground.length > 0) {
    for (const corner of CORNERS) {
      landmarks.push({ point: at(extreme(ground, corner.right, corner.up)), label: `The ${corner.name} corner of the model's base` });
    }
  }
  const base = landmarks.length > 0 ? Math.min(...landmarks.map((l) => l.point[2])) : twin.minZ;

  // Each building offers the corners of its highest roof.
  const candidates: (Landmark & { building: number })[] = [];
  for (const [building, vertices] of roofs) {
    const top = vertices.reduce((max, i) => Math.max(max, twin.positions[i * 3 + 2]!), -Infinity);
    const highest = vertices.filter((i) => twin.positions[i * 3 + 2]! > top - 0.1);
    for (const corner of CORNERS) {
      const point = at(extreme(highest, corner.right, corner.up));
      candidates.push({ building, point, label: `The ${corner.name} roof corner of the building ${Math.round(point[2] - base)} m tall, marked on the plan` });
    }
  }

  // Farthest point first, with height counted three times over so the corners spread vertically too.
  const distance = (a: ModelPoint, b: ModelPoint) => Math.hypot(a[0] - b[0], a[1] - b[1], (a[2] - b[2]) * 3);
  const chosen: (Landmark & { building?: number })[] = [...landmarks];
  for (let n = 0; n < roofCorners && candidates.length > 0; n++) {
    let best = 0;
    let bestScore = -Infinity;
    candidates.forEach((candidate, index) => {
      let score = chosen.length === 0 ? candidate.point[2] : Math.min(...chosen.map((c) => distance(c.point, candidate.point)));
      if (chosen.some((c) => c.building === candidate.building)) score *= 0.4;
      if (score > bestScore) [best, bestScore] = [index, score];
    });
    chosen.push(candidates.splice(best, 1)[0]!);
  }
  return chosen.map(({ point, label }) => ({ point, label }));
}
