import { GdalError, messageOf, positiveInteger, cancellationReason } from './errors.js';
import { TaskQueue } from './task-queue.js';
import { argumentsArray, filename, inputSet, normalizeOverviews, planOverviews } from './validation.js';
import { GdalWorkerClient, resolveAssets } from './worker-client.js';
import { collectOutput } from './output.js';
import type { NativePath } from './output.js';
import type { DatasetInfo, GdalCommandOptions, GdalDrivers, GdalInput, GdalInspection,
  GdalOutput, GdalPluginOptions, OverviewOptions, PyramidResult, TaskOptions, TaskPhase } from './types.js';
interface Dataset { pointer: number; path: string; type: string; info?: Record<string, unknown>; }
interface OpenResult { datasets: Dataset[]; errors?: unknown[]; }
type Session = { client: GdalWorkerClient; drivers: GdalDrivers; emit: (phase: TaskPhase) => void };
/** Isolated, lazy, task-scoped Workers. Native pointers never escape this service. */
export class GdalService {
  private readonly queue: TaskQueue;
  private readonly options: GdalPluginOptions;
  private readonly budget: number;
  private readonly clients = new Set<GdalWorkerClient>();
  constructor(options: GdalPluginOptions = {}) {
    this.options = { ...options, environment: { ...options.environment } };
    for (const [key, value] of Object.entries(this.options.environment ?? {})) {
      if (!/^[A-Z][A-Z0-9_]*$/.test(key) || typeof value !== 'string' || value.includes('\0'))
        throw new GdalError('GDAL_INVALID_INPUT', 'Environment requires uppercase names and string values');
    }
    this.queue = new TaskQueue(options.maxPendingTasks, options.timeoutMs);
    this.budget = positiveInteger(options.maxOutputBytes ?? 256 * 1024 ** 2, 'maxOutputBytes');
  }
  get pendingTasks(): number { return this.queue.pending; }
  private task<T>(operation: string, task: TaskOptions, run: (session: Session) => Promise<T>): Promise<T> {
    return this.queue.enqueue(operation, task, async (signal, emit) => {
      emit('initializing');
      if (signal.aborted) throw cancellationReason(signal);
      const assets = resolveAssets(this.options);
      const factory = this.options.createWorker ?? ((url: URL, config: WorkerOptions) => {
        if (typeof Worker === 'undefined')
          throw new GdalError('GDAL_BROWSER_REQUIRED', 'GDAL requires browser Web Workers');
        return new Worker(url, config);
      });
      const client = new GdalWorkerClient(factory(assets.worker,
        { type: 'classic', name: `emap-gdal-${operation}` }), signal);
      this.clients.add(client);
      try {
        const drivers = await client.initialize(assets, this.options.environment ?? {});
        if (signal.aborted) throw cancellationReason(signal);
        return await run({ client, drivers, emit });
      } finally {
        client.dispose();
        this.clients.delete(client);
      }
    });
  }
  private datasetTask<T>(operation: string, input: GdalInput, task: TaskOptions,
    kind: 'raster' | 'vector' | undefined,
    run: (session: Session, dataset: Dataset, warnings: string[]) => Promise<T>): Promise<T> {
    const snapshot = inputSet(input);
    return this.task(operation, task, async (session) => {
      session.emit('opening');
      const opened = await session.client.call<OpenResult>('open', snapshot.files,
        snapshot.openOptions, snapshot.vfsHandlers);
      if (!Array.isArray(opened?.datasets) || !opened.datasets.length)
        throw new GdalError('GDAL_NO_DATASET', 'GDAL did not open a dataset');
      if (opened.datasets.length !== 1 && snapshot.datasetIndex === undefined)
        throw new GdalError('GDAL_AMBIGUOUS_DATASET', 'Multiple datasets found; specify datasetIndex');
      const dataset = opened.datasets[snapshot.datasetIndex ?? 0];
      if (!dataset || !Number.isInteger(dataset.pointer) || dataset.pointer <= 0)
        throw new GdalError('GDAL_NO_DATASET', 'Invalid datasetIndex or dataset pointer');
      if (kind && dataset.type !== kind)
        throw new GdalError('GDAL_DATASET_TYPE', `Operation requires ${kind}, not ${dataset.type}`);
      session.emit('executing');
      return run(session, dataset, (opened.errors ?? []).map(messageOf));
    });
  }
  private output(session: Session, path: NativePath, warnings: readonly string[]) {
    session.emit('exporting');
    return collectOutput(session.client, path, warnings, this.budget);
  }
  async drivers(task: TaskOptions = {}): Promise<GdalDrivers> {
    return this.task('drivers', task, async ({ drivers }) => drivers);
  }
  async inspect(input: GdalInput, task: TaskOptions = {}): Promise<GdalInspection> {
    return this.datasetTask('inspect', input, task, undefined, async ({ client }, ds, warnings) => ({
      summary: await client.call<DatasetInfo>('getInfo', ds), metadata: ds.info ?? {}, warnings,
    }));
  }
  async getInfo(input: GdalInput, task: TaskOptions = {}): Promise<DatasetInfo> {
    return (await this.inspect(input, task)).summary;
  }
  async gdalinfo(input: GdalInput, args: readonly string[] = [], task: TaskOptions = {}): Promise<Record<string, unknown>> {
    const options = argumentsArray(args);
    return this.datasetTask('gdalinfo', input, task, 'raster', ({ client }, ds) => client.call('gdalinfo', ds, options));
  }
  async ogrinfo(input: GdalInput, args: readonly string[] = [], task: TaskOptions = {}): Promise<Record<string, unknown>> {
    const options = argumentsArray(args);
    return this.datasetTask('ogrinfo', input, task, 'vector', ({ client }, ds) => client.call('ogrinfo', ds, options));
  }
  private conversion(command: string, kind: 'raster' | 'vector', input: GdalInput,
    options: GdalCommandOptions, task: TaskOptions): Promise<GdalOutput> {
    const args = argumentsArray(options.args);
    const flag = command === 'ogr2ogr' ? '-f' : '-of';
    if (!args.includes(flag)) args.unshift(flag, command === 'ogr2ogr' ? 'GeoJSON' : 'GTiff');
    if (args.some((arg, i) => ['-of', '-f'].includes(arg) && args[i + 1]?.toUpperCase() === 'VRT'))
      throw new GdalError('GDAL_UNSUPPORTED', 'VRT would reference a temporary Worker filesystem; use a materialized format');
    const name = filename(options.outputName ?? 'result');
    return this.datasetTask(command, input, task, kind, async (session, ds, warnings) =>
      this.output(session, await session.client.call<NativePath>(command, ds, args, name), warnings));
  }
  async translate(input: GdalInput, options: GdalCommandOptions = {}, task: TaskOptions = {}): Promise<GdalOutput> {
    return this.conversion('gdal_translate', 'raster', input, options, task);
  }
  async warp(input: GdalInput, options: GdalCommandOptions = {}, task: TaskOptions = {}): Promise<GdalOutput> {
    return this.conversion('gdalwarp', 'raster', input, options, task);
  }
  async rasterize(input: GdalInput, options: GdalCommandOptions = {}, task: TaskOptions = {}): Promise<GdalOutput> {
    return this.conversion('gdal_rasterize', 'vector', input, options, task);
  }
  async vectorTranslate(input: GdalInput, options: GdalCommandOptions = {}, task: TaskOptions = {}): Promise<GdalOutput> {
    return this.conversion('ogr2ogr', 'vector', input, options, task);
  }
  async transform(coords: readonly (readonly number[])[], args: readonly string[], task: TaskOptions = {}): Promise<number[][]> {
    if (!Array.isArray(coords) || !coords.length || coords.length > 100000 || coords.some((p) =>
      !Array.isArray(p) || p.length < 2 || p.length > 3 || p.some((v) => !Number.isFinite(v))))
      throw new GdalError('GDAL_INVALID_INPUT', 'Expected finite XY or XYZ coordinate tuples');
    const points = coords.map((p) => [...p]);
    const options = argumentsArray(args);
    return this.task('gdaltransform', task, async ({ client, emit }) => {
      emit('executing');
      return client.call('gdaltransform', points, options);
    });
  }
  async buildOverviews(input: GdalInput, options: OverviewOptions = {}, task: TaskOptions = {}): Promise<PyramidResult> {
    const settings = normalizeOverviews(options);
    return this.datasetTask('buildOverviews', input, task, 'raster', async (session, ds, warnings) => {
      const info = await session.client.call<DatasetInfo>('getInfo', ds);
      const levels = planOverviews(info.width!, info.height!, settings);
      const path = await session.client.call<NativePath>('buildOverviews', ds, settings);
      const output = await this.output(session, path, warnings);
      return Object.freeze({ ...output, overviewFile: output.primary,
        sourceName: ds.path.split('/').pop()!, levels: Object.freeze(levels), resampling: settings.resampling });
    });
  }
  async createPyramid(input: GdalInput, options: OverviewOptions = {}, task: TaskOptions = {}): Promise<PyramidResult> {
    return this.buildOverviews(input, options, task);
  }
  /** This fork supports external creation/rebuild, not the entire native gdaladdo CLI. */
  async gdaladdo(input: GdalInput, options: GdalCommandOptions = {}, task: TaskOptions = {}): Promise<GdalOutput> {
    const args = argumentsArray(options.args);
    const name = options.outputName === undefined ? undefined : filename(options.outputName);
    return this.datasetTask('gdaladdo', input, task, 'raster', async (session, ds, warnings) =>
      this.output(session, await session.client.call<NativePath>('gdaladdo', ds, args, name), warnings));
  }
  /** Uses the upstream fork's explicit [latitude, longitude] order. */
  async locationInfo(input: GdalInput, coordinate: readonly [number, number], task: TaskOptions = {}): Promise<{ pixel: number; line: number }> {
    if (coordinate.length !== 2 || !coordinate.every(Number.isFinite)
      || Math.abs(coordinate[0]) > 90 || Math.abs(coordinate[1]) > 180)
      throw new GdalError('GDAL_INVALID_INPUT', 'Expected a valid latitude/longitude pair');
    const point = [...coordinate];
    return this.datasetTask('gdal_location_info', input, task, 'raster', ({ client }, ds) =>
      client.call('gdal_location_info', ds, point));
  }
  gdal_translate = this.translate.bind(this);
  gdalwarp = this.warp.bind(this);
  gdal_rasterize = this.rasterize.bind(this);
  ogr2ogr = this.vectorTranslate.bind(this);
  gdaltransform = this.transform.bind(this);
  gdal_location_info = this.locationInfo.bind(this);
  dispose(): void {
    this.queue.dispose();
    for (const client of this.clients) client.dispose();
    this.clients.clear();
  }
}
export type GdalContract = Omit<GdalService, 'dispose'>;
