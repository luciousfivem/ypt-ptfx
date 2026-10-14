import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '../../..');
export const BRIDGE_DLL = process.env.VFXFORGE_BRIDGE_DLL ?? resolve(root, 'tools/ypt-bridge/out/vfxforge-ypt-bridge.dll');

function hasDotnet(): boolean {
  try {
    return spawnSync('dotnet', ['--version'], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
}

export const bridgeAvailable = existsSync(BRIDGE_DLL) && hasDotnet();
export const SKIP_REASON = `CodeWalker bridge not built (looked for ${BRIDGE_DLL}). Build it per docs/YPT_BRIDGE.md to run the CodeWalker oracle tests.`;

export interface BridgeReply {
  ok: boolean;
  [k: string]: unknown;
}

export function runBridge(args: string[]): BridgeReply {
  const r = spawnSync('dotnet', [BRIDGE_DLL, ...args], { encoding: 'utf8', env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1' } });
  const line = r.stdout
    .split('\n')
    .reverse()
    .find((l) => l.trim().startsWith('{'));
  if (!line) throw new Error(`bridge printed no JSON (exit ${r.status}): ${r.stdout}\n${r.stderr}`);
  return JSON.parse(line) as BridgeReply;
}

export { execFileSync };
