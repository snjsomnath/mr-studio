/**
 * Every setting an author edits, declared once (#392): who it belongs to and its one home
 * (rule 1 of docs/editor-ui.md, "One home per setting"). A field that edits a setting is
 * tagged with `setting(id, home, field)` where it is drawn; test/editor-layout.test.ts reads
 * every such call in the editor and fails when a setting is edited anywhere but its home.
 * This is the task audit of #384, run on every pull request.
 *
 * The new-table guide (wizard.ts) may ask for any of these as it starts a table (rule 9), so
 * its own steps are not placements. Its first step reuses the Table size and place component.
 *
 * Plain data with no page code, so the tests can read it.
 */

/** Where a setting can be edited. */
export type Home =
  /** Design › Table size and place… */
  | 'dialog:place'
  /** Design › Welcome and languages… */
  | 'dialog:welcome'
  /** Design › Controller pages… (#155) */
  | 'dialog:pages'
  /** Present › Screens and calibration… (this computer, #73) */
  | 'dialog:screens'
  /** File › Settings › This computer, the app's own window outside the editor (#393) */
  | 'app:settings'
  /** Design › Palette */
  | 'dialog:palette'
  /** A gallery or toggle on the Design ribbon */
  | 'ribbon:design'
  /** The Format pane of a selected layer, map life or item */
  | 'format:layer'
  /** The Button section of a layer's Format pane */
  | 'format:button'
  /** The eye on a row of the left list */
  | 'list:eye'
  /** A row selected in the left list, moved with Move up and Move down */
  | 'list:move';

export type Owner = 'table' | 'layer' | 'button' | 'computer';

export interface SettingInfo {
  label: string;
  owner: Owner;
  home: Home;
}

export const SETTINGS = {
  'table.name': { label: 'Name of the table', owner: 'table', home: 'dialog:place' },
  'table.place': { label: 'Where the table is, its ground and its turn', owner: 'table', home: 'dialog:place' },
  'table.size': { label: 'Size of the physical table and its tiles', owner: 'table', home: 'dialog:place' },
  'table.timezone': { label: 'Time zone', owner: 'table', home: 'dialog:place' },
  'table.front': { label: 'Side visitors stand at', owner: 'table', home: 'dialog:place' },
  'table.ribbons': { label: 'Ribbons beside the model', owner: 'table', home: 'dialog:place' },
  'table.glow': { label: 'Ambient glow around the model', owner: 'table', home: 'dialog:place' },
  'controller.title': { label: 'Controller title', owner: 'table', home: 'dialog:welcome' },
  'controller.welcome': { label: 'Welcome line', owner: 'table', home: 'dialog:welcome' },
  'controller.logo': { label: 'Logo', owner: 'table', home: 'dialog:welcome' },
  'controller.idle': { label: 'Back home after', owner: 'table', home: 'dialog:welcome' },
  'controller.loop': { label: 'Welcome loop', owner: 'table', home: 'dialog:welcome' },
  'controller.phones': { label: 'Phones can switch layers', owner: 'table', home: 'dialog:welcome' },
  'controller.two': { label: 'Two layers at once', owner: 'table', home: 'dialog:welcome' },
  'controller.languages': { label: 'Languages for visitors', owner: 'table', home: 'dialog:welcome' },
  'controller.translations': { label: 'The table’s words in Swedish', owner: 'table', home: 'dialog:welcome' },
  'controller.pages': { label: 'Hand-made controller pages', owner: 'table', home: 'dialog:pages' },
  'controller.rotate': { label: 'Time each controller page shows', owner: 'table', home: 'dialog:pages' },
  'controller.theme': { label: 'Controller theme', owner: 'table', home: 'ribbon:design' },
  'controller.buttons': { label: 'Button style', owner: 'table', home: 'ribbon:design' },
  'table.palette': { label: 'Palette', owner: 'table', home: 'dialog:palette' },
  'maplife.shown': { label: 'Map life on or off', owner: 'layer', home: 'list:eye' },
  'item.on': { label: 'An item comes on with its layer', owner: 'layer', home: 'format:layer' },
  'layer.settings': { label: 'A layer’s own settings', owner: 'layer', home: 'format:layer' },
  'layer.order': { label: 'Drawing order and button order', owner: 'layer', home: 'list:move' },
  'button.words': { label: 'A button’s name, description and group', owner: 'button', home: 'format:button' },
  'button.icon': { label: 'A button’s icon', owner: 'button', home: 'format:button' },
  'button.side': { label: 'A button’s side of the controller', owner: 'button', home: 'format:button' },
  'button.hidden': { label: 'A button on the controller or not', owner: 'button', home: 'list:eye' },
  'computer.screens': { label: 'Which screen shows what', owner: 'computer', home: 'app:settings' },
  'computer.calibration': { label: 'Projector calibration', owner: 'computer', home: 'dialog:screens' },
  'computer.colour': { label: 'Colour of each display', owner: 'computer', home: 'app:settings' },
  'computer.quality': { label: 'Drawing quality', owner: 'computer', home: 'dialog:screens' },
} as const satisfies Record<string, SettingInfo>;

export type SettingId = keyof typeof SETTINGS;

/**
 * Marks `field` as where `id` is edited. `home` must be the setting's home: the type says so,
 * and the test reads these calls to check that no setting has a second editable copy.
 */
export function setting<T extends HTMLElement, S extends SettingId>(id: S, home: (typeof SETTINGS)[S]['home'], field: T): T {
  field.dataset.setting = id;
  field.dataset.home = home;
  return field;
}
