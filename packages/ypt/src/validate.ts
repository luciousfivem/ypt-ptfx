/**
 * Export validation. The structural validator works on the XML TREE (the actual bytes
 * that will be handed to CodeWalker), not on the in-memory model, so it validates what is
 * really exported — including donor-patched documents VFXForge did not generate itself.
 */
import { isValidIdentifier } from '@vfxforge/core';
import { validateDds, type DdsInfo } from '@vfxforge/media';
import { child, childrenOf, parseXml, valueOf, XmlError, type XNode } from './xml';

export type Severity = 'error' | 'warning' | 'info';

export interface Issue {
  severity: Severity;
  code: string;
  message: string;
  /** Where: effect/emitter/particle/texture name when known. */
  where?: string;
}

export const err = (code: string, message: string, where?: string): Issue => ({ severity: 'error', code, message, where });
export const warn = (code: string, message: string, where?: string): Issue => ({ severity: 'warning', code, message, where });
export const info = (code: string, message: string, where?: string): Issue => ({ severity: 'info', code, message, where });

/** Jenkins one-at-a-time over raw bytes (reference vectors: "a" -> 0xca2e9442). */
export function jenkinsOaat(bytes: Uint8Array): number {
  let h = 0;
  for (const b of bytes) {
    h = (h + b) >>> 0;
    h = (h + (h << 10)) >>> 0;
    h = (h ^ (h >>> 6)) >>> 0;
  }
  h = (h + (h << 3)) >>> 0;
  h = (h ^ (h >>> 11)) >>> 0;
  h = (h + (h << 15)) >>> 0;
  return h >>> 0;
}

/** The hash CodeWalker/GTA use to key dictionary entries: one-at-a-time over the LOWER-CASED name. */
export function joaat(text: string): number {
  return jenkinsOaat(new TextEncoder().encode(text.toLowerCase()));
}

export interface YptXmlSummary {
  name: string;
  effects: string[];
  emitters: string[];
  particles: string[];
  textures: Array<{ name: string; fileName: string; width: number; height: number; mips: number; format: string }>;
}

export interface InspectResult {
  issues: Issue[];
  summary: YptXmlSummary | null;
  ok: boolean;
}

const num = (n: XNode | undefined): number => {
  const v = valueOf(n);
  if (v === undefined) return NaN;
  return v.startsWith('0x') ? parseInt(v.slice(2), 16) : Number(v);
};

function itemsOf(dict: XNode | undefined): XNode[] {
  return dict ? childrenOf(dict, 'Item') : [];
}

/** `<node><name><Item/>…</name></node>` -> the Item children, or [] when absent. */
function itemsIn(node: XNode | undefined, name: string): XNode[] {
  return itemsOf(node ? child(node, name) : undefined);
}

function nameOf(item: XNode): string {
  return child(item, 'Name')?.text ?? '';
}

function checkUnique(kind: string, names: string[], issues: Issue[]): void {
  const lower = new Map<string, string>();
  const hashes = new Map<number, string>();
  for (const n of names) {
    if (n === '') {
      issues.push(err('name-empty', `A ${kind} has no name.`));
      continue;
    }
    const l = n.toLowerCase();
    const prev = lower.get(l);
    if (prev !== undefined) {
      issues.push(err('name-duplicate', `${kind} names must be unique ignoring case: "${prev}" and "${n}" collide.`, n));
      continue;
    }
    lower.set(l, n);
    const h = joaat(n);
    const other = hashes.get(h);
    if (other !== undefined) issues.push(err('name-hash-collision', `${kind} "${n}" and "${other}" have the same Jenkins hash (0x${h.toString(16)}).`, n));
    hashes.set(h, n);
  }
}

/**
 * Structural validation of a `.ypt.xml` document: root element, dictionaries, unique names,
 * every cross-reference, keyframe-property slot counts and texture entries.
 */
export function inspectYptXml(xml: string): InspectResult {
  const issues: Issue[] = [];
  let root: XNode;
  try {
    root = parseXml(xml);
  } catch (e) {
    const msg = e instanceof XmlError ? e.message : String(e);
    return { issues: [err('xml-invalid', msg)], summary: null, ok: false };
  }
  if (root.name !== 'ParticleEffectsList') {
    return { issues: [err('xml-root', `Root element is <${root.name}>, expected <ParticleEffectsList>. This is not a YPT XML export.`)], summary: null, ok: false };
  }
  const assetName = child(root, 'Name')?.text ?? '';
  if (!isValidIdentifier(assetName.toLowerCase())) {
    issues.push(err('asset-name', `The asset name "${assetName}" must be a lowercase identifier (a-z, 0-9, _), starting with a letter, up to 48 characters.`));
  }
  const effects = itemsOf(child(root, 'EffectRuleDictionary'));
  const emitters = itemsOf(child(root, 'EmitterRuleDictionary'));
  const particles = itemsOf(child(root, 'ParticleRuleDictionary'));
  const textures = itemsOf(child(root, 'TextureDictionary'));
  if (!child(root, 'EffectRuleDictionary')) issues.push(err('dict-missing', 'EffectRuleDictionary is missing.'));
  if (!child(root, 'EmitterRuleDictionary')) issues.push(err('dict-missing', 'EmitterRuleDictionary is missing.'));
  if (!child(root, 'ParticleRuleDictionary')) issues.push(err('dict-missing', 'ParticleRuleDictionary is missing.'));
  if (effects.length === 0) issues.push(err('no-effects', 'The file defines no effect rules, so there is nothing the game can spawn.'));

  const effectNames = effects.map(nameOf);
  const emitterNames = emitters.map(nameOf);
  const particleNames = particles.map(nameOf);
  const textureNames = textures.map(nameOf);
  checkUnique('Effect rule', effectNames, issues);
  checkUnique('Emitter rule', emitterNames, issues);
  checkUnique('Particle rule', particleNames, issues);
  checkUnique('Texture', textureNames, issues);

  const emitterSet = new Set(emitterNames.map((n) => n.toLowerCase()));
  const particleSet = new Set(particleNames.map((n) => n.toLowerCase()));
  const effectSet = new Set(effectNames.map((n) => n.toLowerCase()));
  const textureSet = new Set(textureNames.map((n) => n.toLowerCase()));
  const usedEmitters = new Set<string>();
  const usedParticles = new Set<string>();
  const usedTextures = new Set<string>();

  for (const eff of effects) {
    const en = nameOf(eff);
    for (const k of [en]) if (k && !isValidIdentifier(k.toLowerCase())) issues.push(warn('name-style', `Effect name "${k}" should be a lowercase identifier.`, k));
    const evs = itemsIn(eff, 'EventEmitters');
    if (evs.length === 0) issues.push(err('effect-empty', `Effect "${en}" has no event emitters; it would spawn nothing.`, en));
    if (evs.length > 32) issues.push(err('effect-too-many-emitters', `Effect "${en}" has ${evs.length} event emitters; the format holds at most 32.`, en));
    for (const ev of evs) {
      const er = child(ev, 'EmitterRule')?.text ?? '';
      const pr = child(ev, 'ParticleRule')?.text ?? '';
      if (!emitterSet.has(er.toLowerCase())) issues.push(err('ref-emitter', `Effect "${en}" references emitter rule "${er}" which does not exist.`, en));
      else usedEmitters.add(er.toLowerCase());
      if (!particleSet.has(pr.toLowerCase())) issues.push(err('ref-particle', `Effect "${en}" references particle rule "${pr}" which does not exist.`, en));
      else usedParticles.add(pr.toLowerCase());
      const s = num(child(ev, 'StartRatio'));
      const e = num(child(ev, 'EndRatio'));
      if (!(s >= 0 && s <= 1 && e >= 0 && e <= 1 && e >= s)) issues.push(err('event-ratio', `Effect "${en}" has an event with an invalid StartRatio/EndRatio (${s}..${e}); both must satisfy 0 ≤ start ≤ end ≤ 1.`, en));
    }
    const kp = itemsIn(eff, 'KeyframeProps');
    if (kp.length < 5) issues.push(err('effect-kfp-count', `Effect "${en}" has ${kp.length} keyframe properties; CodeWalker's reader expects 5.`, en));
    checkKeyframes(kp, `effect "${en}"`, issues);
    const dMin = num(child(eff, 'DurationMin'));
    const dMax = num(child(eff, 'DurationMax'));
    if (!(dMin >= 0 && dMax >= dMin)) issues.push(err('effect-duration', `Effect "${en}" has an invalid duration range (${dMin}..${dMax}).`, en));
  }

  for (const em of emitters) {
    const n = nameOf(em);
    const kp = itemsIn(em, 'KeyframeProps');
    if (kp.length !== 10) issues.push(err('emitter-kfp-count', `Emitter rule "${n}" has ${kp.length} keyframe properties; the format has exactly 10 slots.`, n));
    checkKeyframes(kp, `emitter rule "${n}"`, issues);
    for (const tag of ['CreationDomainObj', 'TargetDomainObj', 'AttractorDomainObj']) {
      const d = child(em, tag);
      if (!d) {
        issues.push(err('domain-missing', `Emitter rule "${n}" has no ${tag}.`, n));
        continue;
      }
      const t = valueOf(child(d, 'DomainType'));
      if (!t || !['Box', 'Sphere', 'Cylinder', 'Attractor'].includes(t)) issues.push(err('domain-type', `Emitter rule "${n}" ${tag} has unknown DomainType "${t ?? ''}".`, n));
    }
    if (!usedEmitters.has(n.toLowerCase())) issues.push(warn('unused-emitter', `Emitter rule "${n}" is not used by any effect.`, n));
  }

  for (const p of particles) {
    const n = nameOf(p);
    const behaviours = itemsIn(p, 'AllBehaviours').map((b) => valueOf(child(b, 'Type')) ?? '');
    if (!behaviours.includes('Sprite') && !behaviours.includes('Model') && !behaviours.includes('Trail')) {
      issues.push(err('particle-no-draw', `Particle rule "${n}" has no draw behaviour (Sprite/Model/Trail); nothing would be rendered.`, n));
    }
    if (!behaviours.includes('Age')) issues.push(warn('particle-no-age', `Particle rule "${n}" has no Age behaviour.`, n));
    for (const b of behaviours) {
      if (b === '') issues.push(err('behaviour-type', `Particle rule "${n}" has a behaviour without a Type.`, n));
    }
    const fMin = num(child(p, 'TexFrameIDMin'));
    const fMax = num(child(p, 'TexFrameIDMax'));
    if (!(fMin >= 0 && fMax >= fMin)) issues.push(err('frame-range', `Particle rule "${n}" has an invalid texture frame range (${fMin}..${fMax}).`, n));
    const anim = itemsIn(p, 'AllBehaviours').find((b) => valueOf(child(b, 'Type')) === 'AnimateTexture');
    if (anim) {
      const last = num(child(anim, 'LastFrameID'));
      if (last !== fMax) issues.push(warn('frame-mismatch', `Particle rule "${n}": AnimateTexture.LastFrameID (${last}) differs from TexFrameIDMax (${fMax}).`, n));
    }
    const vars = itemsIn(p, 'ShaderVars');
    let hasTexture = false;
    for (const v of vars) {
      if (valueOf(child(v, 'Type')) === 'Texture') {
        const tn = child(v, 'TextureName')?.text ?? '';
        if (tn === '') continue;
        hasTexture = true;
        usedTextures.add(tn.toLowerCase());
        if (!textureSet.has(tn.toLowerCase())) {
          issues.push(err('ref-texture', `Particle rule "${n}" uses texture "${tn}" which is not in the texture dictionary (it would have to be provided by another YTD already loaded by the game).`, n));
        }
      }
    }
    if (!hasTexture) issues.push(warn('particle-no-texture', `Particle rule "${n}" binds no texture.`, n));
    if (!usedParticles.has(n.toLowerCase())) issues.push(warn('unused-particle', `Particle rule "${n}" is not used by any effect.`, n));
    checkSpawnerRef(child(p, 'EffectSpawnerAtRatio'), effectSet, n, issues);
    checkSpawnerRef(child(p, 'EffectSpawnerOnCollision'), effectSet, n, issues);
  }

  const texSummary: YptXmlSummary['textures'] = [];
  for (const t of textures) {
    const n = nameOf(t);
    const w = num(child(t, 'Width'));
    const h = num(child(t, 'Height'));
    const mips = num(child(t, 'MipLevels'));
    const fileName = child(t, 'FileName')?.text ?? '';
    const format = child(t, 'Format')?.text ?? '';
    texSummary.push({ name: n, fileName, width: w, height: h, mips, format });
    if (!isValidIdentifier(n.toLowerCase())) issues.push(warn('texture-name-style', `Texture name "${n}" should be a lowercase identifier.`, n));
    if (n !== n.toLowerCase()) issues.push(warn('texture-name-case', `Texture name "${n}" has upper-case letters; GTA texture lookups are hash-based and case-insensitive, so keep it lowercase.`, n));
    if (!(w >= 4 && h >= 4)) issues.push(err('texture-size', `Texture "${n}" has invalid dimensions ${w}x${h}.`, n));
    if (w > 0 && h > 0 && ((w & (w - 1)) !== 0 || (h & (h - 1)) !== 0)) issues.push(err('texture-pot', `Texture "${n}" is ${w}x${h}; GTA textures must have power-of-two dimensions.`, n));
    if (!/^[A-Za-z0-9_.\-]+\.dds$/.test(fileName)) issues.push(err('texture-file', `Texture "${n}" has an unsafe or non-.dds file name "${fileName}".`, n));
    if (!['D3DFMT_DXT1', 'D3DFMT_DXT5', 'D3DFMT_A8R8G8B8'].includes(format)) issues.push(err('texture-format', `Texture "${n}" has unsupported format "${format}" (supported: D3DFMT_DXT1, D3DFMT_DXT5, D3DFMT_A8R8G8B8).`, n));
    if (n !== '' && !usedTextures.has(n.toLowerCase())) issues.push(warn('unused-texture', `Texture "${n}" is not referenced by any particle rule.`, n));
  }

  const summary: YptXmlSummary = { name: assetName, effects: effectNames, emitters: emitterNames, particles: particleNames, textures: texSummary };
  return { issues, summary, ok: !issues.some((i) => i.severity === 'error') };
}

function checkSpawnerRef(node: XNode | undefined, effectSet: Set<string>, owner: string, issues: Issue[]): void {
  if (!node) return;
  const ref = child(node, 'EffectRule')?.text ?? '';
  if (ref !== '' && !effectSet.has(ref.toLowerCase())) {
    issues.push(err('ref-effect', `Particle rule "${owner}" spawns effect "${ref}" which does not exist in this file.`, owner));
  }
}

function checkKeyframes(props: XNode[], owner: string, issues: Issue[]): void {
  props.forEach((p, i) => {
    const keys = itemsIn(p, 'Keyframes');
    const kn = child(p, 'Name')?.text ?? '';
    if (kn === '') issues.push(err('kfp-name', `A keyframe property of ${owner} (slot ${i}) has no name.`));
    if (keys.length === 0) issues.push(err('kfp-empty', `Keyframe property ${kn || i} of ${owner} has no keyframes.`));
    let prev = -Infinity;
    for (const k of keys) {
      const t = child(k, 'KeyframeTime');
      const v = child(k, 'KeyframeValue');
      const tx = Number(t?.attrs.x);
      for (const [lane, node] of [['time', t], ['value', v]] as const) {
        for (const a of ['x', 'y', 'z', 'w']) {
          const val = Number(node?.attrs[a]);
          if (!Number.isFinite(val)) issues.push(err('kfp-number', `Keyframe ${lane}.${a} of ${kn || i} (${owner}) is missing or not a finite number.`));
        }
      }
      if (Number.isFinite(tx)) {
        if (tx < prev) issues.push(err('kfp-order', `Keyframes of ${kn || i} (${owner}) are not in ascending time order.`));
        prev = tx;
      }
    }
  });
}

/* ------------------------------------------------------------------ textures */

export interface TextureCheckInput {
  summary: YptXmlSummary;
  /** DDS bytes by file name. */
  files: Record<string, Uint8Array>;
}

/** Cross-checks the DDS files against what the XML promises (dimensions, mips, format). */
export function validateTextureFiles({ summary, files }: TextureCheckInput): { issues: Issue[]; infos: Record<string, DdsInfo> } {
  const issues: Issue[] = [];
  const infos: Record<string, DdsInfo> = {};
  const expectedFmt: Record<string, string> = { D3DFMT_DXT1: 'BC1', D3DFMT_DXT5: 'BC3', D3DFMT_A8R8G8B8: 'BGRA8' };
  for (const t of summary.textures) {
    const bytes = files[t.fileName];
    if (!bytes) {
      issues.push(err('dds-missing', `Texture "${t.name}" needs "${t.fileName}" next to the XML, but that file was not provided.`, t.name));
      continue;
    }
    const v = validateDds(bytes);
    for (const w of v.warnings) issues.push(warn('dds-warning', `${t.fileName}: ${w}`, t.name));
    if (!v.valid || !v.info) {
      for (const e of v.errors) issues.push(err('dds-invalid', `${t.fileName}: ${e}`, t.name));
      continue;
    }
    infos[t.name] = v.info;
    if (v.info.width !== t.width || v.info.height !== t.height) issues.push(err('dds-size-mismatch', `${t.fileName} is ${v.info.width}x${v.info.height} but the XML declares ${t.width}x${t.height}.`, t.name));
    if (v.info.mipLevels !== t.mips) issues.push(err('dds-mip-mismatch', `${t.fileName} has ${v.info.mipLevels} mip level(s) but the XML declares ${t.mips}.`, t.name));
    if (expectedFmt[t.format] !== v.info.format) issues.push(err('dds-format-mismatch', `${t.fileName} is ${v.info.format} but the XML declares ${t.format}.`, t.name));
  }
  return { issues, infos };
}

/** Estimated GPU memory (bytes) of the texture dictionary, including mips. */
export function estimateTextureBytes(textures: YptXmlSummary['textures']): number {
  let total = 0;
  for (const t of textures) {
    const bpp = t.format === 'D3DFMT_DXT1' ? 0.5 : t.format === 'D3DFMT_DXT5' ? 1 : 4;
    const base = t.width * t.height * bpp;
    total += t.mips > 1 ? base * (4 / 3) : base;
  }
  return Math.round(total);
}
