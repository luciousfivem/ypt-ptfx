import { luaEscape } from '@vfxforge/core';

/** A Lua number literal. Rejects NaN/Infinity (they would produce invalid or nonsensical Lua). */
export function lnum(n: number): string {
  if (!Number.isFinite(n)) throw new RangeError(`Cannot write non-finite number ${n} into Lua`);
  if (Number.isInteger(n)) return String(n);
  return String(Math.round(n * 1e6) / 1e6);
}

export function lstr(s: string): string {
  return `'${luaEscape(s)}'`;
}

export function lvec(v: readonly [number, number, number]): string {
  return `{ x = ${lnum(v[0])}, y = ${lnum(v[1])}, z = ${lnum(v[2])} }`;
}

export function lbool(b: boolean): string {
  return b ? 'true' : 'false';
}
