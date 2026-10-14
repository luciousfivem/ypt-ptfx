import { MessageChannel } from 'node:worker_threads';
import { describe, expect, it } from 'vitest';
import { createClient, serve, type Port } from '../src/lib/rpc';

function pair(): [Port, Port] {
  const { port1, port2 } = new MessageChannel();
  const wrap = (p: typeof port1): Port => {
    const w: Port = {
      postMessage: (m, t) => p.postMessage(m, (t ?? []) as never),
      onmessage: null,
    };
    p.on('message', (data) => w.onmessage?.({ data }));
    return w;
  };
  return [wrap(port1), wrap(port2)];
}

describe('rpc', () => {
  it('calls worker methods and returns results, including async ones', async () => {
    const [a, b] = pair();
    serve(b, () => ({ add: (x: number, y: number) => x + y, slow: async (n: number) => { await new Promise((r) => setTimeout(r, 5)); return n * 2; } }));
    const c = createClient<{ add: (x: number, y: number) => number; slow: (n: number) => Promise<number> }>(a);
    expect(await c.api.add(2, 3)).toBe(5);
    expect(await c.api.slow(21)).toBe(42);
    expect(await Promise.all([c.api.add(1, 1), c.api.add(2, 2), c.api.slow(1)])).toEqual([2, 4, 2]);
  });

  it('preserves error names and messages across the boundary', async () => {
    const [a, b] = pair();
    serve(b, () => ({ boom: () => { const e = new Error('kaboom'); e.name = 'RangeError'; throw e; } }));
    const c = createClient<{ boom: () => void; missing: () => void }>(a);
    await expect(c.api.boom()).rejects.toMatchObject({ name: 'RangeError', message: 'kaboom' });
    await expect(c.api.missing()).rejects.toThrow(/Unknown method "missing"/);
  });

  it('lets a long-running worker job call back into the main thread', async () => {
    const [a, b] = pair();
    serve<{ job: (n: number) => Promise<string> }, { ask: (q: string) => string }>(b, (host) => ({
      job: async (n: number) => {
        const answers: string[] = [];
        for (let i = 0; i < n; i++) answers.push(await host.ask(`q${i}`));
        return answers.join(',');
      },
    }));
    const c = createClient<{ job: (n: number) => Promise<string> }>(a, { ask: (q: string) => q.toUpperCase() });
    expect(await c.api.job(3)).toBe('Q0,Q1,Q2');
  });

  it('host errors propagate back into the worker job', async () => {
    const [a, b] = pair();
    serve<{ job: () => Promise<string> }, { fail: () => string }>(b, (host) => ({ job: async () => { try { await host.fail(); return 'no'; } catch (e) { return `caught: ${(e as Error).message}`; } } }));
    const c = createClient<{ job: () => Promise<string> }>(a, { fail: () => { throw new Error('platform exploded'); } });
    expect(await c.api.job()).toBe('caught: platform exploded');
  });

  it('dispose rejects every in-flight call', async () => {
    const [a, b] = pair();
    serve(b, () => ({ hang: () => new Promise<void>(() => {}) }));
    const c = createClient<{ hang: () => void }>(a);
    const p = c.api.hang();
    c.dispose('stopped');
    await expect(p).rejects.toThrow('stopped');
  });

  it('transfers binary data without copying when asked', async () => {
    const [a, b] = pair();
    serve(b, () => ({ size: (buf: ArrayBuffer) => buf.byteLength }));
    const c = createClient<{ size: (b: ArrayBuffer) => number }>(a);
    const buf = new ArrayBuffer(1024);
    expect(await c.callTransfer('size', [buf], [buf])).toBe(1024);
    expect(buf.byteLength).toBe(0); // detached = transferred, not copied
  });
});
