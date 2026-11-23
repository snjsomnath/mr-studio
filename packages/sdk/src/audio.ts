// Sound on points (#150): a point can carry a sound file (WAV, MP3, OGG), and the table shows
// it as rings that follow the sound, like the Chalmers bird-sounds demo.
//
// The visuals never depend on hearing the sound. Each file is analysed once into a loudness
// and a brightness envelope (`analyseSound`), and the rings follow the envelope at the
// playback position. So the editor's preview, a muted table and a browser that blocks
// autoplay all show the same rings, and only the table's own speakers play the sound.

import { seeded } from './blocks/motion.ts';

/** How a sound motion plays its points' sounds. */
export interface SoundProps {
  /** The column naming each point's sound file (`blackbird.mp3`, or a path in the site folder). */
  column: string | null;
  /** One sound for every point, when there is no column. */
  file: string | null;
  /** `chorus`: a few at a time, at random, as in the bird demo. `loop`: every point, always. */
  trigger: 'chorus' | 'loop';
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
}
export const SOUND_DEFAULTS: SoundProps = { column: null, file: null, trigger: 'chorus', voices: 3, gap_s: 1.5, volume: 0.8, reach_mm: 45, width_mm: 2, sensitivity: 0.5 };

/** Columns that look like they name sound files. */
export function soundColumns(rows: readonly (Record<string, unknown> | undefined)[]): string[] {
  const keys = new Set<string>();
  for (const row of rows.slice(0, 200)) for (const k of Object.keys(row ?? {})) keys.add(k);
  return [...keys].filter((k) => rows.some((r) => typeof r?.[k] === 'string' && /\.(wav|mp3|ogg|m4a)$/i.test(r[k] as string)));
}

/** Where a point's sound is, relative to the site folder, or null when it has none. */
export function soundPath(row: Record<string, unknown> | undefined, props: Pick<SoundProps, 'column' | 'file'>): string | null {
  const raw = props.column ? row?.[props.column] : props.file;
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const name = raw.trim();
  if (/^https?:|^\/|\.\./.test(name)) return null;
  // A bare file name is one of the site's sounds; anything with a folder is a path in the site.
  return name.includes('/') ? name : `data/sounds/${name}`;
}

// ---- Analysis --------------------------------------------------------------------

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
export function analyseSound(samples: Float32Array, sampleRate: number, step = 0.02): SoundProfile {
  const size = Math.max(1, Math.round(sampleRate * step));
  const n = Math.max(1, Math.ceil(samples.length / size));
  const loudness = new Float32Array(n);
  const brightness = new Float32Array(n);
  let loudest = 0;
  for (let w = 0; w < n; w++) {
    let sum = 0;
    let crossings = 0;
    const end = Math.min(samples.length, (w + 1) * size);
    for (let i = w * size; i < end; i++) {
      const v = samples[i]!;
      sum += v * v;
      if (i > w * size && (v >= 0) !== (samples[i - 1]! >= 0)) crossings++;
    }
    const count = Math.max(1, end - w * size);
    loudness[w] = Math.sqrt(sum / count);
    // The pitch the zero crossings suggest, as a share of 6 kHz (bird song sits high; wind and traffic low).
    brightness[w] = Math.min(1, ((crossings / count) * sampleRate) / 2 / 6000);
    loudest = Math.max(loudest, loudness[w]!);
  }
  if (loudest > 0) for (let w = 0; w < n; w++) loudness[w]! /= loudest;
  return { duration: samples.length / sampleRate, step, loudness, brightness };
}

/** The profile at `t` seconds into the sound. */
export function profileAt(profile: SoundProfile, t: number): { loudness: number; brightness: number } {
  const i = Math.floor(t / profile.step);
  if (i < 0 || i >= profile.loudness.length) return { loudness: 0, brightness: 0 };
  return { loudness: profile.loudness[i]!, brightness: profile.brightness[i]! };
}

/**
 * Finds calls in a loudness stream: a rise well above the recent average, no sooner than
 * `refractory` seconds after the last. Each call sends out one ring.
 */
export class PeakFinder {
  private average = 0;
  private last = -Infinity;
  /** A call has to fall away before the next one counts, so a held note is one call. */
  private armed = true;
  private readonly refractory: number;
  private readonly rise: number;
  constructor(sensitivity = 0.5, refractory = 0.14) {
    this.refractory = refractory;
    this.rise = 1.6 - 0.9 * Math.min(1, Math.max(0, sensitivity));
  }
  push(level: number, time: number, dt: number): boolean {
    const was = this.average;
    this.average += (level - this.average) * Math.min(1, dt * 4);
    if (!this.armed && level < this.average * 0.85) this.armed = true;
    if (this.armed && level > 0.12 && level > was * this.rise && time - this.last >= this.refractory) {
      this.last = time;
      this.armed = false;
      return true;
    }
    return false;
  }
}

// ---- Scheduling (pure, so it can be tested) -----------------------------------------

/**
 * Picks which points start now. A chorus keeps up to `voices` going, one at a time with a
 * gap after each ends, never the same point twice in a row. A loop starts everything not playing.
 */
export class SoundSchedule {
  private next = 0;
  private lastPicked = -1;
  private readonly random: () => number;
  constructor(seed = 5) {
    this.random = seeded(seed);
  }
  starts(props: Pick<SoundProps, 'trigger' | 'voices' | 'gap_s'>, candidates: readonly number[], playing: ReadonlySet<number>, time: number, justEnded: boolean): number[] {
    if (props.trigger === 'loop') return candidates.filter((i) => !playing.has(i));
    if (justEnded) this.next = Math.max(this.next, time + Math.max(0, props.gap_s) * (0.5 + this.random()));
    if (time < this.next || playing.size >= Math.max(1, Math.round(props.voices))) return [];
    const free = candidates.filter((i) => !playing.has(i) && (i !== this.lastPicked || candidates.length === 1));
    if (free.length === 0) return [];
    const pick = free[Math.floor(this.random() * free.length)]!;
    this.lastPicked = pick;
    // Voices come in one by one, not all at once.
    this.next = time + 0.4 + this.random() * Math.max(0.2, props.gap_s);
    return [pick];
  }
}

// ---- Playing ---------------------------------------------------------------------

type Context = AudioContext;

/** What one point is doing now. */
export interface PointSound {
  playing: boolean;
  loudness: number;
  brightness: number;
  /** A call was heard this frame. */
  call: boolean;
}

interface Voice {
  point: number;
  path: string;
  started: number;
  source: AudioBufferSourceNode | null;
  gain: GainNode | null;
  peaks: PeakFinder;
  loop: boolean;
}

/** Loaded sounds, shared by every layer on a page, by URL. */
const loaded = new Map<string, Promise<{ buffer: AudioBuffer | null; profile: SoundProfile } | null>>();
let shared: Context | null = null;

function context(): Context | null {
  if (shared) return shared;
  const Ctor = (globalThis as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext ?? (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  shared = new Ctor();
  // Browsers start audio only after a gesture on the page: resume on the first one.
  if (typeof window !== 'undefined' && shared.state !== 'running') {
    const wake = () => void shared?.resume().catch(() => {});
    for (const kind of ['pointerdown', 'keydown', 'touchstart'] as const) window.addEventListener(kind, wake, { once: true, capture: true });
  }
  return shared;
}

/** Loads and analyses a sound file once per page. Resolves null when it cannot be read. */
export function loadSound(url: string): Promise<{ buffer: AudioBuffer | null; profile: SoundProfile } | null> {
  let hit = loaded.get(url);
  if (!hit) {
    hit = (async () => {
      const ctx = context();
      if (!ctx || typeof fetch === 'undefined') return null;
      try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`${response.status}`);
        const buffer = await ctx.decodeAudioData(await response.arrayBuffer());
        const mono = new Float32Array(buffer.length);
        for (let c = 0; c < buffer.numberOfChannels; c++) {
          const data = buffer.getChannelData(c);
          for (let i = 0; i < mono.length; i++) mono[i]! += data[i]! / buffer.numberOfChannels;
        }
        return { buffer, profile: analyseSound(mono, buffer.sampleRate) };
      } catch (error) {
        console.warn(`[sound] ${url} could not be played: ${(error as Error).message}`);
        return null;
      }
    })();
    loaded.set(url, hit);
  }
  return hit;
}

/**
 * The sounds of one layer's points. `audible` is false on surfaces that only show the rings
 * (the editor's preview), so one room hears the table and nothing else.
 */
export class SoundStage {
  private readonly voices = new Map<number, Voice>();
  private readonly profiles = new Map<string, SoundProfile>();
  private readonly buffers = new Map<string, AudioBuffer>();
  private readonly schedule = new SoundSchedule();
  private readonly url: (path: string) => string;
  audible: boolean;
  volume = 0.8;

  constructor(options: { audible: boolean; url?: (path: string) => string }) {
    this.audible = options.audible;
    this.url = options.url ?? ((path) => `/site/${path}`);
  }

  /** Starts loading the sounds; points draw calm dots until theirs is ready. */
  prepare(paths: Iterable<string>): void {
    for (const path of new Set(paths)) {
      if (this.profiles.has(path)) continue;
      void loadSound(this.url(path)).then((sound) => {
        if (!sound) return;
        this.profiles.set(path, sound.profile);
        if (sound.buffer) this.buffers.set(path, sound.buffer);
      });
    }
  }

  /** For tests and synthetic sounds: a profile without a file. */
  setProfile(path: string, profile: SoundProfile): void {
    this.profiles.set(path, profile);
  }

  /** Whether the page can actually be heard now (audible and the browser let audio start). */
  get heard(): boolean {
    return this.audible && shared?.state === 'running';
  }

  /**
   * Advances to `time` (seconds) and returns each point's sound. `paths[i]` is point i's
   * sound or null. Call once per frame.
   */
  update(paths: readonly (string | null)[], props: SoundProps, time: number, dt: number): PointSound[] {
    this.volume = Math.min(1, Math.max(0, props.volume));
    let ended = false;
    for (const [point, voice] of this.voices) {
      const profile = this.profiles.get(voice.path);
      const gone = paths[point] !== voice.path || (props.trigger === 'loop') !== voice.loop;
      if (!profile || gone || (!voice.loop && time - voice.started > profile.duration)) {
        this.stopVoice(voice);
        this.voices.delete(point);
        ended = true;
      }
    }
    const ready: number[] = [];
    paths.forEach((path, i) => {
      if (path && this.profiles.has(path)) ready.push(i);
    });
    for (const point of this.schedule.starts(props, ready, new Set(this.voices.keys()), time, ended)) this.startVoice(point, paths[point]!, props, time);
    for (const voice of this.voices.values()) if (voice.gain) voice.gain.gain.value = this.audible ? this.volume : 0;

    return paths.map((_, i) => {
      const voice = this.voices.get(i);
      const profile = voice && this.profiles.get(voice.path);
      if (!voice || !profile) return { playing: false, loudness: 0, brightness: 0, call: false };
      let at = time - voice.started;
      if (voice.loop) at %= Math.max(0.05, profile.duration);
      const { loudness, brightness } = profileAt(profile, at);
      return { playing: true, loudness, brightness, call: voice.peaks.push(loudness, time, dt) };
    });
  }

  /** Points playing now. */
  playing(): number[] {
    return [...this.voices.keys()];
  }

  /** Stops every sound, for when the layer turns off. */
  stop(): void {
    for (const voice of this.voices.values()) this.stopVoice(voice);
    this.voices.clear();
  }

  private startVoice(point: number, path: string, props: SoundProps, time: number): void {
    const voice: Voice = { point, path, started: time, source: null, gain: null, peaks: new PeakFinder(props.sensitivity), loop: props.trigger === 'loop' };
    const buffer = this.buffers.get(path);
    const ctx = shared;
    if (buffer && ctx && this.audible) {
      try {
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.loop = voice.loop;
        const gain = ctx.createGain();
        gain.gain.value = this.volume;
        source.connect(gain).connect(ctx.destination);
        source.start();
        Object.assign(voice, { source, gain });
      } catch {
        // Seen but not heard.
      }
    }
    this.voices.set(point, voice);
  }

  private stopVoice(voice: Voice): void {
    try {
      voice.source?.stop();
    } catch {
      // Already stopped.
    }
    voice.source?.disconnect();
    voice.gain?.disconnect();
  }
}

// ---- Where sound is heard --------------------------------------------------------

/** The editor's switch for hearing sounds in its preview (#150). */
export const LISTEN_KEY = 'mrstudio.listen';

/** Whether this page should be heard: the table always, the editor only when its author turned listening on. */
export function hearsSound(): boolean {
  if (typeof document === 'undefined') return false;
  if (document.body?.dataset.role === 'table') return true;
  try {
    return localStorage.getItem(LISTEN_KEY) === '1';
  } catch {
    return false;
  }
}

// ---- Soundscape (#190) -------------------------------------------------------------
// Two looping beds, nature and city, mixed by how green the view is: walking a viewer from
// a street into a park fades traffic into birdsong, as in the Chalmers demo's isovist.

/** The demo's mix: each bed at most `max`, with a 0.05 floor while it is still in play. */
export function soundscapeMix(gvf: number, max = 0.5): { nature: number; city: number } {
  const g = Math.min(1, Math.max(0, gvf));
  let nature = g * max;
  let city = (1 - g) * max;
  if (g > 0.1) nature = Math.max(nature, 0.05);
  if (g < 0.9) city = Math.max(city, 0.05);
  return { nature, city };
}

/** Eases a volume towards its target: the demo's 0.1 per frame at 60 frames a second. */
export function easeVolume(current: number, target: number, dt: number, rate = 0.1): number {
  return current + (target - current) * (1 - (1 - rate) ** Math.max(0, dt * 60));
}

/**
 * A built-in bed, made from numbers so a table has a soundscape before anyone adds recordings.
 * `nature`: chirps that sweep up and down between 2 and 6 kHz in short phrases, over soft
 * leaves. `city`: a low rumble of traffic that swells as cars pass, over a band of hiss.
 * The loop is seamless: what rings past the end wraps to the start.
 */
export function synthBed(kind: 'nature' | 'city', sampleRate = 22050, seconds = 12, seed = 7): Float32Array {
  const n = Math.round(sampleRate * seconds);
  const out = new Float32Array(n);
  const random = seeded(seed);
  // Filtered noise for the floor of both beds.
  let low = 0;
  let band = 0;
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const white = random() * 2 - 1;
    low += (white - low) * (kind === 'city' ? 0.02 : 0.2);
    const high = white - prev;
    prev = white;
    band += (high - band) * 0.3;
    out[i] = kind === 'city' ? low * 1.6 + band * 0.05 : band * 0.04;
  }
  if (kind === 'city') {
    // Cars passing: slow swells of the rumble, a few per loop.
    const cars = Array.from({ length: 5 }, () => ({ at: random() * seconds, len: 2 + random() * 3, depth: 0.6 + random() * 0.8 }));
    for (let i = 0; i < n; i++) {
      const t = i / sampleRate;
      let swell = 0.5;
      for (const car of cars) {
        let d = Math.abs(t - car.at);
        d = Math.min(d, seconds - d);
        swell += car.depth * Math.exp(-((d / (car.len / 2)) ** 2));
      }
      out[i]! *= swell;
    }
  } else {
    // Phrases of a few chirps, each a sweep with a soft envelope.
    let t = random() * 0.5;
    while (t < seconds) {
      const notes = 2 + Math.floor(random() * 5);
      const base = 2200 + random() * 2500;
      for (let k = 0; k < notes; k++) {
        const len = 0.05 + random() * 0.12;
        const from = base * (0.85 + random() * 0.3);
        const to = from * (random() < 0.5 ? 1.35 : 0.7);
        const loud = 0.12 + random() * 0.18;
        const start = Math.round(t * sampleRate);
        const count = Math.round(len * sampleRate);
        let phase = 0;
        for (let s = 0; s < count; s++) {
          const u = s / count;
          phase += (2 * Math.PI * (from + (to - from) * u)) / sampleRate;
          const env = Math.sin(Math.PI * u) ** 2;
          out[(start + s) % n]! += Math.sin(phase) * env * loud;
        }
        t += len + 0.03 + random() * 0.08;
      }
      t += 0.6 + random() * 2.2;
    }
  }
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(out[i]!));
  if (peak > 0) for (let i = 0; i < n; i++) out[i]! *= 0.9 / peak;
  return out;
}

/** A bed: a sound file in the site (`data/sounds/...`), or the built-in one when null. */
export interface BedSpec {
  file: string | null;
}

interface Bed {
  key: string;
  source: AudioBufferSourceNode | null;
  gain: GainNode | null;
  volume: number;
}

/**
 * Plays the two beds and keeps their mix. Nothing is heard until the page has had a gesture
 * (the browser's autoplay rule) or on a page that is not `audible`; the mix is still worked out,
 * so the controller can show it.
 */
export class Soundscape {
  private readonly beds: Record<'nature' | 'city', Bed> = {
    nature: { key: '', source: null, gain: null, volume: 0 },
    city: { key: '', source: null, gain: null, volume: 0 },
  };
  private readonly url: (path: string) => string;
  private stopped = false;
  audible: boolean;

  constructor(options: { audible: boolean; url?: (path: string) => string }) {
    this.audible = options.audible;
    this.url = options.url ?? ((path) => `/site/${path}`);
  }

  /** The volumes now, after easing, 0 to 1. */
  get volumes(): { nature: number; city: number } {
    return { nature: this.beds.nature.volume, city: this.beds.city.volume };
  }

  /** Moves the mix towards `gvf` and (re)starts beds whose file changed. Call once per frame. */
  update(gvf: number | null, specs: Record<'nature' | 'city', BedSpec>, master: number, dt: number): void {
    if (this.stopped) return;
    const target = gvf === null ? { nature: 0, city: 0 } : soundscapeMix(gvf);
    for (const kind of ['nature', 'city'] as const) {
      const bed = this.beds[kind];
      bed.volume = easeVolume(bed.volume, target[kind], dt);
      const key = specs[kind].file ?? `built-in:${kind}`;
      if (bed.key !== key) {
        this.release(bed);
        bed.key = key;
        void this.start(kind, bed, key, specs[kind].file);
      }
      if (bed.gain) bed.gain.gain.value = this.audible ? bed.volume * Math.min(1, Math.max(0, master)) : 0;
    }
  }

  stop(): void {
    this.stopped = true;
    for (const bed of Object.values(this.beds)) this.release(bed);
  }

  private async start(kind: 'nature' | 'city', bed: Bed, key: string, file: string | null): Promise<void> {
    const ctx = context();
    if (!ctx) return;
    let buffer: AudioBuffer | null = null;
    if (file) buffer = (await loadSound(this.url(file)))?.buffer ?? null;
    if (!buffer) {
      if (file) console.warn(`[soundscape] ${file} could not be played, so the built-in ${kind} bed plays instead`);
      const samples = synthBed(kind, 22050, 12, kind === 'nature' ? 7 : 11);
      buffer = ctx.createBuffer(1, samples.length, 22050);
      buffer.getChannelData(0).set(samples);
    }
    if (this.stopped || bed.key !== key) return;
    try {
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.loop = true;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      source.connect(gain).connect(ctx.destination);
      source.start();
      bed.source = source;
      bed.gain = gain;
    } catch {
      // Seen but not heard.
    }
  }

  private release(bed: Bed): void {
    try {
      bed.source?.stop();
    } catch {
      // Already stopped.
    }
    bed.source?.disconnect();
    bed.gain?.disconnect();
    bed.source = null;
    bed.gain = null;
  }
}
