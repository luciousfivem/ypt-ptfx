import { RAD2DEG } from '@vfxforge/core';
import { Axis3d, Crosshair, Flame, Info, MousePointer2, Pause, Play, RefreshCcw, Rotate3d, Move3d, Camera, ZapOff } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { Badge, Button, EmptyState, IconButton, PanelFrame, Tip, usePageVisible } from '../components/ui';
import { cn } from '../lib/cn';
import { svc } from '../services/app';
import { useDerived } from '../state/derived';
import { editProject, useProject } from '../state/project';
import { runtimeCommands, useRuntime } from '../state/runtime';
import { useUi } from '../state/ui';
import { ViewportEngine } from './engine';

void RAD2DEG;

export function ViewportPanel() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const holder = useRef<HTMLDivElement>(null);
  const visible = usePageVisible();
  const webgl = useRuntime((s) => s.webgl);
  const stats = useRuntime((s) => s.stats);
  const playing = useRuntime((s) => s.playing);
  const equipped = useRuntime((s) => s.equipped);
  const autoFire = useRuntime((s) => s.autoFire);
  const gizmo = useRuntime((s) => s.gizmo);
  const modelError = useRuntime((s) => s.modelError);
  const effectCount = useProject((s) => Object.keys(s.project.effects).length);
  const settings = useUi((s) => s.settings);
  const selection = useUi((s) => s.selection);

  /* engine lifecycle */
  useEffect(() => {
    const el = canvas.current;
    const wrap = holder.current;
    if (!el || !wrap) return;
    if (!ViewportEngine.supported()) {
      useRuntime.getState().set({ webgl: 'unsupported' });
      return;
    }
    let engine: ViewportEngine;
    try {
      engine = new ViewportEngine(
        el,
        {
          onStats: (stats) => useRuntime.getState().set({ stats }),
          onAttachmentEdit: (id, position, rotation) =>
            editProject(
              'Move attachment point',
              (d) => {
                const a = d.weapon.attachments.find((x) => x.id === id);
                if (!a) return;
                a.position = position.map((v) => Math.round(v * 10000) / 10000) as typeof a.position;
                a.rotation = rotation.map((v) => Math.round(v * 100) / 100) as typeof a.rotation;
              },
              { coalesceKey: `att:${id}` },
            ),
          onPick: (id) => useUi.getState().select(id ? { kind: 'attachment', id } : { kind: 'none' }),
          onModel: (info, error) => useRuntime.getState().set({ modelInfo: info, modelError: error }),
        },
        { assetBytes: (a) => svc().platform.assetBytes(a) },
      );
    } catch (e) {
      console.error('WebGL initialisation failed', e);
      useRuntime.getState().set({ webgl: 'unsupported' });
      return;
    }
    useRuntime.getState().set({ viewport: engine, webgl: 'ok' });
    const rt = useRuntime.getState();
    engine.setPlaying(rt.playing);
    engine.setSpeed(rt.speed);
    engine.setSettings({ quality: useUi.getState().settings.quality, bloom: useUi.getState().settings.bloom, grid: useUi.getState().settings.showGrid });
    engine.setProject(useProject.getState().project);
    engine.restart();

    const ro = new ResizeObserver(([entry]) => {
      const r = entry!.contentRect;
      engine.resize(r.width, r.height);
    });
    ro.observe(wrap);

    /* project -> viewport */
    const unsubProject = useProject.subscribe((s, p) => {
      if (s.project !== p.project) engine.setProject(s.project);
    });
    /* derived sheet previews -> GPU textures */
    const uploaded = new Map<string, number>();
    const pushSheets = () => {
      const project = useProject.getState().project;
      const sheets = useDerived.getState().sheets;
      for (const [id, st] of Object.entries(sheets)) {
        const sheet = project.sheets[id];
        if (!sheet || !st.preview) continue;
        const key = st.version * 1000 + (sheet.grid.cols * 31 + sheet.grid.rows) * 2 + (sheet.order === 'row-major' ? 0 : 1);
        if (uploaded.get(id) === key) continue;
        uploaded.set(id, key);
        engine.setSheet(sheet, st.preview);
      }
      for (const id of [...uploaded.keys()])
        if (!project.sheets[id]) {
          uploaded.delete(id);
          engine.removeSheet(id);
        }
    };
    pushSheets();
    const unsubDerived = useDerived.subscribe(pushSheets);
    const unsubProject2 = useProject.subscribe(pushSheets);

    return () => {
      unsubProject();
      unsubDerived();
      unsubProject2();
      ro.disconnect();
      useRuntime.getState().set({ viewport: null, stats: null });
      engine.dispose();
    };
  }, []);

  useEffect(() => {
    useRuntime.getState().viewport?.setVisible(visible);
  }, [visible]);

  useEffect(() => {
    useRuntime.getState().viewport?.setSettings({ quality: settings.quality, bloom: settings.bloom, grid: settings.showGrid });
  }, [settings.quality, settings.bloom, settings.showGrid]);

  useEffect(() => {
    useRuntime.getState().viewport?.selectAttachment(selection.kind === 'attachment' ? selection.id : null);
  }, [selection]);

  const vp = useRuntime.getState().viewport;

  return (
    <PanelFrame
      title="3D Preview"
      bodyClassName="relative overflow-hidden"
      actions={
        <>
          <Tip label="Move the selected attachment point (W)">
            <IconButton label="Translate gizmo" active={gizmo === 'translate'} onClick={() => { vp?.setGizmoMode('translate'); useRuntime.getState().set({ gizmo: 'translate' }); }}>
              <Move3d className="size-4" aria-hidden />
            </IconButton>
          </Tip>
          <IconButton label="Rotate gizmo (E)" active={gizmo === 'rotate'} onClick={() => { vp?.setGizmoMode('rotate'); useRuntime.getState().set({ gizmo: 'rotate' }); }}>
            <Rotate3d className="size-4" aria-hidden />
          </IconButton>
          <IconButton label="Reset camera" onClick={() => vp?.resetCamera()}>
            <Camera className="size-4" aria-hidden />
          </IconButton>
        </>
      }
    >
      <div ref={holder} className="absolute inset-0">
        <canvas ref={canvas} className={cn('block size-full outline-none', webgl === 'unsupported' && 'hidden')} aria-label="3D weapon preview" data-testid="viewport-canvas" />
      </div>

      {webgl === 'unsupported' && (
        <EmptyState icon={<ZapOff className="size-8" aria-hidden />} title="WebGL 2 is not available">
          The 3D preview needs WebGL 2. Everything else (sprite editor, parameters, export) still works. Try updating your graphics driver, or enable hardware acceleration.
        </EmptyState>
      )}

      {webgl === 'ok' && (
        <>
          {/* HUD */}
          <div className="pointer-events-none absolute left-2 top-2 flex flex-col gap-1">
            <div className="rounded-md bg-black/45 px-2 py-1 font-mono text-[10.5px] leading-tight text-white/80 backdrop-blur" data-testid="stats">
              {stats ? (
                <>
                  {stats.fps.toFixed(0)} fps · {stats.particles} particles · {stats.drawCalls} draws
                  <br />
                  {stats.instances} live · ×{stats.pixelRatio.toFixed(2)} {stats.bloom ? '· bloom' : ''}
                </>
              ) : (
                'starting…'
              )}
            </div>
          </div>
          <div className="absolute right-2 top-2 flex items-center gap-1">
            <Tip label="This is a WebGL approximation of the particle simulation on a stand-in weapon. It is not GTA V's renderer: blending, lighting, sprite sizes and sorting will differ in game.">
              <span>
                <Badge tone="warn" className="pointer-events-auto cursor-help">
                  <Info className="size-3" aria-hidden /> Preview ≠ GTA V
                </Badge>
              </span>
            </Tip>
          </div>
          {modelError && (
            <div className="absolute left-1/2 top-10 max-w-md -translate-x-1/2 rounded-md border border-danger/40 bg-danger/15 px-3 py-2 text-[11.5px] text-danger backdrop-blur" role="alert">
              {modelError}
            </div>
          )}
          {effectCount === 0 && (
            <div className="pointer-events-none absolute inset-x-0 bottom-16 flex justify-center">
              <div className="flex items-center gap-2 rounded-lg border border-line bg-black/50 px-3 py-2 text-[12px] text-white/85 backdrop-blur">
                <Flame className="size-4 text-accent" aria-hidden /> Add a preset from the library (left) to see particles here.
              </div>
            </div>
          )}

          {/* weapon-event bar */}
          <div className="absolute inset-x-0 bottom-2 flex justify-center">
            <div className="glass flex items-center gap-1 rounded-lg border border-line p-1 shadow-[var(--shadow)]" role="toolbar" aria-label="Weapon events">
              <IconButton label={playing ? 'Pause (Space)' : 'Play (Space)'} onClick={runtimeCommands.toggle} active={!playing}>
                {playing ? <Pause className="size-4" aria-hidden /> : <Play className="size-4" aria-hidden />}
              </IconButton>
              <IconButton label="Restart" onClick={runtimeCommands.restart}>
                <RefreshCcw className="size-4" aria-hidden />
              </IconButton>
              <span className="mx-1 h-5 w-px bg-line" />
              <Button size="sm" variant={equipped ? 'primary' : 'secondary'} onClick={() => runtimeCommands.equip(!equipped)} aria-pressed={equipped} title="Equip / holster: triggers the switched, equipped and idle events">
                <MousePointer2 className="size-3.5" aria-hidden /> {equipped ? 'Equipped' : 'Holstered'}
              </Button>
              <Button size="sm" onClick={runtimeCommands.fire} disabled={!equipped} title="Fire (F)">
                <Crosshair className="size-3.5" aria-hidden /> Fire
              </Button>
              <Button size="sm" variant={autoFire ? 'primary' : 'secondary'} aria-pressed={autoFire} disabled={!equipped} onClick={() => runtimeCommands.autoFire(!autoFire)} title="Auto-fire at ~8 shots/s">
                <Axis3d className="size-3.5" aria-hidden /> Auto
              </Button>
              <Button size="sm" onClick={runtimeCommands.reload} disabled={!equipped} title="Reload (R)">
                Reload
              </Button>
              <Button size="sm" onClick={runtimeCommands.manual} title="Manual trigger (exports[res]:PlayEffect)">
                Manual
              </Button>
            </div>
          </div>
        </>
      )}
    </PanelFrame>
  );
}
