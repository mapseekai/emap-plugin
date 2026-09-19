/** All operations are browser-only. Inputs are host-owned Files, never filesystem paths. */
export interface GdalInputSet {
  readonly files: readonly File[];
  /** Required when GDAL discovers more than one primary dataset. */
  readonly datasetIndex?: number;
  readonly openOptions?: readonly string[];
  readonly vfsHandlers?: readonly ('vsizip' | 'vsigzip' | 'vsitar')[];
}
export type GdalInput = File | FileList | readonly File[] | GdalInputSet;
export type GdalArguments = readonly string[];
export type OverviewResampling = 'nearest' | 'average' | 'rms' | 'gauss' | 'bilinear'
  | 'cubic' | 'cubicspline' | 'lanczos' | 'average_magphase' | 'mode';
export interface OverviewOptions {
  readonly levels?: readonly number[];
  readonly resampling?: OverviewResampling;
  readonly minSize?: number;
  readonly config?: Readonly<Record<string, string>>;
  /** A basename. For automatic association, keep the default <source filename>.ovr. */
  readonly outputName?: string;
  readonly external?: true;
}
export interface OverviewLevel {
  readonly factor: number;
  readonly width: number;
  readonly height: number;
}
export type TaskPhase = 'queued' | 'initializing' | 'opening' | 'executing' | 'exporting'
  | 'completed' | 'cancelled' | 'failed';
export interface TaskProgress {
  readonly id: number;
  readonly operation: string;
  /** Stage progress only: the upstream build does not expose native percentage callbacks. */
  readonly phase: TaskPhase;
}
export interface TaskOptions {
  readonly signal?: AbortSignal;
  /** Active task timeout, excluding time spent waiting in the queue. */
  readonly timeoutMs?: number;
  readonly onProgress?: (event: TaskProgress) => void;
}
export interface GdalCommandOptions {
  readonly args?: GdalArguments;
  /** Output stem WITHOUT extension for GDAL conversion commands. */
  readonly outputName?: string;
}
export interface GdalOutput {
  readonly primary: File;
  /** Includes the primary file and every generated sidecar, e.g. .shx/.dbf/.prj. */
  readonly files: readonly File[];
  readonly warnings: readonly string[];
}
export interface PyramidResult extends GdalOutput {
  readonly overviewFile: File;
  readonly sourceName: string;
  readonly levels: readonly OverviewLevel[];
  readonly resampling: OverviewResampling;
}
export interface DatasetInfo {
  type: string;
  dsName: string;
  driverName: string;
  bandCount?: number;
  width?: number;
  height?: number;
  projectionWkt?: string;
  coordinateTransform?: number[];
  corners?: number[][];
  layerCount?: number;
  featureCount?: number;
  layers?: Array<{ name: string; featureCount: number }>;
}
export interface GdalInspection {
  readonly summary: DatasetInfo;
  readonly metadata: Record<string, unknown>;
  readonly warnings: readonly string[];
}
export interface GdalDrivers {
  readonly raster: Readonly<Record<string, unknown>>;
  readonly vector: Readonly<Record<string, unknown>>;
}
/** Minimal interface also permits a host-injected Worker factory in tests. */
export interface GdalWorkerPort {
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
  postMessage(message: unknown): void;
  terminate(): void;
}
export interface GdalPluginOptions {
  /** Directory containing the three assets copied by emap-gdal-copy-assets. */
  readonly assetPath?: string | URL;
  readonly workerUrl?: string | URL;
  readonly wasmUrl?: string | URL;
  readonly dataUrl?: string | URL;
  readonly environment?: Readonly<Record<string, string>>;
  /** Includes the active task; default 8. One task executes at a time per service. */
  readonly maxPendingTasks?: number;
  /** Export allocation guard, not a hard cap on GDAL's WASM heap. Default 256 MiB. */
  readonly maxOutputBytes?: number;
  readonly timeoutMs?: number;
  readonly createWorker?: (url: URL, options: WorkerOptions) => GdalWorkerPort;
}
