/**
 * Snapshot-based undo/redo.
 *
 * The project document is an immutable tree (all edits go through immer), so each
 * history entry is just a reference — unchanged subtrees are shared between
 * snapshots and the memory cost of a long undo stack is small.
 *
 * Continuous edits (dragging a slider, scrubbing a curve key) pass a `coalesceKey`;
 * successive commits with the same key inside `coalesceMs` fold into ONE undo step.
 */

export interface HistoryOptions {
  limit?: number;
  coalesceMs?: number;
  now?: () => number;
}

export interface CommitOptions {
  label?: string;
  coalesceKey?: string;
}

interface Entry<T> {
  value: T;
  label: string;
  key: string | undefined;
  at: number;
}

export class History<T> {
  private past: Entry<T>[] = [];
  private future: Entry<T>[] = [];
  private current: Entry<T>;
  private readonly limit: number;
  private readonly coalesceMs: number;
  private readonly now: () => number;
  private listeners = new Set<() => void>();
  /** Bumped on every change so React can use it as a cheap snapshot id. */
  version = 0;

  constructor(initial: T, opts: HistoryOptions = {}) {
    this.limit = opts.limit ?? 200;
    this.coalesceMs = opts.coalesceMs ?? 750;
    this.now = opts.now ?? (() => Date.now());
    this.current = { value: initial, label: 'Initial', key: undefined, at: this.now() };
  }

  get present(): T {
    return this.current.value;
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  get undoLabel(): string | undefined {
    return this.canUndo ? this.current.label : undefined;
  }

  get redoLabel(): string | undefined {
    return this.future[this.future.length - 1]?.label;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Records `next` as the new present. No-op when it is reference-equal to the present. */
  commit(next: T, opts: CommitOptions = {}): void {
    if (Object.is(next, this.current.value)) return;
    const at = this.now();
    const key = opts.coalesceKey;
    const coalesce = key !== undefined && this.current.key === key && at - this.current.at <= this.coalesceMs && this.past.length > 0;
    if (coalesce) {
      // Replace the present in-place: the previous entry in `past` stays the undo target.
      this.current = { value: next, label: opts.label ?? this.current.label, key, at };
    } else {
      this.past.push(this.current);
      if (this.past.length > this.limit) this.past.shift();
      this.current = { value: next, label: opts.label ?? 'Edit', key, at };
    }
    this.future = [];
    this.emit();
  }

  undo(): T | undefined {
    const prev = this.past.pop();
    if (!prev) return undefined;
    this.future.push(this.current);
    this.current = { ...prev, key: undefined }; // never coalesce into an undone entry
    this.emit();
    return this.current.value;
  }

  redo(): T | undefined {
    const next = this.future.pop();
    if (!next) return undefined;
    this.past.push(this.current);
    this.current = { ...next, key: undefined };
    this.emit();
    return this.current.value;
  }

  /** Replaces the whole history, e.g. after opening a different project. */
  reset(value: T): void {
    this.past = [];
    this.future = [];
    this.current = { value, label: 'Initial', key: undefined, at: this.now() };
    this.emit();
  }

  private emit(): void {
    this.version++;
    for (const fn of this.listeners) fn();
  }
}
