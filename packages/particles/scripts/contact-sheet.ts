/** Dev tool: renders a contact sheet of every preset (3 frames each) over a dark background. */
import { writeFileSync } from 'node:fs';
import { createImage, encodePng } from '@vfxforge/media';
import { PRESETS, generateSpriteFrames, instantiatePreset } from '../src';

const out = process.argv[2] ?? 'contact-sheet.png';
const cell = 96;
const cols = 6 * 3; // 6 presets per row, 3 frames each
const rows = Math.ceil(PRESETS.length / 6);
const img = createImage(cols * cell, rows * cell);
for (let i = 0; i < img.data.length; i += 4) { img.data[i] = 14; img.data[i + 1] = 15; img.data[i + 2] = 20; img.data[i + 3] = 255; }
PRESETS.forEach((p, idx) => {
  const inst = instantiatePreset(p, { seed: 4242 + idx, frameSize: 96 });
  const frames = generateSpriteFrames(inst.clip.generator!);
  const additive = inst.effect.emitters[0]!.blend === 'additive';
  [1, 6, 11].forEach((f, k) => {
    const fr = frames[f]!;
    const ox = ((idx % 6) * 3 + k) * cell;
    const oy = Math.floor(idx / 6) * cell;
    for (let y = 0; y < cell; y++) for (let x = 0; x < cell; x++) {
      const s = (y * cell + x) * 4, d = ((oy + y) * img.width + ox + x) * 4;
      const a = fr.data[s + 3]! / 255;
      for (let c = 0; c < 3; c++) img.data[d + c] = additive ? Math.min(255, img.data[d + c]! + fr.data[s + c]! * a) : img.data[d + c]! * (1 - a) + fr.data[s + c]! * a;
    }
  });
});
writeFileSync(out, encodePng(img));
console.log('wrote', out, img.width + 'x' + img.height);
