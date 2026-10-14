/**
 * GPU renderer for the particle preview: one instanced billboard mesh per running emitter
 * instance, flipbook sampling with cross-frame blending, additive / alpha / premultiplied
 * blending.
 *
 * This shows what the particle SIMULATION does with the artist's spritesheet. It is a WebGL
 * approximation and is NOT how GTA V renders particles.
 */
import {
  CustomBlending,
  DynamicDrawUsage,
  DataTexture,
  DoubleSide,
  Group,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  LinearFilter,
  Mesh,
  OneFactor,
  OneMinusSrcAlphaFactor,
  RGBAFormat,
  ShaderMaterial,
  SRGBColorSpace,
  UnsignedByteType,
  Float32BufferAttribute,
  Matrix4,
  type Camera,
} from 'three';
import type { Emitter } from '@vfxforge/core';
import { createInstanceBuffers, type InstanceBuffers, type RuntimeInstance } from '@vfxforge/particles';
import type { RgbaImage } from '@vfxforge/media';

const VERT = /* glsl */ `
attribute vec3 aPos;
attribute vec4 aSizeRot;
attribute vec4 aColor;
attribute vec4 aFrame;
attribute vec4 aVel;
uniform vec2 uGrid;
uniform float uColMajor;
uniform float uOrient;
uniform float uTrail;
varying vec2 vUvA;
varying vec2 vUvB;
varying float vBlend;
varying vec4 vColor;
varying float vGlow;

vec2 cellOrigin(float f) {
  float cols = uGrid.x;
  float rows = uGrid.y;
  float col = uColMajor > 0.5 ? floor(f / rows) : mod(f, cols);
  float row = uColMajor > 0.5 ? mod(f, rows) : floor(f / cols);
  return vec2(col / cols, row / rows);
}

void main() {
  vec2 corner = position.xy;               // -0.5 .. 0.5
  float size = aSizeRot.x;
  float rot = aSizeRot.y;
  float aspect = aSizeRot.z;
  float cs = cos(rot);
  float sn = sin(rot);

  vec4 mv;
  if (uOrient > 0.5 && uOrient < 1.5) {
    // velocity-aligned: the quad's long axis follows the particle's screen-space motion
    mv = modelViewMatrix * vec4(aPos, 1.0);
    vec3 vd = (modelViewMatrix * vec4(aVel.xyz, 0.0)).xyz;
    vec2 d2 = vd.xy;
    float l = length(d2);
    d2 = l > 1e-4 ? d2 / l : vec2(0.0, 1.0);
    vec2 perp = vec2(-d2.y, d2.x);
    float stretch = 1.0 + min(aVel.w * (0.3 + uTrail), 4.0);
    mv.xy += perp * (corner.x * aspect * size) + d2 * (corner.y * size * stretch);
  } else if (uOrient > 1.5) {
    // aligned: a flat quad in the emitter's local XY plane
    vec2 r = vec2(corner.x * aspect * cs - corner.y * sn, corner.x * aspect * sn + corner.y * cs) * size;
    mv = modelViewMatrix * vec4(aPos + vec3(r, 0.0), 1.0);
  } else {
    mv = modelViewMatrix * vec4(aPos, 1.0);
    vec2 c = vec2(corner.x * aspect, corner.y) * size;
    mv.xy += vec2(c.x * cs - c.y * sn, c.x * sn + c.y * cs);
  }
  gl_Position = projectionMatrix * mv;

  vec2 uvc = vec2(corner.x + 0.5, 0.5 - corner.y) / uGrid;   // image rows run top -> bottom
  vUvA = cellOrigin(aFrame.x) + uvc;
  vUvB = cellOrigin(aFrame.y) + uvc;
  vBlend = aFrame.z;
  vGlow = aFrame.w;
  vColor = aColor;
}
`;

const FRAG = /* glsl */ `
uniform sampler2D uMap;
uniform float uMode;     // 0 additive, 1 alpha / premultiplied
uniform float uHasMap;
varying vec2 vUvA;
varying vec2 vUvB;
varying float vBlend;
varying vec4 vColor;
varying float vGlow;

vec4 premult(vec4 c) { return vec4(c.rgb * c.a, c.a); }

void main() {
  vec4 t = vec4(1.0);
  if (uHasMap > 0.5) {
    t = mix(premult(texture2D(uMap, vUvA)), premult(texture2D(uMap, vUvB)), vBlend);
  } else {
    // no spritesheet assigned: a soft round dot so the emitter is still visible
    float a = smoothstep(1.0, 0.0, length(vUvA - 0.5) * 2.0);
    t = vec4(vec3(a), a);
  }
  vec3 tint = pow(max(vColor.rgb, vec3(0.0)), vec3(2.2));
  if (uMode < 0.5) {
    gl_FragColor = vec4(t.rgb * tint * vGlow * vColor.a, t.a * vColor.a);
  } else {
    gl_FragColor = vec4(t.rgb * tint * vColor.a, t.a * vColor.a);
  }
  if (gl_FragColor.a < 0.002 && uMode > 0.5) discard;
}
`;

export interface SheetTexture {
  texture: DataTexture;
  cols: number;
  rows: number;
  colMajor: boolean;
  version: number;
}

export function textureFromImage(img: RgbaImage): DataTexture {
  const data = new Uint8Array(img.data.buffer.slice(img.data.byteOffset, img.data.byteOffset + img.data.byteLength));
  const t = new DataTexture(data, img.width, img.height, RGBAFormat, UnsignedByteType);
  t.colorSpace = SRGBColorSpace;
  t.minFilter = LinearFilter;
  t.magFilter = LinearFilter;
  t.generateMipmaps = false;
  t.flipY = false;
  t.needsUpdate = true;
  return t;
}

interface Slot {
  mesh: Mesh<InstancedBufferGeometry, ShaderMaterial>;
  buffers: InstanceBuffers;
  scratch: InstanceBuffers;
  attrs: InstancedBufferAttribute[];
  capacity: number;
  sortIdx: Uint32Array;
  sortKey: Float32Array;
}

const ORIENT = { billboard: 0, velocity: 1, aligned: 2 } as const;

/** Four corners of a unit quad, shared by every instance. */
function quad(): InstancedBufferGeometry {
  const g = new InstancedBufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  return g;
}

export class ParticleRenderer {
  readonly group = new Group();
  private slots = new Map<number, Slot>();
  private readonly tmp = new Matrix4();
  drawCalls = 0;
  particles = 0;

  constructor(private readonly sheetOf: (emitter: Emitter) => SheetTexture | null) {
    this.group.name = 'particles';
    this.group.frustumCulled = false;
  }

  private create(inst: RuntimeInstance): Slot {
    const em = inst.emitter;
    const capacity = Math.max(1, em.emission.maxParticles);
    const geo = quad();
    const buffers = createInstanceBuffers(capacity);
    const scratch = createInstanceBuffers(capacity);
    const mk = (arr: Float32Array, n: number, name: string) => {
      const a = new InstancedBufferAttribute(arr, n);
      a.setUsage(DynamicDrawUsage);
      geo.setAttribute(name, a);
      return a;
    };
    const attrs = [
      mk(scratch.position, 3, 'aPos'),
      mk(scratch.sizeRot, 4, 'aSizeRot'),
      mk(scratch.color, 4, 'aColor'),
      mk(scratch.frame, 4, 'aFrame'),
      mk(scratch.velocity, 4, 'aVel'),
    ];
    geo.instanceCount = 0;
    const mat = new ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uMap: { value: null },
        uHasMap: { value: 0 },
        uGrid: { value: [1, 1] },
        uColMajor: { value: 0 },
        uOrient: { value: ORIENT[em.particle.orientation] },
        uMode: { value: em.blend === 'additive' ? 0 : 1 },
        uTrail: { value: 0 },
      },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: DoubleSide,
      blending: CustomBlending,
      blendSrc: OneFactor,
      blendDst: em.blend === 'additive' ? OneFactor : OneMinusSrcAlphaFactor,
      blendSrcAlpha: OneFactor,
      blendDstAlpha: em.blend === 'additive' ? OneFactor : OneMinusSrcAlphaFactor,
    });
    const mesh = new Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.renderOrder = 10;
    this.group.add(mesh);
    return { mesh, buffers, scratch, attrs, capacity, sortIdx: new Uint32Array(capacity), sortKey: new Float32Array(capacity) };
  }

  /**
   * Syncs meshes with the running instances and uploads this frame's particles.
   * `frameMatrix(attachmentId)` gives the attachment's world matrix (identity for world-space).
   */
  update(instances: RuntimeInstance[], camera: Camera, frameMatrix: (attachmentId: string | null) => Matrix4): void {
    const live = new Set<number>();
    this.drawCalls = 0;
    this.particles = 0;
    for (const inst of instances) {
      live.add(inst.id);
      let slot = this.slots.get(inst.id);
      if (!slot || slot.capacity !== Math.max(1, inst.emitter.emission.maxParticles)) {
        if (slot) this.release(inst.id);
        slot = this.create(inst);
        this.slots.set(inst.id, slot);
      }
      const em = inst.emitter;
      const mat = slot.mesh.material;
      const u = mat.uniforms;
      const sheet = this.sheetOf(em);
      if (sheet) {
        u.uMap!.value = sheet.texture;
        u.uHasMap!.value = 1;
        u.uGrid!.value = [sheet.cols, sheet.rows];
        u.uColMajor!.value = sheet.colMajor ? 1 : 0;
      } else {
        u.uMap!.value = null;
        u.uHasMap!.value = 0;
        u.uGrid!.value = [1, 1];
      }
      u.uOrient!.value = ORIENT[em.particle.orientation];
      u.uTrail!.value = em.particle.trail.enabled ? Math.min(2, em.particle.trail.length / 8) : 0;
      u.uMode!.value = em.blend === 'additive' ? 0 : 1;
      const add = em.blend === 'additive';
      mat.blendDst = add ? OneFactor : OneMinusSrcAlphaFactor;
      mat.blendDstAlpha = add ? OneFactor : OneMinusSrcAlphaFactor;

      const n = inst.sim.fill(slot.buffers);
      this.upload(slot, n, em.blend !== 'additive', camera, inst, frameMatrix);
      slot.mesh.visible = n > 0;
      if (n > 0) {
        this.drawCalls++;
        this.particles += n;
      }
    }
    for (const id of [...this.slots.keys()]) if (!live.has(id)) this.release(id);
  }

  private upload(slot: Slot, n: number, sort: boolean, camera: Camera, inst: RuntimeInstance, frameMatrix: (id: string | null) => Matrix4): void {
    const world = inst.emitter.transform.space === 'world' ? this.tmp.identity() : this.tmp.copy(frameMatrix(inst.emitter.attachmentId));
    slot.mesh.matrix.copy(world);
    slot.mesh.matrixWorld.copy(world);
    slot.mesh.matrixWorldNeedsUpdate = true;
    const src = slot.buffers;
    const dst = slot.scratch;
    if (sort && n > 1) {
      // back-to-front for alpha blending, by view depth of each particle
      const m = camera.matrixWorldInverse.clone().multiply(world).elements;
      const key = slot.sortKey;
      const idx = slot.sortIdx;
      for (let i = 0; i < n; i++) {
        const x = src.position[i * 3]!;
        const y = src.position[i * 3 + 1]!;
        const z = src.position[i * 3 + 2]!;
        key[i] = m[2]! * x + m[6]! * y + m[10]! * z + m[14]!; // view-space z (more negative = further)
        idx[i] = i;
      }
      const view = idx.subarray(0, n);
      view.sort((a, b) => key[a]! - key[b]!);
      for (let o = 0; o < n; o++) {
        const i = view[o]!;
        dst.position.set(src.position.subarray(i * 3, i * 3 + 3), o * 3);
        dst.sizeRot.set(src.sizeRot.subarray(i * 4, i * 4 + 4), o * 4);
        dst.color.set(src.color.subarray(i * 4, i * 4 + 4), o * 4);
        dst.frame.set(src.frame.subarray(i * 4, i * 4 + 4), o * 4);
        dst.velocity.set(src.velocity.subarray(i * 4, i * 4 + 4), o * 4);
      }
    } else {
      dst.position.set(src.position.subarray(0, n * 3));
      dst.sizeRot.set(src.sizeRot.subarray(0, n * 4));
      dst.color.set(src.color.subarray(0, n * 4));
      dst.frame.set(src.frame.subarray(0, n * 4));
      dst.velocity.set(src.velocity.subarray(0, n * 4));
    }
    for (const a of slot.attrs) a.needsUpdate = true;
    slot.mesh.geometry.instanceCount = n;
  }

  private release(id: number): void {
    const s = this.slots.get(id);
    if (!s) return;
    this.group.remove(s.mesh);
    s.mesh.geometry.dispose();
    s.mesh.material.dispose();
    this.slots.delete(id);
  }

  clear(): void {
    for (const id of [...this.slots.keys()]) this.release(id);
  }

  dispose(): void {
    this.clear();
  }
}
