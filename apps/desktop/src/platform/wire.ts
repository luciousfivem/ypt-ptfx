/**
 * The VFXW container used for binary IPC with the desktop shell. Byte-for-byte the same format as
 * `native/vfxforge-native/src/wire.rs` (both tests assert the same reference bytes).
 *
 *   "VFXW" | version u8 (=1) | json length u32 LE | json | blob count u32 LE | { length u32 LE | bytes }*
 */
const MAGIC = [0x56, 0x46, 0x58, 0x57];
const VERSION = 1;
export const MAX_JSON_BYTES = 64 * 1024 * 1024;
export const MAX_BLOBS = 4096;

export function packWire(json: unknown, blobs: Uint8Array[] = []): Uint8Array {
  const j = new TextEncoder().encode(JSON.stringify(json));
  if (j.length > MAX_JSON_BYTES || blobs.length > MAX_BLOBS) throw new Error('The message is too large to send.');
  let total = 4 + 1 + 4 + j.length + 4;
  for (const b of blobs) total += 4 + b.length;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  out.set(MAGIC, 0);
  out[4] = VERSION;
  view.setUint32(5, j.length, true);
  out.set(j, 9);
  let at = 9 + j.length;
  view.setUint32(at, blobs.length, true);
  at += 4;
  for (const b of blobs) {
    view.setUint32(at, b.length, true);
    out.set(b, at + 4);
    at += 4 + b.length;
  }
  return out;
}

/** Parses a message from an untrusted peer: every length is checked before it is used. */
export function unpackWire<T = unknown>(bytes: Uint8Array): { json: T; blobs: Uint8Array[] } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 0;
  const need = (n: number) => {
    if (n < 0 || at + n > bytes.length) throw new Error('The message from the app core is truncated.');
  };
  need(5);
  for (let i = 0; i < 4; i++) if (bytes[i] !== MAGIC[i]) throw new Error('The message from the app core is not in the expected format.');
  if (bytes[4] !== VERSION) throw new Error('The message from the app core has an unsupported version.');
  at = 5;
  need(4);
  const jl = view.getUint32(at, true);
  at += 4;
  if (jl > MAX_JSON_BYTES) throw new Error('The message header is too large.');
  need(jl);
  const json = JSON.parse(new TextDecoder().decode(bytes.subarray(at, at + jl))) as T;
  at += jl;
  need(4);
  const count = view.getUint32(at, true);
  at += 4;
  if (count > MAX_BLOBS) throw new Error('The message has too many attachments.');
  const blobs: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    need(4);
    const l = view.getUint32(at, true);
    at += 4;
    need(l);
    blobs.push(bytes.subarray(at, at + l));
    at += l;
  }
  if (at !== bytes.length) throw new Error('The message has unexpected trailing bytes.');
  return { json, blobs };
}
