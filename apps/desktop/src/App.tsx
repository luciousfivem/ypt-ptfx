import { Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Group, Panel, Separator, useDefaultLayout, usePanelRef } from 'react-resizable-panels';
import { DropOverlay } from './components/DropOverlay';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Toasts } from './components/Toasts';
import { TooltipProvider } from './components/ui';
import { Dialogs } from './dialogs/Dialogs';
import { ExportDialog } from './dialogs/ExportDialog';
import { SpriteEditor } from './editors/SpriteEditor';
import { useAutosave } from './hooks/useAutosave';
import { useShortcuts } from './hooks/useShortcuts';
import { AssetBrowser } from './panels/AssetBrowser';
import { Inspector } from './panels/Inspector';
import { StatusBar } from './panels/StatusBar';
import { Timeline } from './panels/Timeline';
import { Toolbar } from './panels/Toolbar';
import { getPlatform } from './platform';
import { setServices } from './services/app';
import { getEngine } from './services/engine';
import { startDerivedService } from './state/derived';
import { useUi } from './state/ui';
import { ViewportPanel } from './viewport/ViewportPanel';

function safeStorage() {
  try {
    localStorage.setItem('vfxforge.probe', '1');
    localStorage.removeItem('vfxforge.probe');
    return localStorage;
  } catch {
    return undefined;
  }
}

export function App() {
  const [boot, setBoot] = useState<'loading' | 'ready' | { error: string }>('loading');

  // nothing fails silently: an unexpected rejection or error becomes a visible message
  useEffect(() => {
    const message = (e: unknown) => (e instanceof Error ? e.message : typeof e === 'string' ? e : 'An unexpected error occurred.');
    const onRejection = (ev: PromiseRejectionEvent) => {
      const reason = ev.reason as { name?: string } | undefined;
      if (reason?.name === 'AbortError') return; // cancelled work is not an error
      console.error('Unhandled rejection', ev.reason);
      useUi.getState().toast('error', message(ev.reason));
    };
    window.addEventListener('unhandledrejection', onRejection);
    return () => window.removeEventListener('unhandledrejection', onRejection);
  }, []);

  useEffect(() => {
    let stop: (() => void) | undefined;
    let cancelled = false;
    (async () => {
      try {
        const platform = await getPlatform();
        const engine = getEngine(platform);
        setServices({ platform, engine });
        stop = startDerivedService(engine);
        if (cancelled) return;
        setBoot('ready');
        const rec = await platform.projects.latestAutosave().catch(() => null);
        if (rec && !cancelled) useUi.getState().openDialog('recovery');
      } catch (e) {
        setBoot({ error: e instanceof Error ? e.message : String(e) });
      }
    })();
    return () => {
      cancelled = true;
      stop?.();
    };
  }, []);

  const theme = useUi((s) => s.settings.theme);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  if (boot === 'loading') {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-muted" role="status">
        <Loader2 className="size-4 animate-spin" aria-hidden /> Starting VFXForge…
      </div>
    );
  }
  if (typeof boot === 'object') {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="max-w-lg rounded-xl border border-danger/40 bg-danger/10 p-5" role="alert">
          <h1 className="mb-1 text-[15px] font-semibold text-danger">VFXForge could not start</h1>
          <p className="text-[12.5px] text-fg">{boot.error}</p>
        </div>
      </div>
    );
  }
  return <Shell />;
}

function Shell() {
  useShortcuts();
  useAutosave();
  const mode = useUi((s) => s.mode);
  const storage = safeStorage();
  const main = useDefaultLayout({ id: 'vfxforge.main.v1', storage });
  const center = useDefaultLayout({ id: 'vfxforge.center.v1', storage });
  const timeline = usePanelRef();

  // the frame list lives inside the Sprite Editor, so the emitter timeline gets out of the way there
  useEffect(() => {
    const t = timeline.current;
    if (!t) return;
    if (mode === 'sprite') t.collapse();
    else if (t.isCollapsed()) t.expand();
  }, [mode, timeline]);

  return (
    <TooltipProvider>
      <div className="flex h-full flex-col">
        <Toolbar />
        <Group orientation="horizontal" className="min-h-0 flex-1" defaultLayout={main.defaultLayout} onLayoutChanged={main.onLayoutChanged}>
          <Panel id="left" defaultSize="21%" minSize="220px" maxSize="38%">
            <ErrorBoundary label="library"><AssetBrowser /></ErrorBoundary>
          </Panel>
          <Separator className="w-px" />
          <Panel id="center" minSize="320px">
            <Group orientation="vertical" defaultLayout={center.defaultLayout} onLayoutChanged={center.onLayoutChanged}>
              <Panel id="stage" minSize="30%">
                {/* the 3D engine stays mounted (just hidden) so switching workspaces does not rebuild the GPU scene */}
                <div className={mode === 'sprite' ? 'hidden' : 'size-full'}>
                  <ErrorBoundary label="3D preview"><ViewportPanel /></ErrorBoundary>
                </div>
                {mode === 'sprite' && <ErrorBoundary label="sprite editor"><SpriteEditor /></ErrorBoundary>}
              </Panel>
              <Separator className="h-px" />
              <Panel id="timeline" defaultSize="26%" minSize="110px" maxSize="55%" collapsible collapsedSize="0px" panelRef={timeline}>
                <ErrorBoundary label="timeline"><Timeline /></ErrorBoundary>
              </Panel>
            </Group>
          </Panel>
          <Separator className="w-px" />
          <Panel id="right" defaultSize="25%" minSize="280px" maxSize="42%">
            <ErrorBoundary label="inspector"><Inspector /></ErrorBoundary>
          </Panel>
        </Group>
        <StatusBar />
      </div>
      <Dialogs />
      <ExportDialog />
      <Toasts />
      <DropOverlay />
    </TooltipProvider>
  );
}
