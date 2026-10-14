import type { Asset, Clip, Project } from '@vfxforge/core';
import type { ConvertService, FrameSource } from '@vfxforge/export';
import type { RgbaImage } from '@vfxforge/media';

/** What the current runtime can actually do. The UI disables (and explains) anything it cannot. */
export interface PlatformFeatures {
  /** Video/animated-image extraction through FFmpeg (desktop). Browser mode uses the codecs of the browser. */
  ffmpeg: boolean;
  /** Reads the real source frame rate / frame count. */
  accurateProbe: boolean;
  /** Binary .ypt creation (needs the CodeWalker bridge). */
  binaryYpt: boolean;
  /** Projects live as folders on disk. */
  nativeProjects: boolean;
  /** Frame interpolation modes beyond "none". */
  interpolation: boolean;
}

export interface ExtractOptions {
  onProgress?: (done: number, expected: number | null) => void;
  signal?: AbortSignal;
  /** Informational messages about limitations hit during extraction. */
  onNote?: (message: string) => void;
}

export interface FrameService extends FrameSource {
  extract(clip: Clip, project: Project, opts?: ExtractOptions): Promise<RgbaImage[]>;
}

export interface ProjectSummary {
  id: string;
  name: string;
  modifiedAt: string;
}

export interface ConverterStatus {
  available: boolean;
  detail: string;
  version?: string | null;
  codewalkerCore?: string | null;
}

export interface ProjectStore {
  list(): Promise<ProjectSummary[]>;
  /** Atomic save. Resolves once the data is durable. */
  save(project: Project): Promise<void>;
  open(id: string): Promise<Project>;
  remove(id: string): Promise<void>;
  /** Portable single-file bundle (project.json + assets) for sharing / backup. */
  exportBundle(project: Project): Promise<Uint8Array>;
  importBundle(bytes: Uint8Array): Promise<Project>;
  /** Recoverable snapshot; never replaces the saved project. */
  autosave(project: Project): Promise<void>;
  /** An autosave that is newer than the saved project (i.e. the last session did not end cleanly). */
  recovery(id: string): Promise<Project | null>;
  /** Most recent autosave of any project, for "reopen after a crash". */
  latestAutosave(): Promise<Project | null>;
  clearAutosave(id: string): Promise<void>;
}

export interface ToolPaths {
  ffmpeg: string | null;
  ffprobe: string | null;
  dotnet: string | null;
  dll: string | null;
}

export interface ToolEntry {
  available: boolean;
  path: string | null;
  version: string | null;
  detail: string;
}

export interface ToolsStatus {
  ffmpeg: ToolEntry;
  ffprobe: ToolEntry;
  bridge: ConverterStatus;
  paths: ToolPaths;
}

/** Desktop only: where FFmpeg and the CodeWalker converter bridge live. */
export interface ToolsApi {
  status(): Promise<ToolsStatus>;
  setPaths(paths: ToolPaths): Promise<ToolsStatus>;
}

export interface Platform {
  readonly kind: 'tauri' | 'browser';
  readonly label: string;
  readonly features: PlatformFeatures;
  /** Validates (by content, not extension), hashes and stores `source`; the original is never modified. */
  importAsset(source: File | string, onProgress?: (p: number) => void): Promise<Asset>;
  /** A URL usable by <img>, <video> and loaders. Revoke with `release` when done. */
  assetUrl(asset: Asset): Promise<string>;
  assetBytes(asset: Asset): Promise<Uint8Array>;
  frames: FrameService;
  projects: ProjectStore;
  converter: ConvertService | null;
  converterStatus(): Promise<ConverterStatus>;
  /** Saves a file for the user: native dialog (desktop) or download (browser). */
  saveFile(suggestedName: string, bytes: Uint8Array, mime: string): Promise<'saved' | 'cancelled'>;
  /** Opens a file picker. Desktop returns native paths, the browser returns File objects. */
  pickFiles(opts: { accept: string[]; multiple?: boolean; title?: string }): Promise<Array<File | string>>;
  /** Desktop only. */
  tools?: ToolsApi;
  /**
   * Desktop only: the native window reports file drops (the web engine's own drag & drop is
   * intercepted). `onHover` tells the UI to show its drop target. Returns an unsubscribe function.
   */
  onFilesDropped?(cb: (paths: string[]) => void, onHover?: (active: boolean) => void): Promise<() => void>;
  /** Re-reads capabilities (e.g. after tool paths changed). */
  refresh?(): Promise<void>;
}
