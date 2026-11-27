// Suggestions (#477): features that fit a person's idea and their table, including the ones
// nobody would search for, such as life on the map at rest or strips in the projector's margin.
//
// Every suggestion is a feature card: what it does, when it helps, what it needs and how to switch
// it on. Layer cards are generated from each layer.json (description, about, requires). Table and
// app cards are below, each tied to the site.json setting or file that proves it. check-docs fails
// when a site.json setting is neither on a card nor in NOT_SUGGESTED, so the cards keep up.
//
// The fit is two things: the person's words (ranked like find_capabilities) and what the table
// already has (signals read from site.json). A suggestion says why in one line, and gives the
// exact tool call that switches it on. Suggestions are offered, never applied unasked.

import type { Capability, CapabilityStatus } from './capabilities.ts';
import { rank } from './capabilities.ts';
import type { SiteManifest } from './site.ts';

/** What the table already has, read from site.json. */
export interface SiteSignals {
  /** Dataset names the site can give layers: scene sources and data entries. */
  data: Set<string>;
  /** Layer ids (use) anywhere in the scene, items included. */
  layers: Set<string>;
  /** Button layers: the ones visitors open from the controller. */
  buttons: { id: string; use: string }[];
  /** Layers at rest that move (not the base map). */
  restLife: number;
  /** Datasets in `data` that no layer in the scene names. */
  unusedData: string[];
  steps: boolean;
  stepNotes: boolean;
  languages: number;
  welcome: boolean;
  logo: boolean;
  palette: boolean;
  ribbons: boolean;
  glow: boolean;
  /** Where the model leaves the projection free, from the table's and the area's shapes. */
  margin: { sides: string; share: number } | null;
}

/** What a layer in the scene needs and is: its datasets, and its category from layer.json. */
export type LayerInfo = (use: string) => { data: string[]; category?: string };

export function readSignals(m: SiteManifest, info: LayerInfo = () => ({ data: [] })): SiteSignals {
  const scene: any[] = Array.isArray(m.layers) ? m.layers : [];
  const all = scene.flatMap((l) => [l, ...(Array.isArray(l?.items) ? l.items : [])]);
  const layers = new Set<string>(all.map((l) => String(l?.use ?? '')).filter(Boolean));
  const data = new Set<string>([...Object.keys(m.data ?? {}), ...['buildings', 'trees', 'terrain', 'mesh', 'water'].filter((k) => m.scene?.[k])]);
  const named = new Set(all.flatMap((l) => info(String(l?.use ?? '')).data));
  // At rest: base and ambient layers. Every other top-level layer gets a controller button, set or not.
  const atRest = (l: any) => ['base', 'ambient'].includes(info(String(l?.use ?? '')).category ?? '');
  for (const c of Object.values(m.custom ?? {}) as any[]) for (const d of c?.data ?? []) if (d?.dataset) named.add(d.dataset);
  const tw = Number(m.table?.width_cm), th = Number(m.table?.height_cm), ew = Number(m.extent?.width_m), eh = Number(m.extent?.height_m);
  let margin: SiteSignals['margin'] = null;
  if (tw > 0 && th > 0 && ew > 0 && eh > 0) {
    const t = tw / th, e = ew / eh;
    if (Math.abs(t - e) / t > 0.03) margin = { sides: e > t ? 'top and bottom' : 'left and right', share: Math.round(Math.abs(1 - Math.min(t, e) / Math.max(t, e)) * 100) };
  }
  const languages = Array.isArray(m.branding?.languages) ? m.branding.languages.length : 0;
  const steps = scene.some((l) => l?.steps?.sequence?.length);
  return {
    data,
    layers,
    buttons: scene.filter((l) => !atRest(l) && !l?.button?.hidden).map((l) => ({ id: l.id, use: l.use })),
    restLife: scene.filter((l) => atRest(l) && l?.active !== false && l?.use !== 'basemap').length,
    unusedData: Object.keys(m.data ?? {}).filter((d) => !named.has(d)),
    steps,
    stepNotes: scene.some((l) => l?.steps?.sequence?.some((s: any) => s?.notes)),
    languages,
    welcome: Boolean(m.branding?.welcome),
    logo: Boolean(m.branding?.logo),
    palette: Boolean(m.palette),
    ribbons: Boolean(m.table?.ribbons),
    glow: Boolean(m.table?.glow && m.table.glow.on !== false),
    margin,
  };
}

/** A tool call that switches a feature on, or what a person does when nothing needs setting. */
export type Enable = { tool: string; arguments: Record<string, unknown> } | { how: string };

export interface FeatureCard {
  id: string;
  name: string;
  /** What it does, in one sentence. */
  what: string;
  /** When it helps, in the words people use for their idea. */
  when: string[];
  needs: string[];
  enable: Enable;
  status: CapabilityStatus;
  /** site.json settings it covers, for check-docs. */
  covers: string[];
  issue?: number;
  /** Already on for this table. */
  on: (s: SiteSignals) => boolean;
  /** Why it fits this table, or null when the table says nothing either way. */
  fits: (s: SiteSignals) => string | null;
}

const SITE = '<site>';
const ANALYSIS_WITH_RIBBON = ['sunlight', 'stormwater'];

/** Table and app features. Layers get their cards from layer.json (layerCards). */
export const FEATURE_CARDS: FeatureCard[] = [
  {
    id: 'feature:ambient-glow', name: 'Ambient glow in the margin', status: 'available', issue: 476, covers: ['table.glow'],
    what: "A soft glow in the projection's free margin, taken from the model's own colours, so the model sits in light instead of a black frame.",
    when: ['an exhibition or lobby table that should look finished', 'atmosphere', 'beautiful', 'frame the model'],
    needs: ['A projector that lights more than the model'],
    enable: { tool: 'update_site', arguments: { site: SITE, set: { table: { glow: { on: true, strength: 0.5, colours: 'edges' } } } } },
    on: (s) => s.glow,
    fits: (s) => (s.margin ? `the model leaves the ${s.margin.sides} of the projection free (about ${s.margin.share}%), which would glow instead of staying black` : null),
  },
  {
    id: 'site:ribbons', name: 'Table ribbons', status: 'available', covers: ['table.ribbons', 'table.front'],
    what: "At-a-glance strips (time, sun height, rain so far) in the projection's free margin beside the model, filled by the open layer.",
    when: ['numbers people can read at the table', 'time of day', 'how much rain', 'margin', 'blank space around the model'],
    needs: ['A projector that lights more than the model; table.front says where visitors stand'],
    enable: { tool: 'update_site', arguments: { site: SITE, set: { table: { front: 'bottom', ribbons: { bottom: 'auto' } } } } },
    on: (s) => s.ribbons,
    fits: (s) => {
      const has = ANALYSIS_WITH_RIBBON.filter((l) => s.layers.has(l));
      if (s.margin && has.length) return `the model leaves the ${s.margin.sides} free, and ${has.join(' and ')} can show its numbers there`;
      if (has.length) return `${has.join(' and ')} on this table can show its numbers in the projector's margin`;
      return s.margin ? `the model leaves the ${s.margin.sides} of the projection free` : null;
    },
  },
  {
    id: 'site:languages', name: 'Languages for visitors', status: 'available', covers: ['branding.languages', 'branding.translations'],
    what: 'Visitors switch the controller and phones between English and Swedish; the table\'s own words are translated once.',
    when: ['public', 'visitors', 'residents', 'tourists', 'museum', 'exhibition', 'Swedish', 'international'],
    needs: ['The table\'s own words translated (title, welcome, button names, slide titles)'],
    enable: { tool: 'update_site', arguments: { site: SITE, set: { branding: { languages: ['en', 'sv'], translations: { sv: { '<English text>': '<Swedish>' } } } } } },
    on: (s) => s.languages > 1,
    fits: (s) => (s.buttons.length ? 'visitors read every button and step on the controller, and today it speaks one language' : null),
  },
  {
    id: 'site:branding', name: 'Title, welcome line and logo', status: 'available', covers: ['branding.title', 'branding.welcome', 'branding.logo'],
    what: "The table's title and a welcome line on the controller's home screen, with a logo there and on phones.",
    when: ['welcome', 'first impression', 'brand', 'logo', 'name of the project', 'exhibition'],
    needs: ['A logo picture in the site (add_media) if there is one'],
    enable: { tool: 'update_site', arguments: { site: SITE, set: { branding: { title: '<title>', welcome: '<one line that invites people in>' } } } },
    on: (s) => s.welcome && s.logo,
    fits: (s) => (!s.welcome ? 'the controller greets visitors with a default sentence; one line in your words says what the table is for' : !s.logo ? 'the controller shows no logo yet' : null),
  },
  {
    id: 'site:palette', name: 'Table palette', status: 'available', covers: ['palette'],
    what: 'One colour set for every layer, tuned for projection; with the palette theme the controller and TV follow it.',
    when: ['brand colours', 'colour', 'theme', 'identity', 'warm', 'calm', 'consistent look'],
    needs: [],
    enable: { tool: 'update_site', arguments: { site: SITE, set: { palette: { set: 'ember' }, tv: { theme_name: 'palette' } } } },
    on: (s) => s.palette,
    fits: (s) => (s.layers.size >= 4 ? `${s.layers.size} layers share the table; one palette keeps them reading as one story` : null),
  },
  {
    id: 'site:steps-notes', name: 'A guided tour with presenter notes', status: 'available', covers: [],
    what: 'A sequence of layers stepped with Next, with notes for the guide on their own phone (/guide), never on the table.',
    when: ['tour', 'presentation', 'story', 'workshop', 'guide', 'presenter', 'talk', 'pitch'],
    needs: ['Two or more layers to step through'],
    enable: { tool: 'set_steps', arguments: { site: SITE, id: '<slideshow id>', steps: { mode: 'manual', sequence: [{ layer: '<layer id>', title: '<step title>', notes: '<what the guide says>' }] } } },
    on: (s) => s.steps && s.stepNotes,
    fits: (s) => (s.steps && !s.stepNotes ? "the tour has no notes yet; they show on the guide's phone" : s.buttons.length >= 3 && !s.steps ? `${s.buttons.length} layers could become a story the guide steps through` : null),
  },
  {
    id: 'site:items', name: 'Layers inside a layer', status: 'available', covers: [],
    what: 'A layer that comes on only while another is open, such as trams inside a sun study or field walk spots under an X-ray glass.',
    when: ['context', 'together', 'combine', 'inside', 'while', 'layered'],
    needs: [],
    enable: { tool: 'add_layer', arguments: { site: SITE, use: '<layer>', parent: '<open layer id>' } },
    on: () => false,
    fits: (s) => (s.buttons.length && s.restLife ? 'the map at rest pauses while a layer is open; a copy inside that layer keeps the life it needs' : null),
  },
  {
    id: 'feature:two-layers', name: 'Two layers at once', status: 'available', covers: [],
    what: 'Visitors hold a second layer button until the ring closes (or Shift-click it) to lay it over the open one, such as Wind over Sunlight.',
    when: ['compare', 'combine', 'overlay', 'together', 'at the same time', 'relationship between'],
    needs: ['Two layers with buttons'],
    enable: { how: 'Nothing to set. On the controller, hold a second layer button until its ring closes; tell the guide.' },
    on: () => false,
    fits: (s) => (s.buttons.length >= 2 ? `visitors can lay ${s.buttons.at(-1)!.id} over ${s.buttons.at(-2)!.id} by holding its button, instead of switching between them` : null),
  },
  {
    id: 'feature:starter-pack', name: 'Starter pack for designers', status: 'available', covers: [],
    what: "A zip of the table's basics (outline, tile grid, footprints, streets, projection area) to draw a layer on in QGIS, Illustrator, Photoshop or PowerPoint.",
    when: ['designer', 'architect', 'draw', 'drawing', 'illustrator', 'photoshop', 'powerpoint', 'qgis', 'sketch a proposal', 'students'],
    needs: [],
    enable: { tool: 'export_starter_pack', arguments: { site: SITE, out: '<table name> starter pack.zip' } },
    on: () => false,
    fits: (s) => (s.data.has('buildings') ? 'the table has footprints to draw on' : null),
  },
  {
    id: 'site:custom-layers', name: 'A layer from your own data', status: 'available', covers: ['custom'],
    what: 'A layer made from a dataset with looks, motion and a legend, with no code: colour by a column, pulse, tap for facts, step through years.',
    when: ['our data', 'survey', 'csv', 'results', 'statistics', 'map our', 'show where'],
    needs: ['The dataset in the site (import_data)'],
    enable: { tool: 'save_custom_layer', arguments: { site: SITE, id: '<id>', recipe: '<see the build_from_data prompt>' } },
    on: () => false,
    fits: (s) => (s.unusedData.length ? `${s.unusedData.slice(0, 3).map((d) => `'${d}'`).join(', ')} ${s.unusedData.length === 1 ? 'is' : 'are'} in the table but no layer shows ${s.unusedData.length === 1 ? 'it' : 'them'} yet` : null),
  },
];

/** site.json settings that are set up, not suggested; check-docs needs every other one on a card. */
export const NOT_SUGGESTED = ['format', 'id', 'name', 'origin', 'extent', 'timezone', 'table', 'scene', 'data', 'basemap', 'layers', 'services', 'display', 'tv', 'branding', 'table.width_cm', 'table.height_cm', 'table.tile_cm', 'table.intro'];

/** Layers no one would pick for an idea: the base map is always there, the demo is a demo. */
const NOT_LAYER_CARDS = new Set(['basemap', 'blocks-demo']);

/** Cards for layers, generated from their capability (layer.json: description, about, requires). */
export function layerCards(caps: Capability[]): FeatureCard[] {
  return caps
    .filter((c) => c.kind === 'layer' && c.use && !c.id.startsWith('planned:') && !NOT_LAYER_CARDS.has(c.use) && c.status !== 'planned')
    .map((c) => {
      const use = c.use!;
      const data = c.requires.filter((r) => r.kind === 'data').map((r) => r.what);
      const ambient = /no button/.test(c.surfaces.controller ?? '');
      const pairs = c.pairs_with.map((p) => p.replace(/^layer:/, ''));
      return {
        id: c.id,
        name: c.name,
        what: c.summary,
        when: [c.purpose ?? '', ...c.questions],
        needs: c.requires.map((r) => `${r.what}: ${r.how}`),
        enable: { tool: 'add_layer', arguments: { site: SITE, use, ...(ambient ? { active: true } : {}) } },
        status: c.status,
        covers: [],
        on: (s: SiteSignals) => s.layers.has(use),
        fits: (s: SiteSignals) => {
          const paired = pairs.filter((p) => s.layers.has(p));
          if (paired.length) return `it pairs with ${paired.join(' and ')}, already on this table`;
          if (ambient && !s.restLife) return `nothing moves on the map at rest yet; ${c.name.toLowerCase()} gives it life while nobody touches the controller`;
          if (data.length && data.every((d) => s.data.has(d))) return `the table already has the ${data.join(' and ')} it reads`;
          return null;
        },
      } satisfies FeatureCard;
    });
}

/** Words in nearly every idea that say nothing about which feature fits ("the new tram line"). */
const GENERIC = /\b(new|line|lines|map|maps|table|layer|layers|show|shows|thing|things|place|area)\b/gi;

export interface Suggestion {
  id: string;
  name: string;
  what: string;
  /** One line: why it fits this idea and this table. */
  reason: string;
  status: CapabilityStatus;
  needs: string[];
  enable: Enable;
  issue?: number;
}

/**
 * The cards that fit a goal and a table, best first. A card scores for the person's words (as in
 * find_capabilities) and for what the table says (fits); one that is already on is left out.
 * Planned cards come back separately, as coming.
 */
export function suggest(cards: FeatureCard[], goal: string, signals: SiteSignals | null, site: string | null, limit = 5): { suggestions: Suggestion[]; coming: Suggestion[] } {
  const asCaps = cards.map((c) => ({ c, cap: { id: c.id, kind: 'site', name: c.name, summary: c.what, status: c.status, purpose: c.when.join('. '), questions: [], surfaces: {}, interactions: [], requires: [], uses: [], pairs_with: [], limitations: [], examples: [], evidence: [], issues: [] } as Capability }));
  const asked = goal.replace(GENERIC, ' ');
  const byWords = new Map(asked.trim() ? rank(asCaps.map((x) => x.cap), asked).map((m) => [m.capability.id, m]) : []);
  const scored = asCaps
    .filter(({ c }) => !signals || !c.on(signals))
    .map(({ c }) => {
      const words = byWords.get(c.id);
      const fit = signals ? c.fits(signals) : null;
      const score = (words?.score ?? 0) + (fit ? 3 : 0);
      const said = words ? [...new Set(words.why.map((w) => w.split('→')[0]))].slice(0, 3).join(', ') : '';
      const reason = [said ? `you mentioned ${said}` : '', fit ?? ''].filter(Boolean).join('; ');
      return { c, score, reason, words: Boolean(words), fit: Boolean(fit) };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || Number(b.fit) - Number(a.fit));
  // Layers that fit only for the same kind of table reason (all pair with Sunlight, all bring life
  // at rest) show one each, so the person sees a spread rather than five of a kind.
  const kinds = new Set<string>();
  const kept = scored.filter((x) => {
    if (x.words || !x.c.id.startsWith('layer:')) return true;
    const kind = x.reason.split(' ').slice(0, 3).join(' ');
    if (kinds.has(kind)) return false;
    kinds.add(kind);
    return true;
  });
  const fill = (x: (typeof scored)[number]): Suggestion => ({
    id: x.c.id,
    name: x.c.name,
    what: x.c.what,
    reason: x.reason.charAt(0).toUpperCase() + x.reason.slice(1),
    status: x.c.status,
    needs: x.c.needs,
    enable: 'tool' in x.c.enable && site ? { tool: x.c.enable.tool, arguments: JSON.parse(JSON.stringify(x.c.enable.arguments).replaceAll(`"${SITE}"`, JSON.stringify(site))) } : x.c.enable,
    ...(x.c.issue ? { issue: x.c.issue } : {}),
  });
  return {
    suggestions: kept.filter((x) => x.c.status !== 'planned').slice(0, limit).map(fill),
    coming: kept.filter((x) => x.c.status === 'planned').slice(0, 2).map(fill),
  };
}
