import { describe, expect, it } from 'vitest';
import {
  History,
  Rng,
  bakeCurve,
  cellToFrame,
  computeGridLayout,
  createAsset,
  createClip,
  createEffect,
  createEmitter,
  createProject,
  createSheet,
  evalCurve,
  evalGradient,
  frameToCell,
  frameUvRect,
  isSafeRelativePath,
  linearCurve,
  luaEscape,
  parseProject,
  rotateEulerXYZ,
  sanitizeFilename,
  sanitizeIdentifier,
  suggestGrid,
  uniqueName,
  xmlEscape,
} from '../src';

describe('Rng', () => {
  it('is deterministic for a seed and uniform-ish', () => {
    const a = new Rng(1234);
    const b = new Rng(1234);
    const seqA = Array.from({ length: 50 }, () => a.next());
    const seqB = Array.from({ length: 50 }, () => b.next());
    expect(seqA).toEqual(seqB);
    expect(seqA.every((x) => x >= 0 && x < 1)).toBe(true);
    const mean = seqA.reduce((s, x) => s + x, 0) / seqA.length;
    expect(mean).toBeGreaterThan(0.35);
    expect(mean).toBeLessThan(0.65);
  });

  it('can snapshot and restore state', () => {
    const r = new Rng(9);
    r.next();
    const s = r.getState();
    const x = r.next();
    r.setState(s);
    expect(r.next()).toBe(x);
  });
});

describe('curves', () => {
  const c = linearCurve([[0, 0], [0.5, 1], [1, 0]]);
  it('interpolates, holds ends and handles degenerate curves', () => {
    expect(evalCurve(c, 0)).toBe(0);
    expect(evalCurve(c, 0.25)).toBeCloseTo(0.5);
    expect(evalCurve(c, 0.5)).toBe(1);
    expect(evalCurve(c, 0.75)).toBeCloseTo(0.5);
    expect(evalCurve(c, -3)).toBe(0);
    expect(evalCurve(c, 7)).toBe(0);
    expect(evalCurve({ keys: [] }, 0.5)).toBe(0);
    expect(evalCurve({ keys: [{ t: 0.3, v: 4, ease: 'linear' }] }, 0.9)).toBe(4);
  });

  it('applies the START key ease to its segment', () => {
    const stepCurve = { keys: [{ t: 0, v: 0, ease: 'step' as const }, { t: 1, v: 10, ease: 'linear' as const }] };
    expect(evalCurve(stepCurve, 0.99)).toBe(0);
    expect(evalCurve(stepCurve, 1)).toBe(10);
    const smooth = linearCurve([[0, 0], [1, 1]], 'smooth');
    expect(evalCurve(smooth, 0.5)).toBeCloseTo(0.5);
    expect(evalCurve(smooth, 0.25)).toBeLessThan(0.25);
  });

  it('bakes N samples spanning the full range', () => {
    const lut = bakeCurve(c, 5);
    expect(Array.from(lut)).toEqual([0, 0.5, 1, 0.5, 0].map((x) => Math.fround(x)));
  });

  it('interpolates gradients', () => {
    const g = { stops: [{ t: 0, color: [0, 0, 0, 1] as [number, number, number, number] }, { t: 1, color: [1, 1, 1, 0] as [number, number, number, number] }] };
    const mid = evalGradient(g, 0.5);
    expect(mid).toEqual([0.5, 0.5, 0.5, 0.5]);
  });
});

describe('grid maths', () => {
  it('lays out a 4x4 1024 sheet', () => {
    const { layout, issues } = computeGridLayout({ cols: 4, rows: 4 }, { width: 1024, height: 1024 }, 0, 16);
    expect(issues).toEqual([]);
    expect(layout).toMatchObject({ cellWidth: 256, cellHeight: 256, innerWidth: 256, capacity: 16 });
  });

  it('reports every problem instead of stopping at the first', () => {
    const { layout, issues } = computeGridLayout({ cols: 3, rows: 4 }, { width: 1000, height: 1024 }, 200, 20);
    expect(layout).toBeNull();
    const codes = issues.map((i) => i.code);
    expect(codes).toContain('non-integer-cell');
    expect(codes).toContain('non-power-of-two');
    expect(codes).toContain('too-many-frames');
  });

  it('flags padding that consumes the cell', () => {
    const { layout, issues } = computeGridLayout({ cols: 16, rows: 16 }, { width: 256, height: 256 }, 8, 4);
    expect(layout).toBeNull();
    expect(issues.some((i) => i.code === 'padding-too-large')).toBe(true);
  });

  it('rejects non-positive sizes', () => {
    expect(computeGridLayout({ cols: 0, rows: 4 }, { width: 256, height: 256 }, 0).layout).toBeNull();
    expect(computeGridLayout({ cols: 4, rows: 4 }, { width: 256, height: 256 }, -1).layout).toBeNull();
  });

  it('round-trips frame <-> cell in both orders', () => {
    const grid = { cols: 4, rows: 3 };
    for (const order of ['row-major', 'column-major'] as const) {
      const seen = new Set<string>();
      for (let i = 0; i < 12; i++) {
        const { col, row } = frameToCell(i, grid, order);
        expect(col).toBeLessThan(4);
        expect(row).toBeLessThan(3);
        expect(cellToFrame(col, row, grid, order)).toBe(i);
        seen.add(`${col},${row}`);
      }
      expect(seen.size).toBe(12);
    }
    expect(frameToCell(5, grid, 'row-major')).toEqual({ col: 1, row: 1 });
    expect(frameToCell(5, grid, 'column-major')).toEqual({ col: 1, row: 2 });
  });

  it('computes UV rects with top-left origin', () => {
    expect(frameUvRect(5, { cols: 4, rows: 4 })).toEqual({ u0: 0.25, v0: 0.25, u1: 0.5, v1: 0.5 });
  });

  it('suggests sensible grids', () => {
    expect(suggestGrid(16)).toEqual({ cols: 4, rows: 4 });
    // square texture -> square cells, so 8 frames need 4x4 (never distort frames to 2:1)
    expect(suggestGrid(8)).toEqual({ cols: 4, rows: 4 });
    // a 2:1 texture gets 2:1 grids
    expect(suggestGrid(8, 2)).toEqual({ cols: 4, rows: 2 });
    expect(suggestGrid(17)).toEqual({ cols: 8, rows: 8 });
    expect(suggestGrid(0)).toEqual({ cols: 1, rows: 1 });
    expect(suggestGrid(1)).toEqual({ cols: 1, rows: 1 });
    const g = suggestGrid(300);
    expect(g.cols * g.rows).toBeGreaterThanOrEqual(300);
  });
});

describe('History', () => {
  it('undoes and redoes', () => {
    const h = new History(0);
    h.commit(1);
    h.commit(2);
    expect(h.present).toBe(2);
    expect(h.undo()).toBe(1);
    expect(h.undo()).toBe(0);
    expect(h.undo()).toBeUndefined();
    expect(h.redo()).toBe(1);
    h.commit(9);
    expect(h.canRedo).toBe(false);
  });

  it('coalesces rapid commits with the same key into one undo step', () => {
    let t = 0;
    const h = new History(0, { now: () => t });
    for (let v = 1; v <= 10; v++) {
      t += 100;
      h.commit(v, { coalesceKey: 'slider' });
    }
    expect(h.present).toBe(10);
    expect(h.undo()).toBe(0); // all ten edits were ONE undo step
    expect(h.canUndo).toBe(false);
  });

  it('does not coalesce after the window or across keys', () => {
    let t = 0;
    const h = new History(0, { now: () => t, coalesceMs: 500 });
    h.commit(1, { coalesceKey: 'a' });
    t += 2000;
    h.commit(2, { coalesceKey: 'a' });
    h.commit(3, { coalesceKey: 'b' });
    expect(h.undo()).toBe(2);
    expect(h.undo()).toBe(1);
    expect(h.undo()).toBe(0);
  });

  it('ignores reference-equal commits and respects the limit', () => {
    const h = new History<object>({}, { limit: 3 });
    const same = h.present;
    h.commit(same);
    expect(h.canUndo).toBe(false);
    for (let i = 0; i < 10; i++) h.commit({ i });
    let steps = 0;
    while (h.undo()) steps++;
    expect(steps).toBe(3);
  });

  it('notifies subscribers and bumps version', () => {
    const h = new History(0);
    let calls = 0;
    const off = h.subscribe(() => calls++);
    h.commit(1);
    h.undo();
    off();
    h.redo();
    expect(calls).toBe(2);
    expect(h.version).toBe(3);
  });
});

describe('safety', () => {
  it('sanitises filenames', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('.._.._etc_passwd'.replace(/^\.+/, ''));
    expect(sanitizeFilename('a<b>c:d"e|f?g*h')).toBe('a_b_c_d_e_f_g_h');
    expect(sanitizeFilename('CON')).toBe('_CON');
    expect(sanitizeFilename('nul.txt')).toBe('_nul.txt');
    expect(sanitizeFilename('   ')).toBe('untitled');
    expect(sanitizeFilename('...')).toBe('untitled');
    expect(sanitizeFilename('name. . ')).toBe('name');
    expect(sanitizeFilename('x'.repeat(300)).length).toBeLessThanOrEqual(100);
    expect(sanitizeFilename('bad\u0000name\n.png')).toBe('bad_name_.png');
  });

  it('sanitises identifiers to the FiveM-safe alphabet', () => {
    expect(sanitizeIdentifier('Purple Flames!!')).toBe('purple_flames');
    expect(sanitizeIdentifier('123abc')).toBe('fx_123abc');
    expect(sanitizeIdentifier('Ünïcödé Fx')).toBe('unicode_fx');
    expect(sanitizeIdentifier('')).toBe('vfxforge_fx');
    expect(sanitizeIdentifier('____')).toBe('vfxforge_fx');
    expect(sanitizeIdentifier('a'.repeat(100)).length).toBe(48);
    expect(sanitizeIdentifier("'; os.execute('rm -rf /') --")).toMatch(/^[a-z][a-z0-9_]*$/);
  });

  it('detects unsafe relative paths', () => {
    for (const bad of ['../x', 'a/../../x', '/abs', 'C:\\win', '\\\\server\\share', 'a\\..\\b', '', 'a//b', './x', 'a\0b']) {
      expect(isSafeRelativePath(bad), bad).toBe(false);
    }
    for (const good of ['assets/a.png', 'a.b/c-d_e.ext']) expect(isSafeRelativePath(good), good).toBe(true);
  });

  it('escapes lua and xml', () => {
    expect(luaEscape("it's \\ a\nline")).toBe("it\\'s \\\\ a\\nline");
    expect(luaEscape('a\u0001b')).toBe('a\\001b');
    expect(xmlEscape(`<a b="c">&'</a>\u0001`)).toBe('&lt;a b=&quot;c&quot;&gt;&amp;&apos;&lt;/a&gt;');
  });

  it('makes unique names', () => {
    expect(uniqueName('fx', new Set(['fx', 'fx_2']))).toBe('fx_3');
    expect(uniqueName('fx', new Set())).toBe('fx');
  });
});

describe('math', () => {
  it('rotates by euler XYZ degrees', () => {
    const r = rotateEulerXYZ([0, 0, 1], [90, 0, 0]);
    expect(r[0]).toBeCloseTo(0);
    expect(r[1]).toBeCloseTo(-1);
    expect(r[2]).toBeCloseTo(0);
    const z = rotateEulerXYZ([1, 0, 0], [0, 0, 90]);
    expect(z[0]).toBeCloseTo(0);
    expect(z[1]).toBeCloseTo(1);
  });
});

describe('project schema', () => {
  function sample() {
    const p = createProject('Purple Flames');
    const asset = createAsset({
      kind: 'video',
      name: 'flames.mp4',
      file: 'assets/' + 'a'.repeat(64) + '.mp4',
      sha256: 'a'.repeat(64),
      bytes: 10,
      mime: 'video/mp4',
      info: { width: 64, height: 64, durationSec: 1, fps: 16, frameCount: 16, hasAlpha: false, codec: 'h264' },
    });
    p.assets[asset.id] = asset;
    const clip = createClip('Flames', asset.id);
    p.clips[clip.id] = clip;
    const sheet = createSheet('Flames Sheet', clip.id);
    p.sheets[sheet.id] = sheet;
    const fx = createEffect('Purple Flames');
    fx.emitters.push(createEmitter('Core', sheet.id));
    p.effects[fx.id] = fx;
    return p;
  }

  it('round-trips a full project through JSON', () => {
    const p = sample();
    const r = parseProject(JSON.parse(JSON.stringify(p)));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.project).toEqual(p);
  });

  it('rejects structurally invalid documents with readable paths', () => {
    const p = JSON.parse(JSON.stringify(sample()));
    const sheetId = Object.keys(p.sheets)[0]!;
    p.sheets[sheetId].grid.cols = 0;
    const r = parseProject(p);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join('\n')).toContain('sheets');
  });

  it('rejects asset paths that escape the project folder', () => {
    const p = JSON.parse(JSON.stringify(sample()));
    const id = Object.keys(p.assets)[0]!;
    p.assets[id].file = '../../secrets.txt';
    const r = parseProject(p);
    expect(r.ok).toBe(false);
  });

  it('rejects dangling references', () => {
    const p = JSON.parse(JSON.stringify(sample()));
    const id = Object.keys(p.sheets)[0]!;
    p.sheets[id].clipId = 'clip_missing';
    const r = parseProject(p);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join('\n')).toContain('missing clip');
  });

  it('rejects NaN/Infinity-style numbers and unknown schema versions', () => {
    const p = JSON.parse(JSON.stringify(sample()));
    p.schemaVersion = 99;
    expect(parseProject(p).ok).toBe(false);
    const q = sample();
    q.weapon.modelScale = Number.POSITIVE_INFINITY;
    expect(parseProject(q).ok).toBe(false);
  });

  it('rejects non-identifier resource names that could break Lua/FiveM', () => {
    const p = sample();
    p.export.resourceName = "x'; os.exit() --";
    expect(parseProject(p).ok).toBe(false);
  });
});
