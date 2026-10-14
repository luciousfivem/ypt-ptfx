import { Box, ChevronDown, Download, FilePlus2, FolderOpen, HelpCircle, Moon, PackageCheck, Redo2, Save, Settings, Sparkles, Sun, Undo2, Upload, Wand2, Film } from 'lucide-react';
import { Button, IconButton, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '../components/ui';
import { cn } from '../lib/cn';
import { openBundle, pickAndImport, saveBundle, saveProject } from '../services/actions';
import { editProject, useProject } from '../state/project';
import { useUi, type Mode } from '../state/ui';

const MODES: Array<{ mode: Mode; label: string; icon: typeof Film; key: string }> = [
  { mode: 'sprite', label: 'Sprite Editor', icon: Film, key: '1' },
  { mode: 'particles', label: 'Particle Editor', icon: Wand2, key: '2' },
  { mode: 'weapon', label: 'Weapon Preview', icon: Box, key: '3' },
];

export function Toolbar() {
  const name = useProject((s) => s.project.name);
  const dirty = useProject((s) => s.dirty);
  const canUndo = useProject((s) => s.canUndo);
  const canRedo = useProject((s) => s.canRedo);
  const undoLabel = useProject((s) => s.undoLabel);
  const redoLabel = useProject((s) => s.redoLabel);
  const mode = useUi((s) => s.mode);
  const setMode = useUi((s) => s.setMode);
  const openDialog = useUi((s) => s.openDialog);
  const theme = useUi((s) => s.settings.theme);
  const patchSettings = useUi((s) => s.patchSettings);

  return (
    <header className="flex h-11 shrink-0 items-center gap-1 border-b border-lines bg-panel px-2" role="banner">
      <div className="mr-1 flex items-center gap-2 px-1">
        <div className="flex size-6 items-center justify-center rounded-md bg-gradient-to-br from-accent to-accent2 text-white" aria-hidden>
          <Sparkles className="size-3.5" />
        </div>
        <span className="hidden text-[13px] font-semibold tracking-tight lg:inline">VFXForge</span>
      </div>

      <IconButton label="New project (Ctrl+N)" onClick={() => openDialog('new')}><FilePlus2 className="size-4" aria-hidden /></IconButton>
      <IconButton label="Open project (Ctrl+O)" onClick={() => openDialog('open')}><FolderOpen className="size-4" aria-hidden /></IconButton>
      <IconButton label="Save project (Ctrl+S)" onClick={() => void saveProject()}><Save className="size-4" aria-hidden /></IconButton>
      <Menu>
        <MenuTrigger asChild>
          <button type="button" aria-label="More file actions" className="flex h-7 w-5 items-center justify-center rounded-md text-muted hover:bg-raised hover:text-fg"><ChevronDown className="size-3.5" aria-hidden /></button>
        </MenuTrigger>
        <MenuContent>
          <MenuItem icon={<Save className="size-3.5" />} shortcut="Ctrl+S" onSelect={() => void saveProject()}>Save</MenuItem>
          <MenuItem icon={<Download className="size-3.5" />} onSelect={() => void saveBundle()}>Save as bundle (.vfxforge)…</MenuItem>
          <MenuItem icon={<Upload className="size-3.5" />} onSelect={() => void openBundle()}>Open bundle…</MenuItem>
          <MenuSeparator />
          <MenuItem icon={<PackageCheck className="size-3.5" />} shortcut="Ctrl+E" onSelect={() => openDialog('export')}>Export…</MenuItem>
        </MenuContent>
      </Menu>
      <span className="mx-1 h-5 w-px bg-line" />
      <IconButton label={`Undo${undoLabel ? `: ${undoLabel}` : ''} (Ctrl+Z)`} disabled={!canUndo} onClick={() => useProject.getState().undo()}><Undo2 className="size-4" aria-hidden /></IconButton>
      <IconButton label={`Redo${redoLabel ? `: ${redoLabel}` : ''} (Ctrl+Shift+Z)`} disabled={!canRedo} onClick={() => useProject.getState().redo()}><Redo2 className="size-4" aria-hidden /></IconButton>
      <span className="mx-1 h-5 w-px bg-line" />
      <Button size="sm" variant="ghost" icon={<Upload className="size-3.5" aria-hidden />} onClick={() => void pickAndImport()} data-testid="toolbar-import">
        <span className="hidden xl:inline">Import</span>
      </Button>

      <nav className="mx-1 flex rounded-lg border border-line bg-panel2 p-0.5" aria-label="Workspace">
        {MODES.map(({ mode: m, label, icon: Icon, key }) => (
          <button
            key={m}
            type="button"
            aria-pressed={mode === m}
            title={`${label} (${key})`}
            onClick={() => setMode(m)}
            data-testid={`mode-${m}`}
            className={cn('flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[12px] font-medium transition-colors', mode === m ? 'bg-accent text-white' : 'text-muted hover:text-fg')}
          >
            <Icon className="size-3.5" aria-hidden />
            <span className="hidden md:inline">{label}</span>
          </button>
        ))}
      </nav>

      <div className="mx-2 flex min-w-0 flex-1 items-center justify-center">
        <label className="sr-only" htmlFor="project-name">Project name</label>
        <input
          id="project-name"
          value={name}
          maxLength={120}
          onChange={(e) => editProject('Rename project', (d) => void (d.name = e.target.value || 'Untitled Effect'), { coalesceKey: 'project:name' })}
          className="h-7 w-full max-w-[280px] truncate rounded-md border border-transparent bg-transparent px-2 text-center text-[12.5px] font-medium text-fg outline-none hover:border-line focus:border-accent"
        />
        {dirty && <span className="ml-1 size-2 shrink-0 rounded-full bg-warn" title="Unsaved changes" aria-label="Unsaved changes" />}
      </div>

      <Button variant="primary" size="sm" icon={<PackageCheck className="size-3.5" aria-hidden />} onClick={() => openDialog('export')} data-testid="toolbar-export">
        Export
      </Button>
      <IconButton label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'} onClick={() => patchSettings({ theme: theme === 'dark' ? 'light' : 'dark' })}>
        {theme === 'dark' ? <Sun className="size-4" aria-hidden /> : <Moon className="size-4" aria-hidden />}
      </IconButton>
      <IconButton label="Settings" onClick={() => openDialog('settings')} data-testid="toolbar-settings"><Settings className="size-4" aria-hidden /></IconButton>
      <Menu>
        <MenuTrigger asChild>
          <button type="button" aria-label="Help" className="flex size-7 items-center justify-center rounded-md text-muted hover:bg-raised hover:text-fg"><HelpCircle className="size-4" aria-hidden /></button>
        </MenuTrigger>
        <MenuContent align="end">
          <MenuItem shortcut="?" onSelect={() => openDialog('shortcuts')}>Keyboard shortcuts</MenuItem>
          <MenuItem onSelect={() => openDialog('about')}>What is verified / what is not</MenuItem>
        </MenuContent>
      </Menu>
    </header>
  );
}
