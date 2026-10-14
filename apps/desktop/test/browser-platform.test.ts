import { afterEach, describe, expect, it, vi } from 'vitest';
import { YDR_BROWSER_ERROR } from '../src/lib/model-files';
import { createBrowserPlatform } from '../src/platform/browser';

// RSC7 header (what a real .ydr starts with) followed by filler
const rsc7 = () => new Uint8Array([0x52, 0x53, 0x43, 0x37, 0xa5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4]);

afterEach(() => vi.restoreAllMocks());

describe('browser platform and GTA V drawables', () => {
  it('rejects a .ydr up front with the actionable message, before reading or storing anything, without logging an error', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const p = createBrowserPlatform();
    for (const name of ['w_ar_k2light.ydr', 'UPPER.YDR', 'with space.ydr']) {
      const file = new File([rsc7()], name);
      const read = vi.spyOn(file, 'arrayBuffer');
      const slice = vi.spyOn(file, 'slice');
      await expect(p.importAsset(file)).rejects.toThrow(YDR_BROWSER_ERROR);
      expect(read).not.toHaveBeenCalled();
      expect(slice).not.toHaveBeenCalled();
    }
    // an empty file named .ydr gets the same message, not "is empty"
    await expect(p.importAsset(new File([], 'empty.ydr'))).rejects.toThrow(/desktop app/);
    expect(errors).not.toHaveBeenCalled();
  });

  it('the message tells the user what is needed and what works here', async () => {
    const p = createBrowserPlatform();
    const err = await p.importAsset(new File([rsc7()], 'x.ydr')).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/desktop app/);
    expect((err as Error).message).toMatch(/converter bridge/);
    expect((err as Error).message).toMatch(/docs\/YPT_BRIDGE\.md/);
    expect((err as Error).message).toMatch(/\.glb/);
  });

  it('RSC7 content under another name is still not media: content decides, the .ydr message is only for .ydr names', async () => {
    const p = createBrowserPlatform();
    const err = await p.importAsset(new File([rsc7()], 'looks_like_a_model.glb')).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/not a recognised image, video or 3D model/);
    expect((err as Error).message).not.toBe(YDR_BROWSER_ERROR);
  });

  it('the browser platform has no converter and says so', async () => {
    const p = createBrowserPlatform();
    expect(p.converter).toBeNull();
    expect(p.features.binaryYpt).toBe(false);
  });
});
