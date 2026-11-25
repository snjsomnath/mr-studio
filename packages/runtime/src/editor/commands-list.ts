/**
 * Every editor command, declared once (#392): its name, icon and help text. The ribbon, the
 * right-click menus, command search (Cmd/Ctrl+K, #65) and the shortcut sheet all read these,
 * so a command has the same name and the same tooltip wherever it appears (docs/editor-ui.md,
 * "Right-click" and "Help and hints"). What a command does, and when it is greyed out, the
 * editor gives it by id (`CommandHandlers` in commands.ts); TypeScript makes sure every
 * command here has both.
 *
 * Plain data with no page code, so the tests can read it (test/editor-layout.test.ts).
 */

export interface CommandInfo {
  /** The name on the ribbon and in menus. A trailing … means it opens a dialog. */
  label: string;
  /** The Lucide icon (icons.ts). */
  icon: string;
  /** One line on what it does: the tooltip, and the line under it in command search. */
  tip: string;
  /** The group it is listed under in command search. */
  group: string;
  /** More words command search finds it by. */
  also?: string;
}

export const COMMANDS = {
  // ---- The selection (Home) ----
  'layer.new': { label: 'New layer', icon: 'plus', tip: 'Choose a layer from the gallery: from your data, analysis, story, your own, or map life', group: 'Add', also: 'add gallery' },
  'layer.duplicate': { label: 'Duplicate', icon: 'layers', tip: 'Make a copy of what is selected, with the same settings', group: 'Selection', also: 'copy' },
  'layer.remove': { label: 'Remove', icon: 'trash', tip: 'Take what is selected out of the table. Undo puts it back.', group: 'Selection', also: 'delete' },
  'layer.toggle': { label: 'Hide', icon: 'eye-off', tip: 'Show or hide what is selected: map life on the map at rest, an item while its layer is open', group: 'Selection', also: 'show turn on off' },
  'layer.up': { label: 'Move up', icon: 'up', tip: 'Draw what is selected above the next one on the map, or move its button up', group: 'Selection', also: 'order front' },
  'layer.down': { label: 'Move down', icon: 'down', tip: 'Draw what is selected below the previous one on the map, or move its button down', group: 'Selection', also: 'order back' },
  'layer.rename': { label: 'Rename', icon: 'pencil', tip: 'Rename the selected layer’s button', group: 'Selection', also: 'name button' },
  'layer.reset': { label: 'Reset settings', icon: 'reset', tip: 'Put every setting of what is selected back to its own value', group: 'Selection', also: 'defaults' },
  'commands.search': { label: 'Search commands', icon: 'search', tip: 'Find any command, layer or setting by a few words', group: 'Help', also: 'find' },

  // ---- Adding things (Insert) ----
  'dialog.inside': { label: 'Add inside…', icon: 'plus', tip: 'Put a layer inside the selected one: it comes on with it. The Magnifier and the Reveal line show what is inside them, like an X-ray.', group: 'Insert', also: 'inside item child xray x-ray magnifier reveal add to this layer' },
  'layer.custom': { label: 'Custom layer', icon: 'brush', tip: 'Make a layer from your own data: choose the data, then style it, move it and save it as a button', group: 'Add', also: 'new build style own' },
  'layer.forget': { label: 'Delete custom', icon: 'trash', tip: 'Delete custom layers this table no longer needs, wherever they are used', group: 'Add', also: 'forget' },
  'data.file': { label: 'Data file', icon: 'map', tip: 'Bring in a file: GeoJSON, CSV, GeoTIFF or a plan drawing. MR Studio works out what it is.', group: 'Add', also: 'import add data geojson csv tif buildings ground trees streets' },
  'data.open': { label: 'Open data', icon: 'globe', tip: 'Fetch buildings, ground, trees and streets for this place from OpenStreetMap and open elevation data', group: 'Add', also: 'openstreetmap osm fetch download' },
  'media.picture': { label: 'Picture', icon: 'images', tip: 'Add a picture to the table’s media, for slides and the controller', group: 'Add', also: 'image photo png jpg' },
  'media.video': { label: 'Video', icon: 'play', tip: 'Add a video to the table’s media, for slides and video walks', group: 'Add', also: 'film mp4' },
  'media.sound': { label: 'Sound', icon: 'sound', tip: 'Add a sound to the table’s media', group: 'Add', also: 'audio mp3' },
  'dialog.starter': { label: 'Starter pack…', icon: 'pencil', tip: 'The table’s outline, tiles, buildings and streets to draw on in QGIS, Illustrator, Photoshop or PowerPoint, with how to bring the result back', group: 'Add', also: 'export template guides svg png geojson pptx qgis illustrator photoshop powerpoint draw outside assets' },
  'media.model': { label: '3D model', icon: 'cube', tip: 'Set a 3D model on the ground, fitted to the buildings', group: 'Add', also: 'mesh obj stl glb' },

  // ---- How it looks (Design) ----
  'buttons.icons': { label: 'Icons', icon: 'grid', tip: 'Each button is its icon; the name shows when it is pressed', group: 'Design', also: 'button style' },
  'buttons.labelled': { label: 'Icons and names', icon: 'bars', tip: 'Each button shows its icon and its name', group: 'Design', also: 'button style labels' },
  'map.basemap': { label: 'Base map', icon: 'map', tip: 'Select the base map under At rest, to choose its style in the settings on the right', group: 'Design', also: 'style streets satellite' },
  'map.palette': { label: 'Palette', icon: 'palette', tip: 'The colours every custom layer uses. Change one and the whole table follows.', group: 'Design', also: 'colours colors' },
  'dialog.place': { label: 'Table size and place…', icon: 'route', tip: 'The table’s name, where it is, how much ground it covers, its time zone and where visitors stand', group: 'Design', also: 'name move resize time zone front ribbons location where table settings' },
  'dialog.welcome': { label: 'Welcome and languages…', icon: 'tv', tip: 'What the controller says when nobody is using the table, its logo, and the languages visitors read', group: 'Design', also: 'title logo idle loop swedish english phones table settings' },

  // ---- Showing it (Present) ----
  'present.check': { label: 'Ready to present?', icon: 'check', tip: 'What to check before presenting, and the way to fix each', group: 'Present', also: 'checks problems missing' },
  'present.rehearse': { label: 'Rehearse', icon: 'people', tip: 'Try the table as a visitor here: press the controller and a phone. Nothing is saved and the real displays are not used.', group: 'Present', also: 'try test practise practice preview' },
  'present.start': { label: 'Present', icon: 'tv', tip: 'Show the map on the projector and the controller on its screen', group: 'Present', also: 'start show projector' },
  'dialog.screens': { label: 'Screens and calibration…', icon: 'crosshair', tip: 'Which screen shows what, lining the map up with the table, colour and quality. These belong to this computer.', group: 'Present', also: 'display projector colour calibrate quality' },
  'file.share': { label: 'Share by email', icon: 'share', tip: 'Email this table as one file, for the studio PC or a colleague. Keys stay on this computer.', group: 'File', also: 'send mail' },
  'file.export': { label: 'Export', icon: 'save', tip: 'Save this table as one .mrstable file', group: 'File', also: 'mrstable file' },

  // ---- What is on screen (View) ----
  'view.map': { label: 'Map', icon: 'map', tip: 'Show the map only in the middle', group: 'View', also: 'canvas' },
  'view.controller': { label: 'Controller', icon: 'tv', tip: 'Show the controller only in the middle', group: 'View', also: 'canvas' },
  'view.both': { label: 'Both', icon: 'grid', tip: 'Show the map and the controller side by side', group: 'View', also: 'canvas' },
  'zoom.fit': { label: 'Fit', icon: 'search', tip: 'Fit the map in the window', group: 'View', also: 'zoom' },
  'zoom.100': { label: '100 %', icon: 'search', tip: 'One pixel here for one on the projector', group: 'View', also: 'zoom actual size' },
  'view.outline': { label: 'Table outline', icon: 'grid', tip: 'Show the table’s edge and its tiles over the map', group: 'View', also: 'tiles seams edge' },
  'dialog.media': { label: 'Media library…', icon: 'images', tip: 'Every file and online source of this table, in one place', group: 'View', also: 'files sources media' },
  'window.table': { label: 'Map window', icon: 'table', tip: 'Open the map projected on the table in a window of its own', group: 'View', also: 'open preview' },
  'window.tv': { label: 'Controller window', icon: 'tv', tip: 'Open the screen beside the table in a window of its own', group: 'View', also: 'open' },
  'window.dev': { label: 'Developer', icon: 'code', tip: 'The workbench: map, controls, widget gallery, live values, action log and problems', group: 'View', also: 'open workbench' },

  // ---- Help ----
  'help.tour': { label: 'Tour of the editor', icon: 'pointer', tip: 'A short tour of the window: the ribbon, the list, the map and controller, the Format pane, Present and Help. Its tick box decides whether it opens with the editor.', group: 'Help', also: 'tour introduction start welcome orientation' },
  'help.features': { label: 'Everything on the table', icon: 'layers', tip: 'Every layer, what it shows and where to find it', group: 'Help', also: 'guide features' },
  'help.troubleshooting': { label: 'When something is wrong', icon: 'alert', tip: 'The usual problems and how to fix them: projection, phones, empty layers, speed, updates', group: 'Help', also: 'troubleshooting' },
  'help.shortcuts': { label: 'Keyboard shortcuts', icon: 'info', tip: 'Every key the editor knows', group: 'Help', also: 'keys' },
  'help.report': { label: 'Report a problem', icon: 'alert', tip: 'Opens a new GitHub issue with the version and this computer filled in. You see it before anything is sent.', group: 'Help', also: 'bug issue feedback' },

  // ---- In the title bar and on the keys ----
  'edit.undo': { label: 'Undo', icon: 'undo', tip: 'Undo the last change', group: 'Edit' },
  'edit.redo': { label: 'Redo', icon: 'redo', tip: 'Redo the change just undone', group: 'Edit' },
  'edit.history': { label: 'History of changes', icon: 'undo', tip: 'Every change made to this table, to go back to', group: 'Edit', also: 'revisions earlier versions' },
  'file.save': { label: 'Save', icon: 'save', tip: 'Make sure every change has reached the table folder', group: 'File' },
} as const satisfies Record<string, CommandInfo>;

export type CommandId = keyof typeof COMMANDS;
