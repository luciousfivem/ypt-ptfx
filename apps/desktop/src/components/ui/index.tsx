/**
 * UI primitives. Behaviour/accessibility comes from Radix; look and density are VFXForge's.
 * Everything here is controlled and stateless apart from transient interaction state.
 */
import * as RDialog from '@radix-ui/react-dialog';
import * as RDropdown from '@radix-ui/react-dropdown-menu';
import * as RSelect from '@radix-ui/react-select';
import * as RSlider from '@radix-ui/react-slider';
import * as RSwitch from '@radix-ui/react-switch';
import * as RTabs from '@radix-ui/react-tabs';
import * as RTooltip from '@radix-ui/react-tooltip';
import * as RToggleGroup from '@radix-ui/react-toggle-group';
import { Check, ChevronDown, ChevronRight, Loader2, X } from 'lucide-react';
import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from 'react';
import { cn } from '../../lib/cn';

/* ------------------------------------------------------- field labelling */

/** The visible label of the enclosing <Field>, so every control inside gets a real accessible name. */
const FieldLabel = createContext<string | null>(null);
const ariaFirst = (own: string | undefined, field: string | null) => field ?? own;
const useFieldLabel = (own?: string, suffix?: string): string | undefined => {
  const field = useContext(FieldLabel);
  const parts = [ariaFirst(own, field), suffix].filter((x): x is string => !!x);
  return parts.length ? parts.join(' ') : undefined;
};

/* ----------------------------------------------------------------- tooltip */

export const TooltipProvider = ({ children }: { children: ReactNode }) => <RTooltip.Provider delayDuration={350}>{children}</RTooltip.Provider>;

export function Tip({ label, children, side = 'bottom' }: { label: ReactNode; children: ReactNode; side?: 'top' | 'bottom' | 'left' | 'right' }) {
  return (
    <RTooltip.Root>
      <RTooltip.Trigger asChild>{children}</RTooltip.Trigger>
      <RTooltip.Portal>
        <RTooltip.Content side={side} sideOffset={6} className="z-[100] max-w-xs rounded-md border border-line bg-raised px-2 py-1 text-[11px] text-fg shadow-[var(--shadow)]">
          {label}
        </RTooltip.Content>
      </RTooltip.Portal>
    </RTooltip.Root>
  );
}

/* ------------------------------------------------------------------ button */

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-white hover:brightness-110 active:brightness-95 shadow-[0_0_0_1px_rgb(255_255_255/0.08)_inset]',
  secondary: 'bg-raised text-fg border border-line hover:border-accent/60 hover:bg-panel2',
  ghost: 'text-muted hover:text-fg hover:bg-raised',
  danger: 'bg-danger/15 text-danger border border-danger/40 hover:bg-danger/25',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: 'xs' | 'sm' | 'md';
  loading?: boolean;
  icon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({ variant = 'secondary', size = 'sm', loading, icon, className, children, disabled, ...rest }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      disabled={disabled || loading}
      className={cn(
        'inline-flex select-none items-center justify-center gap-1.5 rounded-md font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45',
        size === 'xs' && 'h-6 px-2 text-[11px]',
        size === 'sm' && 'h-7 px-2.5 text-[12px]',
        size === 'md' && 'h-9 px-4 text-[13px]',
        VARIANTS[variant],
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  );
});

export const IconButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean; size?: 'sm' | 'md' }>(function IconButton(
  { label, active, size = 'sm', className, children, ...rest },
  ref,
) {
  return (
    <Tip label={label}>
      <button
        ref={ref}
        type="button"
        aria-label={label}
        aria-pressed={active}
        className={cn(
          'inline-flex items-center justify-center rounded-md text-muted transition-colors hover:bg-raised hover:text-fg disabled:cursor-not-allowed disabled:opacity-40',
          size === 'sm' ? 'size-7' : 'size-8',
          active && 'bg-accent/20 text-accent',
          className,
        )}
        {...rest}
      >
        {children}
      </button>
    </Tip>
  );
});

/* -------------------------------------------------------------- containers */

export function PanelFrame({ title, actions, children, className, bodyClassName }: { title: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; bodyClassName?: string }) {
  return (
    <section className={cn('flex h-full min-h-0 min-w-0 flex-col bg-panel', className)}>
      <header className="flex h-8 shrink-0 items-center justify-between gap-2 border-b border-lines px-3">
        <h2 className="truncate text-[11px] font-semibold uppercase tracking-[0.09em] text-muted">{title}</h2>
        <div className="flex items-center gap-0.5">{actions}</div>
      </header>
      <div className={cn('min-h-0 flex-1 overflow-auto', bodyClassName)}>{children}</div>
    </section>
  );
}

export function Section({ title, children, defaultOpen = true, actions }: { title: ReactNode; children: ReactNode; defaultOpen?: boolean; actions?: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  return (
    <div className="border-b border-lines">
      <div className="flex h-7 items-center justify-between pr-2">
        <button type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)} className="flex h-7 flex-1 items-center gap-1 px-2 text-left text-[11px] font-semibold uppercase tracking-wider text-muted hover:text-fg">
          {open ? <ChevronDown className="size-3.5" aria-hidden /> : <ChevronRight className="size-3.5" aria-hidden />}
          {title}
        </button>
        {actions}
      </div>
      {open && (
        <div id={id} className="space-y-1.5 px-3 pb-3 pt-0.5">
          {children}
        </div>
      )}
    </div>
  );
}

export function Field({ label, hint, children, className }: { label: ReactNode; hint?: ReactNode; children: ReactNode; className?: string }) {
  const text = typeof label === 'string' ? label : null;
  return (
    <FieldLabel.Provider value={text}>
      <div className={cn('grid grid-cols-[92px_1fr] items-start gap-2', className)}>
        <span className="truncate text-[11.5px] leading-7 text-muted" title={text ?? undefined}>
          {label}
        </span>
        <div className="min-w-0">
          {children}
          {hint && <p className="mt-0.5 text-[10.5px] leading-snug text-dim">{hint}</p>}
        </div>
      </div>
    </FieldLabel.Provider>
  );
}

export function Badge({ children, tone = 'neutral', className }: { children: ReactNode; tone?: 'neutral' | 'ok' | 'warn' | 'danger' | 'accent'; className?: string }) {
  const tones = {
    neutral: 'bg-raised text-muted border-line',
    ok: 'bg-ok/15 text-ok border-ok/30',
    warn: 'bg-warn/15 text-warn border-warn/30',
    danger: 'bg-danger/15 text-danger border-danger/30',
    accent: 'bg-accent/15 text-accent border-accent/30',
  } as const;
  return <span className={cn('inline-flex items-center gap-1 rounded border px-1.5 py-px text-[10.5px] font-medium', tones[tone], className)}>{children}</span>;
}

export function Progress({ value, label }: { value: number | null; label?: string }) {
  return (
    <div role="progressbar" aria-label={label} aria-valuenow={value === null ? undefined : Math.round(value * 100)} aria-valuemin={0} aria-valuemax={100} className="h-1.5 w-full overflow-hidden rounded-full bg-raised">
      <div className={cn('h-full rounded-full bg-gradient-to-r from-accent to-accent2 transition-[width]', value === null && 'w-1/3 animate-pulse')} style={value === null ? undefined : { width: `${Math.max(2, value * 100)}%` }} />
    </div>
  );
}

export function EmptyState({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
      {icon && <div className="text-dim">{icon}</div>}
      <p className="text-[13px] font-medium text-fg">{title}</p>
      {children && <div className="max-w-[260px] text-[11.5px] leading-relaxed text-muted">{children}</div>}
    </div>
  );
}

/* ------------------------------------------------------------------ inputs */

export interface NumberFieldProps {
  value: number;
  onChange: (value: number, live: boolean) => void;
  min?: number;
  max?: number;
  step?: number;
  precision?: number;
  unit?: string;
  label?: string;
  className?: string;
  disabled?: boolean;
  /** Drag sensitivity in value-units per pixel; defaults to step. */
  scrub?: number;
  /** Full accessible name; defaults to the enclosing Field's label plus `label`. */
  ariaLabel?: string;
}

const roundTo = (v: number, p: number) => Math.round(v * 10 ** p) / 10 ** p;

/** Numeric input with drag-to-scrub on its left grip, arrow-key stepping and clamped, validated entry. */
export function NumberField({ value, onChange, min = -Infinity, max = Infinity, step = 1, precision, unit, label, ariaLabel, className, disabled, scrub }: NumberFieldProps) {
  const fromField = useFieldLabel(undefined, label);
  const accessible = ariaLabel ?? fromField;
  const p = precision ?? (Number.isInteger(step) ? 0 : Math.min(6, String(step).split('.')[1]?.length ?? 2));
  const [draft, setDraft] = useState<string | null>(null);
  const drag = useRef<{ x: number; start: number } | null>(null);
  const clamp = useCallback((v: number) => Math.min(max, Math.max(min, v)), [min, max]);

  const commit = (text: string, live = false) => {
    const n = Number(text.replace(',', '.'));
    if (text.trim() === '' || !Number.isFinite(n)) return;
    onChange(roundTo(clamp(n), p), live);
  };

  return (
    <div className={cn('group flex h-7 min-w-0 items-center overflow-hidden rounded-md border border-line bg-panel2 focus-within:border-accent', disabled && 'opacity-50', className)}>
      <span
        role="presentation"
        title="Drag to change"
        onPointerDown={(e) => {
          if (disabled) return;
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          drag.current = { x: e.clientX, start: value };
        }}
        onPointerMove={(e) => {
          if (!drag.current) return;
          const fine = e.shiftKey ? 0.1 : e.altKey ? 10 : 1;
          const delta = (e.clientX - drag.current.x) * (scrub ?? step) * fine;
          onChange(roundTo(clamp(drag.current.start + delta), p), true);
        }}
        onPointerUp={(e) => {
          if (!drag.current) return;
          const fine = e.shiftKey ? 0.1 : e.altKey ? 10 : 1;
          const delta = (e.clientX - drag.current.x) * (scrub ?? step) * fine;
          const final = roundTo(clamp(drag.current.start + delta), p);
          drag.current = null;
          onChange(final, false);
        }}
        className="flex h-full w-5 shrink-0 cursor-ew-resize items-center justify-center text-[10px] text-dim hover:text-accent"
      >
        {label ?? '⋮'}
      </span>
      <input
        inputMode="decimal"
        aria-label={accessible}
        disabled={disabled}
        value={draft ?? String(roundTo(value, p))}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft !== null) commit(draft);
          setDraft(null);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') {
            setDraft(null);
            (e.target as HTMLInputElement).blur();
          }
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            const dir = e.key === 'ArrowUp' ? 1 : -1;
            const mult = e.shiftKey ? 10 : e.altKey ? 0.1 : 1;
            onChange(roundTo(clamp(value + dir * step * mult), p), false);
            setDraft(null);
          }
        }}
        className="h-full min-w-0 flex-1 bg-transparent px-1 text-right font-mono text-[11.5px] text-fg outline-none"
      />
      {unit && <span className="pr-1.5 text-[10px] text-dim">{unit}</span>}
    </div>
  );
}

export function SliderField({ value, onChange, min, max, step = 0.01, unit, precision, scrub }: { value: number; onChange: (v: number, live: boolean) => void; min: number; max: number; step?: number; unit?: string; precision?: number; scrub?: number }) {
  const name = useFieldLabel();
  return (
    <div className="flex items-center gap-2">
      <RSlider.Root
        className="relative flex h-5 min-w-0 flex-1 touch-none select-none items-center"
        value={[Math.min(max, Math.max(min, value))]}
        min={min}
        max={max}
        step={step}
        onValueChange={([v]) => onChange(v!, true)}
        onValueCommit={([v]) => onChange(v!, false)}
      >
        <RSlider.Track className="relative h-1 grow rounded-full bg-raised">
          <RSlider.Range className="absolute h-full rounded-full bg-accent" />
        </RSlider.Track>
        <RSlider.Thumb aria-label={name ? `${name} slider` : 'value'} className="block size-3.5 rounded-full border-2 border-accent bg-fg shadow focus-visible:outline-2 focus-visible:outline-accent2" />
      </RSlider.Root>
      <NumberField value={value} onChange={onChange} min={min} max={max} step={step} unit={unit} precision={precision} scrub={scrub ?? (max - min) / 200} className="w-[78px] shrink-0" />
    </div>
  );
}

export function Vec3Field({ value, onChange, step = 0.01, precision, labels = ['X', 'Y', 'Z'], min, max }: { value: readonly [number, number, number]; onChange: (v: [number, number, number], live: boolean) => void; step?: number; precision?: number; labels?: [string, string, string]; min?: number; max?: number }) {
  return (
    <div className="grid grid-cols-3 gap-1">
      {([0, 1, 2] as const).map((i) => (
        <NumberField
          key={i}
          label={labels[i]}
          value={value[i]}
          step={step}
          precision={precision}
          min={min}
          max={max}
          onChange={(n, live) => {
            const next: [number, number, number] = [value[0], value[1], value[2]];
            next[i] = n;
            onChange(next, live);
          }}
        />
      ))}
    </div>
  );
}

export function RangeField({ value, onChange, step = 0.01, min, max, unit, precision }: { value: { min: number; max: number }; onChange: (v: { min: number; max: number }, live: boolean) => void; step?: number; min?: number; max?: number; unit?: string; precision?: number }) {
  const base = useFieldLabel();
  return (
    <div className="grid grid-cols-2 gap-1">
      <NumberField label="↧" ariaLabel={`${base ?? 'Range'} min`} value={value.min} step={step} min={min} max={max} unit={unit} precision={precision} onChange={(n, live) => onChange({ min: n, max: Math.max(n, value.max) }, live)} />
      <NumberField label="↥" ariaLabel={`${base ?? 'Range'} max`} value={value.max} step={step} min={min} max={max} unit={unit} precision={precision} onChange={(n, live) => onChange({ min: Math.min(n, value.min), max: n }, live)} />
    </div>
  );
}

export function TextField({ value, onChange, placeholder, mono, maxLength, invalid, ...rest }: { value: string; onChange: (v: string) => void; placeholder?: string; mono?: boolean; maxLength?: number; invalid?: boolean } & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>) {
  const name = useFieldLabel(rest['aria-label']);
  return (
    <input
      aria-label={name}
      value={value}
      placeholder={placeholder}
      maxLength={maxLength}
      aria-invalid={invalid}
      onChange={(e) => onChange(e.target.value)}
      className={cn('h-7 w-full rounded-md border bg-panel2 px-2 text-[12px] text-fg outline-none placeholder:text-dim focus:border-accent', invalid ? 'border-danger' : 'border-line', mono && 'font-mono')}
      {...rest}
    />
  );
}

/** Colour in 0..1 RGB(A) tuples (the project's native format). */
export function ColorField({ value, onChange, alpha = false }: { value: readonly number[]; onChange: (v: number[], live: boolean) => void; alpha?: boolean }) {
  const name = useFieldLabel();
  const hex = '#' + [0, 1, 2].map((i) => Math.round(Math.min(1, Math.max(0, value[i] ?? 0)) * 255).toString(16).padStart(2, '0')).join('');
  return (
    <div className="flex items-center gap-1.5">
      <input
        type="color"
        aria-label={name ? `${name} colour` : 'colour'}
        value={hex}
        onChange={(e) => {
          const h = e.target.value;
          const rgb = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
          onChange(alpha ? [...rgb, value[3] ?? 1] : rgb, true);
        }}
        onBlur={(e) => {
          const h = e.target.value;
          const rgb = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
          onChange(alpha ? [...rgb, value[3] ?? 1] : rgb, false);
        }}
        className="h-7 w-9 shrink-0 cursor-pointer rounded border border-line bg-transparent p-0.5"
      />
      <span className="font-mono text-[11px] uppercase text-muted">{hex}</span>
      {alpha && <NumberField label="α" value={value[3] ?? 1} min={0} max={1} step={0.01} onChange={(a, live) => onChange([value[0]!, value[1]!, value[2]!, a], live)} className="ml-auto w-[72px]" />}
    </div>
  );
}

export function SwitchField({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  const name = useFieldLabel(label);
  return (
    <RSwitch.Root
      checked={checked}
      onCheckedChange={onChange}
      aria-label={name}
      className="relative h-5 w-9 shrink-0 rounded-full border border-line bg-raised transition-colors data-[state=checked]:border-accent data-[state=checked]:bg-accent"
    >
      <RSwitch.Thumb className="block size-3.5 translate-x-[3px] rounded-full bg-fg transition-transform data-[state=checked]:translate-x-[19px] data-[state=checked]:bg-white" />
    </RSwitch.Root>
  );
}

export function SelectField<T extends string>({ value, onChange, options, label, className }: { value: T; onChange: (v: T) => void; options: ReadonlyArray<{ value: T; label: string; hint?: string }>; label?: string; className?: string }) {
  const name = useFieldLabel(label);
  return (
    <RSelect.Root value={value} onValueChange={(v) => onChange(v as T)}>
      <RSelect.Trigger aria-label={name} className={cn('flex h-7 w-full items-center justify-between gap-1 rounded-md border border-line bg-panel2 px-2 text-[12px] text-fg hover:border-accent/60 focus:border-accent', className)}>
        <RSelect.Value />
        <RSelect.Icon>
          <ChevronDown className="size-3.5 text-dim" aria-hidden />
        </RSelect.Icon>
      </RSelect.Trigger>
      <RSelect.Portal>
        <RSelect.Content position="popper" sideOffset={4} className="z-[100] max-h-72 min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-md border border-line bg-raised shadow-[var(--shadow)]">
          <RSelect.Viewport className="p-1">
            {options.map((o) => (
              <RSelect.Item key={o.value} value={o.value} className="relative flex cursor-pointer select-none items-center gap-2 rounded px-6 py-1.5 text-[12px] text-fg outline-none data-[highlighted]:bg-accent/20">
                <RSelect.ItemIndicator className="absolute left-1.5">
                  <Check className="size-3.5 text-accent" aria-hidden />
                </RSelect.ItemIndicator>
                <RSelect.ItemText>{o.label}</RSelect.ItemText>
                {o.hint && <span className="ml-auto text-[10.5px] text-dim">{o.hint}</span>}
              </RSelect.Item>
            ))}
          </RSelect.Viewport>
        </RSelect.Content>
      </RSelect.Portal>
    </RSelect.Root>
  );
}

export function Segmented<T extends string>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: ReadonlyArray<{ value: T; label: ReactNode; title?: string }>; label?: string }) {
  const name = useFieldLabel(label);
  return (
    <RToggleGroup.Root type="single" value={value} aria-label={name} onValueChange={(v) => v && onChange(v as T)} className="flex rounded-md border border-line bg-panel2 p-0.5">
      {options.map((o) => (
        <RToggleGroup.Item key={o.value} value={o.value} title={o.title} className="flex h-6 flex-1 items-center justify-center rounded px-2 text-[11.5px] text-muted transition-colors hover:text-fg data-[state=on]:bg-accent data-[state=on]:text-white">
          {o.label}
        </RToggleGroup.Item>
      ))}
    </RToggleGroup.Root>
  );
}

/* ----------------------------------------------------------- tabs / dialogs */

export function Tabs({ value, onValueChange, tabs, children, className }: { value: string; onValueChange: (v: string) => void; tabs: ReadonlyArray<{ value: string; label: ReactNode }>; children?: ReactNode; className?: string }) {
  return (
    <RTabs.Root value={value} onValueChange={onValueChange} className={cn('flex min-h-0 flex-col', className)}>
      <RTabs.List className="flex shrink-0 gap-0 overflow-x-auto border-b border-lines px-1.5 [scrollbar-width:none]">
        {tabs.map((t) => (
          <RTabs.Trigger key={t.value} value={t.value} className="relative h-8 shrink-0 whitespace-nowrap px-2 text-[11.5px] font-medium text-muted transition-colors hover:text-fg data-[state=active]:text-fg data-[state=active]:after:absolute data-[state=active]:after:inset-x-1.5 data-[state=active]:after:bottom-0 data-[state=active]:after:h-0.5 data-[state=active]:after:rounded-full data-[state=active]:after:bg-accent">
            {t.label}
          </RTabs.Trigger>
        ))}
      </RTabs.List>
      {children}
    </RTabs.Root>
  );
}
export const TabPanel = RTabs.Content;

export function Dialog({ open, onOpenChange, title, description, children, footer, wide }: { open: boolean; onOpenChange: (o: boolean) => void; title: string; description?: ReactNode; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  return (
    <RDialog.Root open={open} onOpenChange={onOpenChange}>
      <RDialog.Portal>
        <RDialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" />
        <RDialog.Content
          className={cn('glass fixed left-1/2 top-1/2 z-50 flex max-h-[88vh] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl border border-line shadow-[var(--shadow)]', wide ? 'w-[min(880px,94vw)]' : 'w-[min(520px,94vw)]')}
        >
          <header className="flex items-start justify-between gap-4 border-b border-lines px-5 py-3.5">
            <div>
              <RDialog.Title className="text-[14px] font-semibold text-fg">{title}</RDialog.Title>
              <RDialog.Description className="mt-0.5 text-[11.5px] text-muted">{description ?? ' '}</RDialog.Description>
            </div>
            {/* a plain button: a tooltip here would take the first Escape press when the dialog auto-focuses it */}
            <RDialog.Close aria-label="Close" className="inline-flex size-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-raised hover:text-fg">
              <X className="size-4" aria-hidden />
            </RDialog.Close>
          </header>
          <div className="min-h-0 flex-1 overflow-auto px-5 py-4">{children}</div>
          {footer && <footer className="flex items-center justify-end gap-2 border-t border-lines px-5 py-3">{footer}</footer>}
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}

export const Menu = RDropdown.Root;
export const MenuTrigger = RDropdown.Trigger;
export function MenuContent({ children, align = 'start' }: { children: ReactNode; align?: 'start' | 'end' | 'center' }) {
  return (
    <RDropdown.Portal>
      <RDropdown.Content align={align} sideOffset={6} className="glass z-[100] min-w-[200px] rounded-lg border border-line p-1 shadow-[var(--shadow)]">
        {children}
      </RDropdown.Content>
    </RDropdown.Portal>
  );
}
export function MenuItem({ children, onSelect, shortcut, disabled, danger, icon }: { children: ReactNode; onSelect: () => void; shortcut?: string; disabled?: boolean; danger?: boolean; icon?: ReactNode }) {
  return (
    <RDropdown.Item disabled={disabled} onSelect={onSelect} className={cn('flex cursor-pointer select-none items-center gap-2 rounded px-2 py-1.5 text-[12px] outline-none data-[disabled]:cursor-not-allowed data-[disabled]:opacity-40 data-[highlighted]:bg-accent/20', danger ? 'text-danger' : 'text-fg')}>
      <span className="w-4 text-muted">{icon}</span>
      <span className="flex-1">{children}</span>
      {shortcut && <kbd className="font-mono text-[10.5px] text-dim">{shortcut}</kbd>}
    </RDropdown.Item>
  );
}
export const MenuSeparator = () => <RDropdown.Separator className="my-1 h-px bg-line" />;
export const MenuLabel = ({ children }: { children: ReactNode }) => <RDropdown.Label className="px-2 pb-0.5 pt-1.5 text-[10px] font-semibold uppercase tracking-wider text-dim">{children}</RDropdown.Label>;

/* --------------------------------------------------------------- misc hooks */

/** `true` while the document is visible; used to pause render loops in background tabs. */
export function usePageVisible(): boolean {
  const [v, setV] = useState(() => typeof document === 'undefined' || document.visibilityState === 'visible');
  useEffect(() => {
    const h = () => setV(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', h);
    return () => document.removeEventListener('visibilitychange', h);
  }, []);
  return v;
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-line bg-panel2 px-1 font-mono text-[10px] text-muted">{children}</kbd>;
}
