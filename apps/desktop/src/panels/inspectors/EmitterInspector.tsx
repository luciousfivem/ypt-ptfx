import { SHAPES, TRIGGER_EVENTS, startsLooped, type Emitter, type TriggerEvent } from '@vfxforge/core';
import { Dice5 } from 'lucide-react';
import { useState } from 'react';
import { Button, ColorField, Field, IconButton, NumberField, RangeField, Section, SelectField, Segmented, SliderField, SwitchField, Tabs, TextField, Vec3Field } from '../../components/ui';
import { CurveEditor } from '../../editors/CurveEditor';
import { GradientEditor } from '../../editors/GradientEditor';
import { cn } from '../../lib/cn';
import { useDerived } from '../../state/derived';
import { useProject } from '../../state/project';
import { FidelityTag, Note, patchEmitter } from './common';

const TABS = [
  { value: 'main', label: 'Main' },
  { value: 'emit', label: 'Emission' },
  { value: 'shape', label: 'Shape' },
  { value: 'look', label: 'Look' },
  { value: 'physics', label: 'Physics' },
  { value: 'flip', label: 'Flipbook' },
  { value: 'place', label: 'Place' },
];

const TRIGGER_LABEL: Record<TriggerEvent, string> = {
  equipped: 'Equipped',
  fired: 'Fired',
  reloaded: 'Reloaded',
  switched: 'Switched to',
  idle: 'Idle (held)',
  manual: 'Manual',
};

let lastTab = 'main';

export function EmitterInspector({ effectId, emitterId }: { effectId: string; emitterId: string }) {
  const [tab, setTabState] = useState(lastTab);
  const setTab = (t: string) => {
    lastTab = t;
    setTabState(t);
  };
  const em = useProject((s) => s.project.effects[effectId]?.emitters.find((e) => e.id === emitterId));
  const sheets = useProject((s) => s.project.sheets);
  const attachments = useProject((s) => s.project.weapon.attachments);
  const frameCount = useDerived((s) => (em?.sheetId ? s.sheets[em.sheetId]?.preview?.frameCount : undefined));
  if (!em) return <Note>This emitter no longer exists.</Note>;
  const set = (label: string, key: string, fn: (e: Emitter) => void) => patchEmitter(effectId, emitterId, label, key, fn);

  return (
    <div className="flex min-h-0 flex-col">
      <Tabs value={tab} onValueChange={setTab} tabs={TABS} className="min-h-0" />
      <div className="min-h-0 flex-1">
        {tab === 'main' && (
          <>
            <Section title="Emitter">
              <Field label="Name"><TextField value={em.name} maxLength={120} onChange={(v) => v.trim() && set('Rename emitter', 'name', (e) => void (e.name = v))} /></Field>
              <Field label="Enabled"><SwitchField checked={em.enabled} onChange={(v) => set('Toggle emitter', 'en', (e) => void (e.enabled = v))} label="Enabled" /></Field>
              <Field label="Spritesheet" hint={em.sheetId ? undefined : 'Without a sheet the preview shows a soft dot and the export is blocked.'}>
                <SelectField
                  value={em.sheetId ?? '__none'}
                  options={[{ value: '__none', label: '(none)' }, ...Object.values(sheets).map((s) => ({ value: s.id, label: s.name }))]}
                  onChange={(v) => set('Assign spritesheet', 'sheet', (e) => void (e.sheetId = v === '__none' ? null : v))}
                />
              </Field>
              <Field label="Blend">
                <SelectField
                  value={em.blend}
                  options={[
                    { value: 'additive', label: 'Additive', hint: 'fire, glow' },
                    { value: 'alpha', label: 'Alpha', hint: 'smoke' },
                    { value: 'premultiplied', label: 'Premultiplied' },
                  ]}
                  onChange={(v) => set('Blend mode', 'blend', (e) => void (e.blend = v))}
                />
              </Field>
              <Field label="Attach to">
                <SelectField
                  value={em.attachmentId ?? '__none'}
                  options={[{ value: '__none', label: 'Weapon origin' }, ...attachments.map((a) => ({ value: a.id, label: a.name, hint: a.kind }))]}
                  onChange={(v) => set('Attachment', 'att', (e) => void (e.attachmentId = v === '__none' ? null : v))}
                />
              </Field>
            </Section>
            <Section title="Starts when…">
              <div className="flex flex-wrap gap-1" role="group" aria-label="Trigger events">
                {TRIGGER_EVENTS.map((t) => {
                  const on = em.triggers.includes(t);
                  return (
                    <button
                      key={t}
                      type="button"
                      aria-pressed={on}
                      onClick={() => set('Triggers', 'trig', (e) => void (e.triggers = on ? e.triggers.filter((x) => x !== t) : [...e.triggers, t]))}
                      className={cn('h-6 rounded-md border px-2 text-[11px] transition-colors', on ? 'border-accent bg-accent/20 text-fg' : 'border-line text-muted hover:text-fg')}
                    >
                      {TRIGGER_LABEL[t]}
                    </button>
                  );
                })}
              </div>
              <Note>
                {startsLooped(em)
                  ? 'Continuous + loop: the script starts ONE looped instance on the trigger and stops it when the weapon is put away.'
                  : 'The script starts a fresh one-shot instance on every trigger (rate-limited).'}
              </Note>
              {em.triggers.length === 0 && <Note tone="warn">No trigger: this effect would never start on its own (only via the exported PlayEffect, if it is also tagged “Manual”).</Note>}
            </Section>
            <Section title="Randomness">
              <Field label="Seed">
                <div className="flex gap-1">
                  <NumberField value={em.seed} min={0} max={0xffffffff} step={1} onChange={(v) => set('Seed', 'seed', (e) => void (e.seed = v))} />
                  <IconButton label="New random seed" onClick={() => set('Reseed', 'seed', (e) => void (e.seed = Math.floor(Math.random() * 0xffffffff)))}>
                    <Dice5 className="size-4" aria-hidden />
                  </IconButton>
                </div>
              </Field>
              <Note>The preview is deterministic for a given seed.</Note>
            </Section>
          </>
        )}

        {tab === 'emit' && (
          <Section title="Emission">
            <Segmented
              label="Emission mode"
              value={em.emission.mode}
              options={[{ value: 'continuous', label: 'Continuous' }, { value: 'burst', label: 'Burst' }, { value: 'oneShot', label: 'One-shot' }]}
              onChange={(v) => set('Emission mode', 'mode', (e) => void (e.emission.mode = v))}
            />
            {em.emission.mode === 'continuous' && <Field label="Rate"><NumberField value={em.emission.rate} min={0} max={5000} step={1} unit="/s" onChange={(v) => set('Rate', 'rate', (e) => void (e.emission.rate = v))} /></Field>}
            {em.emission.mode !== 'continuous' && <Field label="Count"><NumberField value={em.emission.burstCount} min={0} max={5000} step={1} onChange={(v) => set('Burst count', 'bc', (e) => void (e.emission.burstCount = v))} /></Field>}
            {em.emission.mode === 'burst' && <Field label="Interval"><NumberField value={em.emission.interval} min={0.01} max={60} step={0.05} unit="s" onChange={(v) => set('Burst interval', 'iv', (e) => void (e.emission.interval = v))} /></Field>}
            <Field label="Lifetime"><RangeField value={em.emission.lifetime} min={0.01} max={60} step={0.05} unit="s" onChange={(v) => set('Lifetime', 'life', (e) => void (e.emission.lifetime = v))} /></Field>
            <Field label="Start delay"><NumberField value={em.emission.startDelay} min={0} max={60} step={0.05} unit="s" onChange={(v) => set('Start delay', 'sd', (e) => void (e.emission.startDelay = v))} /></Field>
            <Field label="Duration"><NumberField value={em.emission.duration} min={0.05} max={600} step={0.1} unit="s" onChange={(v) => set('Duration', 'dur', (e) => void (e.emission.duration = v))} /></Field>
            <Field label="Loop"><SwitchField checked={em.emission.loop} onChange={(v) => set('Loop', 'loop', (e) => void (e.emission.loop = v))} label="Loop" /></Field>
            <Field label="Max particles">
              <div className="space-y-1">
                <NumberField value={em.emission.maxParticles} min={1} max={20000} step={10} onChange={(v) => set('Max particles', 'max', (e) => void (e.emission.maxParticles = v))} />
                <FidelityTag kind="preview-only">The engine has its own pool limits; the preview cap is not exported.</FidelityTag>
              </div>
            </Field>
            {em.emission.mode === 'burst' && em.emission.loop && <Note tone="warn">A repeating burst cannot be stored in one YPT effect: in game it fires once per trigger.</Note>}
          </Section>
        )}

        {tab === 'shape' && (
          <Section title="Emission shape">
            <Field label="Shape"><SelectField value={em.shape.type} options={SHAPES.map((s) => ({ value: s, label: s }))} onChange={(v) => set('Shape', 'shape', (e) => void (e.shape.type = v))} /></Field>
            {em.shape.type === 'cone' && <Field label="Half-angle"><SliderField value={em.shape.angle} min={0} max={89} step={1} unit="°" onChange={(v) => set('Cone angle', 'ang', (e) => void (e.shape.angle = v))} /></Field>}
            {em.shape.type === 'cone' && <FidelityTag kind="approximated">GTA has no cone domain: the cone is emitted from a disc and its half-angle is approximated by the target domain spread.</FidelityTag>}
            {(em.shape.type === 'sphere' || em.shape.type === 'circle' || em.shape.type === 'cone') && (
              <Field label="Radius"><NumberField value={em.shape.radius} min={0} step={0.005} precision={3} unit="m" onChange={(v) => set('Radius', 'rad', (e) => void (e.shape.radius = v))} /></Field>
            )}
            {em.shape.type === 'box' && <Field label="Size"><Vec3Field value={em.shape.size} step={0.005} precision={3} onChange={(v) => set('Box size', 'size', (e) => void (e.shape.size = v))} /></Field>}
            <Field label="From shell"><SwitchField checked={em.shape.fromShell} onChange={(v) => set('From shell', 'shell', (e) => void (e.shape.fromShell = v))} label="Emit from the surface only" /></Field>
          </Section>
        )}

        {tab === 'look' && (
          <>
            <Section title="Size">
              <Field label="Size"><RangeField value={em.particle.size} min={0.001} max={10} step={0.01} precision={3} unit="m" onChange={(v) => set('Size', 'size', (e) => void (e.particle.size = v))} /></Field>
              <Field label="Aspect"><NumberField value={em.particle.aspect} min={0.05} max={20} step={0.05} onChange={(v) => set('Aspect', 'asp', (e) => void (e.particle.aspect = v))} /></Field>
              <Field label="Over life"><CurveEditor value={em.particle.sizeOverLife} yMin={0} yMax={3} yLabel="size ×" onChange={(c) => set('Size over life', 'sol', (e) => void (e.particle.sizeOverLife = c))} /></Field>
            </Section>
            <Section title="Colour & alpha">
              <Field label="Tint"><ColorField alpha value={em.particle.color} onChange={(v) => set('Tint', 'tint', (e) => void (e.particle.color = v as Emitter['particle']['color']))} /></Field>
              <Field label="Colour over life"><GradientEditor value={em.particle.colorOverLife} onChange={(g) => set('Colour over life', 'col', (e) => void (e.particle.colorOverLife = g))} /></Field>
              <Field label="Alpha over life"><CurveEditor value={em.particle.alphaOverLife} yMin={0} yMax={1} yLabel="alpha" onChange={(c) => set('Alpha over life', 'aol', (e) => void (e.particle.alphaOverLife = c))} /></Field>
            </Section>
            <Section title="Rotation & orientation">
              <Field label="Rotation"><RangeField value={em.particle.rotation} min={-360} max={360} step={1} unit="°" onChange={(v) => set('Rotation', 'rot', (e) => void (e.particle.rotation = v))} /></Field>
              <Field label="Spin"><RangeField value={em.particle.angularVelocity} min={-720} max={720} step={1} unit="°/s" onChange={(v) => set('Angular velocity', 'spin', (e) => void (e.particle.angularVelocity = v))} /></Field>
              <Field label="Facing"><SelectField value={em.particle.orientation} options={[{ value: 'billboard', label: 'Billboard (faces camera)' }, { value: 'velocity', label: 'Velocity-aligned' }, { value: 'aligned', label: 'Aligned to emitter' }]} onChange={(v) => set('Orientation', 'ori', (e) => void (e.particle.orientation = v))} /></Field>
              {em.particle.orientation === 'velocity' && <FidelityTag kind="approximated">Velocity-aligned sprites use Sprite.AlignmentMode; the numeric enum value is unverified.</FidelityTag>}
            </Section>
            <Section title="Glow & trails">
              <Field label="Glow">
                <SliderField value={em.particle.glow} min={0} max={8} step={0.05} onChange={(v) => set('Glow', 'glow', (e) => void (e.particle.glow = v))} />
              </Field>
              <FidelityTag kind="approximated">Glow above 1 is mapped to the emissive intensity of ptxu_Colour (unverified); the in-game look differs from the WebGL bloom. At 1 or below it is preview-only.</FidelityTag>
              <Field label="Trail"><SwitchField checked={em.particle.trail.enabled} onChange={(v) => set('Trail', 'trail', (e) => void (e.particle.trail.enabled = v))} label="Trail" /></Field>
              {em.particle.trail.enabled && (
                <>
                  <Field label="Length"><NumberField value={em.particle.trail.length} min={2} max={32} step={1} onChange={(v) => set('Trail length', 'trail', (e) => void (e.particle.trail.length = v))} /></Field>
                  <FidelityTag kind="unsupported">Trails need a ptxd_Trail behaviour with its own texture layout; not generated. The preview stretches sprites along their velocity.</FidelityTag>
                </>
              )}
            </Section>
          </>
        )}

        {tab === 'physics' && (
          <>
            <Section title="Velocity">
              <Field label="Speed"><RangeField value={em.physics.speed} min={0} max={50} step={0.05} unit="m/s" onChange={(v) => set('Speed', 'spd', (e) => void (e.physics.speed = v))} /></Field>
              <Field label="Direction"><Vec3Field value={em.physics.direction} step={0.05} precision={2} onChange={(v) => set('Direction', 'dir', (e) => void (e.physics.direction = v))} /></Field>
              <Note>Emitter space: the barrel points along −Z, up is +Y.</Note>
              <Field label="Spread"><SliderField value={em.physics.spread} min={0} max={180} step={1} unit="°" onChange={(v) => set('Spread', 'spr', (e) => void (e.physics.spread = v))} /></Field>
              <Field label="Randomness"><SliderField value={em.physics.randomness} min={0} max={1} step={0.01} onChange={(v) => set('Randomness', 'rnd', (e) => void (e.physics.randomness = v))} /></Field>
              <Field label="Over life">
                <CurveEditor value={em.physics.speedOverLife} yMin={0} yMax={3} yLabel="speed ×" onChange={(c) => set('Speed over life', 'sol', (e) => void (e.physics.speedOverLife = c))} />
              </Field>
              {em.physics.speedOverLife.keys.length > 1 && <FidelityTag kind="unsupported">Speed-over-life curves are not exported.</FidelityTag>}
            </Section>
            <Section title="Forces">
              <Field label="Gravity"><SliderField value={em.physics.gravity} min={-5} max={5} step={0.05} onChange={(v) => set('Gravity', 'grav', (e) => void (e.physics.gravity = v))} /></Field>
              <Field label="Accel."><Vec3Field value={em.physics.acceleration} step={0.05} precision={2} onChange={(v) => set('Acceleration', 'acc', (e) => void (e.physics.acceleration = v))} /></Field>
              <Field label="Drag"><SliderField value={em.physics.drag} min={0} max={20} step={0.05} onChange={(v) => set('Drag', 'drag', (e) => void (e.physics.drag = v))} /></Field>
              <FidelityTag kind="approximated">Mapped to ptxu_Dampening; the engine&apos;s damping curve may differ from the preview&apos;s exponential drag.</FidelityTag>
              <Field label="Turbulence"><SliderField value={em.physics.turbulence.strength} min={0} max={20} step={0.1} onChange={(v) => set('Turbulence', 'turb', (e) => void (e.physics.turbulence.strength = v))} /></Field>
              {em.physics.turbulence.strength > 0 && <Field label="Frequency"><SliderField value={em.physics.turbulence.frequency} min={0} max={20} step={0.1} onChange={(v) => set('Turbulence frequency', 'turb', (e) => void (e.physics.turbulence.frequency = v))} /></Field>}
              {em.physics.turbulence.strength > 0 && <FidelityTag kind="approximated">Approximated by random velocity noise (ptxu_Noise); frequency is not representable.</FidelityTag>}
              <Field label="Drift"><Vec3Field value={em.physics.drift} step={0.05} precision={2} onChange={(v) => set('Drift', 'drift', (e) => void (e.physics.drift = v))} /></Field>
              {em.physics.drift.some((d) => d !== 0) && <FidelityTag kind="unsupported">A constant drift velocity has no equivalent in the generated rule; preview only.</FidelityTag>}
            </Section>
            <Section title="Attractor" defaultOpen={false}>
              <Field label="Enabled"><SwitchField checked={em.physics.attractor.enabled} onChange={(v) => set('Attractor', 'att', (e) => void (e.physics.attractor.enabled = v))} label="Attractor" /></Field>
              {em.physics.attractor.enabled && (
                <>
                  <Field label="Position"><Vec3Field value={em.physics.attractor.position} step={0.05} precision={2} onChange={(v) => set('Attractor position', 'att', (e) => void (e.physics.attractor.position = v))} /></Field>
                  <Field label="Strength"><SliderField value={em.physics.attractor.strength} min={-100} max={100} step={0.5} onChange={(v) => set('Attractor strength', 'att', (e) => void (e.physics.attractor.strength = v))} /></Field>
                  <FidelityTag kind="unsupported">Attractor behaviour is not exported; preview only.</FidelityTag>
                </>
              )}
            </Section>
          </>
        )}

        {tab === 'flip' && (
          <Section title="Flipbook animation">
            <Note>{em.sheetId ? `The assigned spritesheet has ${frameCount ?? '…'} frame${frameCount === 1 ? '' : 's'}.` : 'Assign a spritesheet on the Main tab.'}</Note>
            <Field label="Playback">
              <SelectField
                value={em.animation.mode}
                options={[{ value: 'overLife', label: 'Spread over life' }, { value: 'fps', label: 'Fixed frame rate' }, { value: 'fixed', label: 'Single frame' }]}
                onChange={(v) => set('Animation mode', 'amode', (e) => void (e.animation.mode = v))}
              />
            </Field>
            {em.animation.mode === 'fps' && <Field label="Frame rate"><NumberField value={em.animation.fps} min={0.1} max={120} step={0.5} unit="fps" onChange={(v) => set('Animation fps', 'afps', (e) => void (e.animation.fps = v))} /></Field>}
            <Field label="First frame"><NumberField value={em.animation.startFrame} min={0} max={Math.max(0, (frameCount ?? 1) - 1)} step={1} onChange={(v) => set('First frame', 'sf', (e) => void (e.animation.startFrame = v))} /></Field>
            <Field label="Last frame" hint="Defaults to the last frame of the sheet.">
              <NumberField
                value={em.animation.endFrame ?? Math.max(0, (frameCount ?? 1) - 1)}
                min={0}
                max={Math.max(0, (frameCount ?? 1) - 1)}
                step={1}
                onChange={(v) => set('Last frame', 'ef', (e) => void (e.animation.endFrame = frameCount && v >= frameCount - 1 ? null : v))}
              />
            </Field>
            <Field label="Loop frames"><SwitchField checked={em.animation.loop} onChange={(v) => set('Loop frames', 'al', (e) => void (e.animation.loop = v))} label="Loop frames" /></Field>
            <Field label="Random start"><SwitchField checked={em.animation.randomStart} onChange={(v) => set('Random start frame', 'rs', (e) => void (e.animation.randomStart = v))} label="Random start frame" /></Field>
            <Field label="Blend frames"><SwitchField checked={em.animation.blendFrames} onChange={(v) => set('Blend frames', 'bf', (e) => void (e.animation.blendFrames = v))} label="Blend between frames" /></Field>
            <Note>Frame blending is a preview feature; the exported flipbook steps between frames.</Note>
          </Section>
        )}

        {tab === 'place' && (
          <Section title="Emitter transform">
            <Field label="Position"><Vec3Field value={em.transform.position} step={0.005} precision={3} onChange={(v) => set('Emitter position', 'pos', (e) => void (e.transform.position = v))} /></Field>
            <Field label="Rotation"><Vec3Field value={em.transform.rotation} step={1} precision={1} onChange={(v) => set('Emitter rotation', 'rot', (e) => void (e.transform.rotation = v))} /></Field>
            <Field label="Scale"><Vec3Field value={em.transform.scale} step={0.05} precision={2} onChange={(v) => set('Emitter scale', 'scl', (e) => void (e.transform.scale = v))} /></Field>
            <Field label="Space">
              <Segmented label="Simulation space" value={em.transform.space} options={[{ value: 'local', label: 'Local' }, { value: 'world', label: 'World' }]} onChange={(v) => set('Space', 'space', (e) => void (e.transform.space = v))} />
            </Field>
            <Note>Rotation is applied about X, then Y, then Z. A rotation about a single axis converts to GTA axes exactly; multi-axis rotations are marked approximated in the export report.</Note>
            <Note>Non-uniform scale is averaged to a uniform scale on export.</Note>
            <Button size="xs" variant="ghost" onClick={() => set('Reset transform', 'rst', (e) => void (e.transform = { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], space: e.transform.space }))}>Reset transform</Button>
          </Section>
        )}
      </div>
    </div>
  );
}
