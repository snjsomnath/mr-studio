// The playbooks the server gives an LLM: short server instructions sent on connect, and
// prompts for the four jobs people bring to it.

import type { Catalog } from './core.ts';

export function serverInstructions(catalog: Catalog): string {
  return `MR Studio puts a real place on a projected physical table; a controller (a TV or touch screen) holds the words and controls, and phones join from any network.
The table is seen from above and drawn in 2D: no extrusion or 3D camera. Keep it clean and mostly visual; words belong on the controller and phones.
This server (core ${catalog.version}) helps assemble MR Studio projects without writing code.

A project is a site package: a folder with site.json, data/ and requests/. The scene is the ordered "layers" list in site.json, bottom to top, each entry a core layer with params. The app ships the engine, kernels and layers; a team's repository holds only its site.

Rules:
1. Design the experience first, then build from what exists. Read mrstudio://concepts (the three surfaces, what goes where, the patterns) and call find_capabilities with the person's goal before proposing anything; describe_layer before setting params. A capability's status comes from the code: available can be used now, needs_setup needs the data or service it names, planned and unsupported are development requests, never something to configure. Never invent layer ids, controls, kernels or site.json keys.
2. Configure, do not code. Do not write layer modules, TypeScript, kernels or copies of core files into a site. When something is missing, run check_layer_idea and then draft_module_request; the core team builds it once for everyone.
3. Edit sites only through the tools (create_site, update_site, add_layer, set_layer, move_layer, remove_layer). They validate every change against the contracts. Finish with validate_site.
4. Submit a module request (submit_module_request) only after the person has read the draft and said yes; it opens a public GitHub issue.
5. Contracts are in read_doc: architecture, roadmap, contracts/site, contracts/layer and the rest. Quote them rather than guess.
6. What changed recently is in whats_new (the changelog, newest first). Check it when someone asks for something that may have just been built.

Prompts: new_project, brainstorm_layer, design_dashboard, request_module.`;
}

export function newProjectPrompt(place?: string, purpose?: string): string {
  return `Help me put together a new MR Studio project${place ? ` for ${place}` : ''}${purpose ? `, for ${purpose}` : ''}.

Work through these steps, one short question at a time, and act with the tools as soon as you have enough:

1. The story. Ask who stands around the table and what they should understand or decide. One or two sentences is enough; everything else follows from it.
2. The place. Agree the centre point (lon, lat in WGS84), the area the table shows in metres, and its rotation (bearing of the table's top edge, clockwise from north). Match the area's aspect ratio to the physical table. Ask the time zone. Then call create_site.
3. The scene. Call list_layers. Pick the layers that tell the story and order them bottom to top: base and ambient layers first, analysis layers above. For each, call describe_layer and set params that frame the story (a date and hour for the sun, for example), and decide which start active. Use add_layer and set_layer.
4. The data. Explain what the site folder needs (building footprints as GeoJSON in WGS84 with a height property, optional terrain and trees) and update scene paths with update_site once files are in data/. If the person has no data yet, the site still runs on a flat area.
5. The look and the welcome. With update_site: branding (title, logo inside the site folder, and the welcome line under the title on the controller's home screen), the basemap (style, black and white, brightness), the table's palette, and display quality. The controller's home screen loops through the layers by itself while nobody touches it (the attract loop) and returns home after a quiet spell; each layer's button (name, icon, side, group) is set with set_layer. Read contracts/site to see what a site can configure today. If they want something the contract does not offer, do not add unknown keys; capture it with draft_module_request, kind "contract".
6. The table's edges. Set table.front (the side visitors stand at) and, if the projector covers more than the model, table.ribbons: at-a-glance strips in the blank space on any side.
7. Languages. If visitors speak more than one language, set branding.languages (["en", "sv"]; the first is where the table starts) and translate the site's own words (title, welcome line, button names, slide titles) in branding.translations.
8. A guided tour. If someone will present, make a slideshow of layers with set_steps and give each step notes: they show on the guide's phone and in the editor, never on the table.
9. The TV. Follow the design_dashboard prompt for what the TV shows.
10. Ideas that do not fit. For any layer idea no core layer covers, follow brainstorm_layer. Many looks need no new code: a custom layer (save_custom_layer) combines data, look, motion and interaction blocks.
11. Check. Run validate_site, fix every error, and tell me how to preview it (preview_site). Keys for live data (Västtrafik, Lantmäteriet, Mapbox and the like) are set up in the app under Sources and keys, never in site.json.

Keep the person's words in names and titles. Explain choices in a line each, not in essays.`;
}

export function brainstormPrompt(idea?: string): string {
  return `Brainstorm a new MR Studio layer with me${idea ? `: "${idea}"` : ''}.

MR Studio layers are short compositions of shared building blocks: kernels in the engine compute (sunlight, wind, stormwater), visual blocks draw (field overlays, particles, marks and arrows, animated paths, choropleths, place motions, ribbons), data blocks feed (site scene, datasets, live feeds, point questions to a kernel, street network, thermal comfort, isovist) and interaction blocks let people steer (generated controls, time control, phone tools, table pointer, sound, languages, guided tours). A new layer should be mostly reuse, and a custom layer (save_custom_layer) often needs no core change at all. Everything on the table is 2D, seen from above.

1. Understand the idea: what question does it answer at the table, for whom, and what do people do with it (watch, scrub time, place things, compare scenarios)?
2. Call list_layers, list_building_blocks and read_doc "roadmap". Offer two or three ways to realise the idea, each named in terms of existing layers, kernels and blocks. Prefer the version that reuses most. Say which roadmap items it is close to.
3. Sketch the layer as data: its name, the controls it would have (types: range, select, toggle, date, color, text, action; mark the ones phones may change), its tools (point, line, polygon), the kernels and blocks it needs, the site data it reads, and any TV panels.
4. Call check_layer_idea with that sketch. It answers one of:
   - use-existing: configure that layer in the scene with add_layer and set_layer. Done, no request needed.
   - compose-from-blocks: everything exists but no layer composes it. Draft a module request of kind "layer" with the sketched layer.json as the example.
   - needs-new-module: blocks or kernels are missing. Draft a module request of kind "block" or "kernel" naming them and the layer they unlock.
5. Show me the draft and its link. Submit it only if I say so.

Do not write layer code, shaders or solver code in the project, and do not suggest forking MR Studio. Requests go to the core so every team benefits.`;
}

export function dashboardPrompt(site?: string, catalog?: Catalog): string {
  const hasDashboard = Boolean(catalog?.docs['contracts/dashboard']);
  return `Design what the TV shows for ${site ? `the site at ${site}` : 'this MR Studio site'}.

The TV is where people steer the table and read results. ${
    hasDashboard
      ? 'Read read_doc "contracts/dashboard" and "dashboard" first: panels sit on a 12 by 6 grid, come in fixed sizes, and a screen has a density budget (reads and panel count). Layers bring their own panels; a site may arrange pages in site.json "tv" (rail, theme tokens, rotate_s, pages).'
      : 'In this core the TV generates a control card for each active layer from its layer.json controls, and a layer may add its own panel. Read read_doc "contracts/layer" and "contracts/site"; site.json "tv" is reserved for dashboard configuration, so check the docs before writing to it.'
  }

1. Ask what the audience should take away in ten seconds of looking. That decides the two or three numbers or charts that matter.
2. List the active layers (get_site) and what each already shows on the TV (describe_layer: controls, panels).
3. Propose a layout using only existing widgets and panel sizes. Keep within the budget; put extra content on a second page rather than shrinking it.
4. Write it with update_site ("tv" section) and run validate_site.
5. A widget, binding or chart the core lacks becomes a module request (kind "block" or "contract"), not custom code.`;
}

export function requestPrompt(need?: string): string {
  return `Write a module request for the MR Studio core${need ? ` for: "${need}"` : ''}.

1. Check it is really missing: list_layers, list_building_blocks, read_doc "roadmap", and check_layer_idea. If an existing layer or param covers it, say so and stop.
2. Pick the kind: layer-change (a control or option on an existing layer), layer (a new layer from existing blocks), block (a shared visual, data or interaction primitive), kernel (engine computation), contract (site.json, TV, protocol, CLI), or promote (a team's layer moved into core).
3. Write it for the core maintainers: the goal in the person's words, why existing pieces fall short, a proposal in terms of reusable blocks (principle 7: building blocks before ports, and a block earns its place when a second layer can use it), what it reuses, what is missing, and an example configuration (the layer.json or site.json fragment the team would write once it exists).
4. Call draft_module_request. Show the person the draft path and the link. Call submit_module_request only after they agree.`;
}
