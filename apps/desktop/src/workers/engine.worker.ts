/// <reference lib="webworker" />
import { serve, type Port } from '../lib/rpc';
import { createEngine, type EngineHost } from './engine-core';

serve<ReturnType<typeof createEngine>, EngineHost>(self as unknown as Port, (host) => createEngine(host as unknown as EngineHost));
