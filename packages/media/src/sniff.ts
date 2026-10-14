/**
 * Content-based file type detection (magic numbers) — the TypeScript twin of
 * native/vfxforge-native/src/sniff.rs, used where the Rust layer is not available (browser mode)
 * and to validate bytes before they are decoded. File extensions are never trusted.
 */
export type MediaKind = 'png' | 'apng' | 'jpeg' | 'gif' | 'webp' | 'mp4' | 'mov' | 'webm' | 'mkv' | 'avi' | 'glb' | 'gltf' | 'obj' | 'fbx' | 'unknown';
export type MediaCategory = 'image' | 'video' | 'model' | 'unknown';

export interface Sniffed {
  kind: MediaKind;
  category: MediaCategory;
  mime: string;
  /** Canonical extension (no dot). */
  ext: string;
}

const META: Record<MediaKind, { category: MediaCategory; mime: string; ext: string }> = {
  png: { category: 'image', mime: 'image/png', ext: 'png' },
  apng: { category: 'image', mime: 'image/apng', ext: 'png' },
  jpeg: { category: 'image', mime: 'image/jpeg', ext: 'jpg' },
  gif: { category: 'image', mime: 'image/gif', ext: 'gif' },
  webp: { category: 'image', mime: 'image/webp', ext: 'webp' },
  mp4: { category: 'video', mime: 'video/mp4', ext: 'mp4' },
  mov: { category: 'video', mime: 'video/quicktime', ext: 'mov' },
  webm: { category: 'video', mime: 'video/webm', ext: 'webm' },
  mkv: { category: 'video', mime: 'video/x-matroska', ext: 'mkv' },
  avi: { category: 'video', mime: 'video/x-msvideo', ext: 'avi' },
  glb: { category: 'model', mime: 'model/gltf-binary', ext: 'glb' },
  gltf: { category: 'model', mime: 'model/gltf+json', ext: 'gltf' },
  obj: { category: 'model', mime: 'model/obj', ext: 'obj' },
  fbx: { category: 'model', mime: 'application/octet-stream', ext: 'fbx' },
  unknown: { category: 'unknown', mime: 'application/octet-stream', ext: 'bin' },
};

const ascii = (b: Uint8Array, at: number, s: string): boolean => {
  if (b.length < at + s.length) return false;
  for (let i = 0; i < s.length; i++) if (b[at + i] !== s.charCodeAt(i)) return false;
  return true;
};

function pngIsAnimated(b: Uint8Array): boolean {
  let i = 8;
  while (i + 8 <= b.length) {
    const len = ((b[i]! << 24) | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!) >>> 0;
    if (ascii(b, i + 4, 'acTL')) return true;
    if (ascii(b, i + 4, 'IDAT') || ascii(b, i + 4, 'IEND')) return false;
    i += 12 + len;
  }
  return false;
}

function detect(b: Uint8Array): MediaKind {
  if (b.length >= 8 && b[0] === 0x89 && ascii(b, 1, 'PNG') && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return pngIsAnimated(b) ? 'apng' : 'png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (ascii(b, 0, 'GIF87a') || ascii(b, 0, 'GIF89a')) return 'gif';
  if (ascii(b, 0, 'RIFF') && b.length >= 12) {
    if (ascii(b, 8, 'WEBP')) return 'webp';
    if (ascii(b, 8, 'AVI ')) return 'avi';
  }
  if (b.length >= 12 && ascii(b, 4, 'ftyp')) return ascii(b, 8, 'qt  ') ? 'mov' : 'mp4';
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) {
    const head = new TextDecoder('latin1').decode(b.subarray(0, Math.min(64, b.length)));
    return head.includes('webm') ? 'webm' : 'mkv';
  }
  if (ascii(b, 0, 'glTF')) return 'glb';
  if (ascii(b, 0, 'Kaydara FBX Binary  ')) return 'fbx';
  // text formats: only when the head decodes as UTF-8 text without NULs
  const headBytes = b.subarray(0, Math.min(4096, b.length));
  if (!headBytes.includes(0)) {
    let text = '';
    try {
      text = new TextDecoder('utf-8', { fatal: false }).decode(headBytes);
    } catch {
      return 'unknown';
    }
    if (text.trimStart().startsWith('{') && text.includes('"asset"') && text.includes('"version"')) return 'gltf';
    const looksObj = text
      .split('\n')
      .slice(0, 200)
      .some((l) => /^(v|vn|vt|f)\s/.test(l.trimStart()));
    if (looksObj) return 'obj';
  }
  return 'unknown';
}

export function sniffBytes(head: Uint8Array): Sniffed {
  const kind = detect(head);
  return { kind, ...META[kind] };
}

export async function sha256Hex(data: Uint8Array | ArrayBuffer): Promise<string> {
  const buf = data instanceof Uint8Array ? (data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer) : data;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}
