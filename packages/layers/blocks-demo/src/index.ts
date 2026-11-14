// A demonstration, not a product layer: two scenes assembled only from the SDK's
// building blocks, on the synthetic `sites/blocks` data. "Places that pull" is the
// shape of Cultural Gravity and "Energy community" the shape of ECOM. Read it as the
// worked example for docs/blocks.md.
import {
  Agent,
  Clock,
  Dwell,
  Lens,
  PerPointer,
  Probe,
  Sequence,
  Swarm,
  aroundRing,
  bars,
  canvasSurface,
  categoryScale,
  colour,
  csvSource,
  defineLayer,
  drawAreas,
  drawDots,
  drawGlow,
  drawLabel,
  drawLens,
  drawPaths,
  drawRings,
  drawSpots,
  formatHour,
  fromToolInput,
  geojsonSource,
  gravityField,
  joinRows,
  keepOnTable,
  levelScale,
  nodePulse,
  particleAlpha,
  pathHeads,
  pickWeighted,
  pointerRouter,
  pullTowards,
  readShapes,
  sampleSeries,
  sharedPeak,
  siteRaster,
  stagger,
  stat,
  tableFrame,
  timeline,
  twoColourScale,
} from '@mrstudio/sdk';
import type { Area, Behaviour, Colormap, Hit, LayerManifest, Path, PointerSample, Rgba, Shapes, Spot, TableFrame, View } from '@mrstudio/sdk';

import manifest from '../layer.json';

interface Params {
  scene: 'gravity' | 'energy';
  hour: number;
  play: boolean;
  pointer: 'probe' | 'people' | 'magnifier' | 'xray';
}

/** What both scenes offer, so the lens and the probe work on either. */
interface Scene {
  step(dt: number): void;
  draw(view: View): void;
  shapes(): Partial<Shapes>;
  describe(hit: Hit): string;
}

const WHITE: Rgba = [255, 255, 255, 1];
const data = (name: string) => `/site/data/${name}`;

// ---- Scene one: places that pull a crowd ------------------------------------

const KIND = categoryScale({
  landmark: '#ff453a', theatre: '#af52de', heritage: '#ff9f0a', education: '#30b0c7',
  studio: '#ff375f', nature: '#32d74b', community: '#ffd60a', art: '#5e5ce6',
});
const PULL: Colormap = { stops: [[0, 20, 10, 60, 0], [0.45, 70, 30, 140, 70], [1, 255, 190, 120, 150]] };
const WELL_M = 110;

function gravityScene(places: Spot[], sequence: Sequence): Scene {
  const swarm = new Swarm({
    max: 600,
    spawnRate: 260,
    spawn: (random) => {
      const place = pickWeighted(places.map((p) => ({ ...p, weight: p.properties.weight as number })), random);
      if (!place) return null;
      const [x, y] = aroundRing(place.point, WELL_M * 1.6, random);
      return { x, y, lifetime: 9 + random() * 4, tag: place };
    },
    steer: pullTowards((p) => (p.tag as Spot).point, { speed: 14, radius_m: WELL_M }),
  });
  const shown = (index: number) => stagger(sequence.level('reveal'), index, places.length, 0.6);
  return {
    step(dt) {
      sequence.tick(dt);
      swarm.step(dt, sequence.level('ramp'));
    },
    draw(view) {
      places.forEach((place, index) => {
        const level = shown(index);
        if (level <= 0) return;
        const tint = KIND(place.properties.kind);
        const weight = place.properties.weight as number;
        drawGlow(view, place.point, WELL_M * weight, tint, 0.34 * level);
        drawRings(view, place.point, { colour: tint, radius_m: WELL_M * weight, direction: 0, count: 3, wobble: 0.07, level: 0.55 * level }, index * 0.13);
      });
      drawSpots(view, places, {
        show: (place) => shown(places.indexOf(place)) > 0,
        colour: (place) => KIND(place.properties.kind),
        radius: (place) => 6.5 * place.properties.weight,
        halo: 18,
        core: 0.35,
        label: (place) => place.properties.name,
      });
      drawDots(view, swarm.particles.map((p) => ({ point: [p.x, p.y] as const, colour: KIND((p.tag as Spot).properties.kind), alpha: particleAlpha(p) * 0.95, size: 2.2 })));
    },
    shapes: () => ({ spots: places }),
    describe: (hit) => `${hit.shape.properties.name} · ${hit.shape.properties.kind} · pull ${hit.shape.properties.weight}`,
  };
}

// ---- Scene two: an energy community over a day --------------------------------

const ENERGY = categoryScale({ building: '#ff00a6', pv: '#eaff00', grid: '#00ffe5', battery: '#fa3600' });
const HOURS = Array.from({ length: 24 }, (_, h) => `h${String(h).padStart(2, '0')}`);

function energyScene(buildings: Area[], nodes: Spot[], flows: Path[], clock: Clock): Scene & { readouts(): Record<string, unknown> } {
  const members = buildings.filter((b) => b.properties.h00 !== undefined);
  for (const member of members) member.properties.demand = HOURS.map((h) => Number(member.properties[h]) || 0);
  const demandOf = (b: Area) => sampleSeries(b.properties.demand, clock.position, { wrap: true });
  // Every member is shaded against the busiest building-hour of the whole community.
  const demandLevel = levelScale({ domain: [0, sharedPeak(members.map((b) => b.properties.demand))], curve: 'sqrt', floor: 0.35 });
  const demandColour = twoColourScale('#2a0b23', ENERGY('building'));

  const links = flows.map((f) => ({ source: f.properties.source as string, target: f.properties.target as string, values: f.properties.flow_hourly as number[] }));
  const flowPeak = sharedPeak(links.map((l) => l.values));
  const flowNow = (f: Path) => sampleSeries(f.properties.flow_hourly, clock.position, { wrap: true });
  const hubs = nodes.filter((n) => n.properties.kind === 'grid' || n.properties.kind === 'battery');
  const roofs = nodes.filter((n) => n.properties.solar_hourly?.some((v: number) => v > 0));
  const solarPeak = sharedPeak(roofs.map((n) => n.properties.solar_hourly));
  const battery = nodes.find((n) => n.properties.kind === 'battery');
  const host = buildings.find((b) => b.id === battery?.properties.host);
  // What the battery holds: charged by what flows in, emptied by what flows out, as a share of its fullest hour.
  const stored = (() => {
    let level = 0;
    const series = Array.from({ length: 24 }, (_, h) => (level = Math.max(0, level - links.reduce((net, l) => net + (l.source === 'battery' ? l.values[h]! : l.target === 'battery' ? -l.values[h]! : 0), 0))));
    const peak = Math.max(1, ...series);
    return series.map((v) => v / peak);
  })();

  return {
    step(dt) {
      clock.tick(dt);
    },
    draw(view) {
      drawAreas(view, buildings, {
        fill: (b) => (b.properties.demand ? demandColour(demandLevel(demandOf(b))) : null),
        stroke: (b) => (b.properties.demand ? [255, 0, 166, 0.9] : [255, 255, 255, 0.12]),
        levelFill: (b) => (b === host ? ENERGY('battery') : null),
        level: () => sampleSeries(stored, clock.position, { wrap: true }),
      });
      for (const roof of roofs) drawGlow(view, roof.point, 45, ENERGY('pv'), 0.55 * (sampleSeries(roof.properties.solar_hourly, clock.position, { wrap: true }) / solarPeak));
      drawPaths(view, flows, {
        colour: (f) => ENERGY(f.properties.kind),
        width: (f) => (flowNow(f) > 0 ? 1 + 7 * Math.sqrt(flowNow(f) / flowPeak) : 0.6),
        glow: 3,
      });
      const heads = pathHeads(flows, view.time, { speed: 90, active: (f) => flowNow(f) > 0.5 });
      drawDots(view, heads.map((head) => ({ point: head.point, colour: ENERGY(flows[head.path]!.properties.kind), alpha: head.alpha, size: 3 + 5 * head.landing })));
      for (const hub of hubs) {
        const pulse = nodePulse(links, hub.properties.id, clock.step);
        drawRings(view, hub.point, { colour: ENERGY(hub.properties.kind), radius_m: 42, direction: pulse.direction, level: pulse.level });
      }
      drawSpots(view, hubs, { colour: (n) => ENERGY(n.properties.kind), radius: 7, core: 0.4, label: (n) => n.properties.name });
    },
    shapes: () => ({ areas: members, spots: hubs, paths: flows }),
    describe(hit) {
      const p = hit.shape.properties;
      if (hit.kind === 'area') return `${p.name} · class ${p.class} · ${Math.round(demandOf(hit.shape))} kW now${p.pv_kw ? ` · ${p.pv_kw} kW solar` : ''}`;
      if (hit.kind === 'path') return `${p.source} to ${p.target} · ${Math.round(flowNow(hit.shape))} kW`;
      return p.name;
    },
    readouts() {
      const at = (kind: string) => flows.filter((f) => f.properties.kind === kind).reduce((sum, f) => sum + flowNow(f), 0);
      const solar = roofs.reduce((sum, n) => sum + sampleSeries(n.properties.solar_hourly, clock.position, { wrap: true }), 0);
      return {
        demand: stat(members.reduce((sum, b) => sum + demandOf(b), 0), 'kW', 'Community demand now'),
        sources: bars([{ label: 'Solar', value: Math.round(solar), slot: 3 }, { label: 'Grid', value: Math.round(at('grid')), slot: 1 }, { label: 'Battery', value: Math.round(at('battery')), slot: 2 }]),
        timeline: timeline(clock),
      };
    },
  };
}

// ---- The layer ----------------------------------------------------------------

/** A person on the table: a dot, the way they face, and their reach. */
function drawPerson(view: View, agent: Agent, tint: Rgba): void {
  drawRings(view, agent.position, { colour: tint, radius_m: 30, direction: 1, level: 0.7, period: 1.8 });
  const ahead: [number, number] = [agent.position[0] + Math.cos(agent.heading) * 16, agent.position[1] + Math.sin(agent.heading) * 16];
  drawPaths(view, [{ id: 0, properties: {}, points: [agent.position, ahead], stations: [0, 16], length: 16 }], { colour: tint, width: 3 });
  drawSpots(view, [{ id: 0, point: agent.position, properties: {} }], { colour: tint, radius: 6, core: 0.4, halo: 10 });
}

async function load(frame: TableFrame, buildingsPath: string | null) {
  const [places, nodes, flows, rows, footprints] = await Promise.all([
    geojsonSource(data('places.geojson')).load(),
    geojsonSource(data('energy-nodes.geojson')).load(),
    geojsonSource(data('energy-flows.geojson')).load(),
    csvSource(data('buildings.csv')).load(),
    buildingsPath ? geojsonSource(`/site/${buildingsPath}`).load() : null,
  ]);
  const buildings = footprints ? readShapes(footprints, frame, 'id').areas : [];
  joinRows(buildings, rows, { shape: 'id', row: 'id' });
  return { places: readShapes(places, frame, 'name').spots, nodes: readShapes(nodes, frame, 'id').spots, flows: readShapes(flows, frame, 'id').paths, buildings };
}

export default defineLayer<Params>({
  manifest: manifest as LayerManifest,

  async table(ctx) {
    const frame = tableFrame(ctx.site);
    const loaded = await load(frame, ctx.site.data.buildings ?? null);
    const surface = canvasSurface(ctx.map.addElement(), frame);

    const sequence = new Sequence([{ id: 'idle' }, { id: 'reveal', seconds: 4 }, { id: 'revealed' }, { id: 'ramp', seconds: 3 }, { id: 'full' }]);
    const clock = new Clock({ span: 24, rate: 0.8, position: ctx.params.hour, playing: ctx.params.play });
    const gravity = gravityScene(loaded.places, sequence);
    const energy = energyScene(loaded.buildings, loaded.nodes, loaded.flows, clock);
    const active = () => (ctx.params.scene === 'energy' ? energy : gravity);
    const other = () => (ctx.params.scene === 'energy' ? gravity : energy);

    // The pull of all places together, as a field drawn through the same overlay a kernel uses.
    const pull = ctx.map.addField('pull', { colormap: PULL, opacity: 0 });
    pull.set(gravityField(loaded.places.map((p) => ({ point: p.point, weight: p.properties.weight })), siteRaster(ctx.site, 8), WELL_M));

    // Interactions: one sample stream, whichever behaviours the pointer mode calls for.
    let reading: string | null = null;
    let hover: Hit | null = null;
    const probe = new Probe({
      shapes: () => active().shapes(),
      tolerance_m: 14,
      onHover: (hit) => (hover = hit),
      onSelect: (hit) => ctx.publish({ reading: (reading = hit ? active().describe(hit) : null) }),
    });
    const dwell = new Dwell({ seconds: 0.8, radius_m: 12, onDwell: () => hover && ctx.publish({ reading: (reading = active().describe(hover)) }) });
    const tints = ['#7dd3fc', '#fca5a5', '#bef264', '#fcd34d', '#d8b4fe'].map(colour);
    const people = new PerPointer(
      (first) => new Agent({ position: first.point, mode: 'follow', constrain: keepOnTable(frame, 5), onMove: () => ctx.publish({ people: people.entries().length }) }),
      { keep: false },
    );
    const magnifier = new Lens({ radius_m: 70, zoom: 3 });
    const xray = new Lens({ radius_m: 110, zoom: 1 });
    const modes: Record<Params['pointer'], Behaviour> = { probe: pointerRouter([probe, dwell]), people, magnifier, xray };
    const route = (sample: PointerSample) => modes[ctx.params.pointer].handle(sample);
    ctx.pointer.on(route);

    let time = 0;
    let lastStep = -1;
    ctx.onFrame((dt) => {
      time += dt;
      active().step(dt);
      ctx.publish({ stage: sequence.stage.id });
      dwell.check(performance.now() / 1000);
      pull.setStyle({ opacity: ctx.params.scene === 'gravity' ? sequence.level('ramp') : 0 });

      const view = surface.begin(time);
      active().draw(view);
      if (ctx.params.pointer === 'probe' && hover) {
        if (hover.kind === 'area') drawAreas(view, [hover.shape], { stroke: WHITE, strokeWidth: 2.5 });
        else if (hover.kind === 'path') drawPaths(view, [hover.shape], { colour: WHITE, width: 2 });
        else drawRings(view, hover.shape.point, { colour: WHITE, radius_m: 22, direction: 0, count: 1 });
        if (reading) drawLabel(view, hover.point, reading, { size: 14 });
      }
      if (ctx.params.pointer === 'people') people.entries().forEach(([, agent], index) => drawPerson(view, agent, tints[index % tints.length]!));
      if (ctx.params.pointer === 'magnifier') drawLens(view, magnifier, (inner) => active().draw(inner));
      if (ctx.params.pointer === 'xray') drawLens(view, xray, (inner) => other().draw(inner), { rim: 'rgba(125,211,252,0.9)' });

      // Readouts go out when the picture they describe changes, not every frame.
      if (ctx.params.scene === 'energy' && clock.step !== lastStep) {
        lastStep = clock.step;
        ctx.publish({ ...energy.readouts(), clock: formatHour(clock.step) });
      }
    });
    ctx.publish({ stage: sequence.stage.id, people: 0, reading: null });

    return {
      update(changed) {
        if (changed.includes('hour')) clock.seek(ctx.params.hour);
        if (changed.includes('play')) clock.playing = ctx.params.play;
        if (changed.includes('scene') || changed.includes('pointer')) {
          hover = null;
          ctx.publish({ reading: (reading = null) });
        }
      },
      action(id) {
        if (id === 'next' && sequence.advance()) ctx.publish({ stage: sequence.stage.id });
      },
      // A phone's point tool is the same pointer as a mouse on the table.
      tool(input) {
        const sample = fromToolInput(input, frame, performance.now() / 1000);
        if (sample) route(sample);
      },
    };
  },

  panel(ctx, el) {
    el.className = 'blocks-demo-panel';
    const render = () => {
      const s = ctx.shared;
      const lines =
        ctx.params.scene === 'energy'
          ? [s.clock && `${s.clock} · ${s.demand?.value ?? '—'} ${s.demand?.unit ?? ''} ${s.demand?.caption ?? ''}`, ...(s.sources?.items ?? []).map((b: { label: string; value: number }) => `${b.label}: ${b.value} kW`)]
          : [s.stage === 'idle' ? 'Press Next step to reveal the places' : s.stage === 'revealed' ? 'Press Next step to start the crowd' : `Stage: ${s.stage ?? '…'}`];
      if (s.people) lines.push(`${s.people} pointer${s.people === 1 ? '' : 's'} walking`);
      if (s.reading) lines.push(s.reading);
      el.replaceChildren(...lines.filter(Boolean).map((line) => Object.assign(document.createElement('p'), { textContent: line })));
    };
    render();
    return { update: render };
  },
});
