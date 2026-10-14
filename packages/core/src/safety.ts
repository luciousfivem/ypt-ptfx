/**
 * Filename / path hygiene shared by every export path. Anything that ends up as a
 * file name, a zip entry, a FiveM resource name, a texture name or a Lua identifier
 * passes through one of these functions first.
 */

const WINDOWS_RESERVED = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

/**
 * Makes an arbitrary user string safe to use as a single path component on
 * Windows, macOS and Linux. Never returns an empty string, "." or "..".
 */
export function sanitizeFilename(input: string, fallback = 'untitled'): string {
  let s = input
    // strip control chars and path separators / reserved characters
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '_')
    .normalize('NFC')
    .trim()
    // Windows silently strips trailing dots and spaces
    .replace(/[. ]+$/g, '')
    .replace(/^\.+/, '');
  if (s.length > 100) s = s.slice(0, 100).replace(/[. ]+$/g, '');
  if (s === '') return fallback;
  const stem = s.split('.')[0]!.toLowerCase();
  if (WINDOWS_RESERVED.has(stem)) s = `_${s}`;
  return s;
}

/**
 * FiveM resource folder / asset names: lowercase `[a-z0-9_]`, must start with a
 * letter, 1..48 chars. These show up in Lua strings and as hashed identifiers, so
 * the alphabet is deliberately tiny.
 */
export function sanitizeIdentifier(input: string, fallback = 'vfxforge_fx'): string {
  let s = input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (s === '') return fallback;
  if (!/^[a-z]/.test(s)) s = `fx_${s}`;
  return s.slice(0, 48).replace(/_+$/g, '') || fallback;
}

export function isValidIdentifier(s: string): boolean {
  return /^[a-z][a-z0-9_]{0,47}$/.test(s);
}

/**
 * True when `p` is a relative path that cannot escape its base: no absolute
 * paths, no drive letters, no `..` segments, no NUL, no backslash tricks.
 */
export function isSafeRelativePath(p: string): boolean {
  if (p === '' || p.includes('\0')) return false;
  if (p.startsWith('/') || p.startsWith('\\') || /^[a-zA-Z]:/.test(p)) return false;
  const segments = p.split(/[\\/]/);
  return segments.every((seg) => seg !== '..' && seg !== '.' && seg !== '');
}

export function assertSafeRelativePath(p: string): string {
  if (!isSafeRelativePath(p)) throw new Error(`Unsafe relative path rejected: ${JSON.stringify(p)}`);
  return p;
}

/** Escapes text for placement inside a single-quoted Lua string literal. */
export function luaEscape(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, (c) => `\\${c.charCodeAt(0).toString().padStart(3, '0')}`);
}

/** Escapes text for XML 1.0 element content / attribute values. */
export function xmlEscape(s: string): string {
  return s
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Ensures a unique name by appending _2, _3 ... when `taken` already contains it. */
export function uniqueName(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let i = 2; i < 10_000; i++) {
    const candidate = `${base}_${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error(`Could not find a unique name for ${base}`);
}
