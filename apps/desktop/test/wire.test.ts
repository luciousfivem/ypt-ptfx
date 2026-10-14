import { describe, expect, it } from 'vitest';
import { packWire, unpackWire } from '../src/platform/wire';

/** The same bytes are asserted by `wire::tests::matches_the_typescript_reference_bytes` in Rust. */
const REFERENCE_HEX = '5646585701' + '07000000' + '7b2261223a317d' + '02000000' + '03000000010203' + '00000000';

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

describe('VFXW wire container', () => {
  it('produces the cross-language reference bytes', () => {
    expect(hex(packWire({ a: 1 }, [new Uint8Array([1, 2, 3]), new Uint8Array()]))).toBe(REFERENCE_HEX);
  });

  it('round-trips JSON and blobs', () => {
    const big = new Uint8Array(200_000).map((_, i) => i % 251);
    const { json, blobs } = unpackWire<{ name: string }>(packWire({ name: 'é✓' }, [big, new Uint8Array([9])]));
    expect(json.name).toBe('é✓');
    expect(blobs).toHaveLength(2);
    expect(blobs[0]).toEqual(big);
    expect([...blobs[1]!]).toEqual([9]);
  });

  it('rejects truncated, mislabelled and padded messages instead of reading out of bounds', () => {
    const good = packWire({}, [new Uint8Array([1, 2, 3])]);
    for (let cut = 0; cut < good.length; cut++) expect(() => unpackWire(good.subarray(0, cut)), `cut at ${cut}`).toThrow();
    expect(() => unpackWire(new Uint8Array([...good, 0]))).toThrow(/trailing/);
    const wrongMagic = good.slice();
    wrongMagic[0] = 0;
    expect(() => unpackWire(wrongMagic)).toThrow(/format/);
    const wrongVersion = good.slice();
    wrongVersion[4] = 7;
    expect(() => unpackWire(wrongVersion)).toThrow(/version/);
  });

  it('does not trust hostile length fields', () => {
    const m = packWire({}, []);
    const huge = m.slice();
    new DataView(huge.buffer).setUint32(5, 0xffffffff, true);
    expect(() => unpackWire(huge)).toThrow();
    const manyBlobs = m.slice();
    new DataView(manyBlobs.buffer).setUint32(m.length - 4, 0xffffffff, true);
    expect(() => unpackWire(manyBlobs)).toThrow();
  });
});
