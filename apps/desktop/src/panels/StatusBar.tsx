import { CheckCircle2, CircleDashed, Loader2, ShieldAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Progress } from '../components/ui';
import { svc } from '../services/app';
import { useProject } from '../state/project';
import { useUi } from '../state/ui';

export function StatusBar() {
  const jobs = useUi((s) => s.jobs);
  const dirty = useProject((s) => s.dirty);
  const undoLabel = useProject((s) => s.undoLabel);
  const [conv, setConv] = useState<{ available: boolean; codewalkerCore?: string | null } | null>(null);
  const [label, setLabel] = useState('');
  useEffect(() => {
    let live = true;
    const { platform } = svc();
    setLabel(platform.label);
    void platform.converterStatus().then((c) => live && setConv(c));
    return () => {
      live = false;
    };
  }, []);
  const running = Object.values(jobs);
  return (
    <footer className="flex h-6 shrink-0 items-center gap-3 border-t border-lines bg-panel px-3 text-[11px] text-muted" role="contentinfo">
      <span className="flex items-center gap-1">
        {conv === null ? <CircleDashed className="size-3" aria-hidden /> : conv.available ? <CheckCircle2 className="size-3 text-ok" aria-hidden /> : <ShieldAlert className="size-3 text-warn" aria-hidden />}
        {conv === null ? 'Checking converter…' : conv.available ? `Binary .ypt ready${conv.codewalkerCore ? ` · ${conv.codewalkerCore}` : ''}` : 'Binary .ypt: converter unavailable'}
      </span>
      {running.length > 0 && (
        <span className="flex items-center gap-2" role="status">
          <Loader2 className="size-3 animate-spin" aria-hidden />
          {running[0]!.label}
          <span className="w-24"><Progress value={running[0]!.progress} /></span>
        </span>
      )}
      <span className="ml-auto flex items-center gap-3">
        {undoLabel && <span className="hidden md:inline">Last: {undoLabel}</span>}
        <span>{dirty ? 'Unsaved changes' : 'All changes saved'}</span>
        <span className="text-dim">{label}</span>
      </span>
    </footer>
  );
}
