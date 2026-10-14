import { PROCEDURAL_TYPES, SPRITE_KINDS, type Clip } from '@vfxforge/core';
import { Button, ColorField, Field, NumberField, Section, SelectField, Segmented, SliderField, SwitchField, TextField } from '../../components/ui';
import { fitGridToFrames } from '../../services/actions';
import { svc } from '../../services/app';
import { useDerived } from '../../state/derived';
import { getProject, useProject } from '../../state/project';
import { Note, patchClip } from './common';
import { useShallow } from 'zustand/react/shallow';

const KEY_MODES = [
  { value: 'none', label: 'None' },
  { value: 'black', label: 'Black' },
  { value: 'white', label: 'White' },
  { value: 'chroma', label: 'Chroma' },
] as const;

export function ClipInspector({ clipId }: { clipId: string }) {
  const clip = useProject((s) => s.project.clips[clipId]);
  const asset = useProject((s) => (clip?.assetId ? s.project.assets[clip.assetId] : undefined));
  const sheetsOfClip = useProject(useShallow((s) => Object.values(s.project.sheets).filter((x) => x.clipId === clipId)));
  const preview = useDerived((s) => {
    for (const sh of sheetsOfClip) if (s.sheets[sh.id]?.preview) return s.sheets[sh.id]!.preview;
    return null;
  });
  if (!clip) return <Note>This clip no longer exists.</Note>;
  const features = svc().platform.features;
  const set = (label: string, key: string, fn: (c: Clip) => void) => patchClip(clipId, label, key, fn);
  const isVideo = asset?.kind === 'video';
  const isStill = asset?.kind === 'image' && (asset.info?.frameCount ?? 2) === 1;
  const isGen = !!clip.generator;
  const regrid = () => {
    const sh = sheetsOfClip[0];
    if (sh) fitGridToFrames(sh.id, undefined);
  };

  return (
    <div>
      <Section title="Clip">
        <Field label="Name">
          <TextField value={clip.name} maxLength={120} onChange={(v) => v.trim() && set('Rename clip', 'name', (c) => void (c.name = v))} />
        </Field>
        {asset && (
          <Note>
            {asset.name} · {asset.kind} · {asset.info ? `${asset.info.width}×${asset.info.height}` : ''}
            {asset.info?.durationSec ? ` · ${asset.info.durationSec.toFixed(2)} s` : ''}
            {asset.info?.fps ? ` · ${asset.info.fps.toFixed(2)} fps` : ''}
          </Note>
        )}
        {preview && (
          <Note>
            Processed: {preview.frameCount} frame{preview.frameCount === 1 ? '' : 's'} at {preview.fps.toFixed(1)} fps
            {preview.ms ? ` · ${preview.ms.toFixed(0)} ms` : ''}.
          </Note>
        )}
        <Note>Your original media is never modified. Everything here is a non-destructive recipe applied on top of it.</Note>
      </Section>

      {isGen && clip.generator && (
        <Section title="Procedural sprite">
          <Field label="Kind">
            <SelectField value={clip.generator.kind} options={SPRITE_KINDS.map((k) => ({ value: k, label: k }))} onChange={(k) => set('Sprite kind', 'gen', (c) => void (c.generator!.kind = k))} />
          </Field>
          <Field label="Frames">
            <NumberField value={clip.generator.frames} min={1} max={64} step={1} onChange={(v) => set('Sprite frames', 'gen', (c) => void (c.generator!.frames = v))} />
          </Field>
          <Field label="Frame size">
            <NumberField value={clip.generator.size} min={16} max={512} step={16} unit="px" onChange={(v) => set('Sprite size', 'gen', (c) => void (c.generator!.size = v))} />
          </Field>
          <Field label="Seed">
            <NumberField value={clip.generator.seed} min={0} max={0xffffffff} step={1} onChange={(v) => set('Sprite seed', 'gen', (c) => void (c.generator!.seed = v))} />
          </Field>
          <Field label="Intensity">
            <SliderField value={clip.generator.intensity} min={0.1} max={2} step={0.05} onChange={(v) => set('Sprite intensity', 'gen', (c) => void (c.generator!.intensity = v))} />
          </Field>
          <Field label="Palette">
            <div className="space-y-1">
              {clip.generator.palette.map((col, i) => (
                <ColorField key={i} value={col} onChange={(v) => set('Sprite palette', `pal${i}`, (c) => void (c.generator!.palette[i] = [v[0]!, v[1]!, v[2]!]))} />
              ))}
            </div>
          </Field>
          <Note>Dark/outer colour first, bright/core last. Frames are generated deterministically from the seed, so the sheet is reproducible.</Note>
          <Button size="xs" onClick={regrid}>Fit spritesheet grid to {clip.generator.frames} frames</Button>
        </Section>
      )}

      {!isGen && (
        <Section title="Frame extraction" defaultOpen={isVideo || !isStill}>
          {isVideo && (
            <>
              <Field label="Start">
                <NumberField value={clip.extract.startSec} min={0} step={0.05} unit="s" onChange={(v) => set('Start time', 'ex', (c) => void (c.extract.startSec = v))} />
              </Field>
              <Field label="End" hint="0 = to the end">
                <NumberField value={clip.extract.endSec ?? 0} min={0} step={0.05} unit="s" onChange={(v) => set('End time', 'ex', (c) => void (c.extract.endSec = v > 0 ? v : null))} />
              </Field>
            </>
          )}
          <Field label="Frame rate" hint={features.accurateProbe ? undefined : 'The browser cannot read the source frame rate; frames are sampled at this rate.'}>
            <NumberField value={clip.extract.fps} min={0.1} max={120} step={0.5} unit="fps" onChange={(v) => set('Extraction fps', 'ex', (c) => void (c.extract.fps = v))} />
          </Field>
          <Field label="Skip frames">
            <NumberField value={clip.extract.frameSkip} min={0} max={64} step={1} onChange={(v) => set('Frame skip', 'ex', (c) => void (c.extract.frameSkip = v))} />
          </Field>
          <Field label="Max frames">
            <NumberField value={clip.extract.maxFrames} min={1} max={1024} step={1} onChange={(v) => set('Max frames', 'ex', (c) => void (c.extract.maxFrames = v))} />
          </Field>
          <Field label="Width" hint="0 = source size">
            <NumberField value={clip.extract.width ?? 0} min={0} max={8192} step={16} unit="px" onChange={(v) => set('Extraction width', 'ex', (c) => void (c.extract.width = v > 0 ? v : null))} />
          </Field>
          <Field label="Height" hint="0 = source size">
            <NumberField value={clip.extract.height ?? 0} min={0} max={8192} step={16} unit="px" onChange={(v) => set('Extraction height', 'ex', (c) => void (c.extract.height = v > 0 ? v : null))} />
          </Field>
          <Field label="Keep aspect">
            <SwitchField checked={clip.extract.keepAspect} onChange={(v) => set('Keep aspect', 'ex', (c) => void (c.extract.keepAspect = v))} label="Keep aspect ratio" />
          </Field>
          <Field label="Interpolation" hint={features.interpolation ? undefined : 'Frame blending needs FFmpeg (desktop app).'}>
            <SelectField
              value={clip.extract.interpolation}
              options={[
                { value: 'none', label: 'None' },
                { value: 'blend', label: features.interpolation ? 'Blend frames' : 'Blend (desktop only)' },
              ]}
              onChange={(v) => set('Interpolation', 'ex', (c) => void (c.extract.interpolation = v))}
            />
          </Field>
          <Note>Preview extraction is capped at 512 px; the export re-extracts with exactly these settings.</Note>
        </Section>
      )}

      <Section title="Playback" defaultOpen={false}>
        <Field label="Reverse">
          <SwitchField checked={clip.playback.reverse} onChange={(v) => set('Reverse', 'pb', (c) => void (c.playback.reverse = v))} label="Reverse" />
        </Field>
        <Field label="Ping-pong">
          <SwitchField checked={clip.playback.pingPong} onChange={(v) => set('Ping-pong', 'pb', (c) => void (c.playback.pingPong = v))} label="Ping-pong" />
        </Field>
        <Field label="Loop">
          <SwitchField checked={clip.playback.loop} onChange={(v) => set('Loop', 'pb', (c) => void (c.playback.loop = v))} label="Loop" />
        </Field>
        <Field label="Speed">
          <SliderField value={clip.playback.speed} min={0.1} max={4} step={0.05} onChange={(v) => set('Speed', 'pb', (c) => void (c.playback.speed = v))} />
        </Field>
      </Section>

      <Section title="Background removal">
        <Segmented label="Keying mode" value={clip.keying.mode} options={KEY_MODES.map((m) => ({ value: m.value, label: m.label }))} onChange={(v) => set('Keying mode', 'key', (c) => void (c.keying.mode = v))} />
        {clip.keying.mode === 'black' && <Note>Black is treated as transparent and colour is un-premultiplied from the brightness: ideal for fire, smoke and energy footage shot on black.</Note>}
        {clip.keying.mode === 'white' && <Note>White is treated as transparent (for dark effects on white).</Note>}
        {clip.keying.mode === 'chroma' && (
          <Field label="Key colour">
            <ColorField value={clip.keying.color} onChange={(v) => set('Key colour', 'key', (c) => void (c.keying.color = [v[0]!, v[1]!, v[2]!]))} />
          </Field>
        )}
        {clip.keying.mode !== 'none' && (
          <>
            <Field label="Tolerance">
              <SliderField value={clip.keying.tolerance} min={0} max={1} step={0.01} onChange={(v) => set('Tolerance', 'key', (c) => void (c.keying.tolerance = v))} />
            </Field>
            <Field label="Feather">
              <SliderField value={clip.keying.feather} min={0} max={1} step={0.01} onChange={(v) => set('Feather', 'key', (c) => void (c.keying.feather = v))} />
            </Field>
            {clip.keying.mode === 'chroma' && (
              <Field label="Despill">
                <SwitchField checked={clip.keying.despill} onChange={(v) => set('Despill', 'key', (c) => void (c.keying.despill = v))} label="Despill" />
              </Field>
            )}
            <Field label="Keep alpha" hint="Combine with the source's own transparency.">
              <SwitchField checked={clip.keying.keepSourceAlpha} onChange={(v) => set('Keep source alpha', 'key', (c) => void (c.keying.keepSourceAlpha = v))} label="Keep source alpha" />
            </Field>
          </>
        )}
      </Section>

      <Section title="Colour & glow" defaultOpen={false}>
        <Field label="Brightness"><SliderField value={clip.adjust.brightness} min={-1} max={1} step={0.01} onChange={(v) => set('Brightness', 'adj', (c) => void (c.adjust.brightness = v))} /></Field>
        <Field label="Contrast"><SliderField value={clip.adjust.contrast} min={-1} max={1} step={0.01} onChange={(v) => set('Contrast', 'adj', (c) => void (c.adjust.contrast = v))} /></Field>
        <Field label="Saturation"><SliderField value={clip.adjust.saturation} min={-1} max={1} step={0.01} onChange={(v) => set('Saturation', 'adj', (c) => void (c.adjust.saturation = v))} /></Field>
        <Field label="Hue"><SliderField value={clip.adjust.hue} min={-180} max={180} step={1} unit="°" onChange={(v) => set('Hue', 'adj', (c) => void (c.adjust.hue = v))} /></Field>
        <Field label="Sharpen"><SliderField value={clip.adjust.sharpen} min={0} max={3} step={0.05} onChange={(v) => set('Sharpen', 'adj', (c) => void (c.adjust.sharpen = v))} /></Field>
        <Field label="Glow"><SliderField value={clip.adjust.glowAmount} min={0} max={2} step={0.05} onChange={(v) => set('Glow', 'adj', (c) => void (c.adjust.glowAmount = v))} /></Field>
        {clip.adjust.glowAmount > 0 && <Field label="Glow radius"><SliderField value={clip.adjust.glowRadius} min={1} max={64} step={1} unit="px" onChange={(v) => set('Glow radius', 'adj', (c) => void (c.adjust.glowRadius = v))} /></Field>}
        <Field label="Motion blur" hint="Blends neighbouring frames; samples 1 = off.">
          <NumberField value={clip.adjust.motionBlurSamples} min={1} max={8} step={1} onChange={(v) => set('Motion blur', 'adj', (c) => void (c.adjust.motionBlurSamples = v))} />
        </Field>
        {clip.adjust.motionBlurSamples > 1 && <Field label="Blur strength"><SliderField value={clip.adjust.motionBlurStrength} min={0} max={1} step={0.01} onChange={(v) => set('Blur strength', 'adj', (c) => void (c.adjust.motionBlurStrength = v))} /></Field>}
      </Section>

      <Section title="Auto-crop" defaultOpen={false}>
        <Field label="Crop to content" hint="Trims every frame by the same rectangle, so frames stay registered.">
          <SwitchField checked={clip.crop.auto} onChange={(v) => set('Auto-crop', 'crop', (c) => void (c.crop.auto = v))} label="Auto-crop" />
        </Field>
        {clip.crop.auto && <Field label="Margin"><NumberField value={clip.crop.margin} min={0} max={256} step={1} unit="px" onChange={(v) => set('Crop margin', 'crop', (c) => void (c.crop.margin = v))} /></Field>}
      </Section>

      {!isGen && (isStill || clip.procedural) && (
        <Section title="Animate a single image">
          <Field label="Effect">
            <SelectField
              value={clip.procedural?.type ?? 'off'}
              options={[{ value: 'off', label: 'Off (static)' }, ...PROCEDURAL_TYPES.map((t) => ({ value: t, label: t }))]}
              onChange={(v) => {
                set('Procedural animation', 'proc', (c) => {
                  c.procedural = v === 'off' ? null : { type: v, frames: c.procedural?.frames ?? 16, intensity: c.procedural?.intensity ?? 0.6, cycles: c.procedural?.cycles ?? 1, seed: c.procedural?.seed ?? 1 };
                });
                const sh = getProject();
                const first = Object.values(sh.sheets).find((x) => x.clipId === clipId);
                if (first && v !== 'off') fitGridToFrames(first.id, 16);
              }}
            />
          </Field>
          {clip.procedural && (
            <>
              <Field label="Frames"><NumberField value={clip.procedural.frames} min={2} max={256} step={1} onChange={(v) => set('Procedural frames', 'proc', (c) => void (c.procedural!.frames = v))} /></Field>
              <Field label="Intensity"><SliderField value={clip.procedural.intensity} min={0} max={2} step={0.05} onChange={(v) => set('Procedural intensity', 'proc', (c) => void (c.procedural!.intensity = v))} /></Field>
              <Field label="Cycles"><SliderField value={clip.procedural.cycles} min={0.25} max={16} step={0.25} onChange={(v) => set('Procedural cycles', 'proc', (c) => void (c.procedural!.cycles = v))} /></Field>
              <Field label="Seed"><NumberField value={clip.procedural.seed} min={0} max={0xffffffff} step={1} onChange={(v) => set('Procedural seed', 'proc', (c) => void (c.procedural!.seed = v))} /></Field>
              <Button size="xs" onClick={regrid}>Fit grid to {clip.procedural.frames} frames</Button>
              <Note>These frames are synthesised from one picture by an authored animation. They are not recovered motion.</Note>
            </>
          )}
        </Section>
      )}
    </div>
  );
}
