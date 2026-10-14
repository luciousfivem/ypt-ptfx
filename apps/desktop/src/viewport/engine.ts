/**
 * The 3D preview. Owns the three.js scene, the weapon (procedural or imported), the attachment
 * points with their transform gizmo, the particle renderer and the weapon-event simulator.
 *
 * What it is: an interactive preview of the project's particle simulation on a stand-in weapon.
 * What it is not: GTA V's renderer. Blending, lighting, soft particles, sorting and sizes in the
 * game will differ; the UI says so wherever the preview is shown.
 */
import {
  ACESFilmicToneMapping,
  AmbientLight,
  Box3,
  Color,
  DirectionalLight,
  Euler,
  GridHelper,
  Group,
  HemisphereLight,
  HalfFloatType,
  Material,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  NoToneMapping,
  Object3D,
  OctahedronGeometry,
  PerspectiveCamera,
  PMREMGenerator,
  Quaternion,
  Raycaster,
  Scene,
  Vector2,
  Vector3,
  WebGLRenderer,
  WebGLRenderTarget,
  AxesHelper,
  type Texture,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { DEG2RAD, RAD2DEG, type Asset, type Emitter, type Project, type Sheet, type Weapon } from '@vfxforge/core';
import { IDENTITY_FRAME, RuntimeSimulator, type EmitterFrame } from '@vfxforge/particles';
import type { SheetPreview } from '../workers/engine-core';
import { loadModel, modelFormatOf, type LoadedModel, type ModelOrigin } from './models';
import { ParticleRenderer, textureFromImage, type SheetTexture } from './particles-gl';
import { buildProceduralWeapon, weaponLength, type BuiltWeapon } from './weapons';

type Vec3 = [number, number, number];

export interface ViewportStats {
  fps: number;
  frameMs: number;
  particles: number;
  drawCalls: number;
  triangles: number;
  pixelRatio: number;
  bloom: boolean;
  instances: number;
}

export interface ModelInfo {
  name: string;
  size: Vec3;
  triangles: number;
  warnings: string[];
  /** "ydr" for a GLB that was converted from a GTA V drawable; null otherwise. */
  origin: ModelOrigin | null;
}

export interface ViewportCallbacks {
  onStats(stats: ViewportStats): void;
  onAttachmentEdit(id: string, position: Vec3, rotation: Vec3): void;
  onPick(id: string | null): void;
  onModel(info: ModelInfo | null, error: string | null): void;
}

export interface ViewportSettings {
  quality: 'auto' | 'high' | 'medium' | 'low';
  bloom: boolean;
  grid: boolean;
}

interface Level {
  dpr: number;
  bloom: boolean;
}

const ENV_PRESETS = {
  darkStudio: { bg: 0x07070d, hemi: [0x6d5cff, 0x07070d, 0.35], key: [0xc6b8ff, 1.2, [1.5, 2.5, 2]], rim: [0x35c4ff, 1.4, [-2, 1.2, -2.5]], envIntensity: 0.25, tone: false, grid: [0x2a2a45, 0x15152a] },
  neutralStudio: { bg: 0x2a2c33, hemi: [0xffffff, 0x444450, 0.7], key: [0xffffff, 1.6, [2, 3, 2]], rim: [0xbfd4ff, 0.9, [-2, 1.5, -2]], envIntensity: 0.7, tone: true, grid: [0x55586a, 0x3a3c48] },
  daylight: { bg: 0x9cc4e8, hemi: [0xdbeeff, 0x6a7a5a, 1.1], key: [0xfff3da, 3.0, [3, 5, 2]], rim: [0xffffff, 0.4, [-2, 1, -2]], envIntensity: 1.0, tone: true, grid: [0x6f8aa5, 0x8fb0cf] },
  night: { bg: 0x03060f, hemi: [0x2a3b7a, 0x02030a, 0.4], key: [0x8fa8ff, 0.7, [-2, 3, 1]], rim: [0x4a5cff, 0.6, [2, 1, -2]], envIntensity: 0.12, tone: false, grid: [0x15204a, 0x0a1030] },
  firstPerson: { bg: 0x9cc4e8, hemi: [0xdbeeff, 0x6a7a5a, 1.1], key: [0xfff3da, 3.0, [3, 5, 2]], rim: [0xffffff, 0.4, [-2, 1, -2]], envIntensity: 1.0, tone: true, grid: [0x6f8aa5, 0x8fb0cf] },
  thirdPerson: { bg: 0x9cc4e8, hemi: [0xdbeeff, 0x6a7a5a, 1.1], key: [0xfff3da, 3.0, [3, 5, 2]], rim: [0xffffff, 0.4, [-2, 1, -2]], envIntensity: 1.0, tone: true, grid: [0x6f8aa5, 0x8fb0cf] },
} as const;

export interface ViewportDeps {
  /** Reads the stored bytes of an imported 3D model. */
  assetBytes(asset: Asset): Promise<Uint8Array>;
}

export class ViewportEngine {
  static supported(): boolean {
    try {
      const c = document.createElement('canvas');
      return !!c.getContext('webgl2');
    } catch {
      return false;
    }
  }

  private renderer: WebGLRenderer;
  private scene = new Scene();
  private camera = new PerspectiveCamera(42, 1, 0.01, 100);
  private orbit: OrbitControls;
  private gizmo: TransformControls;
  private composer: EffectComposer;
  private bloomPass: UnrealBloomPass;
  private pmrem: PMREMGenerator;
  private envTexture: Texture | null = null;
  private lights = new Group();
  private grid: GridHelper | null = null;

  private rig = new Group(); // weapon + attachments, receives recoil
  private modelHolder = new Group();
  private attachNodes = new Map<string, { node: Group; marker: Mesh }>();
  private procedural: BuiltWeapon | null = null;
  private imported: LoadedModel | null = null;
  private modelToken = 0;

  private particles: ParticleRenderer;
  private runtime: RuntimeSimulator;
  private sheets = new Map<string, SheetTexture>();
  private frameCounts = new Map<string, number>();

  private project: Project | null = null;
  private settings: ViewportSettings = { quality: 'auto', bloom: true, grid: true };
  private selected: string | null = null;
  private level = 0;
  private levels: Level[] = [];

  private playing = true;
  private speed = 1;
  private equipped = true;
  private autoFire = false;
  private autoFireAcc = 0;
  private clock = 0;
  private recoilX = 0;
  private recoilV = 0;

  private raf = 0;
  private last = 0;
  private dirty = true;
  private disposed = false;
  private visible = true;
  private width = 1;
  private height = 1;
  private emaMs = 8;
  private evalAt = 0;
  private fastSince = 0;
  private statAt = 0;
  private prevNow = 0;
  private raycaster = new Raycaster();
  private downAt: { x: number; y: number } | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly cb: ViewportCallbacks,
    private readonly deps: ViewportDeps,
  ) {
    this.renderer = new WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance', stencil: false });
    this.renderer.toneMapping = NoToneMapping;
    this.pmrem = new PMREMGenerator(this.renderer);

    this.camera.position.set(0.55, 0.28, 0.6);
    this.scene.add(this.lights);
    this.scene.add(this.rig);
    this.rig.add(this.modelHolder);

    this.orbit = new OrbitControls(this.camera, canvas);
    this.orbit.enableDamping = true;
    this.orbit.dampingFactor = 0.12;
    this.orbit.minDistance = 0.08;
    this.orbit.maxDistance = 12;
    this.orbit.addEventListener('change', () => (this.dirty = true));

    this.gizmo = new TransformControls(this.camera, canvas);
    this.gizmo.setSize(0.7);
    this.scene.add(this.gizmo.getHelper());
    this.gizmo.addEventListener('dragging-changed', (e) => {
      this.orbit.enabled = !(e as unknown as { value: boolean }).value;
      this.dirty = true;
    });
    this.gizmo.addEventListener('objectChange', () => {
      const id = this.selected;
      const att = id ? this.attachNodes.get(id) : undefined;
      if (!id || !att) return;
      const n = att.node;
      this.cb.onAttachmentEdit(id, [n.position.x, n.position.y, n.position.z], [n.rotation.x * RAD2DEG, n.rotation.y * RAD2DEG, n.rotation.z * RAD2DEG]);
      this.dirty = true;
    });

    const size = new Vector2(1, 1);
    const target = new WebGLRenderTarget(1, 1, { type: HalfFloatType, samples: 4 });
    this.composer = new EffectComposer(this.renderer, target);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloomPass = new UnrealBloomPass(size, 0.65, 0.55, 0.9);
    this.composer.addPass(this.bloomPass);
    this.composer.addPass(new OutputPass());

    this.particles = new ParticleRenderer((em) => this.sheetOf(em));
    this.scene.add(this.particles.group);

    this.runtime = new RuntimeSimulator(emptyProject(), { frameCountOf: (em) => this.frameCountOf(em) });

    canvas.addEventListener('pointerdown', this.onDown);
    canvas.addEventListener('pointerup', this.onUp);
    canvas.addEventListener('webglcontextlost', this.onContextLost);

    this.applyQuality();
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.loop);
  }

  /* ---------------------------------------------------------------- public API */

  resize(w: number, h: number): void {
    this.width = Math.max(1, Math.floor(w));
    this.height = Math.max(1, Math.floor(h));
    this.camera.aspect = this.width / this.height;
    this.camera.updateProjectionMatrix();
    this.applySize();
    this.dirty = true;
  }

  setVisible(v: boolean): void {
    this.visible = v;
    if (v) {
      this.last = performance.now();
      this.dirty = true;
    }
  }

  setSettings(s: Partial<ViewportSettings>): void {
    this.settings = { ...this.settings, ...s };
    if (this.grid) this.grid.visible = this.settings.grid;
    this.applyQuality();
    this.dirty = true;
  }

  setProject(project: Project): void {
    const prev = this.project;
    this.project = project;
    if (!prev || prev.weapon.preset !== project.weapon.preset || prev.weapon.modelAssetId !== project.weapon.modelAssetId) {
      this.rebuildWeapon(project.weapon, project);
    }
    if (!prev || prev.weapon.modelScale !== project.weapon.modelScale || prev.weapon.modelRotation !== project.weapon.modelRotation) this.applyModelTransform(project.weapon);
    if (!prev || prev.weapon.environment !== project.weapon.environment) this.applyEnvironment(project.weapon.environment, !prev || prev.weapon.environment !== project.weapon.environment);
    if (!prev || prev.weapon.attachments !== project.weapon.attachments) this.syncAttachments(project.weapon);
    this.rig.updateMatrixWorld(true);
    this.runtime.setProject(project, (id) => this.frameFor(id));
    this.runtime.refreshFrameCounts();
    this.dirty = true;
  }

  /** Called whenever a sheet's derived preview changes. `null` removes the texture. */
  setSheet(sheet: Sheet, preview: SheetPreview | null): void {
    const old = this.sheets.get(sheet.id);
    old?.texture.dispose();
    if (!preview) {
      this.sheets.delete(sheet.id);
      this.frameCounts.delete(sheet.id);
    } else {
      this.sheets.set(sheet.id, {
        texture: textureFromImage(preview.atlas),
        cols: sheet.grid.cols,
        rows: sheet.grid.rows,
        colMajor: sheet.order === 'column-major',
        version: (old?.version ?? 0) + 1,
      });
      this.frameCounts.set(sheet.id, preview.frameCount);
    }
    this.runtime.refreshFrameCounts();
    this.dirty = true;
  }

  removeSheet(sheetId: string): void {
    this.sheets.get(sheetId)?.texture.dispose();
    this.sheets.delete(sheetId);
    this.frameCounts.delete(sheetId);
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  setPlaying(p: boolean): void {
    this.playing = p;
    this.last = performance.now();
    this.dirty = true;
  }

  setSpeed(s: number): void {
    this.speed = Math.max(0.05, Math.min(4, s));
  }

  restart(): void {
    this.runtime.reset();
    this.particles.clear();
    this.clock = 0;
    this.recoilX = 0;
    this.recoilV = 0;
    if (this.equipped) this.runtime.equip();
    this.dirty = true;
  }

  /**
   * Scrubs to `t` seconds by deterministically re-simulating from the start. Only effects that
   * are driven by time/idle are reproduced; shots and reloads are events and are not replayed.
   */
  seek(t: number): void {
    const target = Math.max(0, Math.min(30, t));
    this.runtime.reset();
    this.particles.clear();
    this.recoilX = 0;
    this.recoilV = 0;
    if (this.equipped) this.runtime.equip();
    this.rig.updateMatrixWorld(true);
    const dt = 1 / 60;
    let acc = 0;
    while (acc + dt <= target) {
      this.runtime.update(dt, (id) => this.frameFor(id));
      acc += dt;
    }
    this.clock = acc;
    this.dirty = true;
  }

  setEquipped(on: boolean): void {
    this.equipped = on;
    if (on) this.runtime.equip();
    else {
      this.runtime.switchAway();
      this.autoFire = false;
    }
    this.dirty = true;
  }

  get isEquipped(): boolean {
    return this.equipped;
  }

  fire(): void {
    if (!this.equipped) return;
    this.runtime.fire();
    this.recoilV += 1.1;
    this.dirty = true;
  }

  reload(): void {
    this.runtime.reload();
    this.dirty = true;
  }

  manual(): void {
    this.runtime.manual();
    this.dirty = true;
  }

  setAutoFire(on: boolean): void {
    this.autoFire = on && this.equipped;
    this.autoFireAcc = 0;
  }

  get time(): number {
    return this.clock;
  }

  selectAttachment(id: string | null): void {
    this.selected = id;
    const att = id ? this.attachNodes.get(id) : undefined;
    if (att) this.gizmo.attach(att.node);
    else this.gizmo.detach();
    for (const [aid, a] of this.attachNodes) (a.marker.material as MeshBasicMaterial).color.set(aid === id ? 0xffffff : 0x8b5cf6);
    this.dirty = true;
  }

  setGizmoMode(mode: 'translate' | 'rotate'): void {
    this.gizmo.setMode(mode);
    this.dirty = true;
  }

  resetCamera(): void {
    const w = this.project?.weapon;
    const len = weaponLength(w?.preset ?? 'pistol') * (w?.preset === 'custom' ? 1 : 1);
    const env = w?.environment;
    this.orbit.target.set(0, 0.03, -len * 0.2);
    if (env === 'firstPerson') {
      this.camera.position.set(0.09, 0.14, len * 0.7 + 0.25);
      this.orbit.target.set(0, 0.04, -len * 0.5);
    } else if (env === 'thirdPerson') {
      this.camera.position.set(0.6 + len, 0.35 + len * 0.3, len * 1.4 + 0.5);
    } else {
      this.camera.position.set(0.35 + len * 0.7, 0.2 + len * 0.3, 0.4 + len * 0.7);
    }
    this.orbit.update();
    this.dirty = true;
  }

  /** Measured bounding box of the imported model in metres at the current scale (null for procedural weapons). */
  measureModel(): { size: Vec3 } | null {
    if (!this.imported) return null;
    const b = new Box3().setFromObject(this.imported.root);
    const s = b.getSize(new Vector3());
    return { size: [s.x, s.y, s.z] };
  }

  get currentStats(): ViewportStats {
    return this.collectStats();
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.canvas.removeEventListener('pointerdown', this.onDown);
    this.canvas.removeEventListener('pointerup', this.onUp);
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
    this.gizmo.dispose();
    this.orbit.dispose();
    this.particles.dispose();
    for (const s of this.sheets.values()) s.texture.dispose();
    this.sheets.clear();
    this.clearWeapon();
    this.envTexture?.dispose();
    this.pmrem.dispose();
    this.composer.dispose();
    this.renderer.dispose();
  }

  /* ---------------------------------------------------------------- internals */

  private sheetOf(em: Emitter): SheetTexture | null {
    return em.sheetId ? (this.sheets.get(em.sheetId) ?? null) : null;
  }

  private frameCountOf(em: Emitter): number {
    return em.sheetId ? (this.frameCounts.get(em.sheetId) ?? 1) : 1;
  }

  private frameFor(attachmentId: string | null): EmitterFrame {
    const node = attachmentId ? this.attachNodes.get(attachmentId)?.node : undefined;
    const obj: Object3D = node ?? this.rig;
    obj.updateWorldMatrix(true, false);
    const m = obj.matrixWorld;
    const p = new Vector3();
    const q = new Quaternion();
    const s = new Vector3();
    m.decompose(p, q, s);
    const e = new Euler().setFromQuaternion(q, 'ZYX');
    return { position: [p.x, p.y, p.z], rotation: [e.x * RAD2DEG, e.y * RAD2DEG, e.z * RAD2DEG] };
  }

  private matrixFor = (attachmentId: string | null): Matrix4 => {
    const node = attachmentId ? this.attachNodes.get(attachmentId)?.node : undefined;
    const obj: Object3D = node ?? this.rig;
    obj.updateWorldMatrix(true, false);
    return obj.matrixWorld;
  };

  private clearWeapon(): void {
    if (this.procedural) {
      this.modelHolder.remove(this.procedural.group);
      for (const g of this.procedural.geometries) g.dispose();
      for (const m of this.procedural.materials) m.dispose();
      this.procedural = null;
    }
    if (this.imported) {
      this.modelHolder.remove(this.imported.root);
      this.imported.dispose();
      this.imported = null;
    }
    for (const a of this.attachNodes.values()) {
      this.rig.remove(a.node);
      a.marker.geometry.dispose();
      (a.marker.material as MeshBasicMaterial).dispose();
    }
    this.attachNodes.clear();
  }

  private rebuildWeapon(weapon: Weapon, project: Project): void {
    const token = ++this.modelToken;
    const selected = this.selected;
    // drop whatever is mounted (but keep attachment nodes: they are re-synced afterwards)
    if (this.procedural) {
      this.modelHolder.remove(this.procedural.group);
      for (const g of this.procedural.geometries) g.dispose();
      for (const m of this.procedural.materials) m.dispose();
      this.procedural = null;
    }
    if (this.imported) {
      this.modelHolder.remove(this.imported.root);
      this.imported.dispose();
      this.imported = null;
    }

    const asset = weapon.modelAssetId ? project.assets[weapon.modelAssetId] : undefined;
    const format = asset ? modelFormatOf(asset.file) : null;
    if (asset && format) {
      this.cb.onModel(null, null);
      void (async () => {
        try {
          const bytes = await this.deps.assetBytes(asset);
          const model = await loadModel(bytes, format);
          if (token !== this.modelToken || this.disposed) {
            model.dispose();
            return;
          }
          this.imported = model;
          this.modelHolder.add(model.root);
          this.applyModelTransform(this.project?.weapon ?? weapon);
          this.cb.onModel({ name: asset.name, size: model.size, triangles: model.triangles, warnings: model.warnings, origin: model.origin }, null);
          this.dirty = true;
        } catch (e) {
          if (token !== this.modelToken) return;
          this.mountProcedural(weapon.preset === 'custom' ? 'pistol' : weapon.preset);
          this.cb.onModel(null, e instanceof Error ? e.message : String(e));
        }
      })();
    } else {
      this.mountProcedural(weapon.preset === 'custom' ? 'pistol' : weapon.preset);
      this.cb.onModel(null, null);
    }
    if (selected) this.selectAttachment(selected);
    this.resetCamera();
  }

  private mountProcedural(preset: Exclude<Weapon['preset'], 'custom'>): void {
    this.procedural = buildProceduralWeapon(preset);
    this.modelHolder.add(this.procedural.group);
    this.dirty = true;
  }

  private applyModelTransform(weapon: Weapon): void {
    if (!this.imported) return;
    const root = this.imported.root;
    root.scale.setScalar(weapon.modelScale);
    root.rotation.order = 'ZYX';
    root.rotation.set(weapon.modelRotation[0] * DEG2RAD, weapon.modelRotation[1] * DEG2RAD, weapon.modelRotation[2] * DEG2RAD);
    this.dirty = true;
  }

  private syncAttachments(weapon: Weapon): void {
    const want = new Map(weapon.attachments.map((a) => [a.id, a]));
    for (const [id, a] of this.attachNodes) {
      if (!want.has(id)) {
        if (this.selected === id) this.gizmo.detach();
        this.rig.remove(a.node);
        a.marker.geometry.dispose();
        (a.marker.material as MeshBasicMaterial).dispose();
        this.attachNodes.delete(id);
      }
    }
    for (const att of weapon.attachments) {
      let entry = this.attachNodes.get(att.id);
      if (!entry) {
        const node = new Group();
        node.rotation.order = 'ZYX';
        node.name = `attachment:${att.name}`;
        const marker = new Mesh(new OctahedronGeometry(0.006), new MeshBasicMaterial({ color: 0x8b5cf6, depthTest: false, transparent: true, opacity: 0.95 }));
        marker.renderOrder = 50;
        marker.userData.attachmentId = att.id;
        const axes = new AxesHelper(0.014);
        (axes.material as Material).depthTest = false;
        axes.renderOrder = 49;
        node.add(marker, axes);
        this.rig.add(node);
        entry = { node, marker };
        this.attachNodes.set(att.id, entry);
        if (this.selected === att.id) this.gizmo.attach(node);
      }
      // while the user is dragging this very attachment the gizmo is the source of truth
      if (this.gizmo.dragging && this.selected === att.id) continue;
      entry.node.position.set(att.position[0], att.position[1], att.position[2]);
      entry.node.rotation.set(att.rotation[0] * DEG2RAD, att.rotation[1] * DEG2RAD, att.rotation[2] * DEG2RAD);
    }
    if (this.selected && !this.attachNodes.has(this.selected)) this.selected = null;
  }

  private applyEnvironment(name: Weapon['environment'], moveCamera: boolean): void {
    const env = ENV_PRESETS[name];
    this.scene.background = new Color(env.bg);
    for (const c of [...this.lights.children]) {
      this.lights.remove(c);
      (c as DirectionalLight).dispose?.();
    }
    this.lights.add(new HemisphereLight(env.hemi[0], env.hemi[1], env.hemi[2]));
    this.lights.add(new AmbientLight(0xffffff, 0.05));
    const key = new DirectionalLight(env.key[0], env.key[1]);
    key.position.set(...(env.key[2] as unknown as Vec3));
    const rim = new DirectionalLight(env.rim[0], env.rim[1]);
    rim.position.set(...(env.rim[2] as unknown as Vec3));
    this.lights.add(key, rim);
    this.renderer.toneMapping = env.tone ? ACESFilmicToneMapping : NoToneMapping;
    this.renderer.toneMappingExposure = 1;
    if (!this.envTexture) this.envTexture = this.pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environment = this.envTexture;
    this.scene.environmentIntensity = env.envIntensity;
    if (this.grid) {
      this.scene.remove(this.grid);
      this.grid.geometry.dispose();
      (this.grid.material as Material).dispose();
    }
    this.grid = new GridHelper(4, 40, env.grid[0], env.grid[1]);
    this.grid.position.y = -0.2;
    this.grid.visible = this.settings.grid;
    this.scene.add(this.grid);
    if (moveCamera) this.resetCamera();
    this.dirty = true;
  }

  private applyQuality(): void {
    const maxDpr = Math.min(typeof devicePixelRatio === 'number' ? devicePixelRatio : 1, 2);
    this.levels = [
      { dpr: maxDpr, bloom: true },
      { dpr: Math.min(1, maxDpr), bloom: true },
      { dpr: Math.min(0.75, maxDpr), bloom: false },
      { dpr: 0.5, bloom: false },
    ];
    if (this.settings.quality === 'high') this.level = 0;
    else if (this.settings.quality === 'medium') this.level = 1;
    else if (this.settings.quality === 'low') this.level = 3;
    else this.level = Math.min(this.level, this.levels.length - 1);
    this.applySize();
  }

  private get bloomOn(): boolean {
    return this.settings.bloom && this.levels[this.level]!.bloom;
  }

  private applySize(): void {
    const dpr = this.levels[this.level]?.dpr ?? 1;
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(this.width, this.height, false);
    this.composer.setPixelRatio(dpr);
    this.composer.setSize(this.width, this.height);
    this.bloomPass.enabled = this.bloomOn;
  }

  private onDown = (e: PointerEvent): void => {
    this.downAt = { x: e.clientX, y: e.clientY };
  };

  private onUp = (e: PointerEvent): void => {
    const d = this.downAt;
    this.downAt = null;
    if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) return;
    if (this.gizmo.axis) return; // the click was on the gizmo
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -(((e.clientY - rect.top) / rect.height) * 2 - 1));
    this.raycaster.setFromCamera(ndc, this.camera);
    const markers = [...this.attachNodes.values()].map((a) => a.marker);
    const hit = this.raycaster.intersectObjects(markers, false)[0];
    this.cb.onPick((hit?.object.userData.attachmentId as string | undefined) ?? null);
  };

  private onContextLost = (e: Event): void => {
    e.preventDefault();
  };

  private collectStats(): ViewportStats {
    return {
      fps: this.emaMs > 0 ? Math.min(240, 1000 / this.emaMs) : 0,
      frameMs: this.emaMs,
      particles: this.particles.particles,
      drawCalls: this.renderer.info.render.calls,
      triangles: this.renderer.info.render.triangles,
      pixelRatio: this.levels[this.level]?.dpr ?? 1,
      bloom: this.bloomOn,
      instances: this.runtime.instances.length,
    };
  }

  private loop = (now: number): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    if (!this.visible || this.width < 2 || this.height < 2) return;
    const dtReal = Math.min(0.05, Math.max(0, (now - this.last) / 1000));
    this.last = now;

    let active = this.dirty;
    if (this.playing) {
      const dt = dtReal * this.speed;
      this.clock += dt;
      if (this.autoFire && this.equipped) {
        this.autoFireAcc += dt;
        while (this.autoFireAcc >= 0.12) {
          this.autoFireAcc -= 0.12;
          this.fire();
        }
      }
      // recoil: damped spring along the barrel (preview motion only)
      this.recoilV += (-380 * this.recoilX - 26 * this.recoilV) * dt;
      this.recoilX += this.recoilV * dt;
      this.rig.position.z = this.recoilX * 0.02;
      this.rig.rotation.x = this.recoilX * 0.06;
      this.rig.updateMatrixWorld(true);
      this.runtime.update(dt, (id) => this.frameFor(id));
      active = true;
    }
    if (!active && this.runtime.instances.length === 0 && !this.orbit.enableDamping) return;
    if (!active) {
      // paused and nothing changed: only damping needs frames
      active = this.orbit.update();
      if (!active) {
        this.prevNow = 0;
        return;
      }
    } else this.orbit.update();

    this.particles.update(this.runtime.instances, this.camera, this.matrixFor);
    this.dirty = false;

    this.composer.render(dtReal);

    // wall-clock time between presented frames (what the user feels), smoothed
    if (this.prevNow > 0) this.emaMs = this.emaMs * 0.9 + Math.min(100, now - this.prevNow) * 0.1;
    this.prevNow = now;
    if (now - this.statAt > 500) {
      this.statAt = now;
      this.cb.onStats(this.collectStats());
    }
    this.autoScale(now);
  };

  private autoScale(now: number): void {
    if (this.settings.quality !== 'auto' || !this.playing) return;
    if (now - this.evalAt < 2000) return;
    this.evalAt = now;
    if (this.emaMs > 26 && this.level < this.levels.length - 1) {
      this.level++;
      this.fastSince = 0;
      this.applySize();
    } else if (this.emaMs < 14) {
      this.fastSince = this.fastSince || now;
      if (now - this.fastSince > 8000 && this.level > 0) {
        this.level--;
        this.fastSince = 0;
        this.applySize();
      }
    } else this.fastSince = 0;
  }
}

function emptyProject(): Project {
  // a throwaway project so the simulator can exist before the first setProject
  return {
    schemaVersion: 1,
    id: 'viewport',
    name: 'viewport',
    createdAt: '',
    modifiedAt: '',
    assets: {},
    clips: {},
    sheets: {},
    effects: {},
    weapon: { preset: 'pistol', modelAssetId: null, modelScale: 1, modelRotation: [0, 0, 0], attachments: [], environment: 'darkStudio' },
    export: { resourceName: 'x', assetName: 'x_fx', target: 'fivem-legacy', weapons: [], yptStrategy: 'generate', author: '' },
  };
}

export { IDENTITY_FRAME };
