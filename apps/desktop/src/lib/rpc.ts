/**
 * Tiny typed RPC between the main thread and a worker.
 *
 *   main  -> worker   client.call('method', ...args)          resolves with the method's result
 *   worker -> main    host.call('method', ...args)             lets a long-running worker job ask the
 *                                                               main thread for things only it can do
 *                                                               (platform I/O, the native converter)
 *
 * Errors keep their name and message across the boundary. Works over any MessagePort-like object,
 * so tests can run the exact production code over a `MessageChannel` with no Worker at all.
 */

export interface Port {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((ev: { data: unknown }) => void) | null;
}

type Msg =
  | { k: 'call'; id: number; method: string; args: unknown[] }
  | { k: 'host'; id: number; method: string; args: unknown[] }
  | { k: 'ret'; id: number; ok: true; value: unknown }
  | { k: 'ret'; id: number; ok: false; error: { name: string; message: string } };

type Fn = (...args: never[]) => unknown;
export type Handlers = Record<string, Fn>;
export type Remote<T extends Handlers> = { [K in keyof T]: (...args: Parameters<T[K]>) => Promise<Awaited<ReturnType<T[K]>>> };

const serialiseError = (e: unknown) => ({ name: e instanceof Error ? e.name : 'Error', message: e instanceof Error ? e.message : String(e) });
const reviveError = (e: { name: string; message: string }) => {
  const err = new Error(e.message);
  err.name = e.name;
  return err;
};

class Endpoint {
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  constructor(
    private readonly port: Port,
    private readonly local: Handlers,
    private readonly outKind: 'call' | 'host',
    private readonly inKind: 'call' | 'host',
  ) {
    port.onmessage = (ev) => void this.onMessage(ev.data as Msg);
  }

  request(method: string, args: unknown[], transfer: Transferable[] = []): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.port.postMessage({ k: this.outKind, id, method, args } satisfies Msg, transfer);
    });
  }

  rejectAll(reason: string): void {
    for (const p of this.pending.values()) p.reject(new Error(reason));
    this.pending.clear();
  }

  private async onMessage(m: Msg): Promise<void> {
    if (m.k === 'ret') {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      m.ok ? p.resolve(m.value) : p.reject(reviveError(m.error));
      return;
    }
    if (m.k !== this.inKind) return;
    try {
      const fn = this.local[m.method];
      if (typeof fn !== 'function') throw new Error(`Unknown method "${m.method}"`);
      const value = await (fn as (...a: unknown[]) => unknown)(...m.args);
      this.port.postMessage({ k: 'ret', id: m.id, ok: true, value } satisfies Msg);
    } catch (e) {
      this.port.postMessage({ k: 'ret', id: m.id, ok: false, error: serialiseError(e) } satisfies Msg);
    }
  }
}

export interface ClientHandle<Api extends Handlers> {
  api: Remote<Api>;
  /** Same as api but lets the caller transfer ArrayBuffers instead of copying them. */
  callTransfer(method: keyof Api & string, args: unknown[], transfer: Transferable[]): Promise<unknown>;
  dispose(reason?: string): void;
}

/** Main-thread side: `host` handlers are what the worker may call back into. */
export function createClient<Api extends Handlers>(port: Port, host: Handlers = {}): ClientHandle<Api> {
  const ep = new Endpoint(port, host, 'call', 'host');
  const api = new Proxy({} as Remote<Api>, {
    get: (_t, method: string) => (...args: unknown[]) => ep.request(method, args),
  });
  return {
    api,
    callTransfer: (method, args, transfer) => ep.request(method, args, transfer),
    dispose: (reason = 'The worker was stopped') => ep.rejectAll(reason),
  };
}

/** Worker side: `factory` receives a proxy to the main-thread host handlers. */
export function serve<Api extends Handlers, Host extends Handlers = Handlers>(port: Port, factory: (host: Remote<Host>) => Api): void {
  let ep: Endpoint;
  const host = new Proxy({} as Remote<Host>, {
    get: (_t, method: string) => (...args: unknown[]) => ep.request(method, args),
  });
  const api = factory(host);
  ep = new Endpoint(port, api, 'host', 'call');
}
