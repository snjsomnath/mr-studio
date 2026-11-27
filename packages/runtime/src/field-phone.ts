// The phone's part of a field walk (#445): a card at the top of the phone page while the table
// has a Field walk layer. "Mark a spot" finds the phone by GPS (or the visitor taps where they
// are on a small map of the table), then takes a photo with the phone's own camera or records a
// sound, with an optional note. Every spot is kept on the phone first (IndexedDB) and sent to the
// table in small pieces whenever it can be reached, so walking out of range, the screen sleeping
// or a reload loses nothing. Wire: field.add then field.part (crates/mrs-host/src/field.rs).
import { lonLatToTable, tableToLonLat } from '@mrstudio/sdk';
import type { Connection, SiteInfo } from '@mrstudio/sdk';

import { avatarOf, nameOf } from './avatars.ts';
import { t } from './i18n.ts';
import { loadFootprints } from './phone-tools.ts';
import type { Store } from './store.ts';

const PACKAGE = 'fieldwalk';
const WALKER_KEY = 'mrstudio.walker';
/** The table session this phone's spots belong to (#627): a new session starts a new walk. */
const SESSION_KEY = 'mrstudio.field.session';
/** Raw bytes per piece: 96 kB is 128 kB of base64, well under the host's limit and the 256 kB a WebRTC message may be. */
const PIECE = 96 * 1024;
/** Photos are scaled to at most this many pixels on their long side, as JPEG. */
const PHOTO_PX = 1600;
const PHOTO_QUALITY = 0.82;
const SOUND_MAX_S = 60;
const REQUEST_TIMEOUT_MS = 20_000;
const RETRY_MS = 8_000;
/** GPS less sure than this many metres asks the visitor to tap the spot on the map. */
const ROUGH_M = 30;

/** What the host set up in the walk designer (#628): the Field walk layer's settings. */
export interface WalkDesign {
  /** Kinds to pick from; empty for none. */
  kinds: string[];
  /** Ask for a 1 to 5 feeling. */
  feeling: boolean;
  /** What a spot takes. */
  media: 'both' | 'photo' | 'sound' | 'none';
}

const FACES = ['😣', '🙁', '😐', '🙂', '😍'];

export function designOf(params: Record<string, unknown> | undefined): WalkDesign {
  const seen = new Set<string>();
  const kinds = String(params?.kinds ?? '')
    .split(',')
    .map((k) => k.trim())
    .filter((k) => k && !seen.has(k.toLowerCase()) && seen.add(k.toLowerCase()));
  const media = params?.media;
  return {
    kinds,
    feeling: params?.feeling === true,
    media: media === 'photo' || media === 'sound' || media === 'none' ? media : 'both',
  };
}

interface Kept {
  id: string;
  kind: 'photo' | 'sound' | 'mark';
  /** The kind the walker picked (#628). */
  label?: string;
  /** How they feel about it, 1 to 5 (#628). */
  feeling?: number;
  at: number;
  lon: number;
  lat: number;
  accuracy?: number;
  placed: 'gps' | 'map';
  note?: string;
  mime: string;
  bytes: number;
  duration?: number;
  /** The file, until the table has it all. */
  blob?: Blob;
  /** A small picture for the list, for a photo. */
  thumb?: string;
  sent: boolean;
  have: number;
  /** Why the table turned it down, for good. */
  refused?: string;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** This phone's walker id: the same walker across seats, reloads and sessions of this table. */
function walkerId(): string {
  try {
    const kept = localStorage.getItem(WALKER_KEY);
    if (kept && /^[a-f0-9]{8,40}$/.test(kept)) return kept;
    const made = newId();
    localStorage.setItem(WALKER_KEY, made);
    return made;
  } catch {
    return ((walkerId as { fallback?: string }).fallback ??= newId());
  }
}

// ---- The phone's own keeping: one IndexedDB store of spots ----

class Outbox {
  private db: Promise<IDBDatabase | null>;
  private memory = new Map<string, Kept>();

  constructor() {
    this.db = new Promise((resolve) => {
      try {
        const open = indexedDB.open('mrstudio-field', 1);
        open.onupgradeneeded = () => open.result.createObjectStore('spots', { keyPath: 'id' });
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }

  private async run<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
    const db = await this.db;
    if (!db) return undefined;
    return new Promise((resolve) => {
      const request = work(db.transaction('spots', mode).objectStore('spots'));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(undefined);
    });
  }

  async all(): Promise<Kept[]> {
    const stored = (await this.run('readonly', (s) => s.getAll() as IDBRequest<Kept[]>)) ?? [...this.memory.values()];
    return stored.sort((a, b) => a.at - b.at);
  }

  async put(spot: Kept): Promise<void> {
    this.memory.set(spot.id, spot);
    await this.run('readwrite', (s) => s.put(spot));
  }

  async remove(id: string): Promise<void> {
    this.memory.delete(id);
    await this.run('readwrite', (s) => s.delete(id));
  }
}

function keptSession(): string | null {
  try {
    return localStorage.getItem(SESSION_KEY);
  } catch {
    return null;
  }
}

function keepSession(session: string): void {
  try {
    localStorage.setItem(SESSION_KEY, session);
  } catch {
    // Private browsing: the walk then lasts as long as the page.
  }
}

function base64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(reader.error ?? new Error('could not read the file'));
    reader.readAsDataURL(blob);
  });
}

function withTimeout<T>(promise: Promise<T>): Promise<T> {
  return Promise.race([promise, new Promise<T>((_, reject) => setTimeout(() => reject(new Error('not connected')), REQUEST_TIMEOUT_MS))]);
}

/** A photo from the camera, turned upright, at most PHOTO_PX on its long side, as JPEG, and a thumbnail. */
async function shrinkPhoto(file: Blob): Promise<{ blob: Blob; thumb: string }> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const draw = (most: number) => {
      const scale = Math.min(1, most / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
      canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
      return canvas;
    };
    const big = draw(PHOTO_PX);
    const blob = await new Promise<Blob>((resolve, reject) => big.toBlob((b) => (b ? resolve(b) : reject(new Error('could not keep the photo'))), 'image/jpeg', PHOTO_QUALITY));
    const thumb = draw(160).toDataURL('image/jpeg', 0.7);
    return { blob, thumb };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** The best sound format this browser records in: Opus in WebM, else AAC in MP4 (Safari). */
function recordingType(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  return ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'].find((type) => MediaRecorder.isTypeSupported?.(type));
}

function canRecord(): boolean {
  return typeof MediaRecorder !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia) && window.isSecureContext;
}

function minutes(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * The Field walk card for the phone page. It shows itself while the table has a Field walk
 * layer and keeps sending what this phone collected, whatever the table is showing.
 */
export function fieldCard(store: Store, connection: Connection): HTMLElement {
  const card = el('section', 'layer-card field-card');
  const header = el('header');
  const title = el('div', 'layer-title');
  const intro = el('p', undefined, '');
  title.append(el('h2', undefined, t('Field walk')), intro);
  header.append(title);
  const mark = el('button', 'action primary field-mark', t('Mark a spot'));
  mark.type = 'button';
  const status = el('p', 'field-status');
  const list = el('ul', 'field-list');
  const body = el('div', 'field-body');
  body.append(mark, status, list);
  card.append(header, body);

  const outbox = new Outbox();
  let kept: Kept[] = [];
  let online = true;
  let sending = false;
  let progress: { id: string; share: number } | null = null;
  let retry: number | undefined;

  const present = () => Object.values(store.state.layers).some((l) => (l as { layer?: string }).layer === PACKAGE);
  const design = () => designOf((Object.values(store.state.layers).find((l) => (l as { layer?: string }).layer === PACKAGE) as { params?: Record<string, unknown> } | undefined)?.params);
  const INTRO = {
    both: 'Walk around and mark what you notice, with a photo or a sound.',
    photo: 'Walk around and mark what you notice, with a photo.',
    sound: 'Walk around and mark what you notice, with a sound.',
    none: 'Walk around and mark what you notice on the map.',
  } as const;
  const showCard = () => {
    card.hidden = !present() && !kept.some((k) => !k.sent && !k.refused);
    intro.textContent = t(INTRO[design().media]);
  };

  async function refresh() {
    kept = await outbox.all();
    renderList();
    showCard();
  }

  function renderList() {
    const waiting = kept.filter((k) => !k.sent && !k.refused).length;
    const sent = kept.filter((k) => k.sent).length;
    status.textContent =
      kept.length === 0
        ? t('Your spots show on the table as soon as it can be reached.')
        : waiting === 0
          ? t('{n} spots on the table.', { n: sent })
          : online
            ? t('{sent} on the table, {waiting} sending…', { sent, waiting })
            : t('{sent} on the table, {waiting} waiting until the table can be reached. Keep this page open.', { sent, waiting });
    list.replaceChildren(
      ...[...kept].reverse().map((spot) => {
        const row = el('li', 'field-row');
        const pic = el('span', 'field-thumb');
        if (spot.thumb) pic.style.backgroundImage = `url("${spot.thumb}")`;
        else pic.textContent = spot.kind === 'sound' ? '♪' : spot.kind === 'mark' ? (spot.feeling ? FACES[spot.feeling - 1]! : '📍') : '📷';
        const words = el('span', 'field-words');
        const time = new Date(spot.at).toLocaleTimeString(undefined, {
          hour: '2-digit',
          minute: '2-digit',
        });
        const what = spot.label ?? (spot.kind === 'photo' ? t('Photo') : spot.kind === 'sound' ? t('Sound') : t('Spot'));
        const face = spot.feeling && spot.kind !== 'mark' ? ` ${FACES[spot.feeling - 1]}` : '';
        words.append(el('b', undefined, `${what}${face} · ${time}`));
        const state = spot.sent
          ? t('On the table')
          : spot.refused
            ? t('Not taken: {reason}', { reason: spot.refused })
            : progress?.id === spot.id
              ? t('Sending {p}%', { p: Math.round(progress.share * 100) })
              : t('Waiting to send');
        words.append(el('span', spot.sent ? 'is-sent' : spot.refused ? 'is-refused' : undefined, state + (spot.note ? ` · ${spot.note}` : '')));
        row.append(pic, words);
        // Any of one's own spots can be taken back, also once it is on the table (#627).
        const drop = el('button', 'field-drop', '×');
        drop.type = 'button';
        drop.setAttribute('aria-label', t('Delete this spot'));
        drop.onclick = async () => {
          if (spot.sent) {
            try {
              await withTimeout(connection.request('field.remove', { id: spot.id, walker: walkerId() }));
            } catch {
              status.textContent = t('The table can’t be reached. Try again when it can.');
              return;
            }
          }
          await outbox.remove(spot.id);
          await refresh();
        };
        row.append(drop);
        return row;
      }),
    );
  }

  /**
   * Brings the phone's list in line with the table (#627). A new session of the table starts a
   * new walk, so everything kept from an earlier one goes; within a session, spots the guide
   * removed or cleared go too. Spots still waiting to send, or turned down, stay.
   */
  async function reconcile() {
    const answer = await withTimeout(connection.request<{ session: string; spots: string[] }>('field.mine', { walker: walkerId() }));
    const fresh = keptSession() !== answer.session;
    const have = new Set(answer.spots);
    for (const spot of await outbox.all()) {
      if (fresh || (spot.sent && !have.has(spot.id))) {
        await outbox.remove(spot.id);
      }
    }
    keepSession(answer.session);
    await refresh();
  }

  /** Sends every spot the table does not have yet, one piece at a time, going on where it stopped. */
  async function send() {
    if (sending) return;
    sending = true;
    clearTimeout(retry);
    try {
      for (const spot of await outbox.all()) {
        if (spot.sent || spot.refused || (!spot.blob && spot.kind !== 'mark')) continue;
        const me = store.me();
        const walker = {
          id: walkerId(),
          name: me ? nameOf(me) : undefined,
          avatar: me ? avatarOf(me) : undefined,
          colour: me?.colour,
        };
        try {
          let answer = await withTimeout(
            connection.request<{ have: number; done?: boolean }>('field.add', {
              id: spot.id,
              kind: spot.kind,
              label: spot.label,
              feeling: spot.feeling,
              at: spot.at,
              lon: spot.lon,
              lat: spot.lat,
              accuracy: spot.accuracy,
              placed: spot.placed,
              note: spot.note,
              mime: spot.mime,
              bytes: spot.bytes,
              duration: spot.duration,
              walker,
            }),
          );
          while (!answer.done && spot.blob && answer.have < spot.bytes) {
            progress = { id: spot.id, share: answer.have / spot.bytes };
            renderList();
            const piece = spot.blob.slice(answer.have, answer.have + PIECE);
            answer = await withTimeout(connection.request<{ have: number; done?: boolean }>('field.part', { id: spot.id, offset: answer.have, data: await base64(piece) }));
          }
          // The table has it: the phone keeps only the list entry and its thumbnail.
          await outbox.put({
            ...spot,
            blob: undefined,
            sent: true,
            have: spot.bytes,
          });
        } catch (error) {
          const reason = (error as Error).message;
          // Out of reach or too fast: try again later. Anything else the table will never take.
          if (!online || /not connected|rate limited|disconnected|closed/i.test(reason)) throw error;
          await outbox.put({ ...spot, refused: reason });
        } finally {
          progress = null;
        }
      }
    } catch {
      retry = window.setTimeout(() => void send(), RETRY_MS);
    } finally {
      sending = false;
      await refresh();
    }
  }

  connection.on('disconnected', () => {
    online = false;
    renderList();
  });
  connection.on('welcome', () => {
    online = true;
    void reconcile()
      .catch(() => undefined)
      .then(send);
  });
  window.addEventListener('online', () => void send());
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && void send());
  store.onLayer(showCard);
  store.onScene(showCard);
  mark.onclick = () =>
    document.body.append(
      spotSheet(store.state.site, design(), async (spot) => {
        await outbox.put(spot);
        await refresh();
        void send();
      }),
    );
  void refresh()
    .then(reconcile)
    .catch(() => undefined)
    .then(send);
  return card;
}

/** The sheet that makes one spot: where, a photo or a sound, a note, Save. */
function spotSheet(site: SiteInfo, design: WalkDesign, save: (spot: Kept) => Promise<void>): HTMLElement {
  const sheet = el('div', 'profile-sheet field-sheet');
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');
  const card = el('div', 'profile-card field-sheet-card');
  sheet.append(card);

  // ---- Where ----
  const SVG = 'http://www.w3.org/2000/svg';
  const width = site.extent.width_m;
  const height = site.extent.height_m;
  const map = document.createElementNS(SVG, 'svg');
  map.setAttribute('viewBox', `0 0 ${width} ${height}`);
  map.setAttribute('class', 'tool-map field-map');
  map.setAttribute('aria-label', t('Map of the table'));
  map.style.aspectRatio = `${width} / ${height}`;
  const buildings = document.createElementNS(SVG, 'path');
  buildings.setAttribute('class', 'tool-buildings');
  const halo = document.createElementNS(SVG, 'circle');
  halo.setAttribute('class', 'field-halo');
  const dot = document.createElementNS(SVG, 'circle');
  dot.setAttribute('class', 'field-dot');
  map.append(buildings, halo, dot);
  void loadFootprints(site).then((rings) => {
    buildings.setAttribute('d', rings.map((ring) => `M${ring.map(([u, v]) => `${(u * width).toFixed(1)} ${(v * height).toFixed(1)}`).join('L')}Z`).join(''));
  });
  const where = el('p', 'tool-hint field-where');

  let place: {
    lon: number;
    lat: number;
    accuracy?: number;
    placed: 'gps' | 'map';
  } | null = null;
  const onMap = (lon: number, lat: number) => {
    const [u, v] = lonLatToTable(site, lon, lat);
    return u >= 0 && u <= 1 && v >= 0 && v <= 1;
  };
  const drawPlace = () => {
    const unit = width / 340;
    if (!place || !onMap(place.lon, place.lat)) {
      dot.setAttribute('r', '0');
      halo.setAttribute('r', '0');
    } else {
      const [u, v] = lonLatToTable(site, place.lon, place.lat);
      for (const c of [dot, halo]) {
        c.setAttribute('cx', String(u * width));
        c.setAttribute('cy', String(v * height));
      }
      dot.setAttribute('r', String(7 * unit));
      halo.setAttribute('r', String(Math.max(7 * unit, place.accuracy ?? 0)));
    }
    if (!place) where.textContent = navigator.geolocation && window.isSecureContext ? t('Finding you… or tap where you are on the map.') : t('Tap where you are on the map.');
    else if (!onMap(place.lon, place.lat)) where.textContent = t('You are outside the table’s map. Walk closer, or tap where the spot is.');
    else if (place.placed === 'map') where.textContent = t('Placed by hand. Tap again to move it.');
    else if ((place.accuracy ?? 0) > ROUGH_M)
      where.textContent = t('GPS is rough here (within {m} m). Tap the map to place the spot exactly.', { m: Math.round(place.accuracy ?? 0) });
    else where.textContent = t('Found by GPS, within {m} m. Tap the map if it is wrong.', { m: Math.round(place.accuracy ?? 0) });
    check();
  };
  let watch: number | undefined;
  if (navigator.geolocation && window.isSecureContext) {
    watch = navigator.geolocation.watchPosition(
      (p) => {
        if (place?.placed === 'map') return;
        place = {
          lon: p.coords.longitude,
          lat: p.coords.latitude,
          accuracy: p.coords.accuracy,
          placed: 'gps',
        };
        drawPlace();
      },
      () => {
        if (!place) where.textContent = t('GPS is not allowed. Tap where you are on the map.');
      },
      { enableHighAccuracy: true, maximumAge: 10_000, timeout: 30_000 },
    );
  }
  map.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    const box = map.getBoundingClientRect();
    const u = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width));
    const v = Math.min(1, Math.max(0, (event.clientY - box.top) / box.height));
    const [lon, lat] = tableToLonLat(site, u, v);
    place = {
      lon: Math.round(lon * 1e7) / 1e7,
      lat: Math.round(lat * 1e7) / 1e7,
      placed: 'map',
    };
    drawPlace();
  });

  // ---- What: a photo or a sound ----
  const choose = el('div', 'field-choose');
  const photoButton = el('button', 'action field-kind', `📷  ${t('Photo')}`);
  const soundButton = el('button', 'action field-kind', `🎙  ${t('Sound')}`);
  for (const b of [photoButton, soundButton]) b.type = 'button';
  if (design.media !== 'sound') choose.append(photoButton);
  if (design.media !== 'photo') choose.append(soundButton);
  choose.hidden = design.media === 'none';

  // ---- What it is, and how it feels (#628) ----
  let label: string | undefined;
  let feeling: number | undefined;
  const kinds = el('div', 'field-kinds');
  kinds.hidden = design.kinds.length === 0;
  kinds.setAttribute('role', 'radiogroup');
  kinds.setAttribute('aria-label', t('What is it?'));
  for (const name of design.kinds) {
    const chip = el('button', 'field-chip', name);
    chip.type = 'button';
    chip.setAttribute('role', 'radio');
    chip.setAttribute('aria-checked', 'false');
    chip.onclick = () => {
      label = label === name ? undefined : name;
      for (const c of kinds.children) c.setAttribute('aria-checked', String(c === chip && label !== undefined));
      check();
    };
    kinds.append(chip);
  }
  const feelings = el('div', 'field-feelings');
  feelings.hidden = !design.feeling;
  feelings.setAttribute('role', 'radiogroup');
  feelings.setAttribute('aria-label', t('How do you like this spot?'));
  FACES.forEach((face, i) => {
    const button = el('button', 'field-face', face);
    button.type = 'button';
    button.setAttribute('role', 'radio');
    button.setAttribute('aria-checked', 'false');
    button.setAttribute('aria-label', t(['Don’t like it', 'Not much', 'It’s OK', 'Like it', 'Love it'][i]!));
    button.onclick = () => {
      feeling = feeling === i + 1 ? undefined : i + 1;
      for (const b of feelings.children) b.setAttribute('aria-checked', String(b === button && feeling !== undefined));
      check();
    };
    feelings.append(button);
  });
  const preview = el('div', 'field-preview');
  const photoInput = el('input');
  Object.assign(photoInput, { type: 'file', accept: 'image/*', hidden: true });
  photoInput.setAttribute('capture', 'environment');
  const soundInput = el('input');
  Object.assign(soundInput, { type: 'file', accept: 'audio/*', hidden: true });
  soundInput.setAttribute('capture', 'user');

  let media: {
    kind: 'photo' | 'sound';
    blob: Blob;
    mime: string;
    thumb?: string;
    duration?: number;
  } | null = null;
  const working = el('p', 'tool-hint');

  photoButton.onclick = () => photoInput.click();
  photoInput.onchange = async () => {
    const file = photoInput.files?.[0];
    photoInput.value = '';
    if (!file) return;
    working.textContent = t('Getting the photo ready…');
    try {
      const { blob, thumb } = await shrinkPhoto(file);
      media = { kind: 'photo', blob, mime: 'image/jpeg', thumb };
      const img = el('img', 'field-photo');
      img.src = URL.createObjectURL(blob);
      preview.replaceChildren(img);
      working.textContent = '';
    } catch {
      working.textContent = t('That photo could not be read. Try again.');
    }
    check();
  };

  soundInput.onchange = () => {
    const file = soundInput.files?.[0];
    soundInput.value = '';
    if (!file) return;
    showSound(file, file.type || 'audio/mp4');
  };
  const showSound = (blob: Blob, mime: string, duration?: number) => {
    media = { kind: 'sound', blob, mime, duration };
    const audio = el('audio', 'field-audio');
    audio.controls = true;
    audio.src = URL.createObjectURL(blob);
    preview.replaceChildren(audio);
    check();
  };

  let recorder: MediaRecorder | null = null;
  soundButton.onclick = async () => {
    if (!canRecord()) {
      soundInput.click();
      return;
    }
    if (recorder) {
      recorder.stop();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const type = recordingType();
      recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
      const parts: Blob[] = [];
      const started = performance.now();
      const meter = el('div', 'field-recording');
      const time = el('b', undefined, '0:00');
      meter.append(el('i'), time, el('span', undefined, t('Recording. Tap Stop when done.')));
      preview.replaceChildren(meter);
      soundButton.textContent = `■  ${t('Stop')}`;
      photoButton.disabled = true;
      const tick = window.setInterval(() => {
        const s = (performance.now() - started) / 1000;
        time.textContent = `${minutes(s)} / ${minutes(SOUND_MAX_S)}`;
        if (s >= SOUND_MAX_S) recorder?.stop();
      }, 250);
      recorder.ondataavailable = (e) => e.data.size && parts.push(e.data);
      recorder.onstop = () => {
        clearInterval(tick);
        for (const track of stream.getTracks()) track.stop();
        const mime = recorder?.mimeType || type || 'audio/webm';
        recorder = null;
        soundButton.textContent = `🎙  ${t('Record again')}`;
        photoButton.disabled = false;
        showSound(new Blob(parts, { type: mime }), mime, Math.round((performance.now() - started) / 100) / 10);
      };
      recorder.start(1000);
    } catch {
      recorder = null;
      working.textContent = t('The microphone is not allowed. Pick a recording instead.');
      soundInput.click();
    }
  };

  // ---- A note, and Save ----
  const note = el('input', 'field-note');
  Object.assign(note, {
    maxLength: 140,
    placeholder: t('A few words (optional)'),
    autocomplete: 'off',
    enterKeyHint: 'done',
  });
  const actions = el('div', 'field-actions');
  const cancel = el('button', 'action', t('Cancel'));
  const keep = el('button', 'action primary', t('Save spot'));
  for (const b of [cancel, keep]) b.type = 'button';
  actions.append(cancel, keep);

  // A spot needs its place, and a photo or sound unless the walk takes neither. With kinds, a kind;
  // with feelings, a feeling: what the walk is for.
  function check() {
    const taken = design.media === 'none' || media !== null;
    const said = (design.kinds.length === 0 || label !== undefined) && (!design.feeling || feeling !== undefined);
    keep.disabled = !taken || !said || !place || !onMap(place.lon, place.lat) || recorder !== null;
  }
  const close = () => {
    if (watch !== undefined) navigator.geolocation.clearWatch(watch);
    recorder?.stop();
    sheet.remove();
  };
  cancel.onclick = close;
  keep.onclick = async () => {
    if ((!media && design.media !== 'none') || !place) return;
    keep.disabled = true;
    await save({
      id: newId(),
      kind: media?.kind ?? 'mark',
      label,
      feeling,
      at: Date.now(),
      lon: place.lon,
      lat: place.lat,
      accuracy: place.accuracy,
      placed: place.placed,
      note: note.value.trim() || undefined,
      mime: media?.mime ?? '',
      bytes: media?.blob.size ?? 0,
      duration: media?.duration,
      blob: media?.blob,
      thumb: media?.thumb,
      sent: false,
      have: 0,
    });
    close();
  };

  card.append(el('h2', 'field-sheet-title', t('Mark a spot')), map, where, kinds, feelings, choose, photoInput, soundInput, preview, working, note, actions);
  drawPlace();
  return sheet;
}
