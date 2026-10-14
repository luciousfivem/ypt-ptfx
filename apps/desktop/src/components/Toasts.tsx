import { AlertTriangle, CheckCircle2, Info, XCircle, X } from 'lucide-react';
import { cn } from '../lib/cn';
import { useUi } from '../state/ui';

const ICON = { info: Info, ok: CheckCircle2, warn: AlertTriangle, error: XCircle } as const;
const TONE = { info: 'border-line', ok: 'border-ok/50', warn: 'border-warn/50', error: 'border-danger/60' } as const;
const ICON_TONE = { info: 'text-accent2', ok: 'text-ok', warn: 'text-warn', error: 'text-danger' } as const;

export function Toasts() {
  const toasts = useUi((s) => s.toasts);
  const dismiss = useUi((s) => s.dismissToast);
  return (
    <div className="pointer-events-none fixed bottom-8 right-3 z-[200] flex w-[min(380px,92vw)] flex-col gap-2" aria-live="polite" role="log">
      {toasts.map((t) => {
        const I = ICON[t.tone];
        return (
          <div key={t.id} className={cn('glass pointer-events-auto flex items-start gap-2 rounded-lg border px-3 py-2 text-[12px] shadow-[var(--shadow)]', TONE[t.tone])} role={t.tone === 'error' ? 'alert' : 'status'}>
            <I className={cn('mt-px size-4 shrink-0', ICON_TONE[t.tone])} aria-hidden />
            <p className="flex-1 leading-snug text-fg">{t.text}</p>
            <button type="button" aria-label="Dismiss" onClick={() => dismiss(t.id)} className="text-dim hover:text-fg">
              <X className="size-3.5" aria-hidden />
            </button>
          </div>
        );
      })}
    </div>
  );
}
