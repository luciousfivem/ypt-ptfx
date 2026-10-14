import { describe, expect, it } from 'vitest';
import { sha256Hex, sniffBytes } from '../src';

const bytes = (...n: number[]) => new Uint8Array(n);
const text = (s: string) => new TextEncoder().encode(s);

describe('sniffBytes', () => {
  it('detects image, video and model signatures', () => {
    expect(sniffBytes(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)).kind).toBe('png');
    expect(sniffBytes(bytes(0xff, 0xd8, 0xff, 0xe0)).kind).toBe('jpeg');
    expect(sniffBytes(text('GIF89a....')).kind).toBe('gif');
    expect(sniffBytes(text('RIFF\0\0\0\0WEBPVP8 ')).kind).toBe('webp');
    expect(sniffBytes(text('RIFF\0\0\0\0AVI LIST')).kind).toBe('avi');
    expect(sniffBytes(new Uint8Array([0, 0, 0, 0x20, ...text('ftypisom'), 0, 0, 2, 0])).kind).toBe('mp4');
    expect(sniffBytes(new Uint8Array([0, 0, 0, 0x14, ...text('ftypqt  '), 0, 0, 0, 0])).kind).toBe('mov');
    expect(sniffBytes(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x82, 0x84, ...text('webm')])).kind).toBe('webm');
    expect(sniffBytes(bytes(0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0)).kind).toBe('mkv');
    expect(sniffBytes(text('glTF\x02\0\0\0')).kind).toBe('glb');
    expect(sniffBytes(text('Kaydara FBX Binary  \0\x1a\0')).kind).toBe('fbx');
    expect(sniffBytes(text('{"asset":{"version":"2.0"},"scenes":[]}')).kind).toBe('gltf');
    expect(sniffBytes(text('# c\nv 0 0 0\nf 1 2 3\n')).kind).toBe('obj');
  });

  it('distinguishes APNG from PNG', () => {
    const png = (animated: boolean) => {
      const v: number[] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, ...text('IHDR'), ...new Array(13).fill(0), 0, 0, 0, 0];
      if (animated) v.push(0, 0, 0, 8, ...text('acTL'), ...new Array(8).fill(0), 0, 0, 0, 0);
      v.push(0, 0, 0, 0, ...text('IDAT'));
      return new Uint8Array(v);
    };
    expect(sniffBytes(png(false)).kind).toBe('png');
    expect(sniffBytes(png(true)).kind).toBe('apng');
  });

  it('never classifies playlists, scripts or noise as media', () => {
    for (const s of ['#EXTM3U\n#EXT-X-VERSION:3\nfile:///etc/passwd\n', "ffconcat version 1.0\nfile '/etc/passwd'\n", '<?xml version="1.0"?><svg/>', '#!/bin/sh\nrm -rf /\n']) expect(sniffBytes(text(s)).kind, s).toBe('unknown');
    expect(sniffBytes(new Uint8Array(0)).kind).toBe('unknown');
    expect(sniffBytes(bytes(1, 2, 3, 4, 5)).kind).toBe('unknown');
    expect(sniffBytes(new Uint8Array([...text('v 0 0 0\n'), 0, 1, 2])).kind).toBe('unknown'); // NUL => binary, not an OBJ
  });

  it('reports mime, category and the canonical extension (not the file name)', () => {
    expect(sniffBytes(bytes(0xff, 0xd8, 0xff))).toMatchObject({ category: 'image', mime: 'image/jpeg', ext: 'jpg' });
    expect(sniffBytes(text('glTF\x02\0\0\0'))).toMatchObject({ category: 'model', ext: 'glb' });
  });

  it('hashes with SHA-256', async () => {
    expect(await sha256Hex(text('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
