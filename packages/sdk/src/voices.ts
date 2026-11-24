// Data-driven sound voices (#282): a layer's sound bed declared in layer.json, with no audio
// code in the layer. Each voice is a slow, continuous sound (filtered noise, a hum with
// harmonics, or a plain tone) whose level and colour follow a value the layer publishes, the
// way ECOM's grid import was heard as a hiss and a transformer hum that load up with it.
//
//   "sound": [
//     { "id": "grid", "kind": "noise", "level": { "bind": "shared.import_kw", "from": [0, 800], "to": [0.05, 0.6] },
//       "centre": { "bind": "shared.import_kw", "from": [0, 800], "to": [240, 900] }, "width": 1.2 },
//     { "id": "hum", "kind": "hum", "frequency": 100, "harmonics": 4,
//       "level": { "bind": "shared.import_kw", "from": [0, 800], "to": [0, 0.4] } }
//   ]
//
// Rules from the ECOM learnings (docs/visualisation.md): no repeating events, a level ceiling
// (the whole bed never passes `VOICE_CEILING`), and slow change (every value glides over
// `glide_s`, at least `MIN_GLIDE_S`). Voices play on the table only, start and stop with
// their layer, and fall silent while the controller's sound switch is off for the session.

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
export const VOICE_KINDS: readonly VoiceKind[] = ['noise', 'hum', 'tone'];

const DEFAULTS: Record<VoiceKind, { level: number; centre: number; width: number; frequency: number }> = {
  noise: { level: 0.3, centre: 500, width: 1.5, frequency: 0 },
  hum: { level: 0.25, centre: 0, width: 0, frequency: 100 },
  tone: { level: 0.2, centre: 0, width: 0, frequency: 220 },
};

/** What a binding reads from: the layer's params and what it published. */
export interface VoiceSource {
  params: Record<string, unknown>;
  shared: Record<string, unknown>;
}

function isBinding(value: unknown): value is VoiceBinding {
  return typeof value === 'object' && value !== null && typeof (value as VoiceBinding).bind === 'string';
}

/** A voice value now. A binding whose value is missing gives the low end of its output, so silence is the default. */
export function voiceValue(value: VoiceValue | undefined, source: VoiceSource, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  if (!isBinding(value)) return fallback;
  const [scope, ...path] = value.bind.split('.');
  let raw: unknown = scope === 'params' ? source.params : scope === 'shared' ? source.shared : undefined;
  for (const key of path) raw = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>)[key] : undefined;
  const [a, b] = value.from;
  const [c, d] = value.to;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return c;
  let t = b === a ? 1 : (raw - a) / (b - a);
  t = Math.min(1, Math.max(0, t));
  if (value.curve === 'sqrt') t = Math.sqrt(t);
  if (value.curve === 'square') t = t * t;
  return c + (d - c) * t;
}

/** What one voice should sound like now, with its level already under the bed's share of the ceiling. */
export interface VoiceTarget {
  gain: number;
  /** Noise: the band's centre. Hum and tone: the pitch. Hz, within hearing and the speakers. */
  frequency: number;
  /** Noise: the filter's Q for the band's width. */
  q: number;
  glide_s: number;
}

const clampHz = (hz: number) => Math.min(8000, Math.max(30, hz));

/** Where each voice should be now. The levels share `VOICE_CEILING`, so more voices never means louder. */
export function voiceTargets(voices: readonly VoiceSpec[], source: VoiceSource): VoiceTarget[] {
  const share = VOICE_CEILING / Math.max(1, voices.length);
  return voices.map((voice) => {
    const d = DEFAULTS[voice.kind] ?? DEFAULTS.tone;
    const level = Math.min(1, Math.max(0, voiceValue(voice.level, source, d.level)));
    const frequency = clampHz(voice.kind === 'noise' ? voiceValue(voice.centre, source, d.centre) : voiceValue(voice.frequency, source, d.frequency));
    // A band `width` octaves wide: Q = sqrt(2^w) / (2^w - 1).
    const octaves = Math.min(4, Math.max(0.2, voiceValue(voice.width, source, d.width)));
    const q = Math.sqrt(2 ** octaves) / (2 ** octaves - 1);
    return { gain: level * share, frequency, q, glide_s: Math.max(MIN_GLIDE_S, voice.glide_s ?? 2) };
  });
}

/** Why a layer's `sound` is not one that can play, or an empty list. For the MCP and tests. */
export function checkVoices(sound: unknown): string[] {
  if (sound === undefined || sound === null) return [];
  if (!Array.isArray(sound)) return ['sound is a list of voices'];
  const problems: string[] = [];
  if (sound.length > 4) problems.push('sound has at most 4 voices');
  const ids = new Set<string>();
  sound.forEach((voice: any, i) => {
    const at = `sound[${i}]`;
    if (typeof voice?.id !== 'string' || !voice.id) problems.push(`${at} needs an id`);
    else if (ids.has(voice.id)) problems.push(`${at}: two voices are called '${voice.id}'`);
    else ids.add(voice.id);
    if (!VOICE_KINDS.includes(voice?.kind)) problems.push(`${at}.kind is noise, hum or tone`);
    for (const key of ['level', 'centre', 'width', 'frequency'] as const) {
      const v = voice?.[key];
      if (v === undefined || typeof v === 'number') continue;
      if (!isBinding(v) || !/^(params|shared)\.[A-Za-z0-9_.-]+$/.test(v.bind)) problems.push(`${at}.${key} is a number or { "bind": "shared.<key>" or "params.<id>", "from": [a, b], "to": [c, d] }`);
      else if (!Array.isArray(v.from) || v.from.length !== 2 || !Array.isArray(v.to) || v.to.length !== 2 || ![...v.from, ...v.to].every((n) => typeof n === 'number' && Number.isFinite(n))) problems.push(`${at}.${key}: from and to are two numbers each`);
    }
    if (voice?.harmonics !== undefined && !(Number.isInteger(voice.harmonics) && voice.harmonics >= 0 && voice.harmonics <= 6)) problems.push(`${at}.harmonics is a whole number from 0 to 6`);
    if (voice?.glide_s !== undefined && !(typeof voice.glide_s === 'number' && voice.glide_s >= MIN_GLIDE_S)) problems.push(`${at}.glide_s is at least ${MIN_GLIDE_S} s: sound changes slowly`);
  });
  return problems;
}

// ---- Playing -----------------------------------------------------------------------

let shared: AudioContext | null = null;
function audio(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const Ctor = (window as any).AudioContext ?? (window as any).webkitAudioContext;
  if (!Ctor) return null;
  shared ??= new Ctor();
  if (shared!.state === 'suspended') void shared!.resume().catch(() => {});
  return shared;
}

interface Playing {
  gain: GainNode;
  filter?: BiquadFilterNode;
  oscillators: OscillatorNode[];
  source?: AudioBufferSourceNode;
}

/** A few seconds of white noise, looped under a band-pass filter. */
function noiseBuffer(ctx: AudioContext): AudioBuffer {
  const seconds = 4;
  const buffer = ctx.createBuffer(1, ctx.sampleRate * seconds, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  let seed = 12345;
  for (let i = 0; i < data.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    data[i] = (seed / 0x7fffffff) * 2 - 1;
  }
  return buffer;
}

/**
 * A layer's voices, playing. `update` once a frame (or whenever values change) with the layer's
 * params and published values; `audible` false fades the bed out without stopping it, so the
 * switch back on picks up where the values are now. Nothing is heard before the page's first
 * gesture (the browser's autoplay rule).
 */
export class VoiceBed {
  private playing: Playing[] = [];
  private stopped = false;
  private last = '';
  audible: boolean;

  private readonly voices: readonly VoiceSpec[];

  constructor(voices: readonly VoiceSpec[], options: { audible: boolean }) {
    this.voices = voices;
    this.audible = options.audible;
  }

  /** The targets the bed is gliding to: for tests and the controller. */
  targets(source: VoiceSource): VoiceTarget[] {
    return voiceTargets(this.voices, source);
  }

  update(source: VoiceSource): void {
    if (this.stopped) return;
    const ctx = audio();
    if (!ctx) return;
    if (this.playing.length === 0) this.start(ctx);
    const targets = voiceTargets(this.voices, source);
    // Only a change schedules a glide; an unchanged frame costs nothing.
    const key = JSON.stringify([targets, this.audible]);
    if (key === this.last) return;
    this.last = key;
    const now = ctx.currentTime;
    this.playing.forEach((p, i) => {
      const t = targets[i]!;
      // setTargetAtTime glides exponentially: a third of the glide is one time constant.
      const k = t.glide_s / 3;
      p.gain.gain.setTargetAtTime(this.audible ? t.gain : 0, now, this.audible ? k : 0.3);
      if (p.filter) {
        p.filter.frequency.setTargetAtTime(t.frequency, now, k);
        p.filter.Q.setTargetAtTime(t.q, now, k);
      }
      p.oscillators.forEach((osc, n) => osc.frequency.setTargetAtTime(t.frequency * (n + 1), now, k));
    });
  }

  stop(): void {
    this.stopped = true;
    const ctx = shared;
    for (const p of this.playing) {
      // A short fade, so stopping never clicks.
      if (ctx) p.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.15);
      const end = () => {
        try {
          p.source?.stop();
          p.oscillators.forEach((o) => o.stop());
        } catch {
          // Already stopped.
        }
        p.gain.disconnect();
      };
      if (typeof setTimeout === 'function') setTimeout(end, 800);
      else end();
    }
    this.playing = [];
  }

  private start(ctx: AudioContext): void {
    let noise: AudioBuffer | null = null;
    for (const voice of this.voices) {
      const gain = ctx.createGain();
      gain.gain.value = 0;
      gain.connect(ctx.destination);
      const p: Playing = { gain, oscillators: [] };
      if (voice.kind === 'noise') {
        noise ??= noiseBuffer(ctx);
        const source = ctx.createBufferSource();
        source.buffer = noise;
        source.loop = true;
        const filter = ctx.createBiquadFilter();
        filter.type = 'bandpass';
        source.connect(filter).connect(gain);
        source.start();
        Object.assign(p, { source, filter });
      } else {
        const count = voice.kind === 'hum' ? 1 + Math.min(6, Math.max(0, voice.harmonics ?? 3)) : 1;
        for (let n = 0; n < count; n++) {
          const osc = ctx.createOscillator();
          osc.type = 'sine';
          // Each harmonic quieter than the one below it, as a transformer's hum.
          const part = ctx.createGain();
          part.gain.value = 1 / (n + 1) ** 1.5 / (voice.kind === 'hum' ? 1.6 : 1);
          osc.connect(part).connect(gain);
          osc.start();
          p.oscillators.push(osc);
        }
      }
      this.playing.push(p);
    }
  }
}
