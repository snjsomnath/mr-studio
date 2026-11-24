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
2. Configure before you code. Layers, custom layer recipes (save_custom_layer) and slideshows cover most ideas. A site code layer (create_layer, sdk_reference, check_layer, build_layer) is for behaviour nothing else gives, built with a developer who wants code; never copy core files or kernels into a site. When the core itself is missing something, check it with assess_experience, look for an existing issue with find_related_issues, then draft_development_request; the core team builds it once for everyone.
3. Edit sites only through the tools (create_site, update_site, add_layer, set_layer, move_layer, remove_layer). They validate every change against the contracts. Finish with validate_site.
4. Send development requests (submit_development_request) only after the person has read the drafts and said yes; one yes may cover a batch. They open public GitHub issues.
5. Contracts are in read_doc: architecture, roadmap, contracts/site, contracts/layer and the rest. Quote them rather than guess.
6. What changed recently is in whats_new (the changelog, newest first). Check it when someone asks for something that may have just been built.

Prompts: design_experience, plan_workshop, compare_scenarios, build_from_data, new_project, build_code_layer, build_controller_app, brainstorm_layer, design_dashboard, request_module.`;
}

export function newProjectPrompt(place?: string, purpose?: string): string {
  return `Help me put together a new MR Studio project${place ? ` for ${place}` : ''}${purpose ? `, for ${purpose}` : ''}.

Work through these steps, one short question at a time, and act with the tools as soon as you have enough:

1. The story. Ask who stands around the table and what they should understand or decide. One or two sentences is enough; everything else follows from it. Design the experience before the scene: read mrstudio://concepts, call find_capabilities with that goal, write it as an experience plan and check it with assess_experience (the design_experience prompt walks through this); build_experience then writes steps 3 and 8 for you.
2. The place. Agree the centre point (lon, lat in WGS84), the area the table shows in metres, and its rotation (bearing of the table's top edge, clockwise from north). Match the area's aspect ratio to the physical table. Ask the time zone. Then call create_site.
3. The scene. Call list_layers. Pick the layers that tell the story and order them bottom to top: base and ambient layers first, analysis layers above. For each, call describe_layer and set params that frame the story (a date and hour for the sun, for example), and decide which start active. Use add_layer and set_layer.
4. The data. Ask for the team's files and bring them in with import_data (it checks them like the editor's Add data, reprojects, and points site.json at them; check first, then write). Buildings, trees and streets can come from OpenStreetMap and the ground from free elevation (source osm or elevation). Pictures and sounds go in with add_media and add_sound; list_site_files shows what is there. If the person has no data yet, the site still runs on a flat area.
5. The look and the welcome. With update_site: branding (title, logo inside the site folder, and the welcome line under the title on the controller's home screen), the basemap (style, black and white, brightness), the table's palette, and display quality. The controller's home screen loops through the layers by itself while nobody touches it (the attract loop) and returns home after a quiet spell; each layer's button (name, icon, side, group) is set with set_layer. Read contracts/site to see what a site can configure today. If they want something the contract does not offer, do not add unknown keys; capture it with draft_development_request, kind "site-setting".
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

1. Check it is really missing: find_capabilities and assess_experience. If an existing layer or param covers it, say so and stop. Then find_related_issues: if an issue already asks for it, point the person there and stop.
2. Pick the kind: layer-change (a control or option on an existing layer), layer (a new layer from existing blocks), block (a shared visual, data or interaction primitive), kernel (engine computation), contract (site.json, TV, protocol, CLI), or promote (a team's layer moved into core).
3. Write it for the core maintainers: the goal in the person's words, why existing pieces fall short, a proposal in terms of reusable blocks (principle 7: building blocks before ports, and a block earns its place when a second layer can use it), what it reuses, what is missing, and an example configuration (the layer.json or site.json fragment the team would write once it exists).
4. Call draft_development_request with a user story, the experience on the table, controller and phones, and acceptance criteria. Show the person the draft path and the link. Call submit_development_request only after they agree.`;
}

const DESIGN_RULES = `How to design for MR Studio:
- Read mrstudio://concepts first: the table (2D, seen from above, almost no text), the controller (words, controls, legends, step titles) and phones (a few controls, placing points, routes and areas; the guide's notes). Read the patterns (mrstudio://patterns/<id>) and pick the one or two that fit.
- Call find_capabilities with the person's goal in their words. Use what is available; name what needs setup (data, keys, services); treat planned and unsupported as development, never as settings.
- Write the experience as a plan: title, goal, audience, and 3 to 8 steps. Each step says what the table shows, what the controller says, what phones do, and what the guide says (notes). Add layers at rest and other needs.
- Call assess_experience. Show the person the plan and the verdict in a few lines: what works now, what needs setup, and each gap.
- With their yes, call build_experience on their site (create_site first if there is none), then validate_site and preview_site.
- For each gap, look for an existing issue (find_related_issues); if one asks for it, point the person to it instead. Otherwise draft a development request (draft_development_request with the kind assess_experience gave, a user story and acceptance criteria). Show the drafts; send them with submit_development_request only after the person says yes, and one yes may cover the batch.`;

export function designExperiencePrompt(goal?: string, place?: string, audience?: string): string {
  return `Design an MR Studio experience with me${goal ? ` so that ${goal}` : ''}${place ? `, at ${place}` : ''}${audience ? `, for ${audience}` : ''}.

Start by asking, one short question at a time, only what you cannot infer: who stands around the table, what they should leave understanding or having said, how long they have, and whether a guide presents. Then propose one experience (not three), in the person's words.

${DESIGN_RULES}`;
}

export function planWorkshopPrompt(topic?: string, minutes?: string, participants?: string): string {
  return `Plan a workshop at the MR Studio table${topic ? ` about ${topic}` : ''}${minutes ? `, ${minutes} minutes long` : ''}${participants ? `, for ${participants}` : ''}.

A workshop is a guided story with moments where people contribute. Shape it as: an opening that shows the place today (at rest: ambient life), two to four steps that each answer one question (a simulation, a comparison, a view), a contribution step where people place points, draw routes or areas from their phones (pattern map-it-together), and a closing step that shows what the group made. Give each step a time, a question the guide asks (notes) and what the controller says.

${DESIGN_RULES}`;
}

export function compareScenariosPrompt(today?: string, proposal?: string): string {
  return `Design a comparison of two scenarios at the MR Studio table${today ? `: today is ${today}` : ''}${proposal ? `, the proposal is ${proposal}` : ''}.

The table shows one layer at a time, so comparison is built from a reveal line (swipe), a magnifier (lens), a plan revealed phase by phase (plan), or a sequence that shows the same question twice (sun at 3 pm today, then with the proposal). Read mrstudio://patterns/compare-existing-proposed. Ask which question matters most (sun, wind, water, views, movement) and what data exists for each scenario. Each scenario is data in the site: name the files the person must bring.

${DESIGN_RULES}`;
}

export function buildFromDataPrompt(data?: string): string {
  return `Make an MR Studio experience from data${data ? `: ${data}` : ''}.

1. Ask what the data is (points, lines, areas; which columns), where it is, and what story it should tell. GeoJSON in WGS84 or a CSV with lon and lat columns goes into the site's data/ folder.
2. Read mrstudio://patterns/data-story and mrstudio://schema/recipe. Most datasets need no code: a custom layer (save_custom_layer) colours areas by a column, pulses places by a weight, flows along lines, and reveals things over time. The legend is worked out from the data. A WMS map is shown with the wms layer.
3. Decide what the table shows (one look, at most two) and what the controller explains (legend, a control bound to the recipe), then save the custom layer and use it as a step (use "custom:<id>") in an experience plan.

${DESIGN_RULES}`;
}

/** A team's own code layer (#284): blocks first, code last. */
export function buildCodeLayerPrompt(idea?: string): string {
  return `Build an MR Studio site layer with its own code${idea ? ` for: "${idea}"` : ''}, the way a layer like ECOM is built: blocks first, code last.

1. Make sure code is needed. find_capabilities and assess_experience with the idea; if an existing layer, a custom layer recipe (save_custom_layer) or a slideshow does it, build that and stop. Code is for behaviour: a model behind the table, an interaction no layer has, a controller panel of its own.
2. Plan the three surfaces before any code (read mrstudio://concepts): what the table shows (visual, almost no text), what the controller does (layer buttons, the layer's controls, panels within the TV's density budget) and what phones do. Read docs/contracts/layer.md, "Site layers".
3. If a model computes the answer (Python, an optimiser), put it behind a service: add_service with its folder and command (or url), then requires.services in layer.json and ctx.service(id).job(...) in the code, publishing 'busy' while it runs. The host caches the last answers for when it is down.
4. create_layer, then look up every API with sdk_reference before using it (defineLayer, TableContext, PanelContext, ctx.publish, ctx.pointer, ctx.sendTool, ctx.service, the drawing blocks). Write against what it returns; something the SDK lacks is a development request of kind sdk-runtime (draft_development_request), never a copy of core code.
5. Put every place and number that belongs to this table in the site's data or the layer's params, never in code. Give every word people see a Swedish line in locales/sv.json.
6. check_layer until it passes, build_layer, add_layer with use "./layers/<id>", validate_site, then preview_layer and look at /dev with the person.

${DESIGN_RULES}`;
}

/** A custom map app on the controller (#284), such as a picker or a mini map that drives the table. */
export function buildControllerAppPrompt(idea?: string): string {
  return `Build a controller map app for MR Studio${idea ? `: "${idea}"` : ''}: something people do on the controller's screen that changes the table.

1. Check what exists first: find_capabilities with "controller map", "stage", "tools", "picker". The controller already has the layer's controls, tools that place points, lines and areas on the table, and a stage per layer (docs/contracts/layer.md, "The controller stage" and "Tools"). Use them when they fit.
2. Design it as the controller's centre: big touch targets, words on the controller and not on the table, one task at a time. The table answers visually.
3. If it needs code: create_layer, then sdk_reference for controllerMap, stage(), PanelContext and ctx.sendTool. Inputs go through the host (ctx.sendTool, ctx.publish), so the table, TV and phones agree; never message a surface directly.
4. check_layer (density budget, Swedish words, no site coordinates), build_layer, add_layer, preview_layer and try it in /dev.
5. A missing SDK piece is a development request of kind sdk-runtime or interaction, after find_related_issues.

${DESIGN_RULES}`;
}
