// The types of @mrstudio/sdk, written by MR Studio (`mrstudio layer new`, `mrstudio layer build`).
// Do not edit: the next build writes it again from the installed app. The code itself comes
// from the app that loads the layer.
//
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Nodal Works AB. These type definitions are licensed under the MIT License
// (https://opensource.org/license/mit), unlike the rest of MR Studio.

declare module "@mrstudio/sdk/voices" {
    /** A value fixed, or mapped from a published one: `params.x` or `shared.x`, from a range to a range. */
    export type VoiceValue = number | VoiceBinding;
    export interface VoiceBinding {
        bind: string;
        /** The input range. Values outside it are held at its ends. */
        from: [number, number];
        /** The output range. */
        to: [number, number];
        /** `linear` (default), or `sqrt` that rises fast and settles, or `square` that waits then rises. */
        curve?: 'linear' | 'sqrt' | 'square';
    }
    export type VoiceKind = 'noise' | 'hum' | 'tone';
    export interface VoiceSpec {
        id: string;
        kind: VoiceKind;
        /** 0 to 1, before the ceiling. */
        level?: VoiceValue;
        /** For `noise`: the band's centre in Hz. */
        centre?: VoiceValue;
        /** For `noise`: the band's width in octaves (0.2 narrow to 4 wide). */
        width?: VoiceValue;
        /** For `hum` and `tone`: the pitch in Hz. */
        frequency?: VoiceValue;
        /** For `hum`: how many harmonics above the fundamental, 0 to 6, each quieter than the last. */
        harmonics?: number;
        /** Seconds a change takes to settle. Default 2, never under `MIN_GLIDE_S`. */
        glide_s?: number;
    }
    /** The loudest the whole bed may be, all voices together. */
    export const VOICE_CEILING = 0.5;
    /** No voice changes faster than this: sound on the table is a bed, never an alarm. */
    export const MIN_GLIDE_S = 0.5;
    export const VOICE_KINDS: readonly VoiceKind[];
    /** What a binding reads from: the layer's params and what it published. */
    export interface VoiceSource {
        params: Record<string, unknown>;
        shared: Record<string, unknown>;
    }
    /** A voice value now. A binding whose value is missing gives the low end of its output, so silence is the default. */
    export function voiceValue(value: VoiceValue | undefined, source: VoiceSource, fallback: number): number;
    /** What one voice should sound like now, with its level already under the bed's share of the ceiling. */
    export interface VoiceTarget {
        gain: number;
        /** Noise: the band's centre. Hum and tone: the pitch. Hz, within hearing and the speakers. */
        frequency: number;
        /** Noise: the filter's Q for the band's width. */
        q: number;
        glide_s: number;
    }
    /** Where each voice should be now. The levels share `VOICE_CEILING`, so more voices never means louder. */
    export function voiceTargets(voices: readonly VoiceSpec[], source: VoiceSource): VoiceTarget[];
    /** Why a layer's `sound` is not one that can play, or an empty list. For the MCP and tests. */
    export function checkVoices(sound: unknown): string[];
    /**
     * A layer's voices, playing. `update` once a frame (or whenever values change) with the layer's
     * params and published values; `audible` false fades the bed out without stopping it, so the
     * switch back on picks up where the values are now. Nothing is heard before the page's first
     * gesture (the browser's autoplay rule).
     */
    export class VoiceBed {
        private playing;
        private stopped;
        private last;
        audible: boolean;
        private readonly voices;
        constructor(voices: readonly VoiceSpec[], options: {
            audible: boolean;
        });
        /** The targets the bed is gliding to: for tests and the controller. */
        targets(source: VoiceSource): VoiceTarget[];
        update(source: VoiceSource): void;
        stop(): void;
        private start;
    }
}
declare module "@mrstudio/sdk/types" {
    export const PROTOCOL = 1;
    export const LAYER_API = 1;
    /** `guide` is the guide's phone (#98): it drives tours and reads their notes. */
    export type Role = 'table' | 'tv' | 'phone' | 'dev' | 'guide';
    interface ControlBase {
        id: string;
        label: string;
        /** One or two sentences on what it does, shown as the control's tooltip in the editor (#64, #88). */
        help?: string;
        /**
         * The editor's time bar (#61) drives this control: `hour` a time of day in hours, `date` the day,
         * `progress` a share of a run (0 to 100), `play` the layer's own play switch.
         */
        clock?: 'hour' | 'date' | 'progress' | 'play';
        /** Phone participants may change it. Default: true for a `primary` control, false otherwise (#335). */
        phone?: boolean;
        /** Show only while other controls have these values. */
        visibleWhen?: Record<string, unknown>;
        /**
         * How prominent it is on the controller (docs/contracts/present.md): `primary` controls are large and
         * come first, `secondary` (the default) sit in a row under them, `more` wait behind "More settings".
         * `state` is never shown: a value the layer keeps for itself in its params, so every surface
         * shares it, such as where a video is (#194).
         */
        tier?: 'primary' | 'secondary' | 'more' | 'state';
    }
    export interface RangeControl extends ControlBase {
        type: 'range';
        min: number;
        max: number;
        step?: number;
        unit?: string;
        default: number;
        /**
         * A value the layer publishes, shown in place of the number while it has one: a network's
         * Time slider is a share of its series but reads "19:00" (#338).
         */
        shows?: string;
    }
    export interface SelectControl extends ControlBase {
        type: 'select';
        options: {
            value: string;
            label: string;
        }[];
        default: string;
    }
    export interface ToggleControl extends ControlBase {
        type: 'toggle';
        default: boolean;
    }
    export interface DateControl extends ControlBase {
        type: 'date';
        default: string;
        /** Days offered as one-tap choices: `MM-DD` in the year shown, or `today`. */
        presets?: {
            label: string;
            value: string;
        }[];
    }
    export interface ColorControl extends ControlBase {
        type: 'color';
        default: string;
    }
    export interface TextControl extends ControlBase {
        type: 'text';
        default: string;
        /**
         * The value is the id of a source from the Sources manager (#41) of one of these kinds
         * (`vasttrafik`, `lantmateriet`, `mapbox`, `carto`, `wms`, `wmts`, `arcgis`, `tiles`). The
         * editor offers the sources set up on this computer; the host signs requests with its key.
         */
        sources?: string[];
        /**
         * The value names something the table has (#306): a dataset or a file of one of these kinds.
         * The editor offers a list of them to pick from, and Add media, instead of a box to type in.
         */
        media?: MediaKind[];
        /** With `media`: the value is the dataset's name (the default) or the file's path in the table folder. */
        mediaBy?: 'name' | 'path';
        /** The value is a column of the dataset the layer's control with this id names (#306). */
        columnsOf?: string;
        /**
         * The value is one or more layers (comma-separated) of the map service the layer's other
         * controls name, by id: its address, its kind (`wms` or `arcgis`) and its sign-in (#306).
         */
        serviceLayers?: {
            url: string;
            service?: string;
            source?: string;
        };
        /** What an empty value means, shown as the first choice of a list (`media`, `columnsOf`), such as "Built-in birdsong". Default "None". */
        none?: string;
    }
    /**
     * What a table's media are (#306), as `GET /api/media` lists them: `map` (GeoJSON), `table` (CSV),
     * `raster` (GeoTIFF), `drawing` (SVG), `picture`, `video`, `sound`, `model` (the 3D model), `data` (other files).
     */
    export type MediaKind = 'map' | 'table' | 'raster' | 'drawing' | 'picture' | 'video' | 'sound' | 'model' | 'data';
    export interface ActionControl extends ControlBase {
        type: 'action';
        /**
         * Pressed with a few words typed first (#462), such as a comment on a sketch mark: `prompt`
         * is the field's placeholder, `max` its length (default 120). The layer's `action` gets them.
         */
        words?: {
            prompt?: string;
            max?: number;
        };
    }
    export type Control = RangeControl | SelectControl | ToggleControl | DateControl | ColorControl | TextControl | ActionControl;
    export interface ToolSpec {
        id: string;
        type: 'point' | 'line' | 'polygon';
        label?: string;
        /** False: inputs from other surfaces play no attention cue on the table (#105). Default true. */
        cue?: boolean;
        /** A line drawn with one stroke of the finger instead of tapped corners (#335): a pen. */
        freehand?: boolean;
    }
    /**
     * A set of things on the table a visitor can pick and change one by one (#279): the buildings of
     * an energy community, the stops of a line. Each entity is a feature of `dataset`, named by its
     * `key` property, and has its own values for `controls`. The controller shows the picked one's
     * controls under its name; the host keeps the values in `params.entities[set][entity]`.
     */
    export interface EntitySet {
        /** The set's id, unique in the layer: `params.entities[id]`. */
        id: string;
        /** A dataset from site.json `data` (also `buildings`, the scene's footprints). Name it in `requires.data`. */
        dataset: string;
        /** The feature property that names each entity: unique, a string or a number. `#` is the feature's place in the dataset. */
        key: string;
        /** The feature property shown as its name. Default `key`. */
        label?: string;
        /** A feature property for changes to many at once, such as the owner: "Apply to all of <owner>". */
        group?: string;
        /** What one entity is called on the controller, such as "Building". Default "Item". */
        name?: string;
        /** Each entity's values. Actions are not allowed; `phone: true` lets phones change it. */
        controls: Exclude<Control, ActionControl>[];
        /**
         * Feature properties the controller shows for the picked entity, read only (#38: a custom
         * layer's "tap to read"). A set may have facts and no controls.
         */
        facts?: (string | EntityFact)[];
        /**
         * A log of layers read from another dataset (#602): a well's or a borehole's soil and rock from
         * the top down, drawn as a column on the controller for the picked entity.
         */
        log?: EntityLog;
        /** Milliseconds of quiet before the table's `entities` handler runs, for layers that call a model on change. Default 0. */
        debounce_ms?: number;
    }
    /**
     * A fact read on the controller with its own words (#410): "Noise 48 dB" rather than "Noise db 48".
     * `scale` multiplies a number first (0.31 with scale 100 and unit % reads "31 %").
     */
    export interface EntityFact {
        column: string;
        label?: string;
        unit?: string;
        scale?: number;
        /** Decimals for a number. Default: none for whole numbers, else up to two. */
        decimals?: number;
    }
    /**
     * Where an entity's log is (#602): rows of another dataset, one per layer, found by the entity's
     * key in `key`, each from a depth to a depth with a material: `{ dataset: "well-logs", key:
     * "BRUNNS_ID", from: "FRANDJUP", to: "TILLDJUP", material: "JORD_BERG" }`.
     */
    export interface EntityLog {
        /** A dataset from site.json `data`. Name it in `requires.data`. */
        dataset: string;
        /** The column of the log that holds the entity's key. */
        key: string;
        /** Columns of each layer's top and bottom, as depths. */
        from: string;
        to: string;
        /** The column that says what the layer is: clay, sand, rock. */
        material: string;
        /** A column of remarks shown beside a layer. */
        note?: string;
        /** The depths' unit. Default `m`. */
        unit?: string;
        /** What the column is called on the controller. Default "Layers". */
        title?: string;
    }
    /** An entity that is picked on the table and the controller: `state.selection`. */
    export interface EntitySelection {
        set: string;
        id: string;
    }
    /** Entities whose values changed, by set: what the table's `entities` handler gets. */
    export interface EntityChange {
        set: string;
        ids: string[];
    }
    /** Palette groups in the scene composer. */
    export type LayerCategory = 'base' | 'ambient' | 'analysis' | 'media';
    /** A dialog of a layer's settings in the editor (#644), opened from a button in its settings. */
    export interface LayerDialog {
        id: string;
        /** The button and the dialog's title, such as "Design the walk". */
        label: string;
        /** A line under the title. */
        lead?: string;
        /** The ids of the controls it holds, in order. */
        controls: string[];
        /** Named actions (`actions` in layer.json) it offers as buttons, such as saving. */
        actions?: string[];
        /** A live preview beside the controls: `phone-spot` is the phone's Mark a spot sheet. */
        preview?: 'phone-spot';
    }
    export interface LayerManifest {
        api: number;
        id: string;
        name: string;
        description?: string;
        icon?: string;
        /** Where the composer's palette lists the layer. Default `analysis`. */
        category?: LayerCategory;
        /** The layer stays open when another layer's button is pressed on the controller. Default false. */
        alongside?: boolean;
        /** While the layer is open, the map at rest (its `base` and `ambient` layers) is turned off on the table, and comes back when it closes. The slideshow does this (#205). Default false. */
        hidesAtRest?: boolean;
        /** Phones may turn the layer on and off (#335). Default true; false for a layer only the controller should open. */
        phone_switch?: boolean;
        /** The layer may share the table with a second open layer (#473). Default true; false for one that fills the table, such as the slideshow. */
        combine?: boolean;
        /** `app` (#509): for a site layer, the oldest MR Studio it runs in, such as `">=0.50"`; `mrstudio layer build` writes it. */
        requires?: {
            kernels?: string[];
            data?: string[];
            services?: string[];
            app?: string;
        };
        controls?: Control[];
        tools?: ToolSpec[];
        /**
         * The controller's centre for this layer. `custom` gives it to the module's `stage(ctx, el)`, such
         * as a map app of the layer's own (#283). A layout (#357) builds it from panels with no code: any
         * widget, its controls, a map. Default: the generated controls only.
         */
        stage?: 'custom' | StageLayout;
        /**
         * Named actions without a button of their own (#283), pressed from the layer's stage, hero or
         * panels with `ctx.action(id)`, and handled on the table in `action(id)`.
         */
        actions?: {
            id: string;
            label?: string;
        }[];
        /** Things a visitor picks on the table and changes one by one on the controller (#279). */
        entities?: EntitySet[];
        /** A sound bed of up to four voices that follow the layer's values (#282, voices.ts). Plays on the table only. */
        sound?: import("@mrstudio/sdk/voices").VoiceSpec[];
        /** TV panels the layer contributes while it is on. Rules in docs/contracts/dashboard.md. */
        panels?: PanelSpec[];
        /** The layer is a sequence: its instances may have `steps.sequence` that show other layers (the slideshow). */
        sequence?: boolean;
        /**
         * Larger panels for the editor (#644): a button in the layer's settings opens a dialog with these
         * controls and actions, so settings that need room (a walk's design) get it. In the editor they live
         * only there; the controller lists them as usual.
         */
        dialogs?: LayerDialog[];
        /** The layer reveals its items through a shape it sets with `ctx.reveal` (the Magnifier, the Reveal line, #287). Default false. */
        reveals?: boolean;
        /**
         * For a site's own code layer (#277): the address its built module is imported from, set by the
         * host when `layers/<name>/dist/index.js` exists. Absent for core layers, which are bundled.
         */
        module?: string;
        /**
         * For a site's own code layer whose code is not run on this computer (#506): the table was
         * opened without its programs. There is no `module` then; the layer draws nothing and says why.
         */
        held?: boolean;
        /** Set by the host on a site layer built for a newer MR Studio than this one: the version it needs. It comes without `module`. */
        needs_app?: string;
        /** With `needs_app`: this computer's version. */
        this_app?: string;
        /** For a custom layer saved in the site: the recipe the runtime draws. Absent for a code layer. */
        custom?: CustomLayer;
        /** Rows of the layer's legend on the controller (docs/contracts/present.md). */
        legend?: LegendItem[];
        /** The effect behind the layer on the controller's attract loop (docs/contracts/present.md). */
        attract?: {
            effect: string;
        };
        /**
         * The layer's words in other languages (#80), from its package's `locales/<language>.json`:
         * by language, then by the English text. Read by the visitors' screens; see docs/contracts/layer.md.
         */
        locales?: Record<string, Record<string, string>>;
    }
    /**
     * A layer's controller centre made of panels (#357), on the dashboard's grid: the same panel format
     * as a site's TV pages, so one editor edits both. Panels with `at` stay where they are put; panels
     * without are laid out in order.
     */
    export interface StageLayout {
        /**
         * A map that fills the centre under the layer's name (#374), with the map widget's props
         * (`data`, `entities`, `tool`, `tap_action`, `shapes`, `hint`, `fill_by`, `stroke_by`, `labels`).
         * It zooms with drag and pinch. `panels` then sit along its bottom edge: up to 4, chip or tile.
         */
        map?: Record<string, unknown>;
        /** The stage's panels; with a `map`, the ones along its edge. Without a map, at least one. */
        panels?: PanelSpec[];
        /** Also show the layer's generated control rows under the panels. Default false: the panels are the view. */
        controls?: boolean;
    }
    export interface LegendItem {
        id: string;
        label: string;
        color?: string;
        shape?: 'line' | 'fill' | 'point' | string;
        /** A heading over this row and the ones after it with the same group (#622): which scale the rows belong to. */
        group?: string;
    }
    /** How Next moves through a layer, and a sequence's steps. */
    export interface Steps {
        mode?: 'manual' | 'timed';
        loop?: boolean;
        /** What Next does once a step's sub-steps are done. */
        reveal?: 'stop' | 'then-next';
        /** How a sequence goes from one step to the next, unless a step says otherwise (#43). Default a 0.7 s fade. */
        transition?: 'cut' | 'fade' | 'dip';
        transition_s?: number;
        sequence?: SequenceStep[];
    }
    /** One step of a sequence: another instance, a layer of the scene or one of the sequence's items. */
    export interface SequenceStep {
        layer: string;
        params?: Params;
        duration_s?: number;
        /** `fade` cross-fades; `dip` fades out to the empty map, then in. */
        transition?: 'cut' | 'fade' | 'dip';
        transition_s?: number;
        next?: 'stop' | 'then-next';
        title?: string;
        description?: string;
        source?: string;
        /** What the guide says at this step (#98): on the guide's phone and in the editor, never for visitors. */
        notes?: string;
    }
    /** A custom layer: a recipe of blocks, saved under `custom` in site.json and used as `custom:<id>`. */
    export interface CustomLayer {
        name: string;
        description?: string;
        icon?: string;
        category?: LayerCategory;
        data?: RecipeData[];
        look?: RecipeBlock[];
        motion?: RecipeBlock[];
        interaction?: RecipeBlock[];
        enter?: 'cut' | 'fade';
        controls?: (Control & {
            bind?: string;
        })[];
        legend?: LegendItem[];
        attract?: {
            effect: string;
        };
    }
    /** One source of a custom layer: exactly one of dataset, path, wms and tiles. */
    export interface RecipeData {
        id: string;
        dataset?: string;
        path?: string;
        wms?: {
            url: string;
            layers: string;
            styles?: string;
            format?: string;
            source?: string;
        };
        tiles?: string;
    }
    export interface RecipeBlock {
        id: string;
        block: string;
        data?: string;
        on?: string;
        props?: Record<string, unknown>;
    }
    /** The closed set of panel sizes on the TV grid. */
    export type PanelSize = 'chip' | 'tile' | 'wide' | 'tall' | 'block' | 'hero' | 'band' | 'strip';
    /** A live value: `params.<control>`, `shared.<key>` or `site.<field>` of the panel's layer. */
    export interface Binding {
        bind: string;
    }
    /** One panel: a widget of a fixed size. Plain JSON, so an editor can write it. */
    export interface PanelSpec {
        /** Unique within the layer or page. */
        id: string;
        /** A widget type from the registry: `stat`, `bars`, `series`, `ramp`, `timeline`, `text`, `custom`. */
        widget: string;
        size: PanelSize;
        title?: string;
        /** The widget's props. Values may be literals or bindings, as the widget's schema allows. */
        props?: Record<string, unknown>;
        /** Show only while the layer's params have these values. A list means any of those values. */
        visibleWhen?: Record<string, unknown>;
        /** Higher is placed first by the automatic layout. Default 0. */
        priority?: number;
        /** Fixed position on the grid, 1-based. Only in a site's pages; layers never choose positions. */
        at?: {
            col: number;
            row: number;
        };
        /** In a site's pages: the layer whose params and shared values the bindings read. */
        layer?: string;
        /**
         * Drawn on the table's ribbon, the projector's blank space beside the model (#78), instead of the TV.
         * Only small sizes (`chip`, `tile`, `wide`); rules in docs/contracts/present.md, Ribbon.
         */
        ribbon?: boolean;
    }
    /** `tv` in site.json. */
    /**
     * How finely the table is drawn (#134): `draft` is light on a slow machine, `good` suits most, and `best` uses the
     * screen's full pixel density and the finest sun shadows.
     */
    export type DisplayQuality = 'draft' | 'good' | 'best';
    export interface TvConfig {
        layout?: string;
        /** Where the controls sit. Default `left`. */
        rail?: 'left' | 'right' | 'none';
        /** Style tokens the site overrides. */
        theme?: Record<string, string>;
        /** Hand-made pages. Without them the active layers' panels are laid out automatically. */
        pages?: {
            id: string;
            title?: string;
            panels: PanelSpec[];
        }[];
        /** Seconds each page stays up when there is more than one. Default 12. */
        rotate_s?: number;
        /** How the controller's layer buttons look: `icons` (a square icon with a short name under it, the default) or `labelled` (icon and name side by side, in a wider rail). */
        rail_style?: 'icons' | 'labelled';
        /** The built-in theme `theme` was taken from, if any (see `THEMES` in @mrstudio/dashboard). */
        theme_name?: string;
        /** The About page the controller's About button opens. Without it there is no About button. */
        about?: TvAbout;
        /** Seconds with no touch before the controller goes home, as Reset does. Default 180; 0 never. */
        idle_reset_s?: number;
        /** Seconds each layer stays up on the home screen's attract loop. Default 4. */
        attract_s?: number;
        /**
         * The controller's Map controls group (#198): Reset view, Full screen and Calibrate, for
         * whoever runs the table. Default true; false leaves only Reset, for a table visitors run alone.
         */
        map_controls?: boolean;
        /**
         * Phones may turn layers on and off (#335). Default true. Phones never switch layers while a
         * slideshow or tour is showing, whatever this says.
         */
        phone_switch?: boolean;
        /**
         * A second layer can join the open one (#473): hold its button, or Shift-click it. At most two;
         * the controller shows the newest one's controls. Default true.
         */
        two_layers?: boolean;
    }
    /** The site's About page on the controller: a title, a few lines, and who made it. */
    export interface TvAbout {
        title?: string;
        text?: string;
        credits?: {
            role?: string;
            name: string;
            note?: string;
        }[];
        /** Logos along the top of the Credits page: images in the site folder, with the name each stands for. Without them, `branding.logo`. */
        logos?: {
            path: string;
            name?: string;
        }[];
    }
    export interface Grid {
        width: number;
        height: number;
        cell_m: number;
        rotation_deg: number;
    }
    export interface SiteInfo {
        id: string;
        name: string;
        origin: {
            lon: number;
            lat: number;
        };
        extent: {
            width_m: number;
            height_m: number;
            rotation_deg: number;
        };
        grid: Grid;
        /** Extent corners as [lon, lat]: top left, top right, bottom right, bottom left. */
        corners: [[number, number], [number, number], [number, number], [number, number]];
        timezone: string | null;
        table: {
            width_cm: number;
            height_cm: number;
            tile_cm?: number;
            /** The edge of the projected image where visitors stand. Default bottom. */
            front?: 'top' | 'bottom' | 'left' | 'right';
            /** What the projector's blank space shows per side: off, auto, or a size in cm (docs/contracts/present.md). */
            ribbons?: Partial<Record<'top' | 'bottom' | 'left' | 'right', 'off' | 'auto' | {
                cm: number;
            }>>;
            /** The ambient glow in the projector's blank space, in the model's own colours (#476). */
            glow?: {
                on?: boolean;
                strength?: number;
                colours?: 'edges' | 'one';
            };
            /** How the projected table opens, at start and after Reset: the layers fading in (the default) or the zoom in (#446). */
            intro?: 'fade' | 'zoom';
        } | null;
        basemap: {
            background: string;
            style: string | null;
        };
        /** Table settings (#73): the controller's title, logo and the welcome line under the title. */
        branding: {
            title: string | null;
            logo: string | null;
            welcome?: string | null;
            /** The languages visitors can switch between (#80), the first the table starts in. */
            languages?: string[];
            /** The site's own words in other languages, by language and then by the English text. */
            translations?: Record<string, Record<string, string>>;
        };
        /** The calibrated table view, when the site has a calibration.json. */
        calibration: {
            center: {
                lon: number;
                lat: number;
            };
            zoom: number;
            bearing: number;
            window?: {
                width_px: number;
                height_px: number;
            };
        } | null;
        /** Datasets layers may read, by name: site-relative paths served under `/site/`. */
        data: Record<string, string>;
        tv?: TvConfig | null;
        /** How the table's surfaces render (#134). Without it, `good`. */
        display?: {
            quality?: DisplayQuality;
        } | null;
        /** The table's palette (#93): a built-in set and the slots it changes. Resolve with `resolvePalette`. */
        palette?: {
            set?: string;
            slots?: Record<string, string>;
        } | null;
        /** The 3D model of the site (`scene.mesh`, docs/contracts/site.md), and whether footprints are raised beside it. */
        mesh?: SiteMesh;
    }
    /** A placed 3D model: a file in the site folder and the numbers that put it on the ground. */
    export interface SiteMesh {
        path: string;
        anchor: {
            lon: number;
            lat: number;
        };
        unit_m: number;
        bearing_deg: number;
        base_m: number;
        /** Which axis of the file points up. Default z. */
        up?: 'z' | 'y';
        mirror?: boolean;
        /** For a model in map coordinates: the point of the file (Z up) taken as its origin (#344). */
        offset?: [number, number];
        ground_tolerance_m: number;
        /** False when the model, not the footprints, gives the buildings their shape. */
        extrude: boolean;
    }
    export type Params = Record<string, unknown>;
    export interface LayerState {
        /** The layer package this instance runs. */
        layer: string;
        active: boolean;
        /** How strongly the layer is drawn on the table, 0 to 2. 1 is as the layer intends. Applied by the runtime. */
        intensity: number;
        params: Params;
        shared: Record<string, unknown>;
        /** How the site offers the layer on the controller. What is left out comes from the layer package. */
        button: LayerButton;
        /** Ids of the controls the controller and phones leave out. The editor still shows them. */
        hide?: string[];
        /** For an item: the layer it belongs to. It has no button and comes on with that layer. */
        parent?: string;
        /**
         * For an item of a revealing layer (#606): 1 puts it in the surface stack, shown outside the
         * glass or on the far side of the line; absent, it is in the stack underneath, shown through it.
         */
        stack?: 1;
        /** How Next moves through the layer, and a sequence's steps, as site.json has them. */
        steps?: Steps;
        /** Where Next is while the layer is on: a sequence's current step, or the sub-steps the layer reported. */
        step?: StepState;
        /** For the layer a sequence is showing as its current step: that sequence. */
        shown_by?: string;
        /**
         * Part of the map at rest although its package is not a base or ambient layer: a layer of
         * the scene that site.json starts on and gives no button (#204). It has no button on the
         * controller and stays on while button layers open and close.
         */
        rest?: boolean;
        /** The entity picked on the table or the controller (#279), shared by every surface. */
        selection?: EntitySelection | null;
        /**
         * Trouble while the layer is on (#259): it could not start or lost its data. Absent while it
         * runs as it should. The runtime reports it from the table; the editor and controller show it.
         */
        health?: LayerHealth;
        /** The layer's play head (#373), kept by the host: read it with `ctx.clock.now()`. Absent until the table sets one. */
        clock?: LayerClock;
    }
    /**
     * Where a layer's time is (#373): `value`, in the units of its `clock` time control, at the host's
     * moment `at` (ms since 1970), moving `rate` units a second (0 while it stands still).
     */
    export interface LayerClock {
        value: number;
        rate: number;
        at: number;
    }
    /** A layer that is on but not running as it should (#259). */
    export interface LayerHealth {
        /** `retrying`: starts again by itself in `retry_in` seconds. `failed`: waits for Retry. */
        status: 'retrying' | 'failed';
        /** What went wrong, in words. */
        reason: string;
        retry_in?: number;
    }
    /**
     * Where Next is in a layer (docs/contracts/present.md, Steps). Moved with the host request
     * `layer.step { layer, to: 'next' | 'previous' | 'first' | 'skip' | 'all' | number }`, and
     * played or paused with `layer.play { layer, playing }`.
     *
     * For a sequence, `index` and `count` count its steps, and `sub` is the shown layer's
     * sub-steps. For any other layer they count its sub-steps, and `index` is how many are
     * revealed, from 0 to `count`.
     */
    export interface StepState {
        index: number;
        count: number;
        sub?: {
            index: number;
            count: number;
        };
        /** Moving on by itself: timed mode, or sub-steps played one after another. */
        playing: boolean;
        title?: string;
        description?: string;
        source?: string;
        /** What each sub-step is called, for the controller's legend. */
        titles?: string[];
    }
    /** The button that opens a layer on the controller, as the site's author set it. */
    export interface LayerButton {
        name?: string;
        description?: string;
        /** An icon name, such as `sun` or `route`. */
        icon?: string;
        side?: 'left' | 'right';
        /** The group of buttons it sits in on its rail, such as "Simulations". */
        group?: string;
        /** Its place in the rail; lower first. */
        order?: number;
        /** Kept off the controller and phones, without taking the layer out of the table (#58). */
        hidden?: boolean;
    }
    export interface Participant {
        /** The surface in the slot. It changes when the phone reconnects; the slot does not. */
        surface: number;
        slot: number;
        colour: string;
        /** False while the slot is held for a phone that dropped. */
        connected: boolean;
        /** The phone's animal (#339): fox, octopus, owl, frog, turtle, penguin, butterfly, unicorn, otter, hedgehog, whale or bee. */
        avatar?: string;
        /** With the animal, the fun name: `sunny` and `fox` make "Sunny Fox". */
        mood?: string;
        /** The name the visitor gave themselves, if any. */
        name?: string | null;
    }
    export interface SessionState {
        protocol: number;
        /** `join_url` is what the TV's QR code points at; null when phones cannot reach the host. */
        session: {
            id: string;
            code: string;
            port: number;
            join_url: string | null; /** The visitors' language now (#80). */
            language?: string; /** False while the controller's sound switch mutes the table (#282). */
            sound?: boolean; /** The layer whose ribbon the controller chose (#231); absent or null is Auto. */
            ribbon?: string | null; /** The frame meter shows on the table and controller (#262). */
            performance?: boolean; /** The operator paused the phones (#335): they look but change nothing. */
            phones_paused?: boolean; /** How many views draw the table and run its layers (#412); 0 means no live values. */
            tables?: number;
        };
        site: SiteInfo;
        /** Layer instance ids in draw order, bottom first. */
        scene: string[];
        /** By instance id, which is the layer id unless site.json names the entry. */
        layers: Record<string, LayerState>;
        participants: Participant[];
    }
    /** A `[lon, lat]` position in WGS84. */
    export type Position = [number, number];
    /** The GeoJSON geometry a tool produces: `Point` for point, `LineString` for line, `Polygon` for polygon. */
    export type ToolGeometry = {
        type: 'Point';
        coordinates: Position;
    } | {
        type: 'LineString';
        coordinates: Position[];
    } | {
        type: 'Polygon';
        coordinates: Position[][];
    };
    export interface ToolInput {
        layer: string;
        tool: string;
        /** Checked by the host: the tool's kind, in WGS84, polygon rings closed. */
        geometry: ToolGeometry;
        /** The surface that sent it. */
        from: number;
        /** Present when it came from a phone, with its animal (#423). */
        participant?: Sender;
    }
    /** The phone that sent a tool input or pressed an action. */
    export interface Sender {
        slot: number;
        colour: string;
        /** The phone's animal (#339), an id from the runtime's animal list. */
        avatar?: string;
        name?: string | null;
    }
    export interface FieldFrame {
        stream: number;
        /** Index into the stream's `fields`. */
        field: number;
        width: number;
        height: number;
        revision: number;
        min: number;
        max: number;
        progress: number;
        /** Quantised over [min, max] when Uint8Array. Row-major, row 0 at the top. */
        data: Uint8Array | Float32Array;
    }
    export interface StreamStatus {
        stream: number;
        state: 'running' | 'done';
        progress: number;
        revision: number;
        info: Record<string, any>;
    }
}
declare module "@mrstudio/sdk/service" {
    /** What a service call gave back. */
    export interface ServiceAnswer<T = unknown> {
        value: T;
        /** Set when the service could not answer and this is the answer it gave before: when, in ms since 1970. */
        cached?: number;
    }
    /** A long run (an optimiser): its progress, its result, and a way to stop waiting. */
    export interface ServiceJob<T = unknown> {
        readonly result: Promise<ServiceAnswer<T>>;
        cancel(): void;
    }
    export interface JobProgress {
        /** 0..1 when the service says, else undefined. */
        progress?: number;
        /** What the service says it is doing. */
        message?: string;
        state: string;
    }
    export interface JobOptions {
        /** Called on every poll. */
        onProgress?(progress: JobProgress): void;
        /** Seconds between polls. Default 1. */
        every_s?: number;
    }
    export interface ServiceClient {
        readonly id: string;
        get<T = unknown>(path: string): Promise<ServiceAnswer<T>>;
        post<T = unknown>(path: string, body: unknown): Promise<ServiceAnswer<T>>;
        /**
         * Starts a job: POSTs `body` to `path`, which answers `{ "job": "<id>" }` (or `job_id`), then
         * polls `GET <path>/<id>` until it says `state` (or `status`) `done` / `completed` / `failed`,
         * with `progress` (0..1) and `message` on the way and `result` at the end. ECOM's
         * `/api/optimize` works this way. The finished result is kept by the host, so when the service
         * cannot be reached the same job's last result is given instead.
         */
        job<T = unknown>(path: string, body: unknown, options?: JobOptions): ServiceJob<T>;
        /** Whether the service is up, starting, installing, down or remote, and why. */
        status(): Promise<{
            state: string;
            message?: string;
        } | undefined>;
    }
    export class ServiceError extends Error {
        readonly status: number;
        constructor(message: string, status: number);
    }
    type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
    /** The client for one of the site's services. `base` is the host's address (empty on the host's own pages). */
    export function serviceClient(id: string, options?: {
        base?: string;
        fetch?: Fetch;
    }): ServiceClient;
    /** What a layer publishes as `busy` for the controller to show while a service works. */
    export interface BusyState {
        label: string;
        /** 0..1, or absent while the service does not say. */
        progress?: number;
    }
}
declare module "@mrstudio/sdk/blocks/geo" {
    import type { SiteInfo } from "@mrstudio/sdk/types";
    /** A position in table metres. */
    export type Point = readonly [x: number, y: number];
    /** A position in WGS84. */
    export type LonLat = readonly [lon: number, lat: number];
    export interface TableFrame {
        readonly width: number;
        readonly height: number;
        /** WGS84 to table metres. */
        toTable(lonLat: LonLat): [number, number];
        /** Table metres to WGS84. */
        toLonLat(point: Point): [number, number];
        /** Whether a point is on the table, with an optional margin in metres. */
        contains(point: Point, margin?: number): boolean;
    }
    /**
     * The table frame of a site. Uses the same tangent-plane projection and grid
     * rotation as the engine (`mrs-site` projection, `mrs-engine` grid), so a point
     * drawn by a block lands on the cell a kernel computed for it.
     */
    export function tableFrame(site: Pick<SiteInfo, 'origin' | 'extent'>): TableFrame;
    export function distance(a: Point, b: Point): number;
    /** A polyline with its running length, so a position along it is a binary search. */
    export interface MeasuredPath {
        readonly points: readonly Point[];
        /** Distance from the start to each point, in metres. */
        readonly stations: readonly number[];
        readonly length: number;
    }
    export function measurePath(points: readonly Point[]): MeasuredPath;
    /** The point at a fraction (0..1) of a path's length, and the heading there in radians. */
    export function pointAlong(path: MeasuredPath, fraction: number): {
        point: [number, number];
        heading: number;
    };
    /** A curved line between two points, for flows that have no street route. `bend` is the sag as a share of the distance. */
    export function arc(from: Point, to: Point, bend?: number, segments?: number): [number, number][];
    /** Rings of one polygon: the outer ring first, then holes. */
    export type Polygon = readonly (readonly Point[])[];
    export function pointInRing(point: Point, ring: readonly Point[]): boolean;
    export function pointInPolygon(point: Point, polygon: Polygon): boolean;
    /** Area-weighted centre of a polygon's outer ring. Falls back to the mean of its points. */
    export function centroid(polygon: Polygon): [number, number];
    /** Distance from a point to the nearest segment of a line. */
    export function distanceToLine(point: Point, line: readonly Point[]): number;
}
declare module "@mrstudio/sdk/blocks/sources" {
    import type { MeasuredPath, Polygon, TableFrame } from "@mrstudio/sdk/blocks/geo";
    export interface Source<T> {
        /** Reads the value once. */
        load(): Promise<T>;
        /** Calls back with the value now and whenever it changes. Returns a function that stops watching. */
        watch(onValue: (value: T) => void, onError?: (error: Error) => void): () => void;
    }
    /** The part of `fetch` the sources use, so tests and the host gateway can stand in for it. */
    export type Fetcher = (url: string) => Promise<{
        ok: boolean;
        status: number;
        text(): Promise<string>;
        json(): Promise<unknown>;
    }>;
    export interface SourceOptions {
        fetch?: Fetcher;
    }
    /** A source over a fixed value or a one-off read. */
    export function staticSource<T>(read: () => Promise<T> | T): Source<T>;
    /** Derives a source from another, for reshaping a service's reply into what a block wants. */
    export function mapSource<T, U>(source: Source<T>, map: (value: T) => U): Source<U>;
    export interface GeoJsonFeature {
        type: 'Feature';
        id?: string | number;
        geometry: {
            type: string;
            coordinates: any;
        } | null;
        properties: Record<string, any> | null;
    }
    export interface GeoJsonCollection {
        type: 'FeatureCollection';
        features: GeoJsonFeature[];
        [key: string]: unknown;
    }
    /** A GeoJSON FeatureCollection in WGS84, from a URL or an object already in hand. */
    export function geojsonSource(input: string | GeoJsonCollection, options?: SourceOptions): Source<GeoJsonCollection>;
    type Properties = Record<string, any>;
    /** A filled shape: a building, a district, a grid cell. */
    export interface Area<P = Properties> {
        id: string | number;
        polygons: Polygon[];
        centre: [number, number];
        properties: P;
    }
    /** A line: a street, a route, a flow between two nodes. */
    export interface Path<P = Properties> extends MeasuredPath {
        id: string | number;
        properties: P;
    }
    /** A point: a node, a stop, a point of interest. */
    export interface Spot<P = Properties> {
        id: string | number;
        point: [number, number];
        properties: P;
    }
    export interface Shapes<P = Properties> {
        areas: Area<P>[];
        paths: Path<P>[];
        spots: Spot<P>[];
    }
    /**
     * Turns GeoJSON into shapes in table metres, sorted by geometry type. `idProperty`
     * names the property that identifies a feature; without it the feature's own id or
     * its index is used. Multi-part lines and points become one shape per part.
     */
    export function readShapes<P = Properties>(collection: GeoJsonCollection, frame: TableFrame, idProperty?: string): Shapes<P>;
    export type Row = Record<string, string | number>;
    /**
     * Parses CSV text with a header row. Handles quoted fields, doubled quotes and
     * both line endings. Cells that look like numbers become numbers; the separator
     * is detected from the header (comma, semicolon or tab).
     */
    export function parseCsv(text: string): Row[];
    /** Rows of a CSV file, from a URL. */
    export function csvSource(url: string, options?: SourceOptions): Source<Row[]>;
    /** Columns of a table as arrays, e.g. one hourly series per column. */
    export function columns(rows: Row[], names: string[]): Record<string, number[]>;
    export interface LiveOptions<T> extends SourceOptions {
        /** Seconds between reads. */
        every: number;
        /** Turns the reply into the value. Default: the JSON body. */
        parse?: (body: unknown) => T;
        /** Longest wait after repeated failures, in seconds. Default: ten times `every`. */
        maxBackoff?: number;
        /** For tests. */
        timer?: {
            set(run: () => void, ms: number): unknown;
            clear(handle: unknown): void;
        };
    }
    /**
     * A JSON endpoint read on an interval. Watchers share one poll loop, which runs
     * only while someone is watching. A failed read keeps the last good value, reports
     * the error and backs off, so a service that is down does not blank the table.
     */
    export function liveSource<T = unknown>(url: string, options: LiveOptions<T>): Source<T>;
    /** Lower-cases and strips accents and punctuation, so 'Kårhus' and 'karhus' are the same key. */
    export function foldKey(value: unknown): string;
    /**
     * Attaches table rows to shapes by a shared key, e.g. a CSV of energy classes onto
     * building footprints. Returns how many shapes found a row, so a layer can say when
     * its data does not match its geometry instead of drawing nothing.
     */
    export function joinRows<S extends {
        properties: Record<string, any>;
    }>(shapes: S[], rows: Row[], keys: {
        shape: string;
        row: string;
        fold?: boolean;
    }): {
        matched: number;
        unmatched: S[];
    };
}
declare module "@mrstudio/sdk/blocks/view" {
    import type { CanvasOverlay } from "@mrstudio/sdk/layer";
    import type { Point, TableFrame } from "@mrstudio/sdk/blocks/geo";
    /** The subset of `CanvasRenderingContext2D` the blocks use. */
    export type Pen = Pick<CanvasRenderingContext2D, 'beginPath' | 'moveTo' | 'lineTo' | 'closePath' | 'arc' | 'rect' | 'fill' | 'stroke' | 'clip' | 'save' | 'restore' | 'fillText' | 'setLineDash' | 'createRadialGradient' | 'clearRect' | 'drawImage' | 'quadraticCurveTo' | 'fillRect' | 'fillStyle' | 'strokeStyle' | 'lineWidth' | 'lineCap' | 'lineJoin' | 'globalAlpha' | 'globalCompositeOperation' | 'font' | 'textAlign' | 'textBaseline' | 'shadowColor' | 'shadowBlur' | 'shadowOffsetX' | 'shadowOffsetY' | 'lineDashOffset' | 'imageSmoothingEnabled'>;
    export interface View {
        readonly pen: Pen;
        /** Pixels per metre. Sizes given in metres are multiplied by this; sizes in pixels are not. */
        readonly scale: number;
        /** Table metres to pixels. */
        toPx(point: Point): [number, number];
        /** Seconds since the layer started, for anything that animates. */
        readonly time: number;
        /** Multiplies pixel sizes (line widths, radii, fonts), e.g. inside a magnifier. */
        readonly detail: number;
    }
    /**
     * How the table sits on a surface of `widthPx` by `heightPx`: as large as fits, centred.
     * This is the one place table metres become surface pixels. The runtime fits the map the
     * same way, and when calibration lands it changes here and nowhere else.
     */
    export function fitTable(frame: Pick<TableFrame, 'width' | 'height'>, widthPx: number, heightPx: number): {
        scale: number;
        x: number;
        y: number;
    };
    /** A view that fits the whole table onto a surface. Without a height the table is taken to fill the width. */
    export function tableView(pen: Pen, frame: Pick<TableFrame, 'width' | 'height'>, widthPx: number, time?: number, heightPx?: number): View;
    /**
     * A view of the same scene magnified around a point, as a lens sees it: `centre`
     * stays where it is on the surface and everything around it is `zoom` times larger.
     */
    export function zoomedView(view: View, centre: Point, zoom: number): View;
    export interface CanvasSurface {
        /** A view for this frame. Resizes the backing store to the element and clears it. */
        begin(time: number): View;
        readonly canvas: HTMLCanvasElement;
    }
    /**
     * Puts a canvas inside a table decoration (`ctx.map.addElement()`) and returns views
     * onto it. The canvas follows the element's size and the screen's pixel density.
     */
    export function canvasSurface(container: HTMLElement, frame: TableFrame): CanvasSurface;
    /**
     * Views onto a map canvas (`ctx.map.addCanvas(id)`), for layers that draw blocks on the table
     * (#414). The canvas follows the map, so drawings land on the base buildings wherever the map
     * puts the table: inside margins, calibrated or turned. Each `begin` clears the canvas and clips
     * to the table, so nothing spills past its edge. Prefer this to `canvasSurface(ctx.map.addElement())`,
     * which fits the table to the whole window and comes out too large when the map has margins.
     */
    export function mapSurface(overlay: CanvasOverlay, frame: TableFrame): CanvasSurface;
}
declare module "@mrstudio/sdk/blocks/interaction" {
    import type { ToolInput } from "@mrstudio/sdk/types";
    import type { Point, TableFrame } from "@mrstudio/sdk/blocks/geo";
    import type { Area, Path, Shapes, Spot } from "@mrstudio/sdk/blocks/sources";
    import type { View } from "@mrstudio/sdk/blocks/view";
    /**
     * Where a sample came from. New sources are added here, behaviours do not change.
     * `hand` is a hand seen by a camera over the table (#289): it hovers like a mouse that never
     * presses, so hover behaviours work with it as they are.
     */
    export type InputSource = 'mouse' | 'touch' | 'pen' | 'phone' | 'token' | 'hand' | 'script';
    export interface PointerSample {
        /**
         * Identifies one pointer for as long as it exists: one mouse, one finger, one
         * participant's phone, one physical token. Simultaneous pointers have different ids.
         */
        id: string;
        source: InputSource;
        /** `down` and `up` bracket a press; `move` arrives with or without one; `leave` ends the pointer. */
        phase: 'move' | 'down' | 'up' | 'leave';
        /** Position in table metres. */
        point: [number, number];
        /** The same position in WGS84, for kernel params and services. */
        lonLat: [number, number];
        /** Whether the pointer is pressed (a button held, a finger on the glass, a token on the table). */
        pressed: boolean;
        /** Seconds, on a clock shared by all samples of a surface. */
        time: number;
        /** Rotation in radians for sources that have one: a token's heading, a dial's angle. */
        rotation?: number;
        /** The participant behind a phone pointer (the surface number from `tool.input`). */
        owner?: number;
    }
    /**
     * A point tool input from a phone as a pointer sample: a press at that place. Lines
     * and polygons are not pointers and return null; a layer handles those as drawings.
     */
    export function fromToolInput(input: ToolInput, frame: TableFrame, time?: number): PointerSample | null;
    /** Something that reacts to pointers. Returns true when it used the sample, which stops it reaching behaviours behind it. */
    export interface Behaviour {
        handle(sample: PointerSample): boolean;
    }
    /**
     * Offers each sample to the behaviours in order; the first to use it wins. A
     * behaviour that used a pointer's `down` keeps that pointer until its `up`, so a
     * drag that wanders over another behaviour's target is not stolen.
     */
    export function pointerRouter(behaviours: readonly Behaviour[]): Behaviour;
    /**
     * Gives every pointer its own behaviour: each mouse, finger, phone or token gets
     * an agent, a probe or a lens of its own. The behaviour is made when the pointer
     * first appears and dropped when it leaves (unless `keep`).
     */
    export class PerPointer<B extends Behaviour> implements Behaviour {
        private make;
        private keep;
        private byPointer;
        constructor(make: (sample: PointerSample) => B | null, options?: {
            keep?: boolean;
        });
        handle(sample: PointerSample): boolean;
        /** The live behaviours with their pointer ids, for drawing. */
        entries(): [id: string, behaviour: B][];
    }
    export interface AgentOptions {
        /** Where the agent starts. */
        position: Point;
        /**
         * `drag`: press on the agent and move it. `place`: any press puts it there.
         * `follow`: it goes wherever the pointer is, pressed or not.
         */
        mode?: 'drag' | 'place' | 'follow';
        /** How close a press must be to pick the agent up, in metres. Default 15. */
        grab_m?: number;
        /** Adjusts a wanted position: keep it on the table, snap it to a street, keep it out of buildings. */
        constrain?: (wanted: Point, from: Point) => Point;
        /** Called when the position changed. Send it on from here. */
        onMove?: (agent: Agent, sample: PointerSample) => void;
        /** Called when a drag ends or the agent is placed. */
        onSettle?: (agent: Agent, sample: PointerSample) => void;
    }
    /**
     * A marker a pointer moves: a person whose view is computed, a camera for a
     * street-level view, an origin or a destination. It also keeps a heading: the
     * direction it last moved, or the rotation of the token that drives it.
     */
    export class Agent implements Behaviour {
        position: [number, number];
        /** Radians, 0 pointing right, clockwise on the table. */
        heading: number;
        /** The pointer currently holding the agent, if any. */
        heldBy: string | null;
        private options;
        constructor(options: AgentOptions);
        handle(sample: PointerSample): boolean;
        private moveTo;
    }
    /** Keeps a position on the table, with a margin in metres. A ready-made `constrain`. */
    export function keepOnTable(frame: Pick<TableFrame, 'width' | 'height'>, margin?: number): (wanted: Point) => [number, number];
    export interface LensOptions {
        /** Radius of the lens on the table, in metres. */
        radius_m: number;
        /** Magnification inside the lens. 1 shows the same scale, which is what an X-ray or scenario lens wants. */
        zoom?: number;
        position?: Point;
        /** Zoom range when a dial or token rotation drives the zoom. */
        zoomRange?: readonly [number, number];
        onChange?: (lens: Lens) => void;
    }
    /**
     * A circle that follows a pointer and shows something different inside: the same
     * scene magnified (a magnifying glass), another layer (an X-ray), another scenario
     * (today against 2050). A press pins it in place and another press releases it.
     */
    export class Lens implements Behaviour {
        centre: [number, number];
        radius_m: number;
        zoom: number;
        pinned: boolean;
        /** False until a pointer has shown where the lens is. */
        visible: boolean;
        private options;
        constructor(options: LensOptions);
        handle(sample: PointerSample): boolean;
    }
    export interface LensStyle {
        /** What hides the scene under the lens before the inside is drawn. Default opaque near-black. */
        backdrop?: string | null;
        rim?: string;
        /** Rim width in pixels. */
        rimWidth?: number;
    }
    /**
     * Draws a lens: clips to its circle, clears what is underneath, and calls `inside`
     * with a view magnified around the lens centre. Whatever blocks `inside` draws
     * appear in the lens, so the same draw function serves the table and the glass,
     * and a different one makes an X-ray.
     */
    export function drawLens(view: View, lens: Pick<Lens, 'centre' | 'radius_m' | 'zoom' | 'pinned' | 'visible'>, inside: (inner: View) => void, style?: LensStyle): void;
    export type Hit<P = Record<string, any>> = {
        kind: 'area';
        shape: Area<P>;
        point: Point;
    } | {
        kind: 'path';
        shape: Path<P>;
        point: Point;
    } | {
        kind: 'spot';
        shape: Spot<P>;
        point: Point;
    };
    /**
     * What is under a point: the nearest spot or path within `tolerance_m`, otherwise
     * the area containing it. Small things win over the big things they sit on.
     */
    export function hitTest<P>(shapes: Partial<Shapes<P>>, point: Point, tolerance_m?: number): Hit<P> | null;
    export interface ProbeOptions<P> {
        /** The shapes to read, looked up on every sample so data may change. */
        shapes: () => Partial<Shapes<P>>;
        tolerance_m?: number;
        /** The thing under the pointer changed (null when it left everything). */
        onHover?: (hit: Hit<P> | null, sample: PointerSample) => void;
        /** A press on something, or on nothing (null), which clears the selection. */
        onSelect?: (hit: Hit<P> | null, sample: PointerSample) => void;
    }
    /** Hover and select: the readout behind "click a building to see its numbers". */
    export class Probe<P = Record<string, any>> implements Behaviour {
        hover: Hit<P> | null;
        selected: Hit<P> | null;
        private options;
        constructor(options: ProbeOptions<P>);
        handle(sample: PointerSample): boolean;
    }
    export interface DwellOptions {
        /** How long the pointer must stay put. */
        seconds: number;
        /** How far it may drift and still count as staying put, in metres. Default 10. */
        radius_m?: number;
        onDwell: (sample: PointerSample) => void;
        /** The pointer moved on after a dwell. */
        onLeave?: (sample: PointerSample) => void;
    }
    /**
     * Fires when a pointer rests in one place: reveal details without a click, which
     * suits a table where people point more than they press. Call `check(time)` every
     * frame, since a pointer that is perfectly still sends no samples.
     */
    export class Dwell implements Behaviour {
        private options;
        private resting;
        constructor(options: DwellOptions);
        handle(sample: PointerSample): boolean;
        /** Fires any dwell that has become due at `time` (seconds, the samples' clock). */
        check(time: number): void;
    }
    /** A region a pointer can be over, in table metres. */
    export interface HoverRegion<D = unknown> {
        id: string;
        contains(point: Point): boolean;
        /** Anything the layer wants back with the region: a name, a colour, a phase. */
        data?: D;
    }
    /** A region made of polygons (rings of table metres, outer ring first), such as a district. */
    export function areaRegion<D>(id: string, polygons: Point[][][], data?: D): HoverRegion<D>;
    /** A round region around a point, such as an artwork's place. */
    export function circleRegion<D>(id: string, centre: Point, radius_m: number, data?: D): HoverRegion<D>;
    /**
     * A region drawn as a picture over the whole table: wherever the picture is painted (alpha
     * above `threshold`, 0 to 255) is inside. `pixels` is RGBA, `width` by `height`, as
     * `getImageData` gives it; `table` is the table's size in metres.
     */
    export function maskRegion<D>(id: string, pixels: {
        width: number;
        height: number;
        data: ArrayLike<number>;
    }, table: {
        width: number;
        height: number;
    }, options?: {
        threshold?: number;
        data?: D;
    }): HoverRegion<D>;
    export interface HoverRegionsOptions<D> {
        /** The regions, asked for on every sample, so they may change. The first that contains a point wins. */
        regions: () => readonly HoverRegion<D>[];
        /** How long a pointer must stay over a region before it counts, so passing over does nothing. Default 0.25 s. */
        settle_s?: number;
        /** Seconds a region's `level` takes to rise to 1 and to fall back. Default 0.6. */
        fade_s?: number;
        /** Only pointers from these sources hover. Default: all but `phone` and `script`, which have no hover. */
        sources?: readonly InputSource[];
        /** A region began to be held: the first pointer settled over it. */
        onEnter?: (region: HoverRegion<D>, sample: PointerSample) => void;
        /** The last pointer over a region left it. */
        onLeave?: (region: HoverRegion<D>, sample: PointerSample) => void;
    }
    /**
     * Hovering over large regions of the table plays something there (#289): a mouse now, a hand
     * seen by a camera later. Each region has an eased `level` (0 to 1) that rises while a pointer is
     * over it and falls when it leaves, for the layer to draw with; `onEnter` and `onLeave` are for
     * what goes to other surfaces (`ctx.publish`, the controller's legend). It never uses a sample,
     * so a click still reaches the behaviours behind it. Call `tick(dt, time)` every frame.
     */
    export class HoverRegions<D = unknown> implements Behaviour {
        private options;
        /** By pointer: the region it is over, since when, and whether it settled. */
        private pointers;
        private levels;
        private held;
        constructor(options: HoverRegionsOptions<D>);
        handle(sample: PointerSample): boolean;
        /** Moves the levels on by `dt` seconds and settles pointers that stayed put until `time` (the samples' clock). */
        tick(dt: number, time?: number): void;
        /** How strongly a region plays now, eased from 0 to 1. */
        level(id: string): number;
        /** The regions pointers are over now. */
        active(): HoverRegion<D>[];
        /** Whether anything still eases, so a layer that draws only on change knows to keep drawing. */
        get moving(): boolean;
        private settle;
        /** Works out which regions are held, and says which began and ended. */
        private refresh;
    }
}
declare module "@mrstudio/sdk/colormap" {
    /** A colour ramp: stops at positions 0..1 with RGBA 0..255. */
    export interface Colormap {
        stops: [position: number, r: number, g: number, b: number, a: number][];
    }
    export const colormaps: {
        /** Shadow mask for projection: dark where shaded, a warm wash where lit. */
        daylight: {
            stops: [number, number, number, number, number][];
        };
        /** Sequential, dark to bright, for accumulated quantities. */
        sun: {
            stops: [number, number, number, number, number][];
        };
        /** Blue to red through green, for speeds. */
        speed: {
            stops: [number, number, number, number, number][];
        };
        /** Standing water by depth: clear on dry ground, a deepening blue in puddles, bright where it pools deep. */
        water: {
            stops: [number, number, number, number, number][];
        };
        /** Running water by speed: teal where it barely moves (pooling, as in the Chalmers demo), blue as it runs, white when fast. */
        runoff: {
            stops: [number, number, number, number, number][];
        };
    };
    /** Renders a colormap to a 256-entry RGBA lookup table. */
    export function lut(colormap: Colormap): Uint8Array;
    /** A CSS gradient of the colormap, for legends. */
    export function cssGradient(colormap: Colormap, direction?: string): string;
    /**
     * The same ramp reaching its top colour at `fraction` of the range instead of at the end.
     * Use it to show a field quantised over 0..max on a legend that ends at `fraction * max`.
     */
    export function stretch(colormap: Colormap, fraction: number): Colormap;
}
declare module "@mrstudio/sdk/frame" {
    import type { FieldFrame } from "@mrstudio/sdk/types";
    export const FRAME_HEADER_LEN = 40;
    /** Parses a binary field frame. Layout in docs/contracts/engine.md. */
    export function parseFrame(buffer: ArrayBuffer): FieldFrame;
    /** The value of a cell in field units, whatever the encoding. */
    export function sample(frame: FieldFrame, col: number, row: number): number;
}
declare module "@mrstudio/sdk/connection" {
    import type { FieldFrame, LayerManifest, Role, SessionState } from "@mrstudio/sdk/types";
    export interface Welcome {
        surface: number;
        /** Phones only: present it in the next `hello` to return to the same slot. */
        resume?: string;
        /** Phones only: every seat was taken, so this phone looks but changes nothing (#462). */
        watching?: boolean;
        state: SessionState;
        manifests: LayerManifest[];
        /** The host's clock when it said welcome, in ms since 1970 (#373). */
        time?: number;
    }
    type Listener = (payload: any) => void;
    /** One message seen on the connection, for the Developer window's action log (#358). */
    export interface ConnectionTrace {
        kind: 'request' | 'event';
        method: string;
        payload: unknown;
        /** When it was sent or arrived (performance.now()). */
        at: number;
        /** A request's round trip, once answered. */
        ms?: number;
        ok?: boolean;
        error?: string;
    }
    /** How long a request waits for its answer before it fails (#510). The host answers in milliseconds. */
    export const REQUEST_TIMEOUT_MS = 30000;
    /**
     * The single link between a surface and the host: JSON requests and events,
     * and binary field frames. Reconnects on its own and reports each (re)welcome.
     */
    export class Connection {
        private socket;
        private nextId;
        private pending;
        private listeners;
        private frameListeners;
        private tracers;
        private retry;
        private closed;
        private readonly url;
        private readonly role;
        private readonly code;
        private resume;
        private offset;
        /** `resume` is a token kept from an earlier welcome, for a phone that reloaded. */
        constructor(options: {
            url: string;
            role: Role;
            code?: string;
            resume?: string;
        });
        /** The host's time now, in ms since 1970: what a play head's `at` counts in (#373). */
        hostNow(): number;
        /** Connects and resolves with the first welcome. Later reconnects emit `welcome`. */
        connect(): Promise<Welcome>;
        /**
         * Asks the host and resolves with its answer. Fails when the host refuses, when the connection
         * is lost, and when no answer came within `timeoutMs` (30 s unless given; 0 waits for ever).
         */
        request<T = unknown>(method: string, params?: object, options?: {
            timeoutMs?: number;
        }): Promise<T>;
        /**
         * Tells the host about an error in this window (#260), for the app's log. Dropped while
         * disconnected. The runtime sends these; a layer just throws, or logs with `console.error`.
         */
        report(error: {
            message: string;
            stack?: string;
            layer?: string;
            window?: string;
        }): void;
        /**
         * Says this window of the desktop app is alive and drawing at `fps` (#79), with its worst frame
         * of the last 10 s and the costliest layers (#262). Dropped while disconnected.
         */
        alive(window: string, fps: number, budget?: {
            worst_ms: number;
            layers: {
                id: string;
                ms: number;
                worst_ms: number;
            }[];
        }): void;
        /** Subscribes to an event. Returns the function that unsubscribes. */
        on(event: string, listener: Listener): () => void;
        /** Sees every request this window makes (once answered) and every event it gets. Returns the function that stops it. */
        trace(listener: (trace: ConnectionTrace) => void): () => void;
        private traced;
        onFrame(listener: (frame: FieldFrame) => void): () => void;
        close(): void;
        /** Calls every listener of `event`. One that throws does not keep the event from the others (#510). */
        private emit;
        /** A listener threw, or a message could not be read: the console and the app's log hear of it. */
        private failedListener;
    }
}
declare module "@mrstudio/sdk/engine" {
    import type { Connection } from "@mrstudio/sdk/connection";
    import type { FieldFrame, StreamStatus } from "@mrstudio/sdk/types";
    export interface OpenOptions {
        /** `u8` (default) is quantised over the field's range; `f32` is exact. */
        encoding?: 'u8' | 'f32';
        /** Upper bound on frames per second. Default 30. */
        maxHz?: number;
    }
    /**
     * A running kernel job whose fields arrive as frames. Survives reconnects:
     * it reopens itself with its latest params.
     */
    export class FieldStream {
        private id;
        private params;
        private dirty;
        private sending;
        private closed;
        private fieldListeners;
        private statusListeners;
        private errorListeners;
        private unsubscribe;
        private readonly connection;
        private readonly kernel;
        private readonly fields;
        private readonly options;
        constructor(connection: Connection, kernel: string, params: Record<string, unknown>, fields: string[], options: OpenOptions);
        open(): Promise<void>;
        /** Changes params. Calls are coalesced: while one is in flight only the latest values are kept. */
        set(params: Record<string, unknown>): void;
        on(field: string, listener: (frame: FieldFrame) => void): void;
        onStatus(listener: (status: StreamStatus) => void): void;
        onError(listener: (error: Error) => void): void;
        close(): void;
        private flush;
        private fail;
    }
    /** One what-if change to the scene (`ctx.engine.edit`). Places are WGS84 `[lon, lat]`. */
    export type SceneEdit = {
        kind: 'building';
        outline: [number, number][];
        height_m: number;
    } | {
        kind: 'tree';
        at: [number, number];
        radius_m: number;
        height_m: number;
    } | {
        kind: 'remove';
        at: [number, number];
    };
    export class EngineClient {
        private readonly connection;
        constructor(connection: Connection);
        /** Starts a kernel job and streams the named fields back. */
        open(kernel: string, params: Record<string, unknown>, fields: string[], options?: OpenOptions): Promise<FieldStream>;
        /**
         * Asks a kernel about one place instead of the whole table (sunlight: that spot's light every few
         * minutes across the day, and its sun hours). `at` is WGS84 `[lon, lat]`; the site's own position
         * fills `lat`/`lon` params as for `open`. Rejects for a place off the table or a kernel without probes.
         */
        probe<T = Record<string, unknown>>(kernel: string, params: Record<string, unknown>, at: readonly [number, number] | readonly number[]): Promise<T>;
        /**
         * What-if changes over the baked scene (#500), seen by every kernel until replaced: buildings added or taken
         * away, trees planted or felled. Each call replaces the last list; `[]` gives the baked scene back, as does the
         * table going away. Table only. Nothing is saved to the site. See docs/contracts/engine.md.
         */
        edit(edits: readonly SceneEdit[]): Promise<void>;
        info(): Promise<{
            backend: string;
            adapter: string | null;
            kernels: {
                id: string;
            }[];
        }>;
    }
}
declare module "@mrstudio/sdk/model" {
    import type { Colormap } from "@mrstudio/sdk/colormap";
    import type { FieldOverlay, FieldOverlayStyle } from "@mrstudio/sdk/layer";
    import type { FieldFrame } from "@mrstudio/sdk/types";
    export type SurfaceKind = 'ground' | 'roof' | 'wall';
    /** A point in the site's local frame: metres east and north of the site origin, and up from the site datum. */
    export type ModelPoint = [east: number, north: number, up: number];
    /**
     * Picks surfaces of the twin. Every condition given must hold; an empty query is everything.
     * Buildings are named by the `id` of their footprint feature (or its `properties.id`), and
     * by their position in the footprints file when they have neither.
     */
    export interface SurfaceQuery {
        kind?: SurfaceKind | SurfaceKind[];
        building?: string | string[];
        /** Buildings whose footprint has this property: equal to a value, one of several, or inside a range. */
        attribute?: {
            name: string;
            equals?: unknown;
            in?: unknown[];
            min?: number;
            max?: number;
        };
        /** Surfaces within `radius_m` of a point on the ground plan. */
        within?: {
            east: number;
            north: number;
            radius_m: number;
        };
    }
    export interface SurfaceMaterial {
        /** The surface's own colour, which lights then shade. CSS colour. */
        color?: string;
        /** Light the surface gives off whatever the lighting, such as lit windows. CSS colour. */
        emissive?: string;
        /** 0 hides the surface, 1 is solid. */
        opacity?: number;
    }
    interface LightBase {
        /** CSS colour. Default white. */
        color?: string;
        /** 1 lights a white surface that faces the light fully. Default 1. */
        intensity?: number;
        /** Whether the twin casts shadows in this light. Default true for the sun, false otherwise. */
        shadows?: boolean;
    }
    export interface SunLight extends LightBase {
        type: 'sun';
        /** Compass bearing of the sun, clockwise from north, degrees. */
        azimuth: number;
        /** Angle above the horizon, degrees. At or below 0 the sun gives no light. */
        altitude: number;
        /** Light from the whole sky, so shade is not black. */
        sky?: {
            color?: string;
            intensity?: number;
        };
    }
    export interface PointLight extends LightBase {
        type: 'point';
        position: ModelPoint;
        /** How far the light reaches, in metres. It is even up close and fades out towards this distance. Default 30. */
        range_m?: number;
    }
    export interface SpotLight extends LightBase {
        type: 'spot';
        position: ModelPoint;
        /** What the light points at. */
        target: ModelPoint;
        /** Full width of the cone, degrees. Default 60. */
        angle_deg?: number;
        /** How soft the cone's edge is, 0 (hard) to 1. Default 0.3. */
        softness?: number;
        range_m?: number;
    }
    export type ModelLight = SunLight | PointLight | SpotLight;
    export interface LightHandle<L extends ModelLight = ModelLight> {
        /** Changes some of the light's properties. Cheap enough to call every frame. */
        set(patch: Partial<Omit<L, 'type'>>): void;
        remove(): void;
    }
    export interface ModelHit {
        position: ModelPoint;
        kind: SurfaceKind;
        /** The building the surface belongs to, if any. */
        building?: string;
    }
    export type ModelFieldStyle = FieldOverlayStyle & {
        /** Which surfaces take the field. Default ground and roof. A wall shows the value of the cell at its foot. */
        on?: SurfaceKind[];
    };
    /** What a layer may do to the twin. Everything added is removed with the layer. */
    export interface ModelHandle {
        /** True when a projector calibration is in use; false on a flat table or screen, where the twin is seen from straight above. */
        readonly calibrated: boolean;
        /** Paints a kernel field on the twin. */
        addField(id: string, style: ModelFieldStyle & {
            colormap: Colormap;
        }): FieldOverlay;
        /** Lights the twin. With any light on, unlit surfaces are dark, as on the physical model. */
        addLight<L extends ModelLight>(light: L): LightHandle<L>;
        /**
         * Sharp sun shadows over the table's extent, as a field frame to draw with a map field: 1 where the sun reaches the
         * ground or a roof, 0 in shade, about 0.3 m per pixel. It comes from a GPU shadow map of the buildings' real
         * footprints raised to their roofs, the ground and any imported model, so edges stay crisp at any table size, unlike
         * a kernel field's cells. Resolves to null where there is no twin; use the kernel's field instead. `onChange` is
         * called when the mask for the same sun would come out differently (the table's quality changed), so the layer
         * can ask again; the latest call's callback is the one kept.
         */
        sunShadowMask(sun: {
            azimuth: number;
            altitude: number;
        }, onChange?: () => void): Promise<FieldFrame | null>;
        /** Changes how the picked surfaces look. A later call wins where two overlap. */
        setMaterial(target: SurfaceQuery, material: SurfaceMaterial): void;
        /** Dims everything except the picked surfaces. `null` ends the focus. */
        focus(region: SurfaceQuery | null, options?: {
            dim?: number;
        }): void;
        /**
         * Where a point of the table image meets the twin. `x` and `y` are fractions of the
         * image from its top left corner; the ray runs through the projector's camera.
         */
        pick(x: number, y: number): ModelHit | null;
    }
    export const SURFACE_KINDS: SurfaceKind[];
    export interface TwinMesh {
        /** x east, y north, z up, in metres. Three per vertex. */
        positions: Float32Array;
        /** Unit normals scaled to -127..127. Three per vertex. */
        normals: Int8Array;
        /** Index into `SURFACE_KINDS`, per vertex. */
        kinds: Uint8Array;
        /** 0 for none, otherwise the footprint feature's position in the site's buildings file plus one. */
        buildings: Uint32Array;
        indices: Uint32Array;
        minZ: number;
        maxZ: number;
    }
    /** Parses the twin served at `/api/model`. Layout in docs/contracts/model.md. */
    export function parseTwin(buffer: ArrayBuffer): TwinMesh;
}
declare module "@mrstudio/sdk/reveal" {
    import type { Point } from "@mrstudio/sdk/blocks/geo";
    /**
     * Where a revealing layer's items show, in table metres (x right, y down from the top left).
     * - `circle`: inside a circle, a magnifying glass; with `outside`, everywhere but the circle
     *   (the surface around an X-ray, #606).
     * - `side`: on one side of a straight line across the table, `before` the smaller coordinate
     *   (left of a vertical line, above a horizontal one) or `after` it.
     * - `none`: nowhere; the items are hidden.
     * `null` instead of a shape shows the items everywhere.
     */
    export type RevealShape = {
        kind: 'circle';
        centre: Point;
        radius_m: number;
        outside?: boolean;
    } | {
        kind: 'side';
        axis: 'x' | 'y';
        at_m: number;
        keep: 'before' | 'after';
    } | {
        kind: 'none';
    };
    /** What a revealing layer's context offers: `ctx.reveal`. */
    export interface LayerReveal {
        /** Shows the layer's items only inside `shape`; null shows them everywhere. Cheap to call every frame. */
        set(shape: RevealShape | null): void;
        /**
         * Gives one item, by its place among the layer's items (0 is the first), a shape of its own
         * instead of the layer's: the Reveal line's second map on the other side of the line (#349).
         * `undefined` hands the item back to the layer's shape.
         */
        item(index: number, shape: RevealShape | null | undefined): void;
    }
    /** The other side of a line; any other shape is returned as it is. */
    export function otherSide(shape: RevealShape): RevealShape;
    /**
     * Everywhere the shape is not (#606): stack 1 of a revealing layer, the surface, shows here while
     * stack 2 shows through the shape. Outside a glass, the other side of a line; everywhere for
     * nowhere, and nowhere for everywhere (`null`).
     */
    export function revealComplement(shape: RevealShape | null): RevealShape | null;
    /** Whether a point (table metres) is where the items show. */
    export function revealContains(shape: RevealShape | null, point: Point): boolean;
    /**
     * The shape as a polygon in table metres, inside a table of `width` by `height` metres:
     * a circle as `segments` points, a side as the rectangle it keeps. Empty for `none`. Outside a
     * circle is one outline with a hole: far around the table, in to the circle by a seam and round
     * it the other way, so a non-zero fill (CSS `polygon()`) leaves the circle out.
     * The runtime projects it for the CSS clip of canvases and decorations.
     */
    export function revealPolygon(shape: RevealShape, width: number, height: number, segments?: number): Point[];
    /** Adds the shape to a canvas path in the context's own units (table metres on a drawing overlay). */
    export function revealPath(pen: Pick<CanvasRenderingContext2D, 'beginPath' | 'arc' | 'moveTo' | 'lineTo' | 'closePath'>, shape: RevealShape, width: number, height: number): void;
    /** The same shape, or two shapes that clip alike, so a caller can skip redrawing. */
    export function sameReveal(a: RevealShape | null, b: RevealShape | null): boolean;
    /**
     * The shape as numbers for a shader: `kind` 0 everywhere, 1 circle (x, y, radius), 2 side
     * (axis 0 for x or 1 for y, at, +1 keeps after or -1 keeps before), 3 nowhere, 4 outside a
     * circle (x, y, radius). In metres.
     */
    export function revealUniform(shape: RevealShape | null): {
        kind: number;
        values: [number, number, number];
    };
}
declare module "@mrstudio/sdk/widgets" {
    import type { PanelSize } from "@mrstudio/sdk/types";
    /** One prop of a widget. `kind` decides both validation and the editor's field. */
    export type PropSpec = ({
        kind: 'text';
        max: number;
    } | {
        kind: 'number';
        min?: number;
        max?: number;
    }
    /** A number or a short string, shown as the widget's value. */
     | {
        kind: 'value';
    } | {
        kind: 'boolean';
    } | {
        kind: 'enum';
        options: string[];
    }
    /** A colour ramp: a name from `@mrstudio/sdk`, or a ramp object (`{ stops }`) a layer publishes. */
     | {
        kind: 'colormap';
    }
    /** A categorical colour slot of the theme, 1 to 6. */
     | {
        kind: 'slot';
    }
    /** A list of numbers, such as a series' values. Always live. */
     | {
        kind: 'numbers';
        maxLength: number;
    }
    /** A list of objects with their own props. `max` is the most items the widget draws. */
     | {
        kind: 'list';
        max: number;
        item: Record<string, PropSpec>;
    }
    /** GeoJSON: a FeatureCollection, a Feature or a geometry, usually bound to what a layer publishes. */
     | {
        kind: 'geojson';
    }
    /** How a map colours its features by data (#374): see `ColourBy`. */
     | {
        kind: 'colourBy';
    }) & {
        /** Shown in the editor. */
        label: string;
        required?: boolean;
        /**
         * May be `{ "bind": "shared.x" }` instead of a literal. A `list` may always be bound as a whole
         * (#373): its items are checked against `item` as they arrive.
         */
        bindable?: boolean;
        default?: unknown;
    };
    export interface WidgetHandle {
        /** Draws the resolved props. Called on every change, so it must be cheap. */
        update(props: Record<string, any>): void;
        destroy?(): void;
    }
    /** What a widget gets when it is mounted. */
    export interface WidgetEnv {
        size: PanelSize;
        /**
         * For input widgets (#354): the layer's controls and named actions, to read and to change. Absent
         * for a panel with no layer (a site page panel without `layer`). Where a panel can't be touched
         * (the table's ribbon) `touch` is false: an input widget then shows the value and does nothing.
         */
        controls?: PanelControls;
        /**
         * The panel's layer (#355), for widgets that work with the site and the table: a map that picks
         * an entity or sends a point. Absent for a panel with no layer. `touch` is false where the panel
         * can't be touched.
         */
        layer?: PanelLayer;
        /** For `custom` only: hands the element to the layer's `panel` function. */
        custom?: (el: HTMLElement) => {
            update?(): void;
        } | void;
        /**
         * A widget's own words in the visitors' language (#373): the layer's `locales`, then the site's,
         * then the runtime's; `{name}` is filled from `vars`. Absent outside the runtime: say the text as it is.
         */
        say?: (text: string, vars?: Record<string, string | number>) => string;
    }
    /** A layer's controls as a panel reaches them: the host checks every change as it does the controller's. */
    export interface PanelControls {
        /** False where the panel can't be touched, such as the table's ribbon. */
        touch: boolean;
        /** A control of the layer (layer.json `controls`) or a named action (`actions`), by id. */
        find(id: string): import("@mrstudio/sdk/types").Control | {
            type: 'action';
            id: string;
            label?: string;
        } | undefined;
        /** A control's value now. */
        value(id: string): unknown;
        /** Changes a control's value, as its controller control would. */
        set(id: string, value: unknown): void;
        /** Presses an action control or a named action. */
        press(id: string): void;
    }
    /** A panel's layer as a widget reaches it: the site, what is picked, and the ways to the table. */
    export interface PanelLayer extends Pick<import("@mrstudio/sdk/layer").PanelContext, 'site' | 'selection' | 'select' | 'sendTool' | 'action'> {
        readonly touch: boolean;
        /** The layer's manifest, in the visitors' language: its entity sets, tools and controls. */
        readonly manifest: import("@mrstudio/sdk/types").LayerManifest | undefined;
        /** The layer's params now, entity values among them (#374: a map coloured by an entity value). */
        readonly params?: import("@mrstudio/sdk/types").Params;
        /** What the layer published (#374: a map coloured by a shared value). */
        readonly shared?: Record<string, unknown>;
    }
    export interface WidgetDefinition {
        type: string;
        name: string;
        description: string;
        /** The sizes it may take, smallest first. */
        sizes: PanelSize[];
        props: Record<string, PropSpec>;
        /** Stricter limits on a list prop for a size, such as fewer bars in a `wide` panel. */
        listMax?: (prop: string, size: PanelSize) => number | undefined;
        /** What the panel costs: the number of separate things a visitor has to read. */
        reads(props: Record<string, any>, size: PanelSize): number;
        /** Builds the widget inside a panel body. Only called in a browser. */
        mount(el: HTMLElement, env: WidgetEnv): WidgetHandle;
        /** Set by the runtime on a team widget: the layer package it came from. */
        owner?: string;
        /**
         * Made-up props for the Developer window's widget gallery (#358): plain values, no bindings.
         * A widget without one is shown with no props.
         */
        example?: Record<string, unknown>;
    }
    /** Declares a widget. */
    export function defineWidget(widget: WidgetDefinition): WidgetDefinition;
    /** The name a team widget is known by on the site: the layer's id, a slash, the widget's type. */
    export function teamWidgetType(layer: string, type: string): string;
    /** Why a widget definition can't be used, or an empty list. The runtime skips a widget with problems. */
    export function checkWidget(widget: unknown): string[];
    /**
     * How a map colours its features by data (#374): by a feature's property, an entity's value or
     * a value the layer publishes for each feature (`shared[key][id]`). Numbers follow `ramp` between
     * `min` and `max` (the data's own range when left out); anything else follows `categories`, a
     * value to a CSS colour or a data colour slot (1 to 6), or the data slots in turn.
     */
    export interface ColourBy {
        property?: string;
        entity?: string;
        shared?: string;
        /** The dataset to colour when the map has no entity set: default its first dataset. */
        dataset?: string;
        /** A colour ramp's name from `colormaps`, or two or more CSS colours. Default dark blue to yellow. */
        ramp?: string | string[];
        categories?: Record<string, string | number>;
        min?: number;
        max?: number;
    }
}
declare module "@mrstudio/sdk/layer" {
    import type { ServiceClient } from "@mrstudio/sdk/service";
    import type { PointerSample } from "@mrstudio/sdk/blocks/interaction";
    import type { Colormap } from "@mrstudio/sdk/colormap";
    import type { EngineClient } from "@mrstudio/sdk/engine";
    import type { ModelHandle } from "@mrstudio/sdk/model";
    import type { LayerReveal } from "@mrstudio/sdk/reveal";
    import type { EntityChange, EntitySelection, FieldFrame, LayerManifest, Params, Sender, SiteInfo, StepState, ToolGeometry, ToolInput } from "@mrstudio/sdk/types";
    export interface FieldOverlayStyle {
        colormap?: Colormap;
        /** 0..1, multiplied with the colormap's own alpha. */
        opacity?: number;
        /** Interpolate between cells. Default true. */
        smooth?: boolean;
        /** Blur radius in cells, for soft edges such as shadow penumbras. Default 0. */
        soften?: number;
        /** Seconds over which a new frame eases in, so stepped results move smoothly. Quantised frames only. Default 0. */
        glide?: number;
    }
    /** A field drawn on the table. The frame is uploaded as a texture and coloured on the GPU. */
    export interface FieldOverlay {
        set(frame: FieldFrame): void;
        setStyle(style: FieldOverlayStyle): void;
        remove(): void;
    }
    /**
     * A 2D drawing stretched over the table, inside the scene's draw order. The context is scaled so that one
     * unit is one metre: x runs right from 0 to `width`, y runs down from 0 to `height`.
     * Use `tableSpace(ctx.site)` to turn WGS84 coordinates into these metres.
     */
    export interface DrawingOverlay {
        readonly ctx: CanvasRenderingContext2D;
        /** Table width and height in metres. */
        readonly width: number;
        readonly height: number;
        /** Canvas pixels per metre, for line widths that should stay crisp. */
        readonly scale: number;
        /** Erases everything. */
        clear(): void;
        /** Puts what was drawn since the last commit on the table. */
        commit(): void;
        setOpacity(opacity: number): void;
        remove(): void;
    }
    export interface FlowOverlayStyle {
        /** Colours tracers by the local magnitude of the field. */
        colormap?: Colormap;
        /** The magnitude at the top of the colormap. Default: the frames' `max`. */
        max?: number;
        /**
         * `ribbons` are steady streamlines with a light travelling along them, `particles` fine specks with short tails,
         * `droplets` glowing drops with longer trails that land anywhere on the flow, like rain on running water. Default `ribbons`.
         */
        mode?: 'ribbons' | 'particles' | 'droplets';
        /** Number of particles; ribbons use an eighth as many streamlines. Default 500. */
        count?: number;
        /** Share of the extent's longer side a tracer travels per second, per field unit. Default 0.04. */
        rate?: number;
        /** 0..1, multiplied with the colormap's own alpha. */
        opacity?: number;
        /** Lights building faces where the flow blows straight at them (needs `setFacades`). Default false. */
        facadeGlow?: boolean;
        /** Speeds below this, in field units, draw nothing. Default 0.08. */
        still?: number;
    }
    /** A vector field drawn on the table as moving tracers. Animation and drawing run on the surface. */
    export interface FlowOverlay {
        /** The two components of the same revision, towards the right and towards the bottom of the table. Cells where both are zero are obstacles. */
        set(u: FieldFrame, v: FieldFrame): void;
        setStyle(style: FlowOverlayStyle): void;
        /** Building outlines for the facade glow: polygons of rings, outer ring first, in table metres. */
        setFacades(polygons: [number, number][][][]): void;
        remove(): void;
    }
    /**
     * A 2D canvas locked to the table, for vector drawing: networks, routes, moving markers.
     * It sits above the fields and the building outlines; canvases stack in the order they are added.
     */
    export interface CanvasOverlay {
        /** Scaled so one unit is one CSS pixel. */
        readonly context: CanvasRenderingContext2D;
        /** Size in CSS pixels. */
        readonly width: number;
        readonly height: number;
        /** Table pixels per site metre, so marks can keep a physical size. */
        readonly pixelsPerMetre: number;
        /** Raised whenever the size or the view changes. The canvas is blank afterwards: draw again. */
        readonly revision: number;
        /** WGS84 `[lon, lat]` to canvas pixels. */
        project(lonLat: readonly [number, number] | readonly number[]): [number, number];
        clear(): void;
        setOpacity(opacity: number): void;
        remove(): void;
    }
    /** A point, line or area drawn on the table. */
    export interface Shape {
        geometry: ToolGeometry;
        /** CSS colour. Default white. */
        colour?: string;
    }
    /** Vector shapes drawn on the table, above the fields. */
    export interface ShapeOverlay {
        /** Replaces everything the overlay shows. */
        set(shapes: Shape[]): void;
        setOpacity(opacity: number): void;
        remove(): void;
    }
    /** A picture a sprite overlay stamps: drawn once by the layer, at any size. */
    export type SpriteImage = HTMLCanvasElement | HTMLImageElement | ImageBitmap | OffscreenCanvas;
    /** Numbers per sprite in the buffer given to `SpriteOverlay.set`. */
    export const SPRITE_FLOATS = 7;
    export interface SpriteStyle {
        opacity?: number;
        /** `add` adds the sprites' light to what is below (glows, lamps); `over` paints them on it. Default `over`. */
        blend?: 'over' | 'add';
    }
    /**
     * Many small pictures moving on the table, stamped by the graphics card in one draw (#609): lights
     * flowing along streets, cars, people, tree crowns. Give it every sprite each time they move; it
     * costs a small buffer upload, not a picture of the whole table, so use it rather than a drawing for
     * anything that moves every frame.
     */
    export interface SpriteOverlay {
        /**
         * Shows `count` sprites (default: all in `sprites`), `SPRITE_FLOATS` numbers each: centre x and y
         * in table metres, width and height in metres, angle in radians (clockwise, as a canvas's
         * `rotate`), the index of its picture, and its alpha (0 to 1; 0 hides it).
         */
        set(sprites: Float32Array, count?: number): void;
        /** Replaces the pictures, keeping their indices' meaning up to the layer. */
        setImages(images: SpriteImage[]): void;
        setOpacity(opacity: number): void;
        remove(): void;
    }
    /** One line for a stroke overlay: points in table metres, with a width (metres) and alpha per point or for all. */
    export interface Stroke {
        points: [number, number][];
        /** A CSS hex or rgb() colour. */
        colour: string;
        width: number | number[];
        alpha: number | number[];
    }
    /**
     * Lines that change every frame (trails behind vehicles, wakes), drawn by the graphics card (#609).
     * Each line is one strip with its width and alpha per point, so a tapering trail needs no pieces.
     */
    export interface StrokeOverlay {
        /** Replaces every line the overlay shows. */
        set(strokes: Stroke[]): void;
        setOpacity(opacity: number): void;
        remove(): void;
    }
    /** What a layer may draw on the table. Everything sits at the layer's place in the scene's draw order. */
    export interface MapHandle {
        addField(id: string, style: FieldOverlayStyle & {
            colormap: Colormap;
        }): FieldOverlay;
        addFlow(id: string, style: FlowOverlayStyle & {
            colormap: Colormap;
        }): FlowOverlay;
        addShapes(id: string, style?: {
            opacity?: number;
        }): ShapeOverlay;
        /** Sprites stamped from `images` on the graphics card: see `SpriteOverlay`. */
        addSprites(id: string, images: SpriteImage[], style?: SpriteStyle): SpriteOverlay;
        /** Moving lines drawn on the graphics card: see `StrokeOverlay`. */
        addStrokes(id: string, style?: {
            opacity?: number;
        }): StrokeOverlay;
        /**
         * An element covering the table, above everything the scene draws, for decorations a layer draws itself
         * (a sun path, a compass). It ignores pointer input and is removed with the layer.
         * The table's up direction is `site.extent.rotation_deg`.
         */
        addElement(): HTMLElement;
        /**
         * A drawing in table metres at the layer's place in the scene, for what a layer draws itself: base maps,
         * media, glows that change only with the controls. Each `commit` sends the whole picture to the graphics
         * card, so draw anything that moves every frame with `addSprites` instead (#609).
         */
        addDrawing(id: string, options?: {
            opacity?: number; /** Canvas width in pixels. Default 2048. */
            resolution?: number;
        }): DrawingOverlay;
        /**
         * A canvas above the scene, in CSS pixels, with a projection from WGS84. With `top` it stays
         * above the other canvases, the layer's own items included, as the Magnifier's glass must (#554).
         */
        addCanvas(id: string, style?: {
            opacity?: number;
            top?: boolean;
        }): CanvasOverlay;
        /**
         * What the table shows, for a magnifier (#287): ask for a rectangle of the table view and it is
         * copied at the next frame, with everything drawn there except this layer's own canvases.
         */
        addPicture(): TablePicture;
        /**
         * Lets a magnifier ask this layer for a sharp picture of part of the table (#351), drawn again
         * at the magnifier's resolution rather than copied from the screen. `render` draws in table
         * metres into `g`, whose transform already maps them to its pixels; `scale` is pixels per metre.
         */
        addDetail(render: (g: CanvasRenderingContext2D, scale: number) => void): void;
        /**
         * What the ambient glow in the projector's blank space does while this layer is on (#476):
         * `'off'` turns it off, a colour such as `'#ffb347'` fixes it, `null` gives it back the model's
         * own colours. The most recent layer to ask wins. Nothing happens on a table without the glow.
         */
        setGlow(glow: 'off' | string | null): void;
        /**
         * A sharp picture of the square of side `2 * radius_m` around `centre` (table metres), `size`
         * pixels across, from every other layer that draws one (`addDetail`), in the scene's order.
         * Null when no layer on the table draws one.
         */
        detail(centre: [number, number], radius_m: number, size: number): HTMLCanvasElement | null;
    }
    /** A rectangle in the table view's CSS pixels, as `CanvasOverlay` uses them. */
    export interface PixelRect {
        x: number;
        y: number;
        width: number;
        height: number;
    }
    /**
     * A copy of part of what the table shows (`ctx.map.addPicture()`), for drawing it larger.
     * `want` asks for a rectangle; the copy lands in `canvas` when the table next draws, at the
     * screen's own pixel density, and `taken` says which rectangle it holds.
     */
    export interface TablePicture {
        want(rect: PixelRect): void;
        readonly canvas: HTMLCanvasElement;
        /** The rectangle `canvas` holds now, or null before the first copy. */
        readonly taken: PixelRect | null;
        /** Raised with every copy. */
        readonly revision: number;
        remove(): void;
    }
    /**
     * Pointers acting directly on the table surface: a mouse, a finger, a pen. Samples are
     * local to the table and never pass through the host; a layer sends on what other
     * surfaces need with `setParams` or `publish`. Phone tools arrive through `tool(input)`
     * and become the same samples with `fromToolInput`.
     */
    export interface TablePointer {
        /** Calls back for every sample while the layer is on. Released with the layer. */
        on(callback: (sample: PointerSample) => void): void;
    }
    /**
     * A picture a layer's table sends to its own controller (#351): the Magnifier's view under its
     * glass. The table sends it, the hero on the controller watches it. The latest picture only.
     */
    export interface LayerView {
        /** On the table: sends what `canvas` holds now. Sends are spaced out, so calling it every frame is fine. */
        send(canvas: HTMLCanvasElement | OffscreenCanvas): void;
        /** On the controller: calls back with each new picture until the returned function is called. */
        watch(callback: (picture: ImageBitmap) => void): () => void;
    }
    interface ContextBase<P> {
        readonly site: SiteInfo;
        /** Current params, as held by the host. */
        readonly params: Readonly<P>;
        /** Asks the host to change params. The `update` handler runs once the host has applied them. */
        setParams(patch: Partial<P>): void;
        /** Values the table published for other surfaces. */
        readonly shared: Readonly<Record<string, any>>;
        /** The language visitors read now (#80): `en` or `sv`. */
        readonly language: string;
        /**
         * Words for visitors in their language (#80): the English text looked up in the layer's
         * `locales/<language>.json`, with `{name}` filled from `vars`. `ctx.say('Sun sets at {time}', { time })`.
         * Use it for text the layer makes as it runs (a caption, a status, a legend row); words in
         * layer.json are translated without it.
         */
        say(text: string, vars?: Record<string, string | number>): string;
        /** A picture the table sends to the layer's controller (#351). */
        readonly view: LayerView;
        /**
         * One of the site's outside services (#278), by its id in site.json `services`: `get`, `post`
         * and `job`, through the host. Name it in `requires.services`. While a call runs, publish
         * `busy: { label, progress }` and the controller shows it under the layer's name.
         */
        service(id: string): ServiceClient;
        /**
         * The entity picked on the table or the controller (#279), the same on every surface, or null.
         * Entities are declared in layer.json `entities`; the runtime picks them on the table and
         * shows the picked one's controls on the controller without layer code.
         */
        readonly selection: EntitySelection | null;
        /** Picks an entity, or none with null, for every surface: the controller shows its controls. */
        select(set: string, id: string | null): void;
        /** One entity's values: its controls' defaults with what was set for it on top. */
        entity(set: string, id: string): Record<string, unknown>;
        /**
         * Changes the values of one or more entities through the host, which checks them against the
         * set's controls. `null` puts them back to the defaults.
         */
        setEntity(set: string, ids: string | string[], values: Record<string, unknown> | null): void;
        /**
         * Sends a tool input through the host, as a phone does, for one of the layer's own tools.
         * Every view of the table running the layer (the projector, the editor) gets it in
         * `tool(input)`, so a pick made with the mouse on one view, or on a controller map (#283),
         * shows on all of them. Resolves once the host has accepted it.
         */
        sendTool(tool: string, geometry: ToolGeometry): Promise<void>;
        /**
         * Presses one of the layer's actions through the host: an `action` control, or one of the
         * named `actions` in layer.json that have no button of their own (#283). Every view of the
         * table gets it in `action(id)`, so a controller stage can start an animation on the table.
         */
        action(id: string): Promise<void>;
        /**
         * The layer's play head (#373), the same on every view: where its time is now, in the units of
         * its `clock: hour` or `clock: progress` control, moving between the table's updates.
         */
        readonly clock: LayerPlayHead;
    }
    /** A layer's play head as every view reads it (#373). */
    export interface LayerPlayHead {
        /**
         * The layer's time now, in its clock control's units: the play head while it runs (a time of day
         * wraps at midnight, a run stops at its end), otherwise the control as set. Null for a layer
         * without a `clock: hour` or `clock: progress` control.
         */
        now(): number | null;
        /** It moves on its own: the table set a rate other than 0. */
        readonly running: boolean;
    }
    /** The table's side of the play head (#373): it moves it, and every view follows. */
    export interface TablePlayHead extends LayerPlayHead {
        /**
         * Where the time is now and how many of the control's units a second it moves (0, the default,
         * stands still). Call it every frame if that is easiest: every view works out the time in
         * between, so it is sent on only when play starts, stops, jumps or changes pace.
         */
        set(value: number, rate?: number): void;
    }
    export interface TableContext<P = Params> extends ContextBase<P> {
        readonly engine: EngineClient;
        readonly map: MapHandle;
        /** The digital twin of the physical model: fields, lights and materials on its real surfaces. */
        readonly model: ModelHandle;
        readonly pointer: TablePointer;
        /** The play head: the table moves it with `set`, and every view reads it (#373). */
        readonly clock: TablePlayHead;
        /**
         * Plays the attention cue (#105) at a change, in WGS84: one bright burst that pulls eyes back
         * to the table. Tool inputs from a phone or the controller get one without any code; call this
         * when an action without a place of its own adds something (a controller button that adds a
         * building, say). `colour` is a CSS colour, default white.
         */
        cue(at: ToolGeometry, options?: {
            colour?: string;
        }): void;
        /** Publishes derived values for panels. Only changed keys are sent. */
        publish(values: Record<string, unknown>): void;
        /** Sub-steps: parts of the layer that Next reveals one at a time, such as the categories of a map. */
        readonly steps: LayerSteps;
        /** The legend on the controller's stage, when it changes as the layer runs. */
        readonly legend: LayerLegend;
        /**
         * For a layer whose layer.json says `reveals: true` (the Magnifier, the Reveal line): where its
         * items show on the table. The runtime clips everything the items draw to the shape. Other
         * layers' calls do nothing.
         */
        readonly reveal: LayerReveal;
        /**
         * The layers inside this one (#453), in site.json order, as they are now: read it when you
         * need it (it is live). A layer that draws something an item may also draw, such as Wind's
         * faint tree crowns under a Trees item, can leave its own out while that item is on (#623).
         */
        readonly items: readonly LayerItem[];
        /** Runs every animation frame while the layer is active. `dt` is seconds since the last call. */
        onFrame(callback: (dt: number) => void): void;
        /** Registers cleanup to run when the layer is turned off. */
        onCleanup(callback: () => void): void;
    }
    export interface PanelContext<P = Params> extends ContextBase<P> {
        /** The id of the `custom` panel being drawn, from the manifest's `panels`. */
        readonly panel: string;
        onCleanup(callback: () => void): void;
    }
    export interface TableHandlers {
        /** Params changed. `changed` lists the keys; `ctx.params` holds the new values. Must be cheap. */
        update?(changed: string[]): void;
        /** An action control was pressed; `by` is the phone that pressed it, if a phone did (#335). */
        /** `words`: what was typed with the press, for an action that asks for words (#462). */
        action?(action: string, by?: Sender, words?: string): void;
        /** A spatial input arrived. */
        tool?(input: ToolInput): void;
        /** Next or Previous changed how many sub-steps are revealed (`ctx.steps.revealed`). */
        step?(revealed: number): void;
        /**
         * Entities' values changed (#279), from the controller, a phone or the editor: which ones, by
         * set. Read them with `ctx.entity(set, id)`. Waits for the set's `debounce_ms` of quiet, so a
         * layer that asks a model on every change asks once per gesture.
         */
        entities?(changed: EntityChange[]): void;
        /** Another entity was picked, or none (`ctx.selection`). The runtime marks it on the table itself. */
        select?(selection: EntitySelection | null): void;
    }
    /**
     * Sub-steps (docs/contracts/present.md, Steps). A layer that reveals its parts one at a
     * time declares how many there are when it starts; the controller's Next then walks them,
     * and inside a slideshow moves on to the next slide after the last one (or stops there,
     * as the slide's Next behaviour says).
     */
    /** A layer inside another one (#453): its instance id, the layer it uses and whether it is on. */
    export interface LayerItem {
        readonly id: string;
        /** The layer it is an instance of, such as `trees` or `custom:aerial-1960`. */
        readonly use: string;
        readonly active: boolean;
    }
    export interface LayerSteps {
        /** Declares `count` sub-steps, with a name for each for the controller. 0 removes them. */
        define(count: number, titles?: string[]): void;
        /** How many sub-steps are revealed now: 0 (the overview) to the count. */
        readonly revealed: number;
        /** The layer's steps as the host has them: a sequence's current step, or the sub-steps it defined. */
        readonly state: StepState | undefined;
    }
    /**
     * The controller's legend (docs/contracts/present.md, Stage). Without it the controller
     * shows `legend` from layer.json. Rows are matched by `id`, or by label when they have none,
     * and rows named in `steps.define` titles follow the reveal by themselves.
     */
    export interface LayerLegend {
        /** Replaces the rows. An empty list goes back to layer.json's legend. */
        set(items: LegendRow[]): void;
        /** Marks the row just revealed on the table, or none. */
        highlight(id: string | null): void;
        /** Shows only these rows at full strength, for cumulative reveals; `'all'` shows every row. */
        show(ids: string[] | 'all'): void;
    }
    export interface LegendRow {
        id?: string;
        label: string;
        color?: string;
        shape?: 'line' | 'fill' | 'point' | string;
        /** A heading over this row and the ones after it with the same group (#622): which scale the rows belong to. */
        group?: string;
    }
    export interface PanelHandlers {
        /** Params or shared values changed. */
        update?(): void;
    }
    export interface LayerModule<P = Params> {
        manifest: LayerManifest;
        /**
         * Runs on the table surface when the layer is turned on. Set up overlays and
         * engine streams, and return the handlers. Everything opened through `ctx`
         * is released when the layer is turned off; use `ctx.onCleanup` for the rest.
         */
        table?(ctx: TableContext<P>): TableHandlers | void | Promise<TableHandlers | void>;
        /**
         * Draws the layer's `custom` panels on the TV. Most panels need no code: declare them
         * in the manifest's `panels`. The element has a fixed size and clips what does not fit.
         */
        panel?(ctx: PanelContext<P>, el: HTMLElement): PanelHandlers | void;
        /**
         * Draws the layer's hero on the controller: the one large, direct way to work the layer, at the
         * top of the open layer (Sunlight's sky and time scrubber). It may change params with
         * `ctx.setParams`. `ctx.panel` is `"hero"`. The element is as wide as the centre; the hero sets its height,
         * times the CSS variable `--mrs-hero-scale` (1, or less inside a slideshow step, #577):
         * `height: calc(clamp(16rem, 40vh, 30rem) * var(--mrs-hero-scale, 1))`.
         */
        hero?(ctx: PanelContext<P>, el: HTMLElement): PanelHandlers | void;
        /**
         * Draws the layer's own stage on the controller (#283), for a layer.json with `stage: "custom"`:
         * the whole centre under the layer's name, such as a map of the site to choose on. The rails, the
         * step strip and the layer's controls stay. Reach the table through the host: `ctx.sendTool`,
         * `ctx.action`, `ctx.setParams`, `ctx.select`. `controllerMap` gives a ready map of the site.
         * `ctx.panel` is `"stage"`.
         */
        stage?(ctx: PanelContext<P>, el: HTMLElement): PanelHandlers | void;
        /**
         * The layer's own widgets (#353), made with `defineWidget`. They are known on the site as
         * `<layer id>/<type>`, and the layer's own panels may name them by `type` alone. They follow the
         * core widgets' contract: sizes, labelled props, bindings, theme tokens and an honest read cost.
         */
        widgets?: import("@mrstudio/sdk/widgets").WidgetDefinition[];
        /**
         * Fetches what the layer will need before it is shown, so a sequence (the slideshow) can step
         * to it without waiting. Called on the table when a sequence that shows this layer opens, with
         * the params the step will use. What the host fetches it also keeps, for venues without a
         * connection (#42). Errors are ignored: the layer shows its own when it is turned on.
         */
        prefetch?(site: SiteInfo, params: P): Promise<void> | void;
    }
    /** Declares a layer. The default export of every layer package. */
    export function defineLayer<P = Params>(layer: LayerModule<P>): LayerModule<P>;
}
declare module "@mrstudio/sdk/flow" {
    import type { FieldFrame } from "@mrstudio/sdk/types";
    /** A velocity field on a grid, with the cells nothing flows through. */
    export class FlowField {
        readonly width: number;
        readonly height: number;
        /** Velocity in field units, towards higher columns and higher rows. */
        readonly u: Float32Array;
        readonly v: Float32Array;
        /** 1 where the cell is an obstacle. */
        readonly blocked: Uint8Array;
        /** Mean velocity over the open cells: the prevailing direction and a typical speed. */
        meanU: number;
        meanV: number;
        meanSpeed: number;
        constructor(width: number, height: number);
        /** Builds a field from two component frames. A cell where both are zero is an obstacle. */
        static fromFrames(u: FieldFrame, v: FieldFrame): FlowField;
        /** Moves this field towards `target`, independent of the display's refresh rate. */
        blendTowards(target: FlowField, dt: number, seconds?: number): void;
        measure(): void;
        isBlocked(col: number, row: number): boolean;
        /** Velocity at a point, interpolated between cell centres. Zero outside and inside obstacles. */
        sample(x: number, y: number, out: [number, number]): [number, number];
        /** Whether the straight path between two points touches an obstacle or leaves the field. */
        crossesBlocked(x0: number, y0: number, x1: number, y1: number): boolean;
    }
    export interface TracerOptions {
        count: number;
        /** Seconds of path kept behind each tracer. */
        trailSeconds: number;
        /** Returns 0..1. Defaults to Math.random. */
        random?: () => number;
        /**
         * Where a replaced tracer comes back: `upwind` on the edges the flow enters through (wind),
         * `anywhere` on any open cell (rain landing on running water). Default `upwind`.
         */
        spawn?: 'upwind' | 'anywhere';
        /** Seconds a tracer may stand still before it is replaced. Default 2. */
        maxStall?: number;
    }
    /**
     * A fixed set of tracers. Each follows the field with midpoint integration,
     * never passes through an obstacle, and is replaced at the upwind edge when it
     * leaves, stalls or grows old. Trails are ring buffers, so a frame allocates nothing.
     */
    export class Tracers {
        readonly count: number;
        trailSeconds: number;
        time: number;
        /** Current positions. */
        readonly x: Float32Array;
        readonly y: Float32Array;
        /** Trail points, `TRAIL_CAPACITY` per tracer, oldest first from `start`. */
        readonly trailX: Float32Array;
        readonly trailY: Float32Array;
        readonly trailT: Float32Array;
        readonly start: Uint16Array;
        readonly length: Uint16Array;
        /** Seconds since each tracer was placed. */
        readonly age: Float32Array;
        private readonly stalled;
        private readonly active;
        private readonly random;
        private readonly anywhere;
        private readonly maxStall;
        private field;
        private readonly a;
        private readonly b;
        static readonly capacity = 64;
        constructor(field: FlowField, options: TracerOptions);
        /** Swaps the field the tracers ride. It must have the same size. */
        setField(field: FlowField): void;
        /**
         * Advances every tracer by `dt` seconds. `rate` turns field units into cells
         * per second, so it sets how fast the animation plays.
         */
        update(dt: number, rate: number): void;
        private record;
        private advect;
        /** Places a tracer: anywhere at the start, afterwards on the edges the flow enters through (or anywhere, if so configured). */
        private spawn;
    }
    /** A point of a drawn streamline. Positions are in field cells. */
    export interface StreamPoint {
        x: number;
        y: number;
        /** Seconds the flow takes to get here from the anchor (negative upstream), at the current rate. */
        travel: number;
        /** Signed step count from the anchor; it pairs points between retraces. */
        station: number;
        alpha: number;
        /** 0 at the line's ends rising to 1 ten points in, so ends fade instead of stopping. */
        endFade: number;
        targetX: number;
        targetY: number;
        targetTravel: number;
        targetAlpha: number;
    }
    export interface Streamline {
        id: number;
        points: StreamPoint[];
    }
    const smooth: (t: number) => number;
    /** Anchors on a jittered grid over the open cells, about `count` of them. */
    export function streamAnchors(field: FlowField, count: number): {
        x: number;
        y: number;
        id: number;
    }[];
    /** Whether a drawn piece between two points stays inside the field and off the buildings. */
    export function clearSegment(field: FlowField, ax: number, ay: number, bx: number, by: number): boolean;
    /**
     * Traces a streamline from `seed` with midpoint steps of `STREAM_STEP` cells,
     * downstream for `sign` 1 and upstream for -1. `rate` turns field units into
     * cells per second; it sets each point's travel time.
     */
    export function traceStreamline(field: FlowField, seed: {
        x: number;
        y: number;
    }, sign: 1 | -1, rate: number): {
        x: number;
        y: number;
        travel: number;
        station: number;
    }[];
    /** Steady streamlines that morph as the field changes. See the section comment above. */
    export class Streamlines {
        /** Seeds of the lines. Placed again at every retrace, since obstacles show only once the wind blows. */
        anchors: {
            x: number;
            y: number;
            id: number;
        }[];
        lines: Streamline[];
        readonly count: number;
        private field;
        private sinceTrace;
        constructor(field: FlowField, count: number);
        setField(field: FlowField): void;
        /** Retraces when due, then eases every drawn point by `dt` seconds. */
        update(dt: number, rate: number): void;
        private accept;
    }
    /** A soft bump, 1 at 0 and 0 beyond ±1: the shape of the light travelling along a ribbon. */
    export function bell(t: number): number;
    /** How lit a ribbon is at a point `travel` seconds along it, at animation time `time`. */
    export function ribbonLight(travel: number, time: number, id: number): number;
    export { smooth as smoothstep01 };
    /** A short piece of a building's outline, in field cells, with its outward normal. */
    export interface FacadeEdge {
        ax: number;
        ay: number;
        bx: number;
        by: number;
        nx: number;
        ny: number;
    }
    /**
     * Cuts building outlines (polygons of rings, outer ring first, in field cells,
     * rows down) into pieces of at most `piece` cells with outward normals. Pieces
     * whose middle lies outside the field are dropped.
     */
    export function facadeEdges(polygons: [number, number][][][], width: number, height: number, piece?: number): FacadeEdge[];
    /** How brightly each facade piece glows, from the wind just outside it. */
    export class FacadeGlow {
        readonly edges: FacadeEdge[];
        /** Displayed glow of each edge, 0..1. */
        readonly intensity: Float32Array;
        /** Per edge, the probe stencils: [count, cell, weight, cell, weight, ...] per probe, one after another. */
        private probes;
        private blockedCount;
        private field;
        constructor(field: FlowField, edges: FacadeEdge[]);
        /** Swaps the field. Probes are placed again when its obstacles changed. */
        setField(field: FlowField): void;
        /**
         * Places probes in the open air just outside each edge, out to about 2% of the
         * table's longer side, stopping at the next building. Only edges with a building
         * right behind them get probes. Obstacles show only once the wind blows, so this
         * runs again whenever the obstacle mask changes.
         */
        place(): void;
        /** Moves each edge's glow towards the wind now blowing into it. Field units are m/s. */
        update(dt: number): void;
    }
}
declare module "@mrstudio/sdk/time" {
    /** Minutes that `timeZone` is ahead of UTC at the given instant. */
    export function zoneOffsetMinutes(utcMs: number, timeZone: string): number;
    /**
     * The UTC instant of a wall-clock time in a time zone, as an RFC 3339 string.
     * `date` is YYYY-MM-DD and `hour` is decimal hours, 0 to 24.
     */
    export function zonedTimeToUtc(date: string, hour: number, timeZone: string | null): string;
    /** Formats decimal hours as HH:MM. */
    export function formatHour(hour: number): string;
}
declare module "@mrstudio/sdk/clock" {
    import type { LayerClock, LayerManifest, RangeControl } from "@mrstudio/sdk/types";
    /** The control a layer's time runs on: its `clock: hour` or `clock: progress` range, if it has one. */
    export function clockControl(manifest: LayerManifest | undefined): RangeControl | undefined;
    /**
     * Where a play head is at the host's time `now` (milliseconds since 1970), or null without one.
     * Within a control's range, a running clock wraps around for a time of day (a day loops) and stops
     * at the ends for a share of a run (the table starts it again).
     */
    export function clockAt(clock: LayerClock | null | undefined, now: number, control?: Pick<RangeControl, 'min' | 'max' | 'clock'>): number | null;
}
declare module "@mrstudio/sdk/format" {
    /**
     * One formatter for numbers, units, times and dates (#397), used by the Format pane, dialogs, the
     * table's ribbons, the controller and the phones. Visitors' screens follow the session's language
     * (#80): a decimal comma in Swedish (5,0 m/s), a point in English (5.0 m/s). The editor stays in
     * English. Typed numbers are read with either.
     */
    /** The languages numbers are written in; anything else reads as English. */
    export type NumberLanguage = 'en' | 'sv';
    /** Sets the language numbers are written in. The runtime calls it when the session's language changes. */
    export function setNumberLanguage(language: string): void;
    /** The language numbers are written in now. */
    export function numberLanguage(): NumberLanguage;
    /** A number with exactly `decimals` decimals in the current language: 1 234,5 in Swedish, 1,234.5 in English. */
    export function formatDecimal(value: number, decimals?: number): string;
    /** A large number shortened, as 12k or 1,2 mn: for headlines a visitor takes in at a glance. */
    export function formatCompact(value: number): string;
    /**
     * A number with its unit. Metres of 1000 or more read as kilometres when `km` is set; hours of a
     * day ('h' up to 24 with `clock`) read as a clock.
     */
    export function formatUnit(value: number, unit: string | undefined, decimals?: number, options?: {
        km?: boolean;
        clock?: boolean;
    }): string;
    /** A distance in metres: 40 m, 850 m, 1.2 km, 12 km. */
    export function formatDistance(metres: number): string;
    /** A time of day in hours on the 24-hour clock: 12.5 is 12:30, 24 is 24:00. The same in every language. */
    export function formatClock(hours: number): string;
    /** A date in the current language: 24 juni 2026, 24 June 2026; with `time`, its 24-hour time too. */
    export function formatDate(date: Date | string | number, options?: {
        time?: boolean;
        timeZone?: string;
    }): string;
    /** A typed number, with a decimal point or comma and any spaces between thousands: null when it is none. */
    export function parseNumber(text: string): number | null;
}
declare module "@mrstudio/sdk/controls" {
    import type { Control, Params } from "@mrstudio/sdk/types";
    /** Whether a control should be shown for the current params. A list in `visibleWhen` means any of those values. */
    export function isVisible(control: Control, params: Params): boolean;
}
declare module "@mrstudio/sdk/geo" {
    import type { Position, SiteInfo } from "@mrstudio/sdk/types";
    /** Conversions between WGS84, the site's local metres and its grid. */
    export interface SiteProjection {
        /** `[lon, lat]` to metres east and north of the site origin. */
        toLocal(lonLat: readonly number[]): [east: number, north: number];
        toLonLat(east: number, north: number): [lon: number, lat: number];
        /** `[lon, lat]` to fractional grid `[col, row]`. Cell `(c, r)` spans `c..c+1`, `r..r+1`; row 0 is the top. */
        toGrid(lonLat: readonly number[]): [col: number, row: number];
        /** Ground distance in metres between two `[lon, lat]` points. */
        distance(a: readonly number[], b: readonly number[]): number;
    }
    /**
     * The site's tangent-plane projection, the same one the host bakes the scene with
     * (docs/contracts/engine.md, "Coordinates and the grid").
     */
    export function siteProjection(site: Pick<SiteInfo, 'origin' | 'grid'>): SiteProjection;
    /** Table coordinates (0..1 from the top left corner, u to the right, v down) to WGS84. */
    export function tableToLonLat(site: Pick<SiteInfo, 'corners'>, u: number, v: number): Position;
    /** WGS84 to table coordinates. Outside the table the result is outside 0..1. */
    export function lonLatToTable(site: Pick<SiteInfo, 'corners'>, lon: number, lat: number): [number, number];
}
declare module "@mrstudio/sdk/solar" {
    /** Where the sun is in the sky. */
    export interface SunPosition {
        /** Compass bearing, clockwise from north, degrees. */
        azimuth: number;
        /** Angle above the horizon, degrees. Negative at night. */
        altitude: number;
    }
    /**
     * Sun position from the NOAA solar position equations, for drawing sun paths and legends.
     * It is the same algorithm as the engine's `solar.rs`; kernels remain the source of results.
     */
    export function sunPosition(utcMs: number, lat: number, lon: number): SunPosition;
}
declare module "@mrstudio/sdk/comfort" {
    import type { Colormap } from "@mrstudio/sdk/colormap";
    export interface Irradiance {
        /** Global horizontal, W/m². */
        ghi: number;
        /** Direct normal, W/m². */
        dni: number;
        /** Diffuse horizontal, W/m². */
        dhi: number;
    }
    /**
     * Clear-sky irradiance for a sun `altitudeDeg` above the horizon.
     * `linke` is the Linke turbidity (about 3 for a clear European summer sky); `elevationM` the ground's height.
     */
    export function clearSky(altitudeDeg: number, options?: {
        linke?: number;
        elevationM?: number;
        dayOfYear?: number;
    }): Irradiance;
    export interface RadiantInput {
        /** Air temperature, °C. Surfaces are taken to be at air temperature. */
        airC: number;
        /** Direct sun on a horizontal surface, W/m² (0 in shade). */
        directWm2: number;
        /** Diffuse sky radiation on a horizontal surface, W/m². */
        diffuseWm2: number;
        /** Share of the sky the walker sees, 0..1. */
        svf: number;
        /** Ground reflectivity, 0..1. Default 0.15 (asphalt, paving). */
        albedo?: number;
        /** 1 under a tree crown, 0 in the open. Default 0. */
        canopy?: number;
        sunAltitudeDeg: number;
    }
    /**
     * A standing walker's mean radiant temperature, °C (the demo's `radiant_temperature`).
     * The body's projected direct-beam area is 0.28 of its surface (SOLWEIG); sky and ground each fill half the view;
     * shortwave absorption 0.70 and longwave emissivity 0.97 (ISO 7726).
     */
    export function radiantTemperature(input: RadiantInput): number;
    export interface PetInput {
        airC: number;
        mrtC: number;
        /** Wind at about 1.1 m, m/s. */
        windMs: number;
        /** Relative humidity, %. */
        humidity: number;
        /** Activity, met. Default 2.3 (walking, as in the demo). */
        met?: number;
        /** Clothing, clo. Default 0.9 (as in the demo). */
        clo?: number;
        position?: 'standing' | 'sitting';
    }
    /**
     * Physiological Equivalent Temperature, °C: the air temperature of a standard room (still air, 12 hPa vapour,
     * walls at air temperature) in which the body would be in the same thermal state as outdoors.
     */
    export function pet(input: PetInput): number;
    /** Where the weather and the sun give a walker in full sun and in full shade. */
    export interface SunShadeComfort {
        sun: {
            mrt: number;
            pet: number;
        };
        shade: {
            mrt: number;
            pet: number;
        };
        irradiance: Irradiance;
    }
    export interface ComfortWeather {
        airC: number;
        humidity: number;
        windMs: number;
    }
    /**
     * PET in full sun and in full shade for one moment. Between the two, a place's PET is close to a mix by its share
     * of sun, which is how a walk's PET is estimated live from the shadow field.
     * Sky view is assumed: 0.85 in the open (streets between low buildings) and 0.6 in shade, which on a street is
     * usually cast by something close.
     */
    export function sunShadeComfort(weather: ComfortWeather, sunAltitudeDeg: number, options?: {
        dayOfYear?: number;
        linke?: number;
        elevationM?: number;
    }): SunShadeComfort;
    /**
     * Air temperature through a clear summer day, from the afternoon high: lowest near 05:00, highest near 15:00.
     * `rangeC` is the swing between them (8 °C is typical on a clear day by the sea).
     */
    export function airTemperatureAt(hour: number, highC: number, rangeC?: number): number;
    /** The PET range the demo colours over, °C. */
    export const PET_RANGE: readonly [number, number];
    /** The demo's PET colours (cool cyan to hot red), as stops in °C. */
    export const PET_STOPS: readonly (readonly [number, string])[];
    /** The colour of a PET value, as `#rrggbb`. */
    export function petColour(value: number): string;
    /**
     * A colormap for PET frames quantised by `petFrame`: 0 is "no data" and stays clear, 1..255 run over `PET_RANGE`.
     * `alpha` is the wash's strength (0..255).
     */
    export function petColormap(alpha?: number): Colormap;
    /** Quantises PET values (NaN where there is no data) into a byte per cell for `petColormap`. */
    export function quantisePet(values: ArrayLike<number>, out?: Uint8Array): Uint8Array;
    /** How a PET value feels, on the scale for Central Europe (Matzarakis and Mayer, 1996). */
    export function petFeeling(value: number): string;
}
declare module "@mrstudio/sdk/data" {
    import type { FieldFrame, SiteInfo } from "@mrstudio/sdk/types";
    /** A dataset the site names that could not be read (#259). */
    export interface DataProblem {
        /** The dataset's name in site.json `data`. */
        name: string;
        /** What went wrong, in words: "couldn't read trees.geojson (HTTP 404)". */
        reason: string;
    }
    /**
     * Hears about every site dataset the SDK's helpers could not read, after their retries. The
     * runtime uses it to mark the layers that need the dataset as in trouble and start them again,
     * so a layer does not have to: it reads its data as usual and gets null or an error.
     */
    export function onDataProblem(listener: (problem: DataProblem) => void): () => void;
    /** Tells the runtime a site dataset could not be read. For helpers outside the SDK that read site data themselves. */
    export function dataProblem(problem: DataProblem): void;
    /**
     * Fetches from the host, trying again when the connection fails or the host answers with a
     * server error: a host that is starting (the desktop app switching tables) briefly answers
     * nothing (#222). A missing file (404) and other answers come back at once.
     */
    export function fetchFromHost(url: string, signal?: AbortSignal, attempts?: number, init?: RequestInit): Promise<Response>;
    /** Whether the site provides a named dataset. */
    export function hasSiteData(site: Pick<SiteInfo, 'data'>, name: string): boolean;
    /**
     * Loads a named dataset from the site package as JSON. The name comes from the
     * layer's `requires.data`; the site maps it to a file under `data` in site.json.
     */
    export function loadSiteData<T = unknown>(site: Pick<SiteInfo, 'data'>, name: string, signal?: AbortSignal): Promise<T>;
    /**
     * Loads a raster dataset laid on the site grid (#196): a GeoTIFF, or a folder of one GeoTIFF per hour
     * (`pet_08.tif` .. `pet_20.tif`), in any coordinate system the host reads. Values are exact (f32), NaN where
     * the raster has no data. Null when a folder has no raster for `hour`.
     */
    export function loadSiteField(site: Pick<SiteInfo, 'data'>, name: string, hour?: number, signal?: AbortSignal): Promise<FieldFrame | null>;
}
declare module "@mrstudio/sdk/table-space" {
    import type { CanvasOverlay } from "@mrstudio/sdk/layer";
    import type { SiteInfo } from "@mrstudio/sdk/types";
    export type XY = [x: number, y: number];
    /** The table as a rectangle in metres: x right, y down, origin at the top left corner. */
    export interface TableSpace {
        readonly width: number;
        readonly height: number;
        /** WGS84 to table metres. Points outside the extent give coordinates outside the rectangle. */
        toTable(lon: number, lat: number): XY;
    }
    export function tableSpace(site: SiteInfo): TableSpace;
    /** Below this share of the table reached, a dataset most likely belongs to another place (#180). */
    export const STRAY_REACH = 0.25;
    /**
     * How much of the table a dataset reaches: the share of an 8 × 5 grid of cells over the table that
     * its lines (or points, as lines of one) pass through. Data that runs past the table still reaches
     * all of it; data from another place that only clips one edge reaches a few cells.
     */
    export function tableReach(lines: Iterable<XY[]>, space: Pick<TableSpace, 'width' | 'height'>): number;
    /** The URL of a named site dataset, or null when the site does not have it. */
    export function siteDataUrl(site: SiteInfo, name: string): string | null;
    /**
     * Fetches a named site dataset as JSON. Null when the site does not have it or it cannot be loaded.
     * A failed connection or a server error is tried again a few times, since a host that is starting
     * (the desktop app switching tables) briefly answers nothing (#222). A dataset the site names but
     * that cannot be read is reported (#259): the runtime shows the layers that need it as in trouble
     * and starts them again until it can be read.
     */
    export function readSiteData<T = any>(site: SiteInfo, name: string): Promise<T | null>;
    export interface Placed<G> {
        geometry: G;
        properties: Record<string, any>;
    }
    /** Every line in a GeoJSON document, in table metres. */
    export function geojsonLines(geojson: unknown, space: TableSpace): Placed<XY[]>[];
    /** Every polygon in a GeoJSON document as rings (outer first, then holes), in table metres. */
    export function geojsonPolygons(geojson: unknown, space: TableSpace): Placed<XY[][]>[];
    /** Every point in a GeoJSON document, in table metres. */
    export function geojsonPoints(geojson: unknown, space: TableSpace): Placed<XY>[];
    /** Adds polygon rings to the current path. Fill with the 'evenodd' rule so holes stay open. */
    export function tracePolygon(ctx: CanvasRenderingContext2D, rings: XY[][]): void;
    /** Adds a polyline to the current path. */
    export function traceLine(ctx: CanvasRenderingContext2D, line: XY[]): void;
    /** Whether a point is inside a polygon given as rings (even-odd, so holes are outside). */
    export function insidePolygon(rings: XY[][], x: number, y: number): boolean;
    /** A polyline with its running length, for moving things along it. */
    export interface Track {
        points: XY[];
        /** Distance from the start to each point. */
        at: number[];
        length: number;
    }
    export function track(points: XY[]): Track;
    /** The position and heading (radians, 0 along +x) at a distance along a track. */
    export function along(t: Track, distance: number): {
        x: number;
        y: number;
        angle: number;
    };
    /** The distance along a track of the point on it nearest to (x, y). */
    export function nearestAlong(t: Track, x: number, y: number): number;
    /** A small seeded generator (mulberry32), so every table shows the same "random" scene. */
    export function seededRandom(seed: number): () => number;
    /** `#rrggbb` to an `rgb(r g b / a)` string. */
    export function withAlpha(hex: string, alpha: number): string;
    /**
     * Limits what a canvas overlay draws next to the table's extent, so lines from a dataset
     * larger than the table stop at its edge instead of running into the projector's blank
     * margin (#203). Wrap the drawing in `context.save()` and `context.restore()`.
     */
    export function clipToTable(canvas: Pick<CanvasOverlay, 'context' | 'project'>, site: Pick<SiteInfo, 'corners'>): void;
}
declare module "@mrstudio/sdk/geo-pack" {
    import type { SiteInfo } from "@mrstudio/sdk/types";
    import type { Placed, XY } from "@mrstudio/sdk/table-space";
    /** Shapes of one kind: corners as x, y pairs in table metres, and where each part ends. */
    export interface PackedShapes {
        /** x0, y0, x1, y1, ... in table metres. */
        coords: Float64Array;
        /** Polygons: the corner index each ring ends at. Lines: the corner index each line ends at. Points: unused (empty). */
        ends: Uint32Array;
        /** Polygons only: the ring index each polygon ends at. */
        parts: Uint32Array;
        /** Which feature (an index into `properties`) each polygon, line or point came from. */
        feature: Uint32Array;
    }
    export interface PackedGeometry {
        polygons: PackedShapes;
        lines: PackedShapes;
        points: PackedShapes;
        /** One per feature that had a shape, in file order. */
        properties: Record<string, any>[];
    }
    /** The part of a site the packing needs: where the table is in the world. */
    export type SitePlacement = Pick<SiteInfo, 'corners' | 'extent'>;
    /** Reads a GeoJSON document (text, bytes or already parsed) into table metres. */
    export function packGeojson(source: string | ArrayBuffer | unknown, place: SitePlacement): PackedGeometry;
    /** The typed arrays in a packed result, to hand to `postMessage` so they move instead of being copied. */
    export function packedBuffers(packed: PackedGeometry): ArrayBuffer[];
    /** Placed shapes, in the form `geojsonPolygons`, `geojsonLines` and `geojsonPoints` give. */
    export interface SiteGeometry {
        polygons: Placed<XY[][]>[];
        lines: Placed<XY[]>[];
        points: Placed<XY>[];
    }
    /** Unpacks into fresh arrays of corners, so a layer can change them without touching another layer's copy. Properties are shared: read them, don't change them. */
    export function unpackGeometry(packed: PackedGeometry): SiteGeometry;
}
declare module "@mrstudio/sdk/street-network" {
    import type { Placed, XY } from "@mrstudio/sdk/table-space";
    /** One direction of travel along a street segment, in table metres. */
    export interface StreetEdge {
        from: number;
        to: number;
        length: number;
        /** Heading in radians, 0 along +x. */
        angle: number;
        /** A main street, where most of the traffic starts. */
        major: boolean;
    }
    export interface StreetGraphOptions {
        /** Whether a line is part of this network, from its properties. Default: every line. */
        include?: (properties: Record<string, unknown>) => boolean;
        /** Whether a line is a main street, where most journeys start. Default: none. */
        major?: (properties: Record<string, unknown>) => boolean;
        /** How often a journey starts on a main street, where there are any. Default 0.7. */
        majorShare?: number;
        /** Pieces of network shorter than this in all are left out: anything there could only turn round and round. */
        shortestPieceM?: number;
    }
    /** A rule by OpenStreetMap `highway` class that can be sent to the data worker: see `byHighway`. */
    export interface HighwayRule {
        highway: string[];
        /** Whether lines without a class pass. Default true. */
        unclassed?: boolean;
    }
    /** `StreetGraphOptions` as plain data, so the graph can be built in the SDK's data worker and kept (#484). */
    export interface StreetGraphSpec {
        include?: HighwayRule;
        major?: HighwayRule;
        majorShare?: number;
        shortestPieceM?: number;
    }
    /** The options a spec stands for. */
    export function specOptions(spec: StreetGraphSpec): StreetGraphOptions;
    /** A street graph as typed arrays, to move between the data worker and the page. */
    export interface PackedStreetGraph {
        nodes: Float64Array;
        from: Uint32Array;
        to: Uint32Array;
        length: Float64Array;
        angle: Float64Array;
        major: Uint8Array;
        total: number;
        majorShare: number;
    }
    export function packedGraphBuffers(packed: PackedStreetGraph): ArrayBuffer[];
    /** The OpenStreetMap `highway` class of a street, or undefined when the data has none. */
    export function highwayClass(properties: Record<string, unknown>): string | undefined;
    /** A filter by OpenStreetMap `highway` class. Lines without a class pass when `unclassed` is true. */
    export function byHighway(classes: Iterable<string>, unclassed?: boolean): (properties: Record<string, unknown>) => boolean;
    /**
     * Streets as a graph that things can travel along: cars, walkers, bicycles. Lines that share a
     * vertex are joined there, so data with a vertex at each crossing (as OpenStreetMap exports
     * have) gives junctions to turn at. Nothing turns round: at a dead end, `next` says so and
     * the traveller leaves (#201).
     */
    export class StreetGraph {
        readonly nodes: XY[];
        readonly edges: StreetEdge[];
        /** Edge indices leaving each node. */
        readonly out: number[][];
        /** Total street length in metres, counting each segment once. */
        length: number;
        private index;
        private starts;
        private majorShare;
        constructor(lines: Placed<XY[]>[], options?: StreetGraphOptions);
        /** The graph as typed arrays, for `fromPacked` on the other side of a worker. */
        toPacked(): PackedStreetGraph;
        /** A graph made by `toPacked`, without building it again. */
        static fromPacked(packed: PackedStreetGraph): StreetGraph;
        private prepareStarts;
        /** An edge to start on: by length, so short segments get few travellers, and mostly on main streets where there are any. */
        start(random: () => number): number;
        /**
         * Where a traveller arriving along `edge` goes next: straight on if it can, sometimes turning;
         * null at a dead end. A turn sharper than 135 degrees is taken only when it is the only way on.
         */
        next(edge: number, random: () => number, straightOn?: number): number | null;
        /** The junction or bend nearest a point, or -1 when the network is empty. */
        nearest(point: XY): number;
        /**
         * The shortest way along the streets between two points (#283): from the street point nearest
         * `from` to the one nearest `to`, as a line in table metres. Null when they are not connected.
         */
        route(from: XY, to: XY): XY[] | null;
        /** The point `s` metres along an edge, `offset` metres to its right (y grows down the table). */
        at(edge: number, s: number, offset?: number): XY;
        private pieces;
        private node;
        private edge;
    }
    /** Evenly spaced points along lines, `spacing` metres apart, skipping lines shorter than two spacings. */
    export function pointsAlong(lines: XY[][], spacing: number): XY[];
}
declare module "@mrstudio/sdk/mask" {
    import type { PackedGeometry } from "@mrstudio/sdk/geo-pack";
    /** Fills a packed file's polygons (even-odd) into a mask of the site grid: 1 inside, 0 outside. */
    export function rasteriseMask(packed: PackedGeometry, grid: {
        width: number;
        height: number;
    }, extent: {
        width_m: number;
        height_m: number;
    }): Uint8Array;
}
declare module "@mrstudio/sdk/walk-network" {
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
        geometry?: {
            type?: string;
            coordinates?: unknown;
        } | null;
    }
    /**
     * Builds the network from GeoJSON lines. Lines meet where they share a vertex,
     * which is how street data is drawn; a node is made at every line end and every
     * shared vertex, so a long street becomes one edge per block.
     */
    export function buildWalkNetwork(geojson: {
        features?: LineFeature[];
    }, distance: Distance): WalkNetwork;
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
    export function packWalkNetwork(network: WalkNetwork): PackedWalkNetwork;
    export function walkNetworkBuffers(packed: PackedWalkNetwork): ArrayBuffer[];
    /**
     * Unpacks into fresh nodes and edges, so a layer can mark its own copy (CoolPaths keeps each
     * edge's sun and PET on it). `extra` adds a layer's own fields to every edge.
     */
    export function unpackWalkNetwork<X extends object = Record<never, never>>(packed: PackedWalkNetwork, extra?: () => X): WalkNetwork<WalkEdge & X>;
}
declare module "@mrstudio/sdk/site-geometry" {
    import type { PackedGeometry, SiteGeometry, SitePlacement } from "@mrstudio/sdk/geo-pack";
    import { StreetGraph } from "@mrstudio/sdk/street-network";
    import type { StreetGraphSpec } from "@mrstudio/sdk/street-network";
    import type { Placed, XY } from "@mrstudio/sdk/table-space";
    import type { PackedWalkNetwork, WalkEdge, WalkNetwork } from "@mrstudio/sdk/walk-network";
    import type { SiteInfo } from "@mrstudio/sdk/types";
    export type { SiteGeometry } from "@mrstudio/sdk/geo-pack";
    /** Packs GeoJSON bytes into table metres: in the data worker when there is one, otherwise here. `keep` leaves a copy there for street graphs. */
    export function packInWorker(bytes: ArrayBuffer, place: SitePlacement, keep?: string): Promise<PackedGeometry>;
    /**
     * A named site dataset's polygons, lines and points in table metres, as `geojsonPolygons`,
     * `geojsonLines` and `geojsonPoints` would give them. Null when the site doesn't have the dataset
     * or it can't be read (reported as for `readSiteData`). The parsing happens in the SDK's data
     * worker, and the result is kept until the file changes.
     */
    export function readSiteGeometry(site: SiteInfo, name: string): Promise<SiteGeometry | null>;
    /**
     * The site's streets as lines in table metres, from its `roads` dataset, read in the data worker
     * and kept. A site without one has no streets: nothing is made up, because a made-up grid on a
     * real place would put traffic through its buildings. Layers that need streets say so in `requires.data`.
     */
    export function streetLines(site: SiteInfo): Promise<Placed<XY[]>[]>;
    /**
     * A street graph of a site's lines (the `roads` dataset unless named), as `new StreetGraph(lines,
     * specOptions(spec))` would make it: built in the SDK's data worker and kept until the file
     * changes, so a second layer, or the same layer turned off and on, gets it at once. Layers
     * share the graph: read it, don't change it. Null when the site hasn't got the dataset.
     */
    export function readStreetGraph(site: SiteInfo, spec?: StreetGraphSpec, name?: string): Promise<StreetGraph | null>;
    /**
     * A site dataset of lines as a walking network in longitude and latitude (see walk-network.ts):
     * built in the SDK's data worker and kept until the file changes. Each call unpacks a fresh copy
     * that the layer may mark; `extra` adds the layer's own fields to every edge. Null when the site
     * hasn't got the dataset or it can't be read.
     */
    export function readWalkNetwork<X extends object = Record<never, never>>(site: SiteInfo, name: string, extra?: () => X): Promise<WalkNetwork<WalkEdge & X> | null>;
    /** The walking network as `readWalkNetwork` keeps it, packed: shared, so read it, don't change it (copy it to send it to a worker). */
    export function readWalkNetworkPacked(site: SiteInfo, name: string): Promise<PackedWalkNetwork | null>;
    /**
     * A site dataset's polygons as a mask on the site grid (row by row, 1 inside): the buildings'
     * roofs, the water. Drawn in the SDK's data worker and kept until the file changes. Null when
     * the site hasn't got the dataset.
     */
    export function readSiteMask(site: SiteInfo, name: string): Promise<Uint8Array | null>;
    /** Forgets every kept dataset (tests, and a table that was switched). */
    export function forgetSiteGeometry(): void;
}
declare module "@mrstudio/sdk/slices" {
    /** Above about this many shapes, a layer's drawing is better spread over frames. */
    export const SLICE_FROM = 3000;
    /** Pauses a drawing generator every `every` calls: `if (pause()) yield;`. */
    export function pauseEvery(every?: number): () => boolean;
    /**
     * Runs `steps` for `budgetMs` milliseconds a frame until it finishes, then calls `done`. Returns
     * a function that stops it, for when the drawing is asked for again or the layer closes. Where
     * there are no frames (tests, a page in the background), it runs to the end at once.
     */
    export function inSlices(steps: Iterator<unknown>, done: () => void, budgetMs?: number): () => void;
    /** Runs a drawing generator to the end at once. */
    export function drainSteps(steps: Iterator<unknown>): void;
}
declare module "@mrstudio/sdk/projector" {
    export type Vec3 = [number, number, number];
    export interface CalibrationPair {
        /** A corner of the model, in the local frame. */
        model: Vec3;
        /** Where the projector's marker had to be for its light to land on that corner. */
        image: [number, number];
        label?: string;
    }
    /** A projector's calibration, as stored under `projector` in calibration.json. */
    export interface ProjectorCalibration {
        version: 1;
        /** The 3 x 4 projection, row by row: model metres to homogeneous image pixels. */
        matrix: number[];
        /** The image size the matrix was solved for. The view scales with the window. */
        image: {
            width: number;
            height: number;
        };
        pairs: CalibrationPair[];
        /** Root mean square distance between where the markers were put and where the solved camera puts them. */
        error_px: number;
        /** The camera in plain terms, for people. Derived from `matrix`. */
        camera: ProjectorSummary;
        saved_at?: string;
    }
    export interface ProjectorSummary {
        position: Vec3;
        /** Compass bearing the projector points along, and how far below the horizon. */
        heading_deg: number;
        pitch_deg: number;
        fov_deg: {
            horizontal: number;
            vertical: number;
        };
        /** How far the optical axis sits from the image centre, as a fraction of the image size. */
        lens_shift: {
            x: number;
            y: number;
        };
        /** True when the image arrives mirrored, as through a single mirror. */
        mirrored: boolean;
    }
    export interface ProjectorCamera {
        fx: number;
        fy: number;
        cx: number;
        cy: number;
        skew: number;
        /** Rows take a model direction to camera axes: x right, y down, z forward. */
        rotation: [Vec3, Vec3, Vec3];
        translation: Vec3;
        /** The projector's lens, in the local frame. */
        position: Vec3;
        /** The image is flipped left to right after projection. `fx`, `cx` and `rotation` describe the unflipped image. */
        mirrored: boolean;
    }
    export const MIN_CALIBRATION_PAIRS = 6;
    /** Where a model point lands in the image, and its depth along the optical axis (positive in front). */
    export function projectPoint(matrix: number[], p: Vec3): [u: number, v: number, depth: number];
    /**
     * Finds the projector from marker and model corner pairs. Needs at least six pairs that do
     * not all lie in one plane: mix roof corners with points on the ground.
     */
    export function solveProjector(pairs: CalibrationPair[], image: {
        width: number;
        height: number;
    }): {
        matrix: number[];
        error_px: number;
    };
    /** Splits the matrix into the lens (intrinsics) and where the projector is (pose). */
    export function decomposeProjector(matrix: number[], image: {
        width: number;
        height: number;
    }): ProjectorCamera;
    /** The matrix of a camera, the inverse of `decomposeProjector`. */
    export function composeProjector(camera: ProjectorCamera, image: {
        width: number;
        height: number;
    }): number[];
    /** The camera in the terms a person setting up a projector thinks in. */
    export function describeProjector(matrix: number[], image: {
        width: number;
        height: number;
    }): ProjectorSummary;
    /**
     * The camera as the two matrices a WebGL renderer wants, both column-major:
     * `view` takes the local frame to eye space (x right, y up, looking along -z), and
     * `projection` takes eye space to clip space. A mirrored camera renders unmirrored;
     * flip the finished image left to right.
     */
    export function projectorMatrices(camera: ProjectorCamera, image: {
        width: number;
        height: number;
    }, near: number, far: number): {
        view: number[];
        projection: number[];
    };
}
declare module "@mrstudio/sdk/blocks/scale" {
    import type { Colormap } from "@mrstudio/sdk/colormap";
    /** Red, green, blue 0..255 and alpha 0..1. */
    export type Rgba = readonly [r: number, g: number, b: number, a: number];
    /** Parses `#rgb`, `#rrggbb`, `#rrggbbaa` and `rgb()/rgba()`. Unknown input is mid grey. */
    export function colour(input: string | Rgba): Rgba;
    /** A CSS colour, optionally with its alpha multiplied. */
    export function css(c: Rgba, alpha?: number): string;
    export function mix(a: Rgba, b: Rgba, t: number): Rgba;
    export function clamp01(value: number): number;
    /** Smooth start and stop, for reveals and fades. */
    export function ease(t: number): number;
    /** The smallest and largest finite value. */
    export function extent(values: Iterable<number>): [number, number];
    export interface LevelOptions {
        /** Data values that map to 0 and 1. */
        domain: readonly [number, number];
        /** `sqrt` and `log` keep small values visible beside one very large one. */
        curve?: 'linear' | 'sqrt' | 'log';
        /**
         * The level a present-but-tiny value still gets, 0..1. A member of a community that
         * draws almost nothing must still read as a member on a projection table.
         */
        floor?: number;
    }
    /** A data value to a 0..1 level. */
    export function levelScale(options: LevelOptions): (value: number) => number;
    /** A 0..1 level to a colour along a colormap. */
    export function rampScale(colormap: Colormap): (level: number) => Rgba;
    /** Two colours as a ramp, e.g. an unlit building to its full demand colour. */
    export function twoColourScale(from: string | Rgba, to: string | Rgba): (level: number) => Rgba;
    /**
     * Stepped classes: `bins` are the lower edges, in rising order, and each has a colour.
     * A value below the first edge takes the first colour.
     */
    export function binScale(bins: readonly number[], colours: readonly (string | Rgba)[]): (value: number) => Rgba;
    /** Named classes, e.g. an energy class or a kind of place, with a colour for anything unlisted. */
    export function categoryScale(colours: Record<string, string | Rgba>, fallback?: string | Rgba): (key: unknown) => Rgba;
    export interface LegendEntry {
        label: string;
        colour: string;
    }
    /** Legend rows for stepped classes: "0–5 min", "5–10 min", "30+ min". */
    export function binLegend(bins: readonly number[], colours: readonly (string | Rgba)[], unit?: string): LegendEntry[];
    /** Legend rows for named classes, in the order given. */
    export function categoryLegend(colours: Record<string, string | Rgba>, labels?: Record<string, string>): LegendEntry[];
}
declare module "@mrstudio/sdk/blocks/series" {
    /** The value of a series at a decimal position. */
    export function sampleSeries(values: readonly number[], position: number, options?: {
        interpolate?: boolean;
        wrap?: boolean;
    }): number;
    /** The largest absolute value, the usual "against its own busiest hour" reference. */
    export function seriesPeak(values: readonly number[]): number;
    /** The largest peak over many series: the shared ceiling a whole layer is shaded against. */
    export function sharedPeak(series: Iterable<readonly number[] | undefined>): number;
    /** Element-wise sum of several series. */
    export function sumSeries(series: readonly (readonly number[])[]): number[];
    /** Running total, e.g. energy stored from a charge/discharge series. */
    export function cumulative(values: readonly number[], start?: number): number[];
    export interface ClockOptions {
        /** Number of steps in the span, e.g. 24 for a day of hours. */
        span: number;
        /** Steps per second of wall clock while playing. */
        rate?: number;
        loop?: boolean;
        position?: number;
        playing?: boolean;
    }
    /**
     * The play head of a time series: play, pause, scrub, loop. A layer ticks it from
     * `ctx.onFrame`, or seeks it from a `range` control, and reads `position` or `step`.
     * It holds no timers, so it is deterministic and a paused table costs nothing.
     */
    export class Clock {
        span: number;
        rate: number;
        loop: boolean;
        position: number;
        playing: boolean;
        constructor(options: ClockOptions);
        /** The whole step the play head is in. */
        get step(): number;
        /** Position as a share of the span, 0..1. */
        get progress(): number;
        /** Advances by `dt` seconds. Returns true when the whole step changed. */
        tick(dt: number): boolean;
        /** Moves the play head. Returns true when the whole step changed. */
        seek(position: number): boolean;
    }
}
declare module "@mrstudio/sdk/blocks/readouts" {
    import type { Clock } from "@mrstudio/sdk/blocks/series";
    export interface FormatOptions {
        /** Significant digits kept for small numbers. Default 3. */
        digits?: number;
        /** Scale 1 200 000 to "1.2 M". Default true. */
        compact?: boolean;
    }
    /** A number as short text for a tile: "1.29 k", "247", "0.04" ("1,29 k" in Swedish, #397). Never longer than 8 characters. */
    export function formatNumber(value: number, options?: FormatOptions): string;
    /** One number with a unit and a caption. `delta` is the change the tile may show as an arrow. */
    export interface Stat {
        value: string;
        unit: string;
        caption: string;
        delta?: number;
    }
    export function stat(value: number | string, unit: string, caption: string, options?: FormatOptions & {
        delta?: number;
    }): Stat;
    export interface Bar {
        label: string;
        value: number;
        /** Theme colour slot, 1..6. */
        slot: number;
    }
    /** Up to six bars, e.g. where this hour's energy came from. Slots default to the order given. */
    export function bars(items: {
        label: string;
        value: number;
        slot?: number;
    }[]): {
        items: Bar[];
    };
    /** Each item's share of the total, 0..1, for a stacked bar. */
    export function shares(values: readonly number[]): number[];
    /** The play head on a span of hours, with the daylight part marked. All in hours. */
    export interface Timeline {
        now: number;
        start: number;
        end: number;
        dayFrom: number;
        dayTo: number;
    }
    export function timeline(clock: Pick<Clock, 'position' | 'span'>, options?: {
        hoursPerStep?: number;
        startHour?: number;
        dayFrom?: number;
        dayTo?: number;
    }): Timeline;
    /** Up to three series over the span with the play head as 0..1. Long series are thinned to 96 points. */
    export function trend(series: {
        label: string;
        values: readonly number[];
        slot?: number;
    }[], progress: number): {
        series: {
            label: string;
            values: number[];
            slot: number;
        }[];
        now: number;
    };
}
declare module "@mrstudio/sdk/blocks/draw" {
    import type { Point } from "@mrstudio/sdk/blocks/geo";
    import type { Rgba } from "@mrstudio/sdk/blocks/scale";
    import type { Area, Path, Spot } from "@mrstudio/sdk/blocks/sources";
    import type { View } from "@mrstudio/sdk/blocks/view";
    /** A constant, or a function of the shape being drawn. */
    export type Styled<S, T> = T | ((shape: S) => T);
    export interface AreaStyle<P> {
        /** Fill colour, or null for none. This is the choropleth: colour by attribute. */
        fill?: Styled<Area<P>, Rgba | null>;
        stroke?: Styled<Area<P>, Rgba | null>;
        /** Outline width in pixels. */
        strokeWidth?: Styled<Area<P>, number>;
        /**
         * A second colour that fills the shape from its bottom edge up to `level` (0..1),
         * like liquid in a vessel: a battery's charge, a tank, a quota.
         */
        levelFill?: Styled<Area<P>, Rgba | null>;
        level?: Styled<Area<P>, number>;
        /** Skip shapes for which this is false. */
        show?: (area: Area<P>) => boolean;
    }
    /** Fills and outlines areas. With `fill` driven by a scale this is a choropleth. */
    export function drawAreas<P>(view: View, areas: readonly Area<P>[], style: AreaStyle<P>): void;
    export interface PathStyle<P> {
        colour: Styled<Path<P>, Rgba>;
        /** Width in pixels. Drive it by a flow's share to make a flow map. */
        width?: Styled<Path<P>, number>;
        /** A soft halo this many times the width, 0 for none. */
        glow?: number;
        /** Dash and gap in pixels. */
        dash?: readonly [number, number];
        /** Draw only this share of the line from its start, 0..1, for drawing a line in. */
        reveal?: Styled<Path<P>, number>;
        show?: (path: Path<P>) => boolean;
    }
    /** Draws lines. With `width` driven by a value this is a flow map; with `reveal` the lines draw themselves in. */
    export function drawPaths<P>(view: View, paths: readonly Path<P>[], style: PathStyle<P>): void;
    export interface SpotStyle<P> {
        colour: Styled<Spot<P>, Rgba>;
        /** Radius in pixels. */
        radius?: Styled<Spot<P>, number>;
        /** A soft glow this many pixels wide around the marker, 0 for none. */
        halo?: Styled<Spot<P>, number>;
        /** A white centre, as a share of the radius. */
        core?: number;
        label?: Styled<Spot<P>, string | null>;
        /** Label size in pixels. Default 13. */
        labelSize?: number;
        show?: (spot: Spot<P>) => boolean;
    }
    /** Draws point markers with an optional glow, core and label. */
    export function drawSpots<P>(view: View, spots: readonly Spot<P>[], style: SpotStyle<P>): void;
    /** Text centred above a point, with a dark shadow so it reads on any layer. */
    export function drawLabel(view: View, at: Point, text: string, options?: {
        colour?: Rgba;
        size?: number;
        offset?: number;
    }): void;
    /** A soft disc that fades to nothing at `radius_m`: a catchment, a gravity well, a spotlight. */
    export function drawGlow(view: View, centre: Point, radius_m: number, colour: Rgba, strength?: number): void;
    export interface RingStyle {
        colour: Rgba;
        /** Outer radius in metres. */
        radius_m: number;
        /** +1 rings travel outward (energy leaving), -1 inward (arriving), 0 stand still. */
        direction?: 1 | -1 | 0;
        /** 0..1: how strongly the rings show. 0 draws nothing. */
        level?: number;
        /** How many rings are in flight at once. Default 2. */
        count?: number;
        /** Seconds for a ring to cross the radius. Default 2.4. */
        period?: number;
        /** Ripple amplitude as a share of the radius; 0 is a clean circle. */
        wobble?: number;
        /** Line width in pixels. Default 1.5. */
        width?: number;
    }
    /**
     * Rings around a point. Travelling outward or inward they show which way something
     * flows through a node; with `wobble` and no direction they are the ripples of a
     * gravity well. `phase` offsets the animation so neighbours do not pulse together.
     */
    export function drawRings(view: View, centre: Point, style: RingStyle, phase?: number): void;
    export interface Dot {
        point: Point;
        colour: Rgba;
        /** 0..1, multiplied into the colour's alpha. */
        alpha?: number;
        /** Radius in pixels. */
        size?: number;
    }
    /** Draws many small lights additively, so a crowd of them brightens where it gathers. */
    export function drawDots(view: View, dots: Iterable<Dot>, options?: {
        core?: boolean;
    }): void;
}
declare module "@mrstudio/sdk/blocks/cue" {
    import type { Point } from "@mrstudio/sdk/blocks/geo";
    import type { Rgba } from "@mrstudio/sdk/blocks/scale";
    import type { View } from "@mrstudio/sdk/blocks/view";
    /** Where the change is, in table metres: a place, a line or an area (an open or closed ring). */
    export type CueTarget = {
        point: Point;
    } | {
        line: Point[];
    } | {
        area: Point[];
    };
    /** How long a cue plays, in seconds. */
    export const CUE_SECONDS = 1.4;
    export interface CueStyle {
        /** Default white. The palette accent also works; it should be the brightest colour on the table. */
        colour?: Rgba;
        /** The table, in metres, to tell whether the change is on it. Without it every cue is drawn in place. */
        frame?: {
            width: number;
            height: number;
        };
    }
    /** The points of a target. */
    export function cuePoints(target: CueTarget): Point[];
    /**
     * Where a change off the table should be pointed at: the nearest point on the table's edge,
     * and the direction out to the change. `null` when some of it is on the table.
     */
    export function offTable(points: Point[], frame: {
        width: number;
        height: number;
    }): {
        at: Point;
        towards: Point;
    } | null;
    /** Draws the cue `age` seconds after it started. Returns false once it has finished (and draws nothing). */
    export function drawCue(view: View, target: CueTarget, age: number, style?: CueStyle): boolean;
}
declare module "@mrstudio/sdk/blocks/motion" {
    import type { MeasuredPath, Point } from "@mrstudio/sdk/blocks/geo";
    /** A source of random numbers in [0, 1). Pass a seeded one for repeatable motion. */
    export type Random = () => number;
    /** A small seeded generator (mulberry32), for tests and for tables that must agree. */
    export function seeded(seed: number): Random;
    export interface Head {
        point: [number, number];
        /** Direction of travel in radians. */
        heading: number;
        /** 0..1: fades up as it leaves and out as it lands. */
        alpha: number;
        /** 0..1 over the last tenth of the run, for a burst where it arrives. */
        landing: number;
        /** Index of the path it travels on. */
        path: number;
    }
    export interface HeadOptions<T extends MeasuredPath> {
        /** Seconds for one run from end to end. Default 4.2, slow enough to follow across a table. */
        period?: number;
        /** Or a speed in metres per second, so long routes take longer. Overrides `period`. */
        speed?: number;
        /** Lights in flight per path. Default 1. Drive it by flow to show volume as traffic. */
        count?: number | ((path: T, index: number) => number);
        /** Travel from the end to the start for paths where this is true. */
        reverse?: (path: T, index: number) => boolean;
        /** Paths for which this is false carry no light: an idle line is still a wire. */
        active?: (path: T, index: number) => boolean;
    }
    /**
     * Where the travelling lights are at `time`. A pure function of time: there is no
     * state to keep, scrubbing backwards works, and two surfaces given the same clock
     * draw the same picture. Starts are staggered so lines do not all set off together.
     */
    export function pathHeads<T extends MeasuredPath>(paths: readonly T[], time: number, options?: HeadOptions<T>): Head[];
    export interface Particle {
        x: number;
        y: number;
        vx: number;
        vy: number;
        age: number;
        lifetime: number;
        /** Whatever the spawner attached: a colour, a target, a kind. */
        tag: unknown;
    }
    /** What moves a particle: returns the velocity it should steer towards, in metres per second. */
    export type Steering = (particle: Particle, index: number) => readonly [vx: number, vy: number] | null;
    export interface SwarmOptions {
        /** Most particles alive at once. */
        max: number;
        /** New particles per second at full intensity. */
        spawnRate: number;
        /** Creates a particle, or null to skip this one. */
        spawn: (random: Random) => Pick<Particle, 'x' | 'y' | 'lifetime' | 'tag'> | null;
        steer: Steering;
        /** How quickly velocity follows the steering, per second. Higher is snappier. Default 9. */
        response?: number;
        random?: Random;
    }
    /** A pool of particles that are spawned, steered and retired. */
    export class Swarm {
        readonly particles: Particle[];
        private options;
        private random;
        private debt;
        constructor(options: SwarmOptions);
        /**
         * Advances by `dt` seconds. `intensity` (0..1) scales both how many particles
         * may be alive and how fast they appear, for ramping a crowd in and out.
         */
        step(dt: number, intensity?: number): void;
        clear(): void;
    }
    /** How visible a particle is over its life: quick fade in, slow fade out. */
    export function particleAlpha(p: Particle): number;
    /** Something that pulls: a venue, a stop, a destination. */
    export interface Attractor {
        point: Point;
        /** Relative pull. Also how often it is chosen as a destination. */
        weight: number;
    }
    /** Picks an item with probability proportional to its weight. */
    export function pickWeighted<T extends {
        weight: number;
    }>(items: readonly T[], random: Random): T | undefined;
    /** A point on a ring around a centre, with the distance varied so arrivals do not form a perfect circle. */
    export function aroundRing(centre: Point, radius_m: number, random: Random, spread?: number): [number, number];
    export interface PullOptions {
        /** Drift speed far from the target, metres per second. */
        speed: number;
        /** Inside this distance the pull strengthens, up to three times the speed at the centre. */
        radius_m: number;
        /** Sideways wander as a share of the speed, so a crowd meanders instead of marching. Default 0.4. */
        wander?: number;
        /** A particle this close has arrived and is retired. Default 4 m. */
        arrive_m?: number;
    }
    /**
     * Steering towards one target per particle: the motion of a crowd drawn to a place.
     * `target` reads the destination from the particle, usually from its tag.
     */
    export function pullTowards(target: (particle: Particle) => Point, options: PullOptions): Steering;
    /**
     * Steering by the combined pull of every attractor, falling off with distance: a
     * particle between two venues curves towards the heavier one. Retired on arrival.
     */
    export function gravity(attractors: readonly Attractor[], options: PullOptions): Steering;
    export interface Cluster<T> {
        point: [number, number];
        members: T[];
        /** Sum of the members' weights (1 each when unweighted). */
        weight: number;
    }
    /**
     * Groups points that are closer than `radius_m` into one marker at their weighted
     * centre, so a dense dataset reads as a few sized markers instead of a smear.
     */
    export function clusterPoints<T extends {
        point: Point;
    }>(items: readonly T[], radius_m: number, weight?: (item: T) => number): Cluster<T>[];
    /** A directed link between two named nodes with a value per time step. */
    export interface Link {
        source: string;
        target: string;
        values: readonly number[];
    }
    /**
     * What leaves a node less what arrives at it, at one step. Positive is the node
     * giving (a grid supplying, a battery discharging), negative is it taking.
     */
    export function nodeBalance(links: readonly Link[], node: string, step: number): number;
    /** A node's balance at a step against its own busiest step: a direction and a 0..1 level, for pulse rings. */
    export function nodePulse(links: readonly Link[], node: string, step: number): {
        direction: 1 | -1;
        level: number;
    };
}
declare module "@mrstudio/sdk/blocks/fields" {
    import type { FieldFrame, SiteInfo } from "@mrstudio/sdk/types";
    import type { Point } from "@mrstudio/sdk/blocks/geo";
    import type { Steering } from "@mrstudio/sdk/blocks/motion";
    /** A raster covering the table: `width` by `height` cells of `cell_m` metres, row 0 at the top. */
    export interface Raster {
        width: number;
        height: number;
        cell_m: number;
    }
    /** A raster over the site's extent. `cell_m` defaults to four engine cells, plenty for a smooth data field. */
    export function siteRaster(site: Pick<SiteInfo, 'extent' | 'grid'>, cell_m?: number): Raster;
    /**
     * A heat field: every point spreads its weight over its surroundings with a smooth
     * bump of `radius_m`, and overlapping bumps add up. Density of anything countable:
     * visitors, trips, complaints, trees.
     */
    export function heatField(points: readonly {
        point: Point;
        weight?: number;
    }[], raster: Raster, radius_m: number): FieldFrame;
    /**
     * The pull of a set of attractors at every cell: each contributes its weight,
     * falling off with distance as `1 / (1 + (d / radius)²)`. High where places compete
     * for attention, and its uphill direction is where a crowd would drift.
     */
    export function gravityField(attractors: readonly {
        point: Point;
        weight: number;
    }[], raster: Raster, radius_m: number): FieldFrame;
    /**
     * The value of a field at a point on the table, in field units, interpolated
     * between cells. Works for kernel frames and data fields alike; the field is
     * assumed to cover the whole table, as every engine field does.
     */
    export function sampleField(field: FieldFrame, tableWidth_m: number, point: Point): number;
    /** The uphill direction and steepness of a field at a point, per metre. */
    export function fieldGradient(field: FieldFrame, tableWidth_m: number, point: Point): [number, number];
    /**
     * Steering that climbs (or with `downhill`, descends) a field: particles drift
     * towards high attraction, or run downhill over terrain. The field can be swapped
     * at any time by returning a new one from `current`.
     */
    export function followField(current: () => FieldFrame | null, tableWidth_m: number, options: {
        speed: number;
        downhill?: boolean;
    }): Steering;
    /**
     * Contour lines of a field at the given levels, as line segments in table metres
     * (marching squares). Draw them over a field to make its shape readable from the
     * far side of a table.
     */
    export function contours(field: FieldFrame, tableWidth_m: number, levels: readonly number[]): {
        level: number;
        segments: [Point, Point][];
    }[];
}
declare module "@mrstudio/sdk/blocks/story" {
    export interface Stage {
        id: string;
        /** How long the stage runs before the next starts by itself. Without it the stage waits for `advance()`. */
        seconds?: number;
    }
    export class Sequence {
        readonly stages: readonly Stage[];
        index: number;
        /** Seconds spent in the current stage. */
        elapsed: number;
        constructor(stages: readonly Stage[]);
        get stage(): Stage;
        /** True while the current stage waits for `advance()`. */
        get waiting(): boolean;
        /** 0..1 through the current stage. A waiting stage is complete as soon as it is entered. */
        get progress(): number;
        /**
         * How far a named stage has come: 0 before it, its progress during it, 1 after.
         * Style values read this, so a reveal needs no special cases:
         * `reveal: sequence.level('draw-lines')`.
         */
        level(id: string): number;
        /** Whether a named stage has started. */
        reached(id: string): boolean;
        /** Advances time. Returns true when the stage changed. */
        tick(dt: number): boolean;
        /** "Next": leaves a waiting stage. A timed stage is not interrupted. Returns true when it moved. */
        advance(): boolean;
        /** Jumps to a stage by id, for presets and story steps. */
        goTo(id: string): boolean;
        reset(): void;
    }
    /**
     * Spreads one 0..1 progress over `count` items so they appear one after another.
     * `overlap` (0..1) lets the next item start before the previous has finished.
     */
    export function stagger(progress: number, index: number, count: number, overlap?: number): number;
    /** How many of `count` items a 0..1 progress has revealed. */
    export function revealedCount(progress: number, count: number): number;
}
declare module "@mrstudio/sdk/blocks/network" {
    import type { MeasuredPath, Point } from "@mrstudio/sdk/blocks/geo";
    /** Shortest-path trees towards one place: from any node, the next node and the distance left. */
    export interface RouteTree {
        /** The node the place was snapped to. */
        root: number;
        next: Int32Array;
        cost: Float64Array;
    }
    export class StreetNetwork {
        readonly nodes: Point[];
        private readonly edges;
        private readonly cell;
        private readonly grid;
        /**
         * Builds the network from lines in table metres. Vertices closer than `snap_m` are one
         * node, so lines drawn to meet (or almost meet) are joined.
         */
        constructor(lines: readonly (readonly Point[])[], snap_m?: number);
        get size(): number;
        private key;
        private node;
        private link;
        /** The streets that leave node `n`, with their lengths. */
        neighbours(n: number): readonly {
            to: number;
            length: number;
        }[];
        /** Every street once, as node pairs with their lengths. */
        links(): [number, number, number][];
        /** The node nearest a point, or -1 for an empty network. */
        nearest(point: Point): number;
        /** Shortest distances from every node to `to` along the network (Dijkstra), as a tree to follow. */
        treeTo(to: Point): RouteTree;
        /** The route from node `from` down a tree to its place, or null if they are not connected. */
        follow(tree: RouteTree, from: number, end?: Point): MeasuredPath | null;
        /** The route between two points along the network, or null when none joins them. */
        route(from: Point, to: Point): MeasuredPath | null;
        /** Nodes reachable in a tree, for picking where a walk starts. */
        reachable(tree: RouteTree): number[];
    }
}
declare module "@mrstudio/sdk/blocks/index" {
    export * from "@mrstudio/sdk/blocks/geo";
    export * from "@mrstudio/sdk/blocks/sources";
    export * from "@mrstudio/sdk/blocks/scale";
    export * from "@mrstudio/sdk/blocks/series";
    export * from "@mrstudio/sdk/blocks/readouts";
    export * from "@mrstudio/sdk/blocks/view";
    export * from "@mrstudio/sdk/blocks/draw";
    export * from "@mrstudio/sdk/blocks/cue";
    export * from "@mrstudio/sdk/blocks/motion";
    export * from "@mrstudio/sdk/blocks/fields";
    export * from "@mrstudio/sdk/blocks/story";
    export * from "@mrstudio/sdk/blocks/interaction";
    export * from "@mrstudio/sdk/blocks/network";
}
declare module "@mrstudio/sdk/palette" {
    import type { Rgba } from "@mrstudio/sdk/blocks/scale";
    /** The slots every set fills. */
    export const PALETTE_SLOTS: readonly ["accent", "focus", "warm", "cool", "green", "warning", "neutral", "cat1", "cat2", "cat3", "cat4", "cat5", "cat6", "cat7", "cat8"];
    export type PaletteSlot = (typeof PALETTE_SLOTS)[number];
    /** What each slot is for, in the editor's words. */
    export const SLOT_ROLES: Record<PaletteSlot, string>;
    /** A ramp is a list of colours from low to high, spread evenly. */
    export type Ramp = readonly string[];
    export interface PaletteSet {
        id: string;
        name: string;
        description: string;
        slots: Record<PaletteSlot, string>;
        /** Sequential ramps rise in lightness (C2); `diverging` has a lit middle (C6). */
        ramps: Record<string, Ramp>;
    }
    /** The built-in sets. `night` is the default. */
    export const PALETTE_SETS: readonly PaletteSet[];
    /** The palette as site.json has it: a set and the slots this table changes. */
    export interface SitePalette {
        set?: string;
        slots?: Record<string, string>;
    }
    export interface ResolvedPalette {
        set: PaletteSet;
        slots: Record<PaletteSlot, string>;
        ramps: Record<string, Ramp>;
    }
    /** The site's palette with its overrides applied over its set (or `night`). */
    export function resolvePalette(palette?: SitePalette | null): ResolvedPalette;
    /**
     * The palette a core layer draws with, from its site (`ctx.site`, which follows the table's
     * palette as it changes). Cheap to call every frame: it resolves again only when the palette
     * changed. Compare `.set` or the result itself to notice a change and redraw.
     */
    export function tablePalette(site: {
        palette?: SitePalette | null;
    }): ResolvedPalette;
    /** The categorical slots, in order. */
    export function categorySlots(palette: ResolvedPalette): string[];
    /** A colour as written in a recipe: `@slot` from the palette, or `#rrggbb`. Unknown slots fall back to neutral. */
    export function paletteColour(value: string | undefined, palette: ResolvedPalette, fallback?: PaletteSlot): Rgba;
    /** The hex of a recipe colour, for swatches and legends. */
    export function paletteHex(value: string | undefined, palette: ResolvedPalette): string;
    /** A colour along a ramp, `t` from 0 to 1. */
    export function rampColour(ramp: Ramp, t: number): Rgba;
    /** CIE lightness, 0 (black) to 100 (white). */
    export function lightness(hex: string): number;
    /**
     * Whether a colour shows on the projected table. A projector cannot draw darker than the
     * room makes the model, so a dark colour shows as almost nothing (§1, C1). Returns a
     * warning for the picker, or null.
     */
    export function projectionWarning(hex: string): string | null;
}
declare module "@mrstudio/sdk/marks" {
    import type { Point } from "@mrstudio/sdk/blocks/geo";
    import type { Pen } from "@mrstudio/sdk/blocks/view";
    /** Point marks a look can draw. `icon` draws the pictogram named by the `icon` prop. */
    export const POINT_SHAPES: readonly ["circle", "square", "diamond", "triangle", "ring", "icon"];
    export type PointShape = (typeof POINT_SHAPES)[number];
    /**
     * Pictograms, as SVG path data on a 24 by 24 box centred on 12,12. They are bold and simple
     * so they read at 6 to 12 mm on a projected table (E5), and they are filled, not stroked.
     */
    export const ICONS: Record<string, {
        label: string;
        path: string;
    }>;
    export const ICON_NAMES: string[];
    /**
     * Traces a point mark of radius `r` at x, y (in pixels) as the current path, ready to fill.
     * Returns false for an icon, which draws itself through `fillIcon`.
     */
    export function traceShape(pen: Pen, shape: PointShape, x: number, y: number, r: number): boolean;
    /** Fills a pictogram of radius `r` at x, y. Unknown names draw a circle. */
    export function fillIcon(pen: Pen, name: string, x: number, y: number, r: number): void;
    /** Where arrows go on a line. */
    export const ARROWS: readonly ["none", "end", "along"];
    export type Arrows = (typeof ARROWS)[number];
    /**
     * Arrow positions on a polyline in its own units: the end only, or every `gap` along it,
     * each with the direction it points. A short line still gets one arrow at its middle.
     */
    export function arrowMarks(points: readonly Point[], where: Arrows, gap: number): {
        at: Point;
        angle: number;
    }[];
    /** Draws a filled chevron of size `s` pixels at x, y pointing along `angle` (in screen space). */
    export function fillArrow(pen: Pen, x: number, y: number, angle: number, s: number): void;
    /** Plays a layer through time: features appear as a sweep passes the value in their time column. */
    export interface TimelineProps {
        /** The column holding each feature's time: a year, a number, or a date. */
        column: string | null;
        /** Seconds the sweep takes from the earliest time to the latest (M4: a story, not a blink). */
        duration_s: number;
        /** Seconds it holds at the end before starting again. */
        hold_s: number;
        /** Features stay once they appear, or fade out after a while (a moving window). */
        keep: boolean;
        /** For a moving window, how long a feature stays, as a share of the whole span. */
        window: number;
        /**
         * Changes through time (#95): columns that hold the same measure at successive times, in
         * order (`pop_2000`, `pop_2010`, `pop_2020`). A colour or size by one of them follows the
         * sweep from column to column, blending between them. Null plays a reveal by `column` instead.
         */
        series: string[] | null;
    }
    export const TIMELINE_DEFAULTS: TimelineProps;
    /** Where a timeline is held, as a share of its span, or null to let it play (the controller's Play and When). */
    export type TimelinePosition = () => number | null;
    /** A time as a person reads it: a year as it is, a date as a date. */
    export function timeLabel(value: number, years: boolean): string;
    /** The time a series column stands for: the last number in its name (`pop_2010` is 2010), else its name. */
    export function seriesLabel(column: string): string;
    /**
     * Columns that look like one measure at successive times: names that differ only in a number at
     * the end (`pop_2000`, `pop_2010`), each with numbers in it, at least two. The longest run is
     * offered first, in time order.
     */
    export function seriesColumns(rows: readonly Record<string, unknown>[]): string[][];
    /** The value a series feature has now: kept on each row under this key while the series plays. */
    export const SERIES_VALUE = "__now";
    export interface SeriesSweep {
        columns: string[];
        /** Every value of every column, as rows of `SERIES_VALUE`, so colours and sizes keep one scale through time. */
        flat: Record<string, unknown>[];
        /** Sets each row's `SERIES_VALUE` for this moment. */
        apply(rows: readonly (Record<string, unknown> | undefined)[], time: number): void;
        /** The time on show: the nearest column's label. */
        label(time: number): string;
    }
    /** Prepares changes through time over the features' rows; null without two series columns. */
    export function seriesSweep(rows: readonly (Record<string, unknown> | undefined)[], props: Partial<TimelineProps> & {
        position?: TimelinePosition;
    }): SeriesSweep | null;
    /** A time value from a cell: a number as it is, a date string as milliseconds, or NaN. */
    export function timeValue(value: unknown): number;
    /**
     * Columns that read as times, for the builder's picker: dates, or whole numbers that look like
     * years (1000 to 2200). Columns named like a time (year, date, built, opened…) come first.
     */
    export function timeColumns(rows: readonly Record<string, unknown>[]): string[];
    export interface TimeReveal {
        /** How visible a feature is now, 0 to 1, and how freshly it appeared (1 just now, 0 long ago). */
        at(props: Record<string, unknown> | undefined, time: number): {
            alpha: number;
            fresh: number;
        };
        /** Where the sweep is, as a share of the span. */
        share(time: number): number;
        /** The time the sweep has reached, for the controller: a year or a date. */
        label(time: number): string;
    }
    /** Prepares a timeline over the features' rows. Features with no time are always shown. */
    export function timeReveal(rows: readonly (Record<string, unknown> | undefined)[], props: Partial<TimelineProps> & {
        position?: TimelinePosition;
    }): TimeReveal | null;
}
declare module "@mrstudio/sdk/places" {
    import type { Point } from "@mrstudio/sdk/blocks/geo";
    import type { Rgba } from "@mrstudio/sdk/blocks/scale";
    import { StreetNetwork } from "@mrstudio/sdk/blocks/network";
    import type { Shapes, Spot } from "@mrstudio/sdk/blocks/sources";
    import type { ResolvedPalette } from "@mrstudio/sdk/palette";
    type PlaceRow = Record<string, unknown>;
    /** One place, ready for a motion. */
    export interface Place {
        index: number;
        name: string;
        /** Table metres. */
        point: Point;
        /** 0 to 1, rescaled from the weight column (0.6 for all when there is none). */
        weight: number;
        category: string | null;
        colour: Rgba;
    }
    /** Everything a place motion reads, prepared once per data change. */
    export interface PlaceData {
        places: Place[];
        /** Liveliness of place `i` at time `t`, 0 to 1: from activity.csv, or a slow ambient swell without it. */
        activity(i: number, t: number): number;
        /** Whether `activity` comes from data. */
        hasActivity: boolean;
        /** Flows between places, volume rescaled 0 to 1. Empty without flows.csv. */
        flows: {
            from: number;
            to: number;
            volume: number;
        }[];
        /** Relations between places: links.csv, else places sharing a category. */
        links: {
            a: number;
            b: number;
        }[];
        /** Points a motion reaches out to (spokes, density): a targets dataset, or none. */
        targets: Point[];
        streets: StreetNetwork | null;
        /** Building footprints in table metres: the outer ring of each polygon, plus the bounding box. */
        buildings: {
            point: Point;
            w: number;
            h: number;
            outline: Point[][];
        }[];
        /** The table, in metres. */
        frame: {
            width: number;
            height: number;
        };
        /** Problems an author should see (a flow naming a place that is not there, a weight that is not a number). */
        problems: string[];
    }
    /** Which columns the places use. Each is found by name when not given. */
    export interface PlaceColumns {
        name?: string | null;
        weight?: string | null;
        category?: string | null;
        /** How places are coloured: one palette colour each, by category, or one slot (`@warm`) for all. */
        colours?: 'each' | 'category' | string;
    }
    export interface PlaceTables {
        activity?: PlaceRow[];
        flows?: PlaceRow[];
        links?: PlaceRow[];
    }
    export interface PlaceExtras {
        streets?: Shapes | null;
        buildings?: Shapes | null;
        targets?: Shapes | null;
    }
    /** Guesses which columns of the places are the name, weight and category (#160: auto-detection). */
    export function guessPlaceColumns(rows: readonly PlaceRow[]): {
        name: string | null;
        weight: string | null;
        category: string | null;
    };
    /** Builds the places and their tables. `cycle_s` is how long activity.csv takes to play through once. */
    export function placeData(spots: readonly Spot[], columns: PlaceColumns, tables: PlaceTables, extras: PlaceExtras, palette: ResolvedPalette, frame: {
        width: number;
        height: number;
    }, cycle_s?: number): PlaceData;
    /** The data shapes a motion can read, with an example an author can copy. */
    export const PLACE_DATA_HELP: {
        readonly places: {
            readonly file: "places.geojson";
            readonly what: "Points, one per place. Any GeoJSON, or a CSV with lon and lat columns.";
            readonly example: "{\"type\":\"Feature\",\n \"geometry\":{\"type\":\"Point\",\"coordinates\":[11.9746,57.6896]},\n \"properties\":{\"name\":\"Library\",\"weight\":0.85}}";
        };
        readonly activity: {
            readonly file: "places.geojson + activity.csv";
            readonly what: "The same points, plus a value per place over time. Long format: one row per place per time step.";
            readonly example: "place,time,activity\nLibrary,2026-11-23T08:00,0.2\nLibrary,2026-11-23T09:00,0.7\nStation,2026-11-23T08:00,1.0";
        };
        readonly flows: {
            readonly file: "places.geojson + flows.csv";
            readonly what: "The places, plus one row per trip or flow between two of them.";
            readonly example: "from,to,volume\nStation,Library,420\nMarket,Station,180";
        };
        readonly links: {
            readonly file: "places.geojson + links.csv";
            readonly what: "The places, plus one row per relation. Or skip the file and link places that share a category column.";
            readonly example: "from,to\nLibrary,School\nLibrary,Station";
        };
        readonly targets: {
            readonly file: "places.geojson + targets.geojson";
            readonly what: "Hubs, plus the points to reach. The targets can be any point dataset already on the site (shops, stops, trees).";
            readonly example: "targets.geojson: points, no columns required";
        };
        readonly audio: {
            readonly file: "places.geojson + audio files";
            readonly what: "The places, with a column naming a sound file (#150). Until audio lands, the bars move by weight and activity.";
            readonly example: "{\"properties\":{\"name\":\"Park\",\"sound\":\"blackbird.mp3\"}}";
        };
        readonly raster: {
            readonly file: "places.geojson (density)";
            readonly what: "Points turned into a density surface. The places and any targets count, each by its weight.";
            readonly example: "places.geojson + targets.geojson";
        };
    };
    export type PlaceDataKind = keyof typeof PLACE_DATA_HELP;
    /** What each column a motion reads means. */
    export const PLACE_COLUMN_HELP: Record<string, string>;
}
declare module "@mrstudio/sdk/schemes" {
    export interface CategoryScheme {
        id: string;
        label: string;
        /** The categories in order, with their colours. */
        classes: {
            value: string;
            color: string;
        }[];
        /** A value as the scheme spells it, or null when it is not one of the scheme's. */
        normalise(value: unknown): string | null;
    }
    export const CATEGORY_SCHEMES: readonly CategoryScheme[];
    export function categoryScheme(id: string | null | undefined): CategoryScheme | null;
    /** The scheme every non-empty value belongs to, if any: what a layer is offered without asking. */
    export function schemeFor(values: readonly unknown[]): CategoryScheme | null;
    /** A value's colour in a scheme, or null when the value is not one of its classes. */
    export function schemeColour(scheme: CategoryScheme, value: unknown): string | null;
    /** Values sorted in the scheme's order (A before B), values outside it last, in their own order. */
    export function schemeOrder(scheme: CategoryScheme, values: readonly string[]): string[];
    /**
     * Which scheme a layer uses: `palette` turns schemes off, a scheme's id picks it, and
     * `auto` (or nothing) picks the one every value belongs to.
     */
    export function pickScheme(setting: string | null | undefined, values: readonly unknown[]): CategoryScheme | null;
}
declare module "@mrstudio/sdk/audio" {
    /** How a sound motion plays its points' sounds. */
    export interface SoundProps {
        /** The column naming each point's sound file (`blackbird.mp3`, or a path in the site folder). */
        column: string | null;
        /** One sound for every point, when there is no column. */
        file: string | null;
        /** `chorus`: a few at a time, at random, as in the bird demo. `loop`: every point, always. `tap`: only when asked (a tap, a card, a step). */
        trigger: 'chorus' | 'loop' | 'tap';
        /** For a chorus: how many play at once, and the quiet between one ending and the next starting. */
        voices: number;
        gap_s: number;
        /** 0 to 1. */
        volume: number;
        /** How far a ring travels before it fades, in table mm (E5), and its width at the loudest. */
        reach_mm: number;
        width_mm: number;
        /** How readily a rise in loudness counts as a call that sends out a ring: 0 calm, 1 eager. */
        sensitivity: number;
        /** A closed waveform round each point while it plays, drawn from the sound itself (#555). */
        waveform: boolean;
        /** How far the waveform swings out at the loudest, in table mm. */
        wave_mm: number;
    }
    export const SOUND_DEFAULTS: SoundProps;
    /** Columns that look like they name sound files. */
    export function soundColumns(rows: readonly (Record<string, unknown> | undefined)[]): string[];
    /** Where a point's sound is, relative to the site folder, or null when it has none. */
    export function soundPath(row: Record<string, unknown> | undefined, props: Pick<SoundProps, 'column' | 'file'>): string | null;
    /** What to call a point's sound on the controller: its name, species or label, else its file name. */
    export function soundLabel(row: Record<string, unknown> | undefined, path: string | null): string;
    /** A sound reduced to what the rings need, every `step` seconds. */
    export interface SoundProfile {
        duration: number;
        step: number;
        /** 0 to 1, the loudest window being 1. */
        loudness: Float32Array;
        /** 0 to 1: low and dull to high and bright (zero crossings per window). */
        brightness: Float32Array;
    }
    /** Analyses mono samples. Windows are 20 ms. */
    export function analyseSound(samples: Float32Array, sampleRate: number, step?: number): SoundProfile;
    /**
     * The waveform the table draws round a playing point (#555): the sound's last `span` seconds
     * before `at`, wrapped round a circle. The newest moment sits at the top and the past runs down
     * both sides, so the ring closes without a seam. `n` values, each the loudness at that moment,
     * with the zero crossings (brightness) as a fine ripple so high song shimmers and low sound swells.
     */
    export function waveformRing(profile: SoundProfile, at: number, span: number, n: number, out?: Float32Array): Float32Array;
    /** The profile at `t` seconds into the sound. */
    export function profileAt(profile: SoundProfile, t: number): {
        loudness: number;
        brightness: number;
    };
    /**
     * Finds calls in a loudness stream: a rise well above the recent average, no sooner than
     * `refractory` seconds after the last. Each call sends out one ring.
     */
    export class PeakFinder {
        private average;
        private last;
        /** A call has to fall away before the next one counts, so a held note is one call. */
        private armed;
        private readonly refractory;
        private readonly rise;
        constructor(sensitivity?: number, refractory?: number);
        push(level: number, time: number, dt: number): boolean;
    }
    /**
     * Picks which points start now. A chorus keeps up to `voices` going, one at a time with a
     * gap after each ends, never the same point twice in a row. A loop starts everything not playing.
     */
    export class SoundSchedule {
        private next;
        private lastPicked;
        private readonly random;
        constructor(seed?: number);
        starts(props: Pick<SoundProps, 'trigger' | 'voices' | 'gap_s'>, candidates: readonly number[], playing: ReadonlySet<number>, time: number, justEnded: boolean): number[];
    }
    /** What one point is doing now. */
    export interface PointSound {
        playing: boolean;
        loudness: number;
        brightness: number;
        /** A call was heard this frame. */
        call: boolean;
    }
    /** Loads and analyses a sound file once per page. Resolves null when it cannot be read. */
    export function loadSound(url: string): Promise<{
        buffer: AudioBuffer | null;
        profile: SoundProfile;
    } | null>;
    /**
     * The sounds of one layer's points. `audible` is false on surfaces that only show the rings
     * (the editor's preview), so one room hears the table and nothing else.
     */
    export class SoundStage {
        private readonly voices;
        private readonly profiles;
        private readonly buffers;
        private readonly schedule;
        /** Points asked to play (a tap, a card, a step), started as soon as their sound is ready. */
        private readonly cues;
        private readonly url;
        audible: boolean;
        volume: number;
        constructor(options: {
            audible: boolean;
            url?: (path: string) => string;
        });
        /** Starts loading the sounds; points draw calm dots until theirs is ready. */
        prepare(paths: Iterable<string>): void;
        /** For tests and synthetic sounds: a profile without a file. */
        setProfile(path: string, profile: SoundProfile): void;
        /** Whether the page can actually be heard now (audible and the browser let audio start). */
        get heard(): boolean;
        /**
         * Advances to `time` (seconds) and returns each point's sound. `paths[i]` is point i's
         * sound or null. Call once per frame.
         */
        update(paths: readonly (string | null)[], props: SoundProps, time: number, dt: number): PointSound[];
        /** Plays a point's sound now, once, whatever the trigger (a tap on it, its card, a step). */
        cue(point: number): void;
        /**
         * The waveform round `point` at `time` (waveformRing), or null when it is not playing or its
         * sound is not analysed yet. Call after `update` for the same frame.
         */
        waveform(point: number, time: number, span: number, n: number, out?: Float32Array): Float32Array | null;
        /** Points playing now. */
        playing(): number[];
        /** Stops every sound, for when the layer turns off. */
        stop(): void;
        private startVoice;
        private stopVoice;
    }
    /** The editor's switch for hearing sounds in its preview (#150). */
    export const LISTEN_KEY = "mrstudio.listen";
    export function setSessionSound(on: boolean): void;
    /**
     * Whether this page should be heard: the table always, the editor only when its author turned
     * listening on, and neither while the controller's sound switch is off for the session.
     */
    export function hearsSound(): boolean;
    /** The demo's mix: each bed at most `max`, with a 0.05 floor while it is still in play. */
    export function soundscapeMix(gvf: number, max?: number): {
        nature: number;
        city: number;
    };
    /** Eases a volume towards its target: the demo's 0.1 per frame at 60 frames a second. */
    export function easeVolume(current: number, target: number, dt: number, rate?: number): number;
    /**
     * A built-in bed, made from numbers so a table has a soundscape before anyone adds recordings.
     * `nature`: chirps that sweep up and down between 2 and 6 kHz in short phrases, over soft
     * leaves. `city`: a low rumble of traffic that swells as cars pass, over a band of hiss.
     * The loop is seamless: what rings past the end wraps to the start.
     */
    export function synthBed(kind: 'nature' | 'city', sampleRate?: number, seconds?: number, seed?: number): Float32Array;
    /** A bed: a sound file in the site (`data/sounds/...`), or the built-in one when null. */
    export interface BedSpec {
        file: string | null;
    }
    /**
     * Plays the two beds and keeps their mix. Nothing is heard until the page has had a gesture
     * (the browser's autoplay rule) or on a page that is not `audible`; the mix is still worked out,
     * so the controller can show it.
     */
    export class Soundscape {
        private readonly beds;
        private readonly url;
        private stopped;
        audible: boolean;
        constructor(options: {
            audible: boolean;
            url?: (path: string) => string;
        });
        /** The volumes now, after easing, 0 to 1. */
        get volumes(): {
            nature: number;
            city: number;
        };
        /** Moves the mix towards `gvf` and (re)starts beds whose file changed. Call once per frame. */
        update(gvf: number | null, specs: Record<'nature' | 'city', BedSpec>, master: number, dt: number): void;
        stop(): void;
        private start;
        private release;
    }
    /** Seconds an ambient loop takes to come in or go. */
    export const AMBIENT_FADE_S = 1.5;
    /** Moves a volume towards `target` at a steady pace: from silence to full in `fade_s`. */
    export function stepVolume(current: number, target: number, dt: number, fade_s?: number): number;
    /**
     * Plays one sound file of the site (`data/sounds/...`) on a loop, easing in when it starts and
     * when its volume changes. `stop` lets it fade out by itself, so a layer can stop it as it closes.
     * Nothing is heard until the page has had a gesture (the browser's autoplay rule) or on a page
     * that is not `audible`.
     */
    export class AmbientLoop {
        private source;
        private gain;
        private key;
        private stopped;
        private readonly url;
        /** The volume now, after easing, 0 to 1. */
        volume: number;
        audible: boolean;
        constructor(options: {
            audible: boolean;
            url?: (path: string) => string;
        });
        /** Eases towards `target` (0 to 1) and (re)starts the loop when `file` changed; null plays nothing. Call once per frame. */
        update(file: string | null, target: number, dt: number): void;
        /** Fades out over `fade_s` and stops. */
        stop(fade_s?: number): void;
        private start;
        private release;
    }
    /** Where a sound named in a layer's setting is: a bare file name is one of the site's sounds (`data/sounds/`), else a path in the site. */
    export function soundFilePath(name: string | null | undefined): string | null;
}
declare module "@mrstudio/sdk/place-motions" {
    import type { View } from "@mrstudio/sdk/blocks/view";
    import type { PlaceData, PlaceDataKind } from "@mrstudio/sdk/places";
    import type { ResolvedPalette } from "@mrstudio/sdk/palette";
    /** One style knob of a motion, shown as a slider in the builder's Motion tab. */
    export interface PlaceKnob {
        key: string;
        label: string;
        min: number;
        max: number;
        step: number;
        value: number;
        unit?: string;
    }
    export type PlaceMotionGroup = 'Place motions' | 'Circular waves' | 'Cultural gravity';
    export interface PlaceMotionDef {
        id: string;
        group: PlaceMotionGroup;
        label: string;
        about: string;
        /** The data setup the ? panel shows. */
        data: PlaceDataKind;
        columns: string[];
        /** A note for the ? panel. */
        extra?: string;
        /** Site datasets the motion needs besides the places. */
        uses?: ('streets' | 'buildings')[];
        knobs: PlaceKnob[];
        create(env: PlaceEnv): {
            draw(view: View, time: number, alpha: number): void;
        };
    }
    export interface PlaceEnv {
        data: PlaceData;
        /** Knob values over their defaults, plus the shared `speed`, `glow` and `scale`. */
        props: Record<string, number>;
        /** Metres per design unit (1.25 table mm). */
        u: number;
        palette: ResolvedPalette;
        /**
         * Where Next is, when the motion steps (#341): 0 before the first Next (nothing yet), 1 while
         * the places appear one by one, 2 once the motion runs. `since` is the draw time it got there.
         * Without it the motion simply runs.
         */
        stage?: () => PlaceStage;
    }
    export interface PlaceStage {
        revealed: number;
        since: number;
    }
    /** The sub-steps of a place motion that steps (#341), for the controller's strip. */
    export function placeStepTitles(motion: string): string[];
    /** Seconds between one place appearing and the next, and how long the motion takes to fade in. */
    export const ARRIVAL_S = 0.6;
    /** Knobs every place motion has. */
    export const SHARED_KNOBS: PlaceKnob[];
    /** How far apart the preview's places are, in du (see `placeSpacing`). */
    export const PREVIEW_SPACING_DU = 326;
    /** How a motion's units land on this table. */
    export interface Fit {
        /** Metres per du for distances on the map. */
        u: number;
        /** Metres per du for the size of marks. */
        mark: number;
        /** The scale over the preview: `u` over the table's own du. */
        scale: number;
    }
    /**
     * A typical distance between places, in the units of `points`: the geometric mean of the median
     * nearest neighbour (how close places sit) and the spread (the side of the share of the places'
     * bounding box each one has). NaN for fewer than two places.
     */
    export function placeSpacing(points: readonly (readonly [number, number])[]): number;
    /** The fit of the places in `data` on a table of `u` metres per du, times the author's `scale`. */
    export function placeFit(data: Pick<PlaceData, 'places'>, u: number, scale?: number): Fit;
    type Canvas = HTMLCanvasElement | OffscreenCanvas;
    /** A canvas to draw into off screen, or null where there is none (tests). */
    export function makeCanvas(w: number, h: number): Canvas | null;
    /** Every place motion, in the preview's order. */
    export const PLACE_MOTIONS: readonly PlaceMotionDef[];
    export const PLACE_MOTION_IDS: string[];
    export function placeMotion(id: string): PlaceMotionDef | undefined;
    /** Design units: metres per du on this table (1.25 table mm). */
    export function placeUnit(metresPerTableMm: number): number;
}
declare module "@mrstudio/sdk/networks" {
    import type { Point } from "@mrstudio/sdk/blocks/geo";
    import type { MeasuredPath } from "@mrstudio/sdk/blocks/geo";
    import { StreetNetwork } from "@mrstudio/sdk/blocks/network";
    import type { Rgba } from "@mrstudio/sdk/blocks/scale";
    import type { Shapes, Spot } from "@mrstudio/sdk/blocks/sources";
    import type { View } from "@mrstudio/sdk/blocks/view";
    import type { ResolvedPalette } from "@mrstudio/sdk/palette";
    import type { LegendItem } from "@mrstudio/sdk/types";
    type NetworkRow = Record<string, unknown>;
    /** The props of a `network` motion block, on a points look (the nodes). */
    export interface NetworkProps {
        /** A dataset of links: a CSV with from,to or lines with from/to properties. */
        links: string | null;
        /** A CSV dataset of series, long format. Without it every link carries its `value` (or 1). */
        series: string | null;
        /** A dataset of lines that links without a line of their own follow; null draws them straight. */
        streets: string | null;
        /**
         * The series column a link's flow comes from. Positive flows from `from` to `to`. On a link
         * itself the property may hold a whole list, one value per step (#373), such as `flow_hourly`.
         */
        flow: string;
        /** The series column a node's gauge comes from (0 to 1, or rescaled to its own top). */
        gauge: string;
        /** Seconds each step of the series takes on the table. */
        step_s: number;
        /** Link width at the busiest flow, in table mm; quiet links are thinner. */
        width_mm: number;
        /** Lights travelling on each link; 0 for none. Speed and brightness follow the flow. */
        heads: number;
        /** Table mm per second a light travels at the busiest flow. */
        speed_mm: number;
        /** Rings travel out of a node that gives and into one that takes. */
        rings: boolean;
        /** How far the rings reach, in table mm. */
        ring_mm: number;
        /** A gauge around each node that has a `gauge` series. */
        gauges: boolean;
        /** The flow's colour: `from` takes the colour of the node it leaves (solar flows in the solar colour), else a palette slot or #hex. */
        colour: string;
        /** Colours of the rings and gauges: palette slots or #hex. */
        giving: string;
        taking: string;
        gauge_colour: string;
        /** The series column whose text announces a change at a step (#338): a spotlight on its node, the words on the controller. */
        note: string;
        /** Seconds a change's spotlight stays on the table. */
        note_s: number;
        /** The series column with how many movers reach a node in a step (#338), along the streets. Empty for none. */
        arrivals: string;
        /** A mover's size on the table, in millimetres. */
        mover_mm: number;
        mover_colour: string;
    }
    export const NETWORK_DEFAULTS: NetworkProps;
    /** A node of the network. */
    export interface NetworkNode {
        id: string;
        kind: string | null;
        /** Table metres. */
        point: Point;
        /** The node's gauge per step (0 to 1), or null without one. */
        gauge: number[] | null;
    }
    /** A link between two nodes, with its flow per step. */
    export interface NetworkLink {
        id: string;
        from: number;
        to: number;
        path: MeasuredPath;
        /** Where its line came from. */
        route: 'own' | 'streets' | 'straight';
        values: number[];
    }
    /** A change announced at a step (#338): words for the controller, nodes for the spotlight. */
    export interface NetworkNote {
        text: string;
        nodes: number[];
    }
    /** A network ready to draw: nodes, links, the steps of its series and what went wrong. */
    export interface NetworkData {
        nodes: NetworkNode[];
        links: NetworkLink[];
        /** The number of steps in the series (1 without one). */
        steps: number;
        /** The time of each step as the series wrote it, for the controller. */
        labels: string[];
        /** The busiest flow on any link at any step. */
        peak: number;
        /** Problems an author should see: a link naming a node that is not there, a series row with no time. */
        problems: string[];
        /** Per step, the change it announces, or null (#338). */
        notes: (NetworkNote | null)[];
        /** Per node, how many movers reach it in each step, or null for a node without any (#338). */
        arrivals: (number[] | null)[];
        /** The streets movers drive along, when there are any. */
        streets: StreetNetwork | null;
    }
    export interface NetworkInputs {
        /** Links as lines (with from/to properties). */
        linkShapes?: Shapes | null;
        /** Links as a table. */
        linkRows?: NetworkRow[] | null;
        series?: NetworkRow[] | null;
        /** Streets that links without a line follow. */
        streets?: Shapes | null;
    }
    /** The id of a node: its `id` column, else its `name`, else its position in the file. */
    export function nodeId(spot: Pick<Spot, 'properties'>, index: number): string;
    /**
     * Reads a network: the look's points are its nodes; `inputs` hold its links, series and
     * streets. Everything is matched by id, case and spacing as written.
     */
    export function networkData(spots: readonly Spot[], inputs: NetworkInputs, props?: Partial<NetworkProps>): NetworkData;
    /** What leaves node `node` less what arrives, at a decimal step. Positive is giving. */
    export function networkBalance(data: Pick<NetworkData, 'links'>, node: number, position: number): number;
    /** The play head: a decimal step, looping over the series. */
    export function networkPosition(steps: number, seconds: number, step_s: number): number;
    /** The drawing of a network motion, for compileLook. */
    export interface NetworkLook {
        data: NetworkData;
        legend: LegendItem[];
        /** Draws the network at a decimal step of its series. */
        draw(view: View, time: number, alpha: number, position: number): void;
    }
    export function networkLook(data: NetworkData, props: Partial<NetworkProps>, palette: ResolvedPalette, mm: number, nodeColour?: (node: number) => Rgba): NetworkLook;
    /** How bright a change's spotlight is `age` seconds after its step began: in fast, held, out over the last second. */
    export function spotlight(age: number, seconds: number): number;
    /** One mover: the way it comes, and the decimal step it reaches the node. */
    export interface Mover {
        node: number;
        due: number;
        path: MeasuredPath;
    }
    /** Every mover of the series, with its way to its node (#338). Each node gets a few ways in, shared by its movers. */
    export function moverRoutes(data: Pick<NetworkData, 'nodes' | 'arrivals' | 'streets' | 'steps'>): Mover[];
    /** The files a network motion reads, by role, for whoever loads them. */
    export function networkFiles(props: Partial<NetworkProps>): {
        links?: string;
        series?: string;
        streets?: string;
    };
}
declare module "@mrstudio/sdk/recipe" {
    import type { Rgba } from "@mrstudio/sdk/blocks/scale";
    import type { Shapes } from "@mrstudio/sdk/blocks/sources";
    import type { View } from "@mrstudio/sdk/blocks/view";
    import type { Point } from "@mrstudio/sdk/blocks/geo";
    import type { ResolvedPalette } from "@mrstudio/sdk/palette";
    import type { Arrows, PointShape, TimelinePosition, TimelineProps } from "@mrstudio/sdk/marks";
    import { SoundStage } from "@mrstudio/sdk/audio";
    import type { SoundProps } from "@mrstudio/sdk/audio";
    import type { PlaceExtras, PlaceTables } from "@mrstudio/sdk/places";
    import type { PlaceStage } from "@mrstudio/sdk/place-motions";
    import type { NetworkInputs, NetworkProps } from "@mrstudio/sdk/networks";
    import type { CustomLayer, LegendItem, RecipeBlock, SiteInfo } from "@mrstudio/sdk/types";
    /** A colour: `@slot`, `#rrggbb`, or driven by a column. */
    export type Paint = string | PaintBy;
    export interface PaintBy {
        by: string;
        /** `category`: one palette colour per value (C5: six shown, the rest grouped). `number`: a ramp. */
        kind: 'category' | 'number';
        /** For categories: the colour of each value, when the author picked one. */
        colors?: Record<string, string>;
        /** For categories: a scheme of their own (`epc`), `palette` for the table's category colours, or `auto` (the default): a scheme when every value belongs to one (#207). */
        scheme?: string;
        /** For numbers: the ramp's name in the palette. Default `sun`. */
        ramp?: string;
        /**
         * For numbers: a smooth ramp, or classes of equal width, equal count, natural breaks (Jenks),
         * or the author's own edges (`custom`, in `stops`). Default `continuous`.
         */
        classes?: 'continuous' | 'equal' | 'quantile' | 'natural' | 'custom';
        /** How many classes, 2 to 7. Default 5. */
        count?: number;
        /** With `classes: custom`: the edges between classes, low to high, at most six (#94). */
        stops?: number[];
        /**
         * The value the ramp's middle colour stands for (#94). With a diverging ramp it is the calm
         * middle, such as 0 or an average, and the two ends spread from it. Default: halfway.
         */
        mid?: number;
    }
    /** The class edges a numeric paint draws with: the author's own, or worked out from the values. */
    export function paintBreaks(paint: Pick<PaintBy, 'classes' | 'count' | 'stops'>, values: readonly number[]): number[];
    /**
     * Where a value sits on the ramp, 0 to 1. With a middle the two halves stretch apart, so the
     * middle colour lands on `mid` however lopsided the data is.
     */
    export function rampShare(n: number, lo: number, hi: number, mid?: number): number;
    /** A size in table millimetres: fixed, or spread over a range by a numeric column. */
    export type Size = number | {
        by: string;
        range: [number, number];
    };
    /** `raster`: a GeoTIFF of values on the table's grid (#601), drawn by raster-look.ts. */
    export type GeometryKind = 'points' | 'lines' | 'fill' | 'raster';
    /** The props of each look block, with their defaults. */
    export interface PointsProps {
        color: Paint;
        radius_mm: Size;
        opacity: number;
        /** A soft glow around each point, 0 to 1. */
        glow: number;
        /** A white centre (C3: focus). */
        core: boolean;
        stroke: string | null;
        stroke_mm: number;
        /** A column whose value is written beside the point. Use for place names only (S1). */
        label: string | null;
        /** The mark: a circle, square, diamond, triangle, ring, or the pictogram named by `icon`. */
        shape: PointShape;
        icon: string;
    }
    export interface LinesProps {
        color: Paint;
        width_mm: Size;
        opacity: number;
        glow: number;
        /** A dark casing either side, so a bright line reads over busy ground (C7). */
        casing: boolean;
        dash: 'solid' | 'dashed' | 'dotted';
        dash_mm: number;
        gap_mm: number;
        /** Chevrons showing which way a line goes: at its end, or along it every `arrow_gap_mm`. */
        arrows: Arrows;
        arrow_mm: number;
        arrow_gap_mm: number;
    }
    export interface FillProps {
        color: Paint;
        opacity: number;
        stroke: string | null;
        stroke_mm: number;
        /** A glow along the outline, 0 to 1. */
        edge_glow: number;
        /** A soft shadow cast to the south-east, in mm: lifts an area off the ground without extrusion (D1). */
        shadow_mm: number;
        /** Diagonal hatching instead of a flat fill. */
        hatch: boolean;
    }
    export const LOOK_DEFAULTS: {
        points: {
            color: string;
            radius_mm: number;
            opacity: number;
            glow: number;
            core: true;
            stroke: any;
            stroke_mm: number;
            label: any;
            shape: "circle";
            icon: string;
        };
        lines: {
            color: string;
            width_mm: number;
            opacity: number;
            glow: number;
            casing: true;
            dash: "solid";
            dash_mm: number;
            gap_mm: number;
            arrows: "none";
            arrow_mm: number;
            arrow_gap_mm: number;
        };
        fill: {
            color: string;
            opacity: number;
            stroke: string;
            stroke_mm: number;
            edge_glow: number;
            shadow_mm: number;
            hatch: false;
        };
        raster: {
            color: Paint;
            opacity: number;
            hide_below: number | null;
            hide_above: number | null;
            edge_glow: number;
            edge_color: string;
            unit: string;
            /** The heading over its legend rows when the layer has more than one scale (#622). */
            legend: string;
        };
    };
    /** Motion blocks of this slice, by the geometry they act on. */
    export interface PulseProps {
        /** Seconds for a ring to travel out (M4: 1.5 to 2.5). */
        period_s: number;
        /** How far the rings travel, in table mm. */
        size_mm: number;
        rings: number;
        /** Rings go out (+1, giving) or in (-1, gathering). */
        direction: 1 | -1;
    }
    export interface DrawInProps {
        /** Seconds to draw every line in (M4: 0.6 to 1.2 for a reveal; longer reads as a story). */
        duration_s: number;
        /** Lines start one after another instead of together. */
        stagger: boolean;
    }
    export interface FlowProps {
        /** Table millimetres per second the dashes travel. */
        speed_mm: number;
    }
    /** Lights travelling along every line, as a pure function of time. */
    export interface ParticlesProps {
        /** Lights on each line at once. */
        per_line: number;
        speed_mm: number;
        size_mm: number;
    }
    /** A crowd of free particles drawn in to each point from around it: attention, pull (M8: free particles are for abstract forces). */
    export interface AttractProps {
        /** Particles in flight at once. */
        count: number;
        speed_mm: number;
        /** How far out they start, in table mm. */
        reach_mm: number;
        /** A numeric column that makes some points pull harder, or null for all alike. */
        weight: string | null;
        size_mm: number;
    }
    /** People walking to each point along the street network (#96, M8: motion follows the place). */
    export interface GravityProps {
        /** The site dataset whose lines are the streets. */
        network: string;
        count: number;
        speed_mm: number;
        weight: string | null;
        size_mm: number;
        /** A short fading trail behind each walker. */
        trail: boolean;
    }
    /**
     * A place motion on a points look. `motion` names one of PLACE_MOTIONS; the other files are
     * site datasets (streets, buildings, targets) or CSV tables (activity, flows, links), each
     * optional. Every other prop is a knob of the motion (speed, glow and its own).
     */
    export interface PlaceProps {
        motion: string;
        streets: string | null;
        buildings: string | null;
        targets: string | null;
        activity: string | null;
        flows: string | null;
        links: string | null;
        /** Seconds activity.csv takes to play through. */
        cycle_s: number;
        /** One palette colour each, by category, or one slot for all. */
        colours: string;
        /** Next steps it (#341): first the places appear one by one, then the motion starts. */
        reveal: boolean;
        [knob: string]: unknown;
    }
    export const PLACE_DEFAULTS: PlaceProps;
    export const MOTION_DEFAULTS: {
        pulse: {
            period_s: number;
            size_mm: number;
            rings: number;
            direction: 1;
        };
        'draw-in': {
            duration_s: number;
            stagger: true;
        };
        flow: {
            speed_mm: number;
        };
        particles: {
            per_line: number;
            speed_mm: number;
            size_mm: number;
        };
        attract: {
            count: number;
            speed_mm: number;
            reach_mm: number;
            weight: any;
            size_mm: number;
        };
        gravity: {
            network: string;
            count: number;
            speed_mm: number;
            weight: any;
            size_mm: number;
            trail: true;
        };
        timeline: TimelineProps;
        place: PlaceProps;
        sound: SoundProps;
        network: NetworkProps;
    };
    /** Which motions fit which look (L1: verbs fit the form). */
    export const MOTIONS_FOR: Record<GeometryKind, (keyof typeof MOTION_DEFAULTS)[]>;
    /** The look a geometry gets by default (D2: a single file can be a layer). */
    export function lookFor(shapes: Shapes): GeometryKind;
    type Props = Record<string, any>;
    /** The numeric values of a column, skipping blanks. */
    export function columnNumbers(rows: readonly Props[], column: string): number[];
    /** The distinct values of a column, most common first. */
    export function columnCategories(rows: readonly Props[], column: string): string[];
    /** Which columns of a dataset are numbers and which are categories, for the "based on" pickers. */
    export function profileColumns(rows: readonly Props[]): {
        name: string;
        kind: 'number' | 'category';
        distinct: number;
    }[];
    /** Class breaks for numbers: the upper bound of each class but the last. */
    export function classBreaks(values: readonly number[], classes: 'equal' | 'quantile' | 'natural', count: number): number[];
    /**
     * Natural breaks (Fisher-Jenks): the class boundaries that keep each class as tight as it can
     * be, so gaps in the data become edges between colours. `sorted` is ascending. Returns
     * `n - 1` breaks, each the lowest value of the class above it.
     */
    export function naturalBreaks(sorted: readonly number[], n: number): number[];
    /** A paint turned into a colour for each shape's properties, with the legend rows that explain it. */
    export interface PaintScale {
        colour(properties: Props): Rgba;
        legend: {
            label: string;
            color: string;
        }[];
    }
    export function paintScale(paint: Paint | undefined, rows: readonly Props[], palette: ResolvedPalette): PaintScale;
    /** A size scale over the rows, in table mm. */
    export function sizeScale(size: Size | undefined, rows: readonly Props[], fallback: number): (properties: Props) => number;
    /**
     * Metres on the ground per millimetre on the physical table. Sizes in a recipe are table
     * millimetres (E5: a line 2 mm, a point 4 mm), so they look the same on a 1 m and a 3 m table.
     */
    export function metresPerTableMm(site: Pick<SiteInfo, 'extent' | 'table'>): number;
    /** One look block made ready to draw: its scales computed over its data and the palette. */
    export interface CompiledLook {
        id: string;
        kind: GeometryKind;
        /** Draws the block. `time` is seconds since the layer came on; `alpha` is the layer's fade. */
        draw(view: View, time: number, alpha: number): void;
        legend: LegendItem[];
        /** For points with sounds (#150): each sound, for the controller's cards, and a way to play one. */
        sounds?: {
            list(): SoundCard[];
            cue(point: number): void;
        };
        /** For points with a network motion (#280): its steps and their times, and what is wrong with its data. */
        network?: {
            steps: number;
            labels: string[];
            problems: string[]; /** Per step, the words of a change announced there (#338), or null. */
            notes: (string | null)[];
        };
        /** With a Through time motion (#95): the year or date on show now, for the controller. */
        timeLabel?(time: number): string;
    }
    /** A point's sound as the controller shows it. */
    export interface SoundCard {
        /** The point's index in its look block. */
        point: number;
        label: string;
        /** CSS colour of the point and its rings. */
        colour: string;
        /** Where it is, in table metres. */
        at: Point;
        playing: boolean;
    }
    export interface LookMotion {
        pulse?: Partial<PulseProps>;
        drawIn?: Partial<DrawInProps>;
        flow?: Partial<FlowProps>;
        particles?: Partial<ParticlesProps>;
        attract?: Partial<AttractProps>;
        /** `streets` is the network dataset in table metres, loaded by whoever draws the recipe. */
        gravity?: Partial<GravityProps> & {
            streets?: Shapes;
        };
        /** `position` holds the sweep where the controller put it (a share of the span), or null to play. */
        timeline?: Partial<TimelineProps> & {
            position?: TimelinePosition;
        };
        /** A place motion (#161-163): `extras` and `tables` are its other files, loaded by whoever draws the recipe. */
        place?: Partial<PlaceProps> & {
            extras?: PlaceExtras;
            tables?: PlaceTables;
            frame?: {
                width: number;
                height: number;
            };
            stage?: () => PlaceStage;
        };
        /** Sound on points (#150). `stage` plays the sounds; whoever draws the recipe owns it and stops it. */
        sound?: Partial<SoundProps> & {
            stage?: SoundStage;
        };
        /**
         * A network of nodes and flows (#280): the look's points are the nodes. `inputs` are its links,
         * series and streets, loaded by whoever draws the recipe; `position` is the shared play head
         * (a decimal step of the series), else the series plays from the layer's own time.
         */
        network?: Partial<NetworkProps> & {
            inputs?: NetworkInputs;
            position?: () => number;
        };
    }
    /** Props of a look block over its defaults, with control overrides (`look.<id>.<prop>`) applied. */
    export function lookProps<K extends GeometryKind>(kind: K, block: RecipeBlock, overrides?: Record<string, unknown>): (typeof LOOK_DEFAULTS)[K];
    /**
     * Prepares one look block to draw. `shapes` is its dataset in table metres; `mm` is metres per
     * table millimetre (`metresPerTableMm`).
     */
    export function compileLook(block: RecipeBlock, shapes: Shapes, palette: ResolvedPalette, mm: number, motion?: LookMotion, overrides?: Record<string, unknown>): CompiledLook | null;
    /** The share of each line drawn so far, for a draw-in reveal. */
    export function drawnShare(index: number, count: number, time: number, drawIn: DrawInProps | null): number;
    /** The files a place motion block reads, by role, for whoever loads them. */
    export function placeFiles(props: Partial<PlaceProps>): {
        datasets: Partial<Record<'streets' | 'buildings' | 'targets', string>>;
        tables: Partial<Record<'activity' | 'flows' | 'links', string>>;
    };
    /** The motion blocks acting on a look block, as compileLook takes them. */
    export function motionFor(recipe: Pick<CustomLayer, 'motion'>, look: string, overrides?: Record<string, Record<string, unknown>>): LookMotion;
    /**
     * Control values as overrides of block props: a control whose `bind` is
     * `look.<block>.<prop>` or `motion.<block>.<prop>` sets that prop.
     */
    export function boundOverrides(recipe: Pick<CustomLayer, 'controls'>, params: Record<string, unknown>): {
        look: Record<string, Record<string, unknown>>;
        motion: Record<string, Record<string, unknown>>;
    };
    /** One "show only" rule on a look (#38): features whose column is this value, or at least this number. */
    export interface ShapeFilter {
        column: string;
        is?: string;
        atLeast?: number;
    }
    /**
     * The "show only" rules the controller's controls set, by look: a control bound to
     * `filter.<look>.<column>`. A choice keeps the features with that value (an empty choice keeps
     * all); a slider keeps those at or above its value.
     */
    export function boundFilters(recipe: Pick<CustomLayer, 'controls'>, params: Record<string, unknown>): Record<string, ShapeFilter[]>;
    /** The shapes that pass every rule. The same object when there are no rules, so nothing is copied. */
    export function filterShapes<S extends Shapes>(shapes: S, filters: readonly ShapeFilter[] | undefined): S;
    /** The legend a recipe's looks give, for the controller (S2: every colour on the table has its swatch). */
    export function recipeLegend(looks: readonly CompiledLook[]): LegendItem[];
    /**
     * Each look's legend rows as one legend (#622). When more than one look has a scale (several
     * rows), each scale gets a heading, so a soil-depth ramp and a rock-height ramp read as two
     * legends: the look's `legend` prop, else its id in words. Single swatches come first, so
     * none sits under a scale's heading.
     */
    export function lookLegend(parts: readonly {
        block: RecipeBlock;
        rows: readonly LegendItem[];
    }[]): LegendItem[];
}
declare module "@mrstudio/sdk/raster-look" {
    import type { Paint } from "@mrstudio/sdk/recipe";
    import type { Colormap } from "@mrstudio/sdk/colormap";
    import type { ResolvedPalette } from "@mrstudio/sdk/palette";
    import type { FieldFrame, LegendItem } from "@mrstudio/sdk/types";
    export interface RasterProps {
        /** By value (always `by: "value"`, `kind: "number"`): ramp, classes, middle. A fixed colour paints every cell alike. */
        color: Paint;
        opacity: number;
        /** Hide cells below this value (null: none hidden). A bound slider makes it Dig. */
        hide_below: number | null;
        /** Hide cells above this value (null: none hidden). */
        hide_above: number | null;
        /** A glow along the cut, 0 to 1, in `edge_color`. */
        edge_glow: number;
        edge_color: string;
        /** Words after numbers in the legend: `m`, `dB`. */
        unit: string;
    }
    export const RASTER_DEFAULTS: RasterProps;
    /** The props of a raster look over its defaults, with control overrides applied. */
    export function rasterProps(props: Record<string, unknown> | undefined, overrides?: Record<string, unknown>): RasterProps;
    /** What a raster look draws: its coloured frame, the glowing cut, and their legend. */
    export interface RasterPicture {
        frame: FieldFrame;
        colormap: Colormap;
        /** Cells along the cut, 0 or 1; null when nothing is cut or the glow is off. */
        edge: FieldFrame | null;
        edgeColormap: Colormap;
        legend: LegendItem[];
        /** The values on the table, low and high, for sliders. */
        range: [number, number];
    }
    /** Up to `most` values of the field, spread evenly, for classes and a legend. */
    export function rasterSample(field: Pick<FieldFrame, 'data'>, most?: number): number[];
    /**
     * Colours a field of exact values for the table: each cell a level of the look's ramp (or its
     * class), the cells past a cut-off left empty, and the cells just inside the cut marked for the
     * glow. `field` is a frame of f32 values with NaN where there is no data.
     */
    export function rasterPicture(field: FieldFrame, props: RasterProps, palette: ResolvedPalette): RasterPicture;
}
declare module "@mrstudio/sdk/isovist" {
    import type { Point } from "@mrstudio/sdk/blocks/geo";
    import type { XY } from "@mrstudio/sdk/table-space";
    /** A building footprint: rings in table metres, outer first. */
    export interface ViewBuilding {
        rings: XY[][];
        /** What kind of building it is (the demo's `objekttyp`), for the view's breakdown. */
        type: string;
    }
    /** A tree crown: a circle in table metres. */
    export interface ViewTree {
        x: number;
        y: number;
        r: number;
    }
    export interface ViewScene {
        readonly buildings: readonly ViewBuilding[];
        readonly trees: readonly ViewTree[];
        /** Indices of the buildings and trees whose boxes touch a grid cell. */
        readonly cell: number;
        readonly buildingCells: Map<string, number[]>;
        readonly treeCells: Map<string, number[]>;
        /** Each building's box: min x, min y, max x, max y. */
        readonly boxes: Float64Array;
    }
    export interface ViewOptions {
        /** How far the eye reaches, in metres. Default 200. */
        radius_m?: number;
        /** The field of view in degrees; 360 for all round. Default 120. */
        fov_deg?: number;
        /** The direction the person faces, in radians in table space (0 = right, π/2 = down). */
        heading?: number;
        /** Rays cast across the field of view. Default 180. */
        rays?: number;
        /** Whether tree crowns block the view. Default true. */
        trees?: boolean;
    }
    export type RayHit = 'open' | 'building' | 'tree';
    export interface Ray {
        angle: number;
        dist: number;
        hit: RayHit;
        /** The building or tree it stopped at, else -1. */
        index: number;
    }
    export interface ViewStats {
        /** Rays cast. */
        rays: number;
        open: number;
        trees: number;
        buildings: number;
        /** Building rays by building type. */
        byType: Record<string, number>;
        /** Share of rays that end in a tree crown: the green view factor, 0 to 1. */
        gvf: number;
        /** Share of rays that reach the edge of sight. */
        openShare: number;
        /** How many different buildings and trees are seen. */
        seenBuildings: number;
        seenTrees: number;
    }
    export interface Isovist {
        origin: XY;
        /** The edge of what is seen, in table metres. Starts and ends at the origin for a cone. */
        polygon: XY[];
        rays: Ray[];
        seenBuildings: number[];
        seenTrees: number[];
        stats: ViewStats;
    }
    /** Indexes buildings and trees once, so each view only looks at what is near. */
    export function viewScene(buildings: readonly ViewBuilding[], trees: readonly ViewTree[], cell?: number): ViewScene;
    /** Whether a point is inside a building (outside its holes). */
    export function insideBuilding(scene: ViewScene, [x, y]: Point): boolean;
    /** The point itself when it is outside every building, else the nearest one outside (5 m rings, 16 directions). */
    export function outsideBuildings(scene: ViewScene, point: Point, reach?: number): XY;
    /** Casts the view from `origin`. */
    export function isovist(scene: ViewScene, origin: Point, options?: ViewOptions): Isovist;
    /** The crown radius of a tree the demo's way: a given crown, else 2 m plus 0.3 m per metre of height. */
    export function crownRadius(properties: Record<string, unknown>, fallback_m?: number): number;
    /**
     * One step of the demo's follow: a placed viewer stays put until the cursor is `threshold`
     * metres away, then closes `speed` of the gap per step (60 steps a second).
     */
    export function follow(viewer: Point, cursor: Point, dt: number, threshold?: number, speed?: number): XY;
    /** The compass bearing (degrees, 0 = north) of a direction in table space, for a table turned by `rotation_deg`. */
    export function compassBearing(heading: number, rotation_deg: number): number;
    /**
     * Whether a view has moved enough to be worth sending on: the demo sends Street View a new
     * place after 3 m or 15° of turning.
     */
    export function viewMoved(last: {
        point: Point;
        bearing: number;
    } | null, point: Point, bearing: number, metres?: number, degrees?: number): boolean;
}
declare module "@mrstudio/sdk/hero" {
    export interface HeroFact {
        label: string;
        value: string;
    }
    export interface TimelineHeroSpec {
        /** What the band sets, for screen readers: "Time of day". */
        label: string;
        min: number;
        max: number;
        /** Values snap to this. */
        step: number;
        /** The value now, and how to set it. Setting it stops a playing timeline. */
        value(): number;
        set(value: number): void;
        /** Where the band is labelled, and how. */
        ticks: number[];
        tick(value: number): string;
        /** How a value is read aloud and shown while dragging. */
        format(value: number): string;
        /** ▶ and ⏸, when the timeline plays by itself. */
        playing?(): boolean;
        play?(playing: boolean): void;
        /** The big readout: a value, an optional unit beside it and a line under it. */
        readout(value: number): {
            value: string;
            unit?: string;
            line?: string;
        };
        /** Up to three small facts at the top right. */
        facts?(value: number): HeroFact[];
        /** The backdrop, top to bottom, for a value: three CSS colours. Default: the night sky. */
        sky?(value: number): [string, string, string];
        /** A stretch of the band to light up, such as the hours of daylight. */
        lit?(): {
            from: number;
            to: number;
            colors: [string, string];
        } | null;
    }
    /**
     * Draws a timeline hero into `el`. Call `update()` when the value or anything the readout
     * shows changes; `onCleanup` gets what to release when the layer closes.
     */
    export function timelineHero(el: HTMLElement, spec: TimelineHeroSpec, onCleanup: (cleanup: () => void) => void): {
        update(): void;
    };
}
declare module "@mrstudio/sdk/transition" {
    import type { Steps } from "@mrstudio/sdk/types";
    /** How a sequence goes from one step to the next (#43). */
    export type StepTransitionKind = 'cut' | 'fade' | 'dip';
    /** The transition a sequence uses when nothing says otherwise: the Chalmers demo's cross-fade. */
    export const DEFAULT_TRANSITION: {
        kind: StepTransitionKind;
        seconds: number;
    };
    /** The longest a transition may take. */
    export const MAX_TRANSITION_S = 10;
    /** The transition into step `index` of a sequence: the step's own, else the sequence's, else the default. */
    export function stepTransition(steps: Steps | undefined, index: number | undefined): {
        kind: StepTransitionKind;
        seconds: number;
    };
    /**
     * How strongly a layer shows `t` (0 to 1) of the way through a transition: the step coming
     * in rises from 0 to 1, the one going falls from 1 to 0. A fade does both at once; a dip lets
     * the old step go first, to the empty map, and brings the new one in after it.
     */
    export function transitionGain(kind: StepTransitionKind, role: 'in' | 'out', t: number): number;
}
declare module "@mrstudio/sdk/entities" {
    import type { EntityChange, EntityFact, EntityLog, EntitySet, Params, Position, ToolGeometry } from "@mrstudio/sdk/types";
    /** `params.entities` as the host keeps it: set, then entity, then control. Only changed values are there. */
    export type EntityOverrides = Record<string, Record<string, Record<string, unknown>>>;
    /** The overrides kept for every entity of one set. */
    export function entityOverrides(params: Params | undefined, set: string): Record<string, Record<string, unknown>>;
    /** One entity's values: each control's default, with what was set for it on top. */
    export function entityValues(set: EntitySet, params: Params | undefined, id: string): Record<string, unknown>;
    /** Which entities' values differ between two params, by set. Empty when none did. */
    export function entityChanges(before: Params | undefined, after: Params | undefined): EntityChange[];
    /** One entity of a dataset: its id, what it is called, its group and its shape. */
    export interface EntityFeature {
        id: string;
        label: string;
        group?: string;
        /** The set's facts for this entity, as name and value, when the set has `facts`. */
        facts?: [string, string][];
        geometry: ToolGeometry | {
            type: 'MultiPolygon';
            coordinates: Position[][][];
        } | {
            type: 'MultiLineString';
            coordinates: Position[][];
        };
    }
    interface Collection {
        features?: {
            properties?: Record<string, unknown> | null;
            geometry?: {
                type: string;
                coordinates: unknown;
            } | null;
        }[];
    }
    /**
     * A feature property by name, or by a dotted path into nested properties (#373): `ecom.name`
     * reads `properties.ecom.name`. A property whose own name has a dot (`"ecom.name"`) wins.
     */
    export function propertyAt(properties: Record<string, unknown> | null | undefined, path: string): unknown;
    /** The entities of a set in its dataset, in the dataset's order. Features without a key are left out. */
    export function entityFeatures(collection: Collection, set: Pick<EntitySet, 'key' | 'label' | 'group' | 'facts'>): EntityFeature[];
    /** The column a fact reads. */
    export function factColumn(fact: string | EntityFact): string;
    /**
     * The facts of one feature, in the set's order; empty values are left out. A fact given as a
     * column has its name tidied (`floor_area` reads "Floor area"); one given as an object reads its
     * own label and unit (#410).
     */
    export function factsOf(properties: Record<string, unknown>, facts: readonly (string | EntityFact)[]): [string, string][];
    /** How far `p` is from a feature in metres: 0 inside an area. */
    export function entityDistance(feature: Pick<EntityFeature, 'geometry'>, p: Position): number;
    /**
     * The entity under a point in WGS84: the area it is in, or else the nearest point or line
     * within `tolerance_m` (default 12 m, about a fingertip on a 1:1000 table). Null when none is.
     */
    export function pickEntity(features: readonly EntityFeature[], at: Position, tolerance_m?: number): EntityFeature | null;
    /** One layer of a log (#602), from a depth to a depth. */
    export interface LogLayer {
        from: number;
        to: number;
        material: string;
        note?: string;
    }
    /**
     * The layers of one entity's log, from the top down: the rows of `collection` whose key column is
     * `id`, with a material and a thickness. Rows sharing a top are kept once (the deepest wins).
     */
    export function logLayers(collection: Collection, log: EntityLog, id: string): LogLayer[];
    /** The colour a log draws a material in. */
    export function materialColour(material: string): string;
}
declare module "@mrstudio/sdk/controller-map" {
    import type { PanelContext } from "@mrstudio/sdk/layer";
    import type { TableSpace, XY } from "@mrstudio/sdk/table-space";
    import type { Position, ToolGeometry } from "@mrstudio/sdk/types";
    /** A site dataset drawn under the layer's own drawing. Colours are CSS; default from the controller's theme. */
    export interface ControllerMapData {
        name: string;
        fill?: string;
        stroke?: string;
        /** Line width in CSS pixels. Default 1.5. */
        width?: number;
        /** Point radius in CSS pixels. Default 3. */
        radius?: number;
    }
    /** What a tap does: `pick` gives a point, `line` and `polygon` add corners until `points` are placed or `finish()`. */
    export type ControllerMapMode = 'pick' | 'line' | 'polygon' | 'none';
    export interface ControllerMapOptions {
        /** Datasets drawn bottom first. Default: the site's `roads` and `buildings`, when it has them. */
        data?: ControllerMapData[];
        mode?: ControllerMapMode;
        /** For `line` and `polygon`: finish by itself once this many corners are placed, such as 2 for a route from A to B. */
        points?: number;
        /** A tap in `pick` mode, in WGS84 and table metres. */
        onPick?(at: Position, xy: XY): void;
        /** A finished line or area, as a tool input's geometry. */
        onDraw?(geometry: ToolGeometry): void;
        /** Draws the layer's own visual over the data, in CSS pixels; use `map.toScreen` and `map.project`. Called on every redraw. */
        draw?(g: CanvasRenderingContext2D, map: ControllerMap): void;
        /** Drag and pinch (or the wheel) move and zoom the map (#374); `resetView()` frames the table again. Default false. */
        zoom?: boolean;
        /** Told when the view moves away from the table's frame or back, to show a Reset button. */
        onView?(moved: boolean): void;
    }
    export interface ControllerMap {
        readonly canvas: HTMLCanvasElement;
        /** The table in metres: what `toScreen` takes. */
        readonly space: TableSpace;
        /** Corners placed so far in `line` or `polygon` mode, in WGS84. */
        readonly drawing: readonly Position[];
        /** Table metres to canvas CSS pixels. */
        toScreen(xy: XY): [number, number];
        /** WGS84 to canvas CSS pixels. */
        project(at: Position | readonly number[]): [number, number];
        /** Canvas CSS pixels to WGS84. */
        unproject(x: number, y: number): Position;
        setMode(mode: ControllerMapMode, points?: number): void;
        /** Ends a line or area being drawn and hands it to `onDraw`. Nothing happens with too few corners. */
        finish(): void;
        /** Drops the corners placed so far. */
        cancel(): void;
        /** Draws again on the next frame, after the layer's own state changed. */
        redraw(): void;
        /** Frames the whole table again after a pan or zoom. */
        resetView(): void;
        remove(): void;
    }
    /**
     * A map of the site in `el`, filling it, for a layer's `stage` (or hero) on the controller. Released
     * with `ctx.onCleanup`. Taps reach the table through the layer: send them on with `ctx.sendTool`.
     */
    export function controllerMap(el: HTMLElement, ctx: Pick<PanelContext, 'site' | 'onCleanup'>, options?: ControllerMapOptions): ControllerMap;
}
declare module "@mrstudio/sdk/test-data" {
    import type { GeometryKind } from "@mrstudio/sdk/recipe";
    import type { SiteInfo } from "@mrstudio/sdk/types";
    export type TestDataKind = 'points' | 'places' | 'network' | 'lines' | 'areas';
    export interface TestDataDef {
        kind: TestDataKind;
        label: string;
        about: string;
        /** The look the layer starts with. */
        geometry: GeometryKind;
        /** The dataset name it is brought in as (a free one is picked when taken). */
        dataset: string;
    }
    export const TEST_DATA: readonly TestDataDef[];
    /** One file to bring into the table: `suffix` is added to the dataset name (`-activity`). */
    export interface TestFile {
        suffix: '' | '-activity' | '-flows' | '-links' | '-series';
        filename: string;
        text: string;
    }
    /**
     * The files for one kind of test data on a table, in WGS84 so they go through the normal
     * import. Every position lies inside the table's extent.
     */
    export function makeTestData(kind: TestDataKind, site: Pick<SiteInfo, 'origin' | 'extent'>, seed?: number): TestFile[];
}
declare module "@mrstudio/sdk/table-pad" {
    import type { PanelContext } from "@mrstudio/sdk/layer";
    export interface TablePadBox {
        /** Where the table is on the pad's canvas, in CSS pixels. */
        x: number;
        y: number;
        width: number;
        height: number;
    }
    export interface TablePadOptions {
        /** Draws the layer's marks over the table, in the pad's CSS pixels. Called again by `redraw()`. */
        draw(g: CanvasRenderingContext2D, box: TablePadBox): void;
        /** A press, a drag and a release on the pad: where, as fractions of the table (0 to 1, left to right, top to bottom). */
        onDrag(at: [number, number], phase: 'down' | 'move' | 'up'): void;
        /** One line under the pad, such as "Drag to move the glass". */
        caption?: string;
        /** How the pad looks to a screen reader. */
        label?: string;
    }
    /**
     * Draws a table pad into a hero's element. The buildings come from the table's `buildings`
     * dataset when it has one. Returns `redraw()` for when the marks changed (params arrived).
     */
    export function tablePad(ctx: Pick<PanelContext, 'site' | 'onCleanup'>, el: HTMLElement, options: TablePadOptions): {
        redraw(): void;
        canvas: HTMLCanvasElement;
    };
}
declare module "@mrstudio/sdk/drawing-reveal" {
    /** A 2D affine transform as SVG and canvases write it: x' = a x + c y + e, y' = b x + d y + f. */
    export type Affine = [a: number, b: number, c: number, d: number, e: number, f: number];
    export const IDENTITY: Affine;
    /** `m` applied after `n`: a point goes through `n` first. */
    export function multiply(m: Affine, n: Affine): Affine;
    export function apply(m: Affine, [x, y]: readonly [number, number]): [number, number];
    export function invert(m: Affine): Affine;
    /** An SVG `transform` attribute as one matrix: matrix, translate, scale, rotate, skewX and skewY, in order. */
    export function parseTransform(text: string | null | undefined): Affine;
    /** The outline of an SVG shape element as path data, or null for a tag that has none. */
    export function shapePath(tag: string, attr: (name: string) => string | null): string | null;
    /**
     * Which batch of the trace a stroke starting at `(x, y)` belongs to, 0 first, in a drawing of
     * `width` by `height`. Batches spread out from the middle with a fixed grain, so neighbouring
     * strokes come in together and the drawing wakes from its heart outwards, the same on every table.
     */
    export function traceBucket(x: number, y: number, width: number, height: number, buckets?: number): number;
    /** How far a batch is traced at overall progress `t` (0 to 1): batches start one after another and each takes the last 38%. */
    export function batchProgress(t: number, bucket: number, buckets?: number): number;
    export interface OpeningTiming {
        /** Seconds the drawing takes to come in. */
        in_s: number;
        /** Seconds it stays as lines before it turns, and how long the turn takes. Null never turns. */
        colour_after_s: number | null;
        colour_s: number;
    }
    /**
     * Where the opening is `t` seconds after the layer started: how far the drawing has come in, and
     * how far it has turned to colour, both 0 to 1 and eased.
     */
    export function openingAt(t: number, timing: OpeningTiming): {
        drawn: number;
        colour: number;
    };
    /**
     * Where a drawing lands on the table. Without corners it is stretched over the table; with them
     * it is placed by its top left, top right and bottom left corners, given in table metres (turn
     * WGS84 into metres with `tableFrame(site).toTable`). The result takes a drawing's unit square
     * (0 to 1 across and down) to table metres.
     */
    export function placement(table: {
        width: number;
        height: number;
    }, corners?: readonly [readonly [number, number], readonly [number, number], readonly [number, number]] | null): Affine;
    type Corners = [[number, number], [number, number], [number, number]];
    /**
     * A drawing drawn turned (#301): `corners` are where the top left, top right and bottom left of
     * the drawing *as shown* land, `quarters` the quarter turns clockwise it is shown at. Answers
     * where the corners of the drawing as drawn land, for `placement`.
     */
    export function turnCorners(corners: readonly (readonly [number, number])[], quarters: number): Corners;
    /**
     * Where a drawing placed by no corners lands (#559): as large as fits inside the table, centred,
     * at its own proportions as shown (`quarters` quarter turns clockwise swap its sides), never
     * stretched. Answers the corners of the drawing as shown, in table metres, as `corners` gives them.
     * A drawing within 2 % of the table's shape fills it, as before.
     */
    export function fitCorners(table: {
        width: number;
        height: number;
    }, drawing: {
        width: number;
        height: number;
    } | null, quarters?: number): Corners;
    /** A drawing's own size from its viewBox, else its width and height attributes; null when it has neither. */
    export function drawingSize(svg: Element | null | undefined): {
        width: number;
        height: number;
    } | null;
    /** Corners as the `corners` param writes them: "lon,lat; lon,lat; lon,lat", to about a centimetre. */
    export function formatCorners(corners: readonly (readonly [number, number])[]): string;
    /**
     * Reads "lon,lat; lon,lat; lon,lat" (top left, top right, bottom left of the drawing) from a
     * text param. Null when it is empty or not three points.
     */
    export function parseCorners(text: string | null | undefined): [[number, number], [number, number], [number, number]] | null;
    /** The radius a part needs to be fully shown when it grows from `from`: to its bounds' farthest corner. */
    export function growRadius(from: readonly [number, number], bounds: readonly [number, number, number, number]): number;
    /** Strokes of one style that come in together. Paths are already in the target's units. */
    export interface TraceBatch {
        path: Path2D;
        bucket: number;
        width: number;
        colour: string;
        alpha: number;
        cap: CanvasLineCap;
        join: CanvasLineJoin;
    }
    export const NOT_DRAWN: Set<string>;
    /** An inherited presentation attribute: the element's own, its style, or its nearest ancestor's. */
    export function inherited(el: Element, name: string): string | null;
    /**
     * A drawing's stroked shapes as trace batches. `root` is the drawing's `<svg>`; `toTarget` takes
     * its viewBox units to the units the batches are drawn in (table metres on a drawing overlay).
     * Shapes without a stroke are left to the drawing's own picture, which the trace settles into.
     */
    export function traceDrawing(root: Element, toTarget: Affine, buckets?: number): TraceBatch[];
    export interface TraceStyle {
        /** The length of one dash of the trace, in the target's units: about a tenth of the drawing's diagonal. */
        dash: number;
        /** Thinnest line drawn, in the target's units, so hair lines still show on a projector. */
        minWidth: number;
        /** The glint a stroke flashes as it is traced. Default warm white. */
        glint?: string;
        buckets?: number;
    }
    /**
     * Draws the trace at progress `t` (0 to 1): each batch traced along its length as its turn comes,
     * flashing a warm glint at the height of it. The strokes keep their own colour once traced.
     */
    export function drawTrace(g: CanvasRenderingContext2D, batches: readonly TraceBatch[], t: number, style: TraceStyle): void;
    export interface StagedWeights {
        /** What the overview (before the first Next) shows: every part, or none of them. */
        overview: 'all' | 'none';
        /** How strongly the parts before the newest one show. 1 keeps them (a masterplan), lower dims them (viewpoints). */
        earlier: number;
        /** How faintly the parts still to come show, so the whole can be read ahead. 0 hides them. */
        later: number;
        /** Whether a last step shows every part together, and how strongly. */
        finale: number | null;
    }
    /**
     * How strongly part `k` (0 first) of `count` shows when `revealed` steps are revealed: 0 is the
     * overview, 1 to `count` bring the parts in one by one, and `count + 1` is the finale when there is one.
     */
    export function stagedWeight(k: number, revealed: number, count: number, weights: StagedWeights): number;
}
declare module "@mrstudio/sdk/drawing-roles" {
    import type { Affine } from "@mrstudio/sdk/drawing-reveal";
    export type DrawingRole = 'boundary' | 'axis' | 'route' | 'arrow' | 'point' | 'node' | 'area' | 'label' | 'shape';
    export const DRAWING_ROLES: readonly DrawingRole[];
    /** The role a name says, or null. Leading numbers ("01_", "2 -") and punctuation are ignored. */
    export function roleOfName(name: string | null | undefined): DrawingRole | null;
    /** The order a phase's name gives ("01_PROJECT BOUNDARY" is 1), or null. */
    export function phaseNumber(name: string | null | undefined): number | null;
    /** A phase's name as people read it: "01_PROJECT BOUNDARY:" becomes "Project boundary". */
    export function phaseTitle(name: string): string;
    /** How a part looks at one moment of its motion. */
    export interface RoleFrame {
        /** How much of its outline is drawn, 0 to 1. */
        draw: number;
        /** Where the drawn part starts: 'start' along the path, or 'middle' growing out both ways. */
        from: 'start' | 'middle';
        /** Scale about the part's middle. */
        scale: number;
        /** Opacity, times the part's own. */
        alpha: number;
        /** Glow, 0 none to 1 strong. */
        glow: number;
        /** Marching dashes: seconds they have been marching, or null for a solid line. */
        march: number | null;
    }
    /**
     * A part's motion: `p` is how far its phase has come in (0 to 1), `time` seconds since the layer
     * started (for the steady motion after), `index` and `count` its place among the parts of the same
     * role in its phase. Shared by the table and anything that previews a drawing.
     */
    export function roleFrame(role: DrawingRole, p: number, time: number, index?: number, count?: number): RoleFrame;
    /** Whether a role keeps moving after its phase is in, so the table must keep drawing it. */
    export function roleMoves(role: DrawingRole): boolean;
    /** One part of a drawing to animate: a shape, or for a node the shapes of the whole node. */
    export interface RolePiece {
        role: DrawingRole;
        path: Path2D;
        /** Fill and stroke colours, or null. */
        fill: string | null;
        stroke: string | null;
        /** Stroke width and dashes in the target's units. */
        width: number;
        dash: number[] | null;
        cap: CanvasLineCap;
        join: CanvasLineJoin;
        alpha: number;
        /** Its middle and its length (for a stroke), in the target's units. */
        centre: [number, number];
        length: number;
        /** Its place among the pieces of its role in its group of pieces, and how many there are. */
        index: number;
        count: number;
    }
    /** The name a drawing element goes by: its role, its layer name, its own <title> or its id. */
    export function elementName(el: Element): string | null;
    /** Whether any part of a drawing names a role, so it animates by role. */
    export function hasRoles(root: Element): boolean;
    /**
     * The pieces of `group` (a phase), with their roles. `toTarget` takes the drawing's viewBox
     * units (already offset by its origin) to the units drawn in, as for `traceDrawing`. Shapes
     * outside any named role become `fallback`.
     */
    export function rolePieces(group: Element, toTarget: Affine, fallback?: DrawingRole): RolePiece[];
    export interface RoleDrawStyle {
        /** How strongly the phase shows (an earlier phase dimmed, a later one faint). */
        weight: number;
        /** Device pixels of glow at full strength. */
        glowPx: number;
        /** Thinnest line, in the target's units. */
        minWidth: number;
        /** Length of a marching dash and its gap, in the target's units. */
        dash: [number, number];
    }
    /** Draws one piece at one frame of its motion. */
    export function drawRolePiece(g: CanvasRenderingContext2D, piece: RolePiece, frame: RoleFrame, style: RoleDrawStyle): void;
}
declare module "@mrstudio/sdk/readiness" {
    /**
     * Ready to present? (#63): every check of a table before it is shown, in one list. The editor's
     * Checks button and Present, and the MCP server's validation, read these same rules, so they
     * always name the same problems.
     *
     * The rules look only at a plain summary of the table, which each side builds from what it has:
     * the editor from the live session, the MCP server from site.json and the layer catalogue.
     */
    export type ReadyLevel = 'must' | 'should' | 'nice';
    /**
     * Layers that carry the author's own data (a GeoJSON file, a picture, a web map, a plan, a
     * slideshow). Their package's description says what kind of layer they are, which is for the
     * gallery, not for visitors (#586): until the author writes one, visitors see none.
     */
    export const KIND_LAYERS: ReadonlySet<string>;
    /** Where a problem is fixed. The editor turns each into a button; the MCP server into words. */
    export type ReadyFix = {
        kind: 'data';
        dataset: string;
    } | {
        kind: 'layer';
        id: string;
    } | {
        kind: 'guide';
        step: 'place' | 'rest' | 'layers';
    } | {
        kind: 'table';
    } | {
        kind: 'controller';
    } | {
        kind: 'calibrate';
    };
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
        /** Visitors see no words about it: it holds the author's own data and none were written (#586). */
        noWords?: boolean;
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
    export function readiness(table: ReadyTable): ReadyCheck[];
}
declare module "@mrstudio/sdk" {
    export * from "@mrstudio/sdk/types";
    export * from "@mrstudio/sdk/layer";
    export * from "@mrstudio/sdk/connection";
    export * from "@mrstudio/sdk/engine";
    export * from "@mrstudio/sdk/frame";
    export * from "@mrstudio/sdk/colormap";
    export * from "@mrstudio/sdk/flow";
    export * from "@mrstudio/sdk/time";
    export * from "@mrstudio/sdk/clock";
    export * from "@mrstudio/sdk/format";
    export * from "@mrstudio/sdk/controls";
    export * from "@mrstudio/sdk/geo";
    export * from "@mrstudio/sdk/solar";
    export * from "@mrstudio/sdk/comfort";
    export * from "@mrstudio/sdk/table-space";
    export * from "@mrstudio/sdk/site-geometry";
    export { rasteriseMask } from "@mrstudio/sdk/mask";
    export * from "@mrstudio/sdk/slices";
    export { packGeojson, unpackGeometry } from "@mrstudio/sdk/geo-pack";
    export type { PackedGeometry, PackedShapes, SitePlacement } from "@mrstudio/sdk/geo-pack";
    export * from "@mrstudio/sdk/data";
    export * from "@mrstudio/sdk/model";
    export * from "@mrstudio/sdk/projector";
    export * from "@mrstudio/sdk/blocks/index";
    export * from "@mrstudio/sdk/palette";
    export * from "@mrstudio/sdk/recipe";
    export * from "@mrstudio/sdk/raster-look";
    export * from "@mrstudio/sdk/marks";
    export * from "@mrstudio/sdk/places";
    export * from "@mrstudio/sdk/place-motions";
    export * from "@mrstudio/sdk/networks";
    export * from "@mrstudio/sdk/voices";
    export * from "@mrstudio/sdk/audio";
    export * from "@mrstudio/sdk/isovist";
    export * from "@mrstudio/sdk/schemes";
    export * from "@mrstudio/sdk/hero";
    export * from "@mrstudio/sdk/transition";
    export * from "@mrstudio/sdk/street-network";
    export { buildWalkNetwork, packWalkNetwork, unpackWalkNetwork } from "@mrstudio/sdk/walk-network";
    export type { PackedWalkNetwork, WalkEdge, WalkNetwork } from "@mrstudio/sdk/walk-network";
    export * from "@mrstudio/sdk/service";
    export * from "@mrstudio/sdk/entities";
    export * from "@mrstudio/sdk/controller-map";
    export * from "@mrstudio/sdk/test-data";
    export * from "@mrstudio/sdk/reveal";
    export * from "@mrstudio/sdk/table-pad";
    export * from "@mrstudio/sdk/drawing-reveal";
    export * from "@mrstudio/sdk/drawing-roles";
    export * from "@mrstudio/sdk/readiness";
    export * from "@mrstudio/sdk/widgets";
}
