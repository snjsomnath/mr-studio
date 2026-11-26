// What-if changes from a phone (#500): a visitor draws a new building, plants a tree, or taps one away, and the
// sun study redraws with it. The changes live in the engine's scene while Sunlight is open; nothing is saved.
import type { SceneEdit, Shape, TableContext, ToolInput } from '@mrstudio/sdk';

type Params = { whatIfHeight: number };

/** A planted tree: a crown this wide and tall, like a grown street tree. */
const TREE_RADIUS_M = 4;
const TREE_HEIGHT_M = 10;
/** The most changes kept; the oldest go first. Matches the host's limit. */
const MAX_EDITS = 200;

const BUILDING_COLOUR = '#f4efe4';
const TREE_COLOUR = '#3ed39a';
const REMOVED_COLOUR = '#ff5d73';

export const WHAT_IF_TOOLS = ['addBuilding', 'plantTree', 'remove'];

/** A circle as a closed ring, for drawing a planted tree's crown. */
function circle(at: [number, number], radiusM: number, lat: number): [number, number][] {
  const dLat = radiusM / 111_320;
  const dLon = dLat / Math.cos((lat * Math.PI) / 180);
  const ring: [number, number][] = [];
  for (let k = 0; k <= 16; k++) {
    const a = (k / 16) * Math.PI * 2;
    ring.push([at[0] + Math.cos(a) * dLon, at[1] + Math.sin(a) * dLat]);
  }
  return ring;
}

/** The shapes the table draws for the changes: new buildings and trees filled, taps that removed something marked. */
export function editShapes(edits: readonly SceneEdit[]): Shape[] {
  return edits.map((edit): Shape => {
    if (edit.kind === 'building') {
      const ring = [...edit.outline];
      const [first, last] = [ring[0]!, ring[ring.length - 1]!];
      if (first[0] !== last[0] || first[1] !== last[1]) ring.push(first);
      return { geometry: { type: 'Polygon', coordinates: [ring] }, colour: BUILDING_COLOUR };
    }
    if (edit.kind === 'tree') return { geometry: { type: 'Polygon', coordinates: [circle(edit.at, edit.radius_m, edit.at[1])] }, colour: TREE_COLOUR };
    return { geometry: { type: 'Point', coordinates: edit.at }, colour: REMOVED_COLOUR };
  });
}

/** A phone's drawing or tap as a change, or null for something else. */
export function editFromTool(input: Pick<ToolInput, 'tool' | 'geometry'>, heightM: number): SceneEdit | null {
  const geometry = input.geometry as { type?: string; coordinates?: unknown };
  if (input.tool === 'addBuilding' && geometry.type === 'Polygon') {
    const ring = (geometry.coordinates as number[][][])[0] ?? [];
    if (ring.length < 4) return null;
    return { kind: 'building', outline: ring.map((p) => [p[0]!, p[1]!] as [number, number]), height_m: Math.min(400, Math.max(0.5, heightM)) };
  }
  if (geometry.type !== 'Point') return null;
  const [lon, lat] = geometry.coordinates as number[];
  const at: [number, number] = [lon!, lat!];
  if (input.tool === 'plantTree') return { kind: 'tree', at, radius_m: TREE_RADIUS_M, height_m: TREE_HEIGHT_M };
  if (input.tool === 'remove') return { kind: 'remove', at };
  return null;
}

export function whatIfOnTable(ctx: TableContext<Params>, changed: () => void) {
  const edits: SceneEdit[] = [];
  const shapes = ctx.map.addShapes('what-if');
  // One request at a time, in order, so the engine always ends on the newest list.
  let queue = Promise.resolve();
  function push() {
    shapes.set(editShapes(edits));
    ctx.publish({ whatIfCount: edits.length });
    const list = [...edits];
    queue = queue.then(() => ctx.engine.edit(list)).catch((error) => console.warn('[sunlight] what-if changes not applied', error));
    changed();
  }
  ctx.publish({ whatIfCount: 0 });

  return {
    /** Whether the scene has changes, so shadows come from the engine rather than the unchanged twin. */
    active: () => edits.length > 0,
    tool(input: ToolInput): boolean {
      if (!WHAT_IF_TOOLS.includes(input.tool)) return false;
      const edit = editFromTool(input, ctx.params.whatIfHeight);
      if (!edit) return true;
      edits.push(edit);
      if (edits.length > MAX_EDITS) edits.shift();
      push();
      return true;
    },
    undo() {
      if (edits.pop()) push();
    },
    clear() {
      if (!edits.length) return;
      edits.length = 0;
      push();
    },
  };
}
