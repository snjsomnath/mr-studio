/**
 * Ready to present? (#63): every check of a table before it is shown, in one list. The editor's
 * Checks button and Present, and the MCP server's validation, read these same rules, so they
 * always name the same problems.
 *
 * The rules look only at a plain summary of the table, which each side builds from what it has:
 * the editor from the live session, the MCP server from site.json and the layer catalogue.
 */

export type ReadyLevel = 'must' | 'should' | 'nice';

/** Where a problem is fixed. The editor turns each into a button; the MCP server into words. */
export type ReadyFix =
  | { kind: 'data'; dataset: string }
  | { kind: 'layer'; id: string }
  | { kind: 'guide'; step: 'place' | 'rest' | 'layers' }
  | { kind: 'table' }
  | { kind: 'controller' }
  | { kind: 'calibrate' };

export interface ReadyCheck {
  /** Stable, so a list can be compared or a check dismissed: `data:sunlight:buildings`. */
  id: string;
  level: ReadyLevel;
  /** One sentence, in the person's words. */
  text: string;
  /** The words on the fix button. */
  action: string;
  fix: ReadyFix;
}

export interface ReadyLayer {
  id: string;
  /** The name on its button, or the layer's own. */
  name: string;
  /** Map life at rest (base or ambient), not a button. */
  ambient: boolean;
  /** Set for an item inside another layer. */
  parent?: string | null;
  /** Hidden from the controller. */
  hidden?: boolean;
  side?: 'left' | 'right';
  /** Site data it reads (`requires.data`). */
  needs?: string[];
}

export interface ReadyTable {
  /** The site's datasets by name. */
  data: string[];
  layers: ReadyLayer[];
  /** The physical table's size, when set. */
  size: boolean;
  timezone?: string | null;
  /** Whether this computer's projector is calibrated; null when it cannot be known (MCP). */
  calibrated?: boolean | null;
  title?: string | null;
  welcome?: string | null;
}

/** Data a layer reads and the words for it. */
const DATA_WORDS: Record<string, string> = {
  buildings: 'buildings',
  terrain: 'ground heights',
  trees: 'trees',
  roads: 'streets',
  walkways: 'walking paths',
  trips: 'trips',
};

const words = (dataset: string): string => DATA_WORDS[dataset] ?? `"${dataset}"`;

const ORDER: Record<ReadyLevel, number> = { must: 0, should: 1, nice: 2 };

export function readiness(table: ReadyTable): ReadyCheck[] {
  const checks: ReadyCheck[] = [];
  const data = new Set(table.data);
  const top = table.layers.filter((l) => !l.parent);
  const buttons = top.filter((l) => !l.ambient);
  const shown = buttons.filter((l) => !l.hidden);

  if (!data.has('buildings')) {
    checks.push({ id: 'data:buildings', level: 'must', text: 'This table has no buildings yet, so the map is empty.', action: 'Bring in your place', fix: { kind: 'guide', step: 'place' } });
  }
  if (buttons.length === 0) {
    checks.push({ id: 'layers:none', level: 'must', text: 'There are no layers yet. Each layer becomes a button on the controller.', action: 'Choose layers', fix: { kind: 'guide', step: 'layers' } });
  } else if (shown.length === 0) {
    checks.push({ id: 'layers:hidden', level: 'must', text: 'Every layer is hidden from the controller, so visitors have nothing to press.', action: 'Show the buttons', fix: { kind: 'controller' } });
  }
  // A layer without the data it draws shows little or nothing (Traffic without streets, #34).
  for (const layer of table.layers) {
    for (const dataset of layer.needs ?? []) {
      if (data.has(dataset) || dataset === 'buildings') continue;
      checks.push({
        id: `data:${layer.id}:${dataset}`,
        level: layer.hidden ? 'should' : 'must',
        text: `${layer.name} has no ${words(dataset)} to draw on, so it shows little or nothing.`,
        action: `Bring in ${words(dataset)}`,
        fix: { kind: 'data', dataset },
      });
    }
  }
  if (!top.some((l) => l.ambient)) {
    checks.push({ id: 'rest:empty', level: 'should', text: 'The map shows nothing when no layer is open.', action: 'Choose what shows at rest', fix: { kind: 'guide', step: 'rest' } });
  }
  if (!table.size) {
    checks.push({ id: 'table:size', level: 'should', text: 'The table has no size, so the projector cannot match the model.', action: 'Set the size', fix: { kind: 'guide', step: 'place' } });
  }
  if (!table.timezone) {
    checks.push({ id: 'table:timezone', level: 'should', text: 'The table has no time zone, so sun and clocks follow this computer instead of the place.', action: 'Set the time zone', fix: { kind: 'table' } });
  }
  if (table.calibrated === false) {
    checks.push({ id: 'projector', level: 'should', text: 'The projector is not calibrated on this computer, so the map may not sit on the model.', action: 'Calibrate', fix: { kind: 'calibrate' } });
  }
  // A one-sided controller looks unfinished (#50).
  const left = shown.filter((l) => (l.side ?? 'left') === 'left').length;
  const right = shown.length - left;
  if (shown.length >= 4 && (left === 0 || right === 0)) {
    checks.push({ id: 'controller:one-side', level: 'should', text: `All ${shown.length} buttons are on the ${left === 0 ? 'right' : 'left'} of the controller; the other side stands empty.`, action: 'Arrange the buttons', fix: { kind: 'controller' } });
  }
  if (Math.max(left, right) > 8) {
    checks.push({ id: 'controller:crowded', level: 'nice', text: `${Math.max(left, right)} buttons on one side of the controller is a lot to choose from. Groups or a second side help.`, action: 'Arrange the buttons', fix: { kind: 'controller' } });
  }
  if (!table.welcome) {
    checks.push({ id: 'table:welcome', level: 'nice', text: 'The controller has no welcome line of its own, so it says the default.', action: 'Write a welcome', fix: { kind: 'table' } });
  }
  return checks.sort((a, b) => ORDER[a.level] - ORDER[b.level]);
}
