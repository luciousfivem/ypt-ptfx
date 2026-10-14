/**
 * The export pipeline. One function, explicit stages, hard gates:
 *
 *   1  frames        raw frames for every clip used by an emitter        (FrameSource)
 *   2  sheets        non-destructive clip pipeline -> atlas -> PNG + DDS   (media)
 *   3  flipbook      Flipbook Compatibility Validator per sheet            (ypt)
 *   4  yupt model    effects -> rules, mapping report                      (ypt)
 *   5  xml           CodeWalker XML + structural validation + DDS checks   (ypt)
 *   6  binary        XML -> binary .ypt through the converter bridge, with
 *                    CodeWalker's own read-back verification              (ConvertService)
 *   7  resource      FiveM resource + ZIP                                  (fivem)
 *
 * Gate: ANY error from stages 1-6 means `status: 'blocked'` and no resource is produced. If
 * only the converter is missing the caller may opt into a clearly-labelled source-only package.
 * A file is never reported as exported merely because it was written.
 */
import type { Clip, Project, Sheet } from '@vfxforge/core';
import {
  bleedTransparentColor,
  buildAtlas,
  encodeDds,
  encodePng,
  expandHolds,
  mipLevelCount,
  processClip,
  type RgbaImage,
} from '@vfxforge/media';
import {
  applyDonorPlan,
  buildYptModel,
  err,
  info,
  inspectYptXml,
  loadDonor,
  validateFlipbook,
  validateTextureFiles,
  warn,
  writeYptXml,
  type BindingPlan,
  type DonorPlan,
  type FlipbookReport,
  type Issue,
  type MappingNote,
  type SheetAsset,
  type YptXmlSummary,
} from '@vfxforge/ypt';
import { DEFAULT_RESOURCE_OPTIONS, packageResource, type ResourceOptions } from '@vfxforge/fivem';
import { estimateProject, textureBytes, type Estimate, type SheetCost } from './estimate';

/** Supplies raw frames for a clip (FFmpeg on desktop, <video> in the browser, a fixture in tests). */
export interface FrameSource {
  getFrames(clip: Clip, project: Project, signal?: AbortSignal): Promise<RgbaImage[]>;
}

export interface ConvertResult {
  ypt: Uint8Array;
  /** CodeWalker re-loaded the binary and the structure matched the XML. */
  roundTripOk: boolean;
  mismatches: string[];
  resourceVersion: number;
  codewalkerCore: string | null;
}

/** XML + DDS -> binary YPT through a verified converter. Omit when none is configured. */
export interface ConvertService {
  convert(args: { xml: string; dds: Record<string, Uint8Array>; gen9: boolean; assetName: string }): Promise<ConvertResult>;
}

export interface ExportOptions {
  resource: Partial<ResourceOptions>;
  donor?: { xml: string; plan: Omit<DonorPlan, 'assetName'> } | null;
  /** If no converter is available, produce a clearly labelled source-only package instead of blocking. */
  allowSourceOnly?: boolean;
  signal?: AbortSignal;
  onStage?: (stage: Stage, detail?: string) => void;
}

export type Stage = 'frames' | 'sheets' | 'flipbook' | 'model' | 'xml' | 'binary' | 'resource';

export interface SheetArtifact {
  sheetId: string;
  textureName: string;
  png: Uint8Array;
  dds: Uint8Array;
  ddsFileName: string;
  flipbook: FlipbookReport;
  frames: number;
  warnings: string[];
}

export type ExportStatus = 'complete' | 'source-only' | 'blocked';

export interface ExportReport {
  status: ExportStatus;
  issues: Issue[];
  /** Issues that stopped the export (a subset of `issues`). */
  blockers: Issue[];
  mapping: MappingNote[];
  estimate: Estimate | null;
  summary: YptXmlSummary | null;
  converter: { used: boolean; roundTripOk: boolean | null; resourceVersion: number | null; codewalkerCore: string | null };
}

export interface ExportResult {
  report: ExportReport;
  xml: string | null;
  sheets: SheetArtifact[];
  ypt: Uint8Array | null;
  zip: Uint8Array | null;
  files: Record<string, Uint8Array> | null;
  bindings: BindingPlan[];
}

class Cancelled extends Error {
  constructor() {
    super('Export cancelled');
    this.name = 'Cancelled';
  }
}

const check = (signal?: AbortSignal) => {
  if (signal?.aborted) throw new Cancelled();
};

export async function runExport(project: Project, frames: FrameSource, convert: ConvertService | null, opts: ExportOptions): Promise<ExportResult> {
  const issues: Issue[] = [];
  const stage = (s: Stage, d?: string) => opts.onStage?.(s, d);
  const blocked = (partial: Partial<ExportResult> & { mapping?: MappingNote[]; estimate?: Estimate | null; summary?: YptXmlSummary | null }): ExportResult => ({
    report: {
      status: 'blocked',
      issues,
      blockers: issues.filter((i) => i.severity === 'error'),
      mapping: partial.mapping ?? [],
      estimate: partial.estimate ?? null,
      summary: partial.summary ?? null,
      converter: { used: false, roundTripOk: null, resourceVersion: null, codewalkerCore: null },
    },
    xml: partial.xml ?? null,
    sheets: partial.sheets ?? [],
    ypt: null,
    zip: null,
    files: null,
    bindings: partial.bindings ?? [],
  });

  /* ---- which sheets are actually used ---- */
  const usedSheetIds = new Set<string>();
  for (const e of Object.values(project.effects)) for (const em of e.emitters) if (em.enabled && em.sheetId) usedSheetIds.add(em.sheetId);
  if (usedSheetIds.size === 0) {
    issues.push(err('no-sheets', 'No enabled emitter uses a spritesheet. Create a spritesheet and assign it to an emitter first.'));
    return blocked({});
  }
  const names = new Map<string, string>();
  for (const id of usedSheetIds) {
    const s = project.sheets[id];
    if (!s) continue;
    const prev = names.get(s.textureName);
    if (prev) issues.push(err('texture-name-clash', `Spritesheets "${prev}" and "${s.name}" both use the texture name "${s.textureName}".`));
    names.set(s.textureName, s.name);
  }
  if (issues.some((i) => i.severity === 'error')) return blocked({});

  /* ---- stages 1-3: frames, atlas, flipbook ---- */
  const artifacts: SheetArtifact[] = [];
  const sheetAssets: Record<string, SheetAsset> = {};
  const sheetCosts: SheetCost[] = [];
  const ddsFiles: Record<string, Uint8Array> = {};
  const frameCache = new Map<string, RgbaImage[]>();
  try {
    for (const id of usedSheetIds) {
      check(opts.signal);
      const sheet = project.sheets[id]!;
      const clip = project.clips[sheet.clipId]!;
      stage('frames', sheet.name);
      let raw = frameCache.get(clip.id);
      if (!raw) {
        raw = await frames.getFrames(clip, project, opts.signal);
        frameCache.set(clip.id, raw);
      }
      check(opts.signal);
      stage('sheets', sheet.name);
      const processed = processClip(raw, clip);
      for (const n of processed.notes) issues.push(info('clip-note', n, sheet.name));
      const expanded = expandHolds(processed.frames, processed.durations);
      const atlas = buildAtlas(expanded, atlasParams(sheet));
      for (const w of atlas.warnings) issues.push(warn('atlas-warning', w, sheet.name));
      const bled = bleedTransparentColor(atlas.image);
      const dds = encodeDds(bled, sheet.dds);
      const mips = sheet.dds.mipmaps ? mipLevelCount(sheet.texture.width, sheet.texture.height) : 1;
      const ddsFileName = `${sheet.textureName}.dds`;

      stage('flipbook', sheet.name);
      const usedRange = frameRangeFor(project, id, atlas.frameCount);
      const flipbook = validateFlipbook({
        textureName: sheet.textureName,
        frameCount: atlas.frameCount,
        grid: sheet.grid,
        texture: sheet.texture,
        order: sheet.order,
        padding: sheet.padding,
        mipmaps: sheet.dds.mipmaps,
        frameRange: usedRange,
        target: project.export.target,
        strategy: project.export.yptStrategy,
        donorGrid: null,
        donorTextureName: null,
      });
      for (const i of flipbook.issues) issues.push({ ...i, where: i.where ?? sheet.name });

      artifacts.push({ sheetId: id, textureName: sheet.textureName, png: encodePng(atlas.image), dds, ddsFileName, flipbook, frames: atlas.frameCount, warnings: atlas.warnings });
      sheetAssets[id] = { sheet, frameCount: atlas.frameCount, ddsFileName, width: sheet.texture.width, height: sheet.texture.height, mipLevels: mips, ddsFormat: sheet.dds.format };
      sheetCosts.push({ sheetId: id, textureName: sheet.textureName, width: sheet.texture.width, height: sheet.texture.height, frames: atlas.frameCount, format: sheet.dds.format, mips, bytes: textureBytes(sheet.texture.width, sheet.texture.height, sheet.dds.format, mips) });
      ddsFiles[ddsFileName] = dds;
    }
  } catch (e) {
    if (e instanceof Cancelled) throw e;
    issues.push(err('sheet-failed', e instanceof Error ? e.message : String(e)));
    return blocked({ sheets: artifacts });
  }
  const estimate = estimateProject(project, sheetCosts);
  issues.push(...estimate.issues);

  /* ---- stage 4-5: model, xml, validation ---- */
  check(opts.signal);
  stage('model', project.name);
  const assetName = project.export.assetName;
  const built = buildYptModel(project, sheetAssets, { assetName });
  for (const e of built.errors) issues.push(err('model', e));
  if (built.errors.length) return blocked({ sheets: artifacts, estimate, mapping: built.notes });
  let xml = writeYptXml(built.model);
  let bindings = built.bindings;
  let mapping = built.notes;

  if (project.export.yptStrategy === 'donor') {
    if (!opts.donor) {
      issues.push(err('donor-missing', 'The donor strategy needs a donor .ypt.xml. Load one in the Export panel or switch to "generate".'));
      return blocked({ sheets: artifacts, estimate, mapping });
    }
    try {
      const patched = applyDonorPlan(loadDonor(opts.donor.xml).root, { ...opts.donor.plan, assetName });
      for (const line of patched.report) issues.push(info('donor', line));
      xml = patched.xml;
      // the donor supplies the rules; our generated bindings still describe how the script starts them
    } catch (e) {
      issues.push(err('donor-failed', e instanceof Error ? e.message : String(e)));
      return blocked({ sheets: artifacts, estimate, mapping });
    }
  }

  stage('xml', assetName);
  const inspected = inspectYptXml(xml);
  issues.push(...inspected.issues);
  if (inspected.summary) {
    const tex = validateTextureFiles({ summary: inspected.summary, files: ddsFiles });
    issues.push(...tex.issues);
  }
  const unsupported = mapping.filter((n) => n.status === 'unsupported');
  for (const n of unsupported) issues.push(warn('not-exported', `${n.effect} / ${n.emitter}: ${n.property} is not exported. ${n.detail}`));

  if (issues.some((i) => i.severity === 'error')) {
    return blocked({ sheets: artifacts, estimate, mapping, xml, summary: inspected.summary, bindings });
  }

  /* ---- stage 6: binary ---- */
  check(opts.signal);
  stage('binary', assetName);
  let ypt: Uint8Array | null = null;
  let conv: ConvertResult | null = null;
  if (convert) {
    try {
      conv = await convert.convert({ xml, dds: ddsFiles, gen9: project.export.target === 'fivem-enhanced', assetName });
      if (!conv.roundTripOk) {
        issues.push(err('roundtrip-failed', `CodeWalker could not read the binary YPT back identically: ${conv.mismatches.join('; ') || 'unknown mismatch'}. The file was NOT exported.`));
      } else {
        ypt = conv.ypt;
        issues.push(info('roundtrip-ok', `Binary YPT (resource v${conv.resourceVersion}) was re-loaded by CodeWalker and matched the XML.`));
      }
    } catch (e) {
      issues.push(err('convert-failed', e instanceof Error ? e.message : String(e)));
    }
  } else if (!opts.allowSourceOnly) {
    issues.push(err('no-converter', 'No verified converter is configured, so a binary .ypt cannot be produced. Set up the CodeWalker bridge (docs/YPT_BRIDGE.md), or export a source-only package for CodeWalker.'));
  } else {
    issues.push(warn('source-only', 'No converter is configured: exporting a SOURCE-ONLY package (.ypt.xml + DDS). Convert it with CodeWalker before the resource can load an effect.'));
  }
  if (issues.some((i) => i.severity === 'error')) {
    return blocked({ sheets: artifacts, estimate, mapping, xml, summary: inspected.summary, bindings });
  }

  /* ---- stage 7: resource ---- */
  stage('resource', project.export.resourceName);
  const options: ResourceOptions = {
    ...DEFAULT_RESOURCE_OPTIONS,
    resourceName: project.export.resourceName,
    assetName,
    author: project.export.author,
    weapons: project.export.weapons,
    ...opts.resource,
  };
  const validationSummary = [
    `Structure: ${inspected.summary?.effects.length ?? 0} effect rule(s), ${inspected.summary?.emitters.length ?? 0} emitter rule(s), ${inspected.summary?.particles.length ?? 0} particle rule(s), ${inspected.summary?.textures.length ?? 0} texture(s) — all references resolved, no errors.`,
    `Textures: DDS files validated (format, size, mip chain) and matched to the XML.`,
    conv
      ? `CodeWalker${conv.codewalkerCore ? ' ' + conv.codewalkerCore : ''} loaded the binary YPT (RSC7 v${conv.resourceVersion}) and its structure matched the XML.`
      : 'No binary conversion was performed (source-only package).',
    'Flipbook layout: structurally valid; engine-side frame/UV mapping is UNVERIFIED (see the fidelity report).',
  ];
  let packaged;
  try {
    packaged = packageResource({
      options,
      bindings,
      ypt,
      source: { xml, dds: ddsFiles },
      notes: mapping,
      validationSummary,
      sourceOnly: ypt === null,
    });
  } catch (e) {
    issues.push(err('resource-failed', e instanceof Error ? e.message : String(e)));
    return blocked({ sheets: artifacts, estimate, mapping, xml, summary: inspected.summary, bindings });
  }
  for (const w of packaged.warnings) issues.push(warn('resource-warning', w));

  return {
    report: {
      status: ypt ? 'complete' : 'source-only',
      issues,
      blockers: [],
      mapping,
      estimate,
      summary: inspected.summary,
      converter: { used: !!conv, roundTripOk: conv?.roundTripOk ?? null, resourceVersion: conv?.resourceVersion ?? null, codewalkerCore: conv?.codewalkerCore ?? null },
    },
    xml,
    sheets: artifacts,
    ypt,
    zip: packaged.zip,
    files: packaged.files,
    bindings,
  };
}

function atlasParams(sheet: Sheet) {
  return {
    grid: sheet.grid,
    texture: sheet.texture,
    order: sheet.order,
    padding: sheet.padding,
    extrude: sheet.extrude,
    fit: sheet.fit,
    trim: sheet.trim,
    center: sheet.center,
    range: sheet.range,
  };
}

/** The union of frame ids the emitters that use this sheet will request. */
function frameRangeFor(project: Project, sheetId: string, frameCount: number): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (const e of Object.values(project.effects)) {
    for (const em of e.emitters) {
      if (!em.enabled || em.sheetId !== sheetId) continue;
      const last = Math.max(0, Math.min(frameCount - 1, em.animation.endFrame ?? frameCount - 1));
      const first = Math.max(0, Math.min(last, em.animation.startFrame));
      min = Math.min(min, first);
      max = Math.max(max, last);
    }
  }
  return min === Infinity ? { min: 0, max: Math.max(0, frameCount - 1) } : { min, max };
}
