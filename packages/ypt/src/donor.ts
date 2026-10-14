/**
 * Donor-template workflow.
 *
 * Generating a rule from scratch is schema-valid but its engine-side values (shader names,
 * blend-set numbers, KFP semantics) are partly inferred. A *donor* is a `.ypt.xml` that the
 * user exported with CodeWalker from game files they own, containing a rule that is known
 * to render. This module patches ONLY the fields VFXForge controls — the atlas texture, the
 * frame range / animation rate, names — and carries every other byte of the donor through
 * unchanged, because the document is edited as a generic tree rather than re-modelled.
 */
import { child, childrenOf, parseXml, serializeTree, valueOf, type XNode } from './xml';
import { inspectYptXml, type InspectResult } from './validate';

export interface DonorTextureEdit {
  /** Name of the existing texture entry in the donor to replace. */
  donorTextureName: string;
  /** Rename the texture (all shader-var references are updated). Omit to keep the donor's name. */
  newName?: string;
  fileName: string;
  width: number;
  height: number;
  mipLevels: number;
  format: 'D3DFMT_DXT1' | 'D3DFMT_DXT5' | 'D3DFMT_A8R8G8B8';
}

export interface DonorParticleEdit {
  particleName: string;
  texFrameMin: number;
  texFrameMax: number;
  /** Written to the first key of ptxu_AnimateTexture's AnimRateKFP when provided. */
  animFps?: number;
}

export interface DonorPlan {
  assetName: string;
  /** Prune the document down to these effects plus everything they (transitively) reference. */
  keepEffects?: string[];
  renameEffects?: Record<string, string>;
  texture?: DonorTextureEdit;
  particles?: DonorParticleEdit[];
}

export interface DonorLoad {
  root: XNode;
  inspect: InspectResult;
}

export function loadDonor(xml: string): DonorLoad {
  const inspect = inspectYptXml(xml);
  if (!inspect.summary) throw new Error(inspect.issues.map((i) => i.message).join(' '));
  return { root: parseXml(xml), inspect };
}

export interface DonorResult {
  xml: string;
  report: string[];
  inspect: InspectResult;
}

const lc = (s: string | undefined) => (s ?? '').toLowerCase();

function dict(root: XNode, name: string): XNode | undefined {
  return child(root, name);
}

function items(root: XNode, name: string): XNode[] {
  const d = dict(root, name);
  return d ? childrenOf(d, 'Item') : [];
}

function setValueChild(node: XNode, tag: string, v: string | number): void {
  const existing = child(node, tag);
  if (existing) existing.attrs.value = String(v);
  else node.children.push({ name: tag, attrs: { value: String(v) }, children: [], text: '' });
}

function setTextChild(node: XNode, tag: string, text: string): void {
  const existing = child(node, tag);
  if (existing) existing.text = text;
  else node.children.push({ name: tag, attrs: {}, children: [], text });
}

function find(list: XNode[], name: string): XNode | undefined {
  return list.find((i) => lc(child(i, 'Name')?.text) === lc(name));
}

/** Applies the plan to a deep copy of the donor and re-validates the result. */
export function applyDonorPlan(donor: XNode, plan: DonorPlan): DonorResult {
  const root: XNode = structuredClone(donor);
  const report: string[] = [];

  setTextChild(root, 'Name', plan.assetName);
  report.push(`Asset name set to "${plan.assetName}".`);

  // 1. prune to the requested effects + transitive references
  if (plan.keepEffects) pruneTo(root, plan.keepEffects, report);

  // 2. texture replacement (in place)
  if (plan.texture) {
    const t = plan.texture;
    const entry = find(items(root, 'TextureDictionary'), t.donorTextureName);
    if (!entry) throw new Error(`The donor has no texture named "${t.donorTextureName}". Available: ${items(root, 'TextureDictionary').map((i) => child(i, 'Name')?.text).join(', ') || '(none)'}.`);
    setValueChild(entry, 'Width', t.width);
    setValueChild(entry, 'Height', t.height);
    setValueChild(entry, 'MipLevels', t.mipLevels);
    setTextChild(entry, 'Format', t.format);
    setTextChild(entry, 'FileName', t.fileName);
    report.push(`Texture "${t.donorTextureName}" now points at ${t.fileName} (${t.width}x${t.height}, ${t.mipLevels} mip(s), ${t.format}).`);
    if (t.newName && lc(t.newName) !== lc(t.donorTextureName)) {
      setTextChild(entry, 'Name', t.newName);
      let refs = 0;
      for (const p of items(root, 'ParticleRuleDictionary')) {
        for (const v of childrenOf(child(p, 'ShaderVars') ?? EMPTY, 'Item')) {
          const tn = child(v, 'TextureName');
          if (tn && lc(tn.text) === lc(t.donorTextureName)) {
            tn.text = t.newName;
            refs++;
          }
        }
      }
      report.push(`Texture renamed to "${t.newName}" (${refs} shader-variable reference(s) updated).`);
    }
  }

  // 3. particle frame range / animation rate
  for (const e of plan.particles ?? []) {
    const p = find(items(root, 'ParticleRuleDictionary'), e.particleName);
    if (!p) throw new Error(`The donor has no particle rule named "${e.particleName}".`);
    setValueChild(p, 'TexFrameIDMin', e.texFrameMin);
    setValueChild(p, 'TexFrameIDMax', e.texFrameMax);
    const anim = childrenOf(child(p, 'AllBehaviours') ?? EMPTY, 'Item').find((b) => valueOf(child(b, 'Type')) === 'AnimateTexture');
    if (anim) {
      setValueChild(anim, 'LastFrameID', e.texFrameMax);
      if (e.animFps !== undefined) {
        const keys = childrenOf(child(child(anim, 'AnimRateKFP') ?? EMPTY, 'Keyframes') ?? EMPTY, 'Item');
        for (const k of keys) {
          const v = child(k, 'KeyframeValue');
          if (v) {
            v.attrs.x = String(e.animFps);
            v.attrs.y = String(e.animFps);
          }
        }
        report.push(`Particle "${e.particleName}": frames ${e.texFrameMin}..${e.texFrameMax}, animation rate ${e.animFps}.`);
      } else {
        report.push(`Particle "${e.particleName}": frames ${e.texFrameMin}..${e.texFrameMax}.`);
      }
    } else {
      report.push(`Particle "${e.particleName}": frames ${e.texFrameMin}..${e.texFrameMax} (the donor rule has no AnimateTexture behaviour, so it will not animate).`);
    }
  }

  // 4. effect renames (effect names are only referenced by other effects' spawners and by Lua)
  for (const [from, to] of Object.entries(plan.renameEffects ?? {})) {
    const eff = find(items(root, 'EffectRuleDictionary'), from);
    if (!eff) throw new Error(`The donor has no effect named "${from}".`);
    setTextChild(eff, 'Name', to);
    for (const p of items(root, 'ParticleRuleDictionary')) {
      for (const tag of ['EffectSpawnerAtRatio', 'EffectSpawnerOnCollision']) {
        const er = child(child(p, tag) ?? EMPTY, 'EffectRule');
        if (er && lc(er.text) === lc(from)) er.text = to;
      }
    }
    report.push(`Effect "${from}" renamed to "${to}".`);
  }

  const xml = serializeTree(root);
  return { xml, report, inspect: inspectYptXml(xml) };
}

const EMPTY: XNode = { name: '', attrs: {}, children: [], text: '' };

function pruneTo(root: XNode, keepEffects: string[], report: string[]): void {
  const effectItems = items(root, 'EffectRuleDictionary');
  const particleItems = items(root, 'ParticleRuleDictionary');

  const keepEffect = new Set<string>();
  const keepEmitter = new Set<string>();
  const keepParticle = new Set<string>();
  const keepTexture = new Set<string>();
  const queue = keepEffects.map(lc);
  for (const k of queue) if (!find(effectItems, k)) throw new Error(`The donor has no effect named "${k}".`);
  while (queue.length) {
    const en = queue.pop()!;
    if (keepEffect.has(en)) continue;
    keepEffect.add(en);
    const eff = find(effectItems, en);
    if (!eff) continue;
    for (const ev of childrenOf(child(eff, 'EventEmitters') ?? EMPTY, 'Item')) {
      const er = lc(child(ev, 'EmitterRule')?.text);
      const pr = lc(child(ev, 'ParticleRule')?.text);
      if (er) keepEmitter.add(er);
      if (pr && !keepParticle.has(pr)) {
        keepParticle.add(pr);
        const p = find(particleItems, pr);
        if (p) {
          for (const tag of ['EffectSpawnerAtRatio', 'EffectSpawnerOnCollision']) {
            const ref = lc(child(child(p, tag) ?? EMPTY, 'EffectRule')?.text);
            if (ref) queue.push(ref);
          }
          for (const v of childrenOf(child(p, 'ShaderVars') ?? EMPTY, 'Item')) {
            const tn = lc(child(v, 'TextureName')?.text);
            if (tn) keepTexture.add(tn);
          }
        }
      }
    }
  }
  const prune = (dictName: string, keep: Set<string>, label: string) => {
    const d = dict(root, dictName);
    if (!d) return;
    const before = childrenOf(d, 'Item').length;
    d.children = d.children.filter((c) => c.name !== 'Item' || keep.has(lc(child(c, 'Name')?.text)));
    const removed = before - childrenOf(d, 'Item').length;
    if (removed > 0) report.push(`Removed ${removed} unused ${label}.`);
  };
  prune('EffectRuleDictionary', keepEffect, 'effect rule(s)');
  prune('EmitterRuleDictionary', keepEmitter, 'emitter rule(s)');
  prune('ParticleRuleDictionary', keepParticle, 'particle rule(s)');
  prune('TextureDictionary', keepTexture, 'texture(s)');
  if (items(root, 'DrawableDictionary').length > 0) report.push('The donor has a DrawableDictionary; it was kept unchanged (not pruned).');
}
