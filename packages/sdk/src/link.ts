/**
 * The frames phones' traffic travels in when it does not reach the studio directly (#89,
 * #275): through the relay, or over WebRTC from the join page. Same layout as
 * `mrs_relay::protocol`: one byte for the kind, four for the stream (big endian), then the
 * payload. HTTP heads are JSON followed by a zero byte and the body.
 *
 * A WebRTC data channel carries messages of limited size, so over it every frame is cut into
 * pieces: one byte (1 = more follows, 0 = last piece) and up to PIECE bytes of the frame.
 */

/**
 * The link's version: what the join page and a table's bridge must agree on. It goes up only
 * when this format or the join page's handshake changes in a way older tables cannot follow,
 * and each version's join page stays published at `/v<N>/`. The host checks it matches
 * `mrs_host::bridge::LINK_VERSION`.
 */
export const LINK_VERSION = 1;

/** The bridge's first message on a new data channel: stream 0, JSON `{ "v": LINK_VERSION }`. */
export const LINK_HELLO = 7;

export const HTTP_REQUEST = 1;
export const HTTP_RESPONSE = 2;
export const WS_OPEN = 3;
export const WS_TEXT = 4;
export const WS_BINARY = 5;
export const WS_CLOSE = 6;

/** Bytes of a frame per data channel message; small enough for every browser. */
export const PIECE = 16 * 1024;

export interface HttpHead {
  method?: string;
  path?: string;
  status?: number;
  headers: [string, string][];
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function frame(kind: number, stream: number, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
  const out = new Uint8Array(5 + payload.length);
  out[0] = kind;
  new DataView(out.buffer).setUint32(1, stream >>> 0);
  out.set(payload, 5);
  return out;
}

export function withHead(kind: number, stream: number, head: object, body: Uint8Array = new Uint8Array(0)): Uint8Array {
  const json = encoder.encode(JSON.stringify(head));
  const payload = new Uint8Array(json.length + 1 + body.length);
  payload.set(json, 0);
  payload.set(body, json.length + 1);
  return frame(kind, stream, payload);
}

export function textFrame(kind: number, stream: number, text: string): Uint8Array {
  return frame(kind, stream, encoder.encode(text));
}

export interface Parsed {
  kind: number;
  stream: number;
  payload: Uint8Array;
}

export function parse(bytes: Uint8Array): Parsed | null {
  if (bytes.length < 5) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { kind: bytes[0]!, stream: view.getUint32(1), payload: bytes.subarray(5) };
}

/** A frame with its stream number changed, as the bridge renumbers each phone's streams. */
export function restream(bytes: Uint8Array, stream: number): Uint8Array {
  const out = bytes.slice();
  new DataView(out.buffer).setUint32(1, stream >>> 0);
  return out;
}

export function splitHead<T>(payload: Uint8Array): { head: T; body: Uint8Array } | null {
  const end = payload.indexOf(0);
  if (end < 0) return null;
  try {
    return { head: JSON.parse(decoder.decode(payload.subarray(0, end))) as T, body: payload.subarray(end + 1) };
  } catch {
    return null;
  }
}

export function text(payload: Uint8Array): string {
  return decoder.decode(payload);
}

/** A frame cut into data channel messages. */
export function pieces(bytes: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let at = 0; at < bytes.length || out.length === 0; at += PIECE) {
    const chunk = bytes.subarray(at, at + PIECE);
    const piece = new Uint8Array(chunk.length + 1);
    piece[0] = at + PIECE < bytes.length ? 1 : 0;
    piece.set(chunk, 1);
    out.push(piece);
  }
  return out;
}

/** Puts pieces back together: `push` returns a whole frame on its last piece. */
export class Joiner {
  private parts: Uint8Array[] = [];
  private size = 0;
  private readonly limit: number;
  constructor(limit = 64 * 1024 * 1024 + 4096) {
    this.limit = limit;
  }

  push(piece: Uint8Array): Uint8Array | null {
    if (piece.length === 0) return null;
    const chunk = piece.subarray(1);
    this.size += chunk.length;
    if (this.size > this.limit) {
      this.parts = [];
      this.size = 0;
      throw new Error('frame too large');
    }
    this.parts.push(chunk);
    if (piece[0] === 1) return null;
    const whole = new Uint8Array(this.size);
    let at = 0;
    for (const part of this.parts) {
      whole.set(part, at);
      at += part.length;
    }
    this.parts = [];
    this.size = 0;
    return whole;
  }
}

/** Bytes from whatever a data channel delivers. */
export async function bytesOf(data: unknown): Promise<Uint8Array | null> {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (typeof Blob !== 'undefined' && data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
  return null;
}
