/**
 * The editor's layout as data (#392): which tabs the ribbon has, which groups each tab holds
 * and which commands sit in each group. The commands themselves are declared once, in
 * commands-list.ts, and the editor gives each one its action. Moving a command to another tab,
 * or trying a different UI philosophy, is an edit of this file, not of the editor.
 *
 * This file is plain data with no page code, so the tests can read it (test/editor-layout.test.ts).
 * The layout today is the PowerPoint shell agreed in docs/editor-ui.md (#382).
 */
import type { CommandId } from './commands-list.ts';

/** A piece of a ribbon group the editor draws itself: a gallery or a list that changes with the table. */
export type WidgetId = 'themes' | 'help.guides' | 'help.news' | 'help.diagnostics';

/** One thing in a group: a command, large (icon over its name) or small (three to a column), or a widget. */
export type LayoutItem = CommandId | { command: CommandId; large?: boolean } | { widget: WidgetId };

export interface LayoutGroup {
  name: string;
  items: LayoutItem[];
  /** Stays in full when the window is narrow; other groups fold first (#66). */
  keep?: boolean;
}

export interface LayoutTab {
  id: string;
  label: string;
  tip: string;
  groups: LayoutGroup[];
}

const large = (command: CommandId): LayoutItem => ({ command, large: true });

/**
 * The PowerPoint shell (docs/editor-ui.md, "The ribbon"). Tabs hold commands only: opening one
 * never changes the canvas, the list, the selection or the map (rule 3).
 */
export const RIBBON: LayoutTab[] = [
  {
    id: 'home',
    label: 'Home',
    tip: 'Work on what is selected: hide it, move it, rename, duplicate or remove it',
    groups: [
      { name: 'Layer', items: [large('layer.new'), 'layer.duplicate', 'layer.remove'] },
      { name: 'Selection', items: ['layer.toggle', 'layer.up', 'layer.down', 'layer.rename', 'layer.reset'], keep: true },
      { name: 'Find', items: [large('commands.search')] },
    ],
  },
  {
    id: 'insert',
    label: 'Insert',
    tip: 'Add layers, data, pictures, video, sound and 3D models',
    groups: [
      { name: 'Layers', items: [large('layer.new'), large('layer.custom'), 'layer.forget'] },
      { name: 'Your data', items: [large('data.file'), large('data.open')] },
      { name: 'Media', items: ['media.picture', 'media.video', 'media.sound', 'media.model'] },
    ],
  },
  {
    id: 'design',
    label: 'Design',
    tip: 'How the controller looks, the map’s colours, and the table’s size, place and welcome',
    groups: [
      { name: 'Controller theme', items: [{ widget: 'themes' }] },
      { name: 'Buttons', items: ['buttons.icons', 'buttons.labelled'] },
      { name: 'Map', items: [large('map.basemap'), large('map.palette')] },
      { name: 'Table', items: ['dialog.place', 'dialog.welcome'], keep: true },
    ],
  },
  {
    id: 'present',
    label: 'Present',
    tip: 'Check the table, rehearse it here, present it, set up the screens and send it',
    groups: [
      { name: 'Check', items: [large('present.check')] },
      { name: 'Start', items: [large('present.rehearse'), large('present.start')], keep: true },
      { name: 'Set up', items: [large('dialog.screens')] },
      { name: 'Send', items: ['file.share', 'file.export'] },
    ],
  },
  {
    id: 'view',
    label: 'View',
    tip: 'Map, controller or both in the middle, the zoom, the media library and windows',
    groups: [
      { name: 'Show', items: ['view.map', 'view.controller', 'view.both'] },
      { name: 'Zoom', items: ['zoom.fit', 'zoom.100', 'view.outline'] },
      { name: 'Library', items: [large('dialog.media')] },
      { name: 'Open in a window', items: ['window.table', 'window.tv', 'window.dev'] },
    ],
  },
  {
    id: 'help',
    label: 'Help',
    tip: 'Every feature and step-by-step guides, in a window of their own',
    groups: [
      { name: 'Guide', items: [{ widget: 'help.guides' }] },
      { name: 'Features', items: [large('help.features')] },
      { name: 'Problems', items: [large('help.troubleshooting'), { widget: 'help.diagnostics' }] },
      { name: 'Keys and feedback', items: ['commands.search', 'help.shortcuts', 'help.report'] },
      { name: 'What’s new', items: [{ widget: 'help.news' }] },
    ],
  },
];

/** The tab the editor opens on. */
export const FIRST_TAB = RIBBON[0]!.id;

/** The command an item names, if it names one. */
export function commandOf(item: LayoutItem): CommandId | null {
  if (typeof item === 'string') return item;
  return 'command' in item ? item.command : null;
}
