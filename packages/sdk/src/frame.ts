import type { FieldFrame } from './types.ts';

export const FRAME_HEADER_LEN = 40;

/** Parses a binary field frame. Layout in docs/contracts/engine.md. */
export function parseFrame(buffer: ArrayBuffer): FieldFrame {
  if (buffer.byteLength < FRAME_HEADER_LEN) throw new Error('field frame is too short');
  const view = new DataView(buffer);
  const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (magic !== 'MRSF' || view.getUint16(4, true) !== 1) throw new Error('not a version 1 field frame');
  const encoding = view.getUint16(6, true);
  const width = view.getUint32(16, true);
  const height = view.getUint32(20, true);
  const count = width * height;
  const expected = FRAME_HEADER_LEN + count * (encoding === 0 ? 4 : 1);
  if (buffer.byteLength !== expected) throw new Error(`field frame is ${buffer.byteLength} bytes, expected ${expected}`);
  return {
    stream: view.getUint32(8, true),
    field: view.getUint32(12, true),
    width,
    height,
    revision: view.getUint32(24, true),
    min: view.getFloat32(28, true),
    max: view.getFloat32(32, true),
    progress: view.getFloat32(36, true),
    data: encoding === 0 ? new Float32Array(buffer, FRAME_HEADER_LEN, count) : new Uint8Array(buffer, FRAME_HEADER_LEN, count),
  };
}

/** The value of a cell in field units, whatever the encoding. */
export function sample(frame: FieldFrame, col: number, row: number): number {
  const raw = frame.data[row * frame.width + col] ?? 0;
  return frame.data instanceof Uint8Array ? frame.min + (raw / 255) * (frame.max - frame.min) : raw;
}
