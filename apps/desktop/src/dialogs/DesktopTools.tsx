import { FolderOpen } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge, Button, Field, TextField } from '../components/ui';
import type { ToolPaths, ToolsStatus } from '../platform';
import { svc } from '../services/app';
import { toast } from '../state/ui';

const LABEL: Record<keyof ToolPaths, string> = { ffmpeg: 'FFmpeg', ffprobe: 'FFprobe', dotnet: '.NET (dotnet)', dll: 'ypt-bridge DLL' };

/** Desktop-only: locate FFmpeg and the CodeWalker converter bridge. Empty = search PATH / next to the app. */
export function DesktopTools({ onChanged }: { onChanged: () => void }) {
  const tools = svc().platform.tools!;
  const [status, setStatus] = useState<ToolsStatus | null>(null);
  const [paths, setPaths] = useState<ToolPaths>({ ffmpeg: null, ffprobe: null, dotnet: null, dll: null });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void tools.status().then((s) => {
      if (!live) return;
      setStatus(s);
      setPaths(s.paths);
    });
    return () => {
      live = false;
    };
  }, [tools]);

  const browse = async (key: keyof ToolPaths) => {
    const picked = await svc().platform.pickFiles({ accept: key === 'dll' ? ['.dll'] : [], title: `Locate ${LABEL[key]}` });
    const f = picked[0];
    if (typeof f === 'string') setPaths((p) => ({ ...p, [key]: f }));
  };

  const apply = async () => {
    setBusy(true);
    try {
      const s = await tools.setPaths(paths);
      setStatus(s);
      await svc().platform.refresh?.();
      onChanged();
      toast('ok', 'Tool locations saved.');
    } catch (e) {
      toast('error', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const entry = (k: 'ffmpeg' | 'ffprobe') => status?.[k];
  return (
    <div className="space-y-2 border-t border-lines pt-3" data-testid="desktop-tools">
      <p className="text-[12px] font-medium text-fg">Tools</p>
      <p className="text-[11px] leading-snug text-dim">Leave a path empty to search PATH and the folder of the app. The converter bridge is a separate program you build against your own CodeWalker checkout (docs/YPT_BRIDGE.md).</p>
      {(Object.keys(LABEL) as Array<keyof ToolPaths>).map((k) => (
        <Field key={k} label={LABEL[k]}>
          <div className="flex gap-1">
            <TextField mono value={paths[k] ?? ''} placeholder="auto-detect" onChange={(v) => setPaths((p) => ({ ...p, [k]: v.trim() === '' ? null : v }))} />
            <Button size="sm" aria-label={`Browse for ${LABEL[k]}`} icon={<FolderOpen className="size-3.5" aria-hidden />} onClick={() => void browse(k)} />
          </div>
          {(k === 'ffmpeg' || k === 'ffprobe') && entry(k) && (
            <p className="mt-0.5 text-[10.5px]">{entry(k)!.available ? <Badge tone="ok">found</Badge> : <Badge tone="warn">not found</Badge>} <span className="text-dim">{entry(k)!.available ? (entry(k)!.version ?? entry(k)!.path) : entry(k)!.detail}</span></p>
          )}
          {k === 'dll' && status && <p className="mt-0.5 text-[10.5px]">{status.bridge.available ? <Badge tone="ok">ready</Badge> : <Badge tone="warn">unavailable</Badge>} <span className="text-dim">{status.bridge.available ? (status.bridge.codewalkerCore ?? status.bridge.version) : status.bridge.detail}</span></p>}
        </Field>
      ))}
      <Button variant="primary" size="sm" loading={busy} onClick={() => void apply()}>Apply</Button>
    </div>
  );
}
