import { GdalError, positiveInteger } from './errors.js';
import type { GdalInput, GdalInputSet, OverviewLevel, OverviewOptions, OverviewResampling } from './types.js';

const resampling: readonly string[] = ['nearest', 'average', 'rms', 'gauss', 'bilinear',
  'cubic', 'cubicspline', 'lanczos', 'average_magphase', 'mode'];
export function filename(value: string): string {
  if (typeof value !== 'string' || !value || value === '.' || value === '..'
    || /[/\\\0:*?"<>|]/.test(value) || value.toLowerCase().startsWith('.gdal3-overviews-'))
    throw new GdalError('GDAL_INVALID_INPUT', 'Expected a portable filename, not a path');
  return value;
}
export function argumentsArray(args: readonly string[] = []): string[] {
  if (!Array.isArray(args) || args.length > 1024 || args.some((arg) =>
    typeof arg !== 'string' || arg.includes('\0') || arg.length > 65536))
    throw new GdalError('GDAL_INVALID_INPUT', 'GDAL arguments must be a bounded array of strings without NUL');
  return [...args];
}
export function inputSet(input: GdalInput): GdalInputSet {
  let set: GdalInputSet;
  if (typeof File !== 'undefined' && input instanceof File) set = { files: [input] };
  else if (Array.isArray(input) || (typeof FileList !== 'undefined' && input instanceof FileList))
    set = { files: Array.from(input as File[] | FileList) };
  else set = input as GdalInputSet;
  if (!set || !Array.isArray(set.files) || !set.files.length || set.files.length > 256)
    throw new GdalError('GDAL_INVALID_INPUT', 'Provide 1–256 Files (include sidecars in the same input set)');
  const names = new Set<string>();
  const files = set.files.map((file) => {
    if (typeof File === 'undefined' || !(file instanceof File))
      throw new GdalError('GDAL_INVALID_INPUT', 'Inputs must be browser File objects');
    const name = filename(file.name);
    if (names.has(name)) throw new GdalError('GDAL_INVALID_INPUT', `Duplicate input filename: ${name}`);
    names.add(name);
    return file;
  });
  if (set.datasetIndex !== undefined && (!Number.isSafeInteger(set.datasetIndex) || set.datasetIndex < 0))
    throw new GdalError('GDAL_INVALID_INPUT', 'datasetIndex must be a nonnegative integer');
  const handlers = [...(set.vfsHandlers ?? [])];
  if (handlers.some((v) => !['vsizip', 'vsigzip', 'vsitar'].includes(v)))
    throw new GdalError('GDAL_INVALID_INPUT', 'Only local archive VFS handlers are accepted');
  return { files, datasetIndex: set.datasetIndex, openOptions: argumentsArray(set.openOptions), vfsHandlers: handlers };
}
export interface NormalizedOverviewOptions {
  levels?: number[];
  resampling: OverviewResampling;
  minSize: number;
  config: Record<string, string>;
  outputName?: string;
  external: true;
}
export function normalizeOverviews(options: OverviewOptions = {}): NormalizedOverviewOptions {
  if (!options || typeof options !== 'object' || Array.isArray(options))
    throw new GdalError('GDAL_INVALID_INPUT', 'Overview options must be an object');
  if (options.external !== undefined && options.external !== true)
    throw new GdalError('GDAL_UNSUPPORTED', 'Only external .ovr generation is supported; source Files are never changed');
  const method = options.resampling ?? 'nearest';
  if (!resampling.includes(method)) throw new GdalError('GDAL_INVALID_INPUT', `Unknown resampling: ${method}`);
  const minSize = positiveInteger(options.minSize ?? 256, 'minSize', 2147483647);
  let levels: number[] | undefined;
  if (options.levels !== undefined) {
    if (!Array.isArray(options.levels) || !options.levels.length || options.levels.length > 64)
      throw new GdalError('GDAL_INVALID_INPUT', 'levels must contain 1–64 reduction factors');
    for (const level of options.levels) {
      positiveInteger(level, 'level', 2147483647);
      if (level < 2) throw new GdalError('GDAL_INVALID_INPUT', 'Overview reduction factors must be at least 2');
    }
    levels = [...new Set(options.levels)].sort((a, b) => a - b);
  }
  if (options.config !== undefined && (!options.config || typeof options.config !== 'object' || Array.isArray(options.config)))
    throw new GdalError('GDAL_INVALID_INPUT', 'Overview config must be an object');
  const config = { COMPRESS_OVERVIEW: 'DEFLATE', GDAL_TIFF_OVR_BLOCKSIZE: '256', ...options.config };
  for (const [key, value] of Object.entries(config)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key) || typeof value !== 'string' || value.includes('\0'))
      throw new GdalError('GDAL_INVALID_INPUT', 'Overview configuration requires uppercase keys and string values');
    if (!key.endsWith('_OVERVIEW') && !['GDAL_TIFF_OVR_BLOCKSIZE', 'USE_RRD', 'VRT_VIRTUAL_OVERVIEWS'].includes(key))
      throw new GdalError('GDAL_INVALID_INPUT', `${key} is not a per-call overview option; set GDAL_CACHEMAX in environment`);
    if (['USE_RRD', 'VRT_VIRTUAL_OVERVIEWS'].includes(key) && value !== 'NO')
      throw new GdalError('GDAL_UNSUPPORTED', `${key} must be NO for external TIFF overviews`);
  }
  return { levels, resampling: method, minSize, config,
    ...(options.outputName === undefined ? {} : { outputName: filename(options.outputName) }), external: true };
}
/** Mirrors this fork's ceil-based automatic overview selection, including the final small level. */
export function planOverviews(width: number, height: number, options: OverviewOptions = {}): readonly OverviewLevel[] {
  positiveInteger(width, 'width', 2147483647);
  positiveInteger(height, 'height', 2147483647);
  const settings = normalizeOverviews(options);
  const levels = settings.levels ?? [];
  if (!settings.levels) {
    let factor = 1;
    while (Math.ceil(Math.max(width, height) / factor) > settings.minSize && factor <= 1073741823) {
      factor *= 2;
      levels.push(factor);
    }
  }
  if (!levels.length)
    throw new GdalError('GDAL_NO_OVERVIEWS_NEEDED', 'Raster already fits minSize; provide explicit levels to force overviews');
  return levels.map((factor) => Object.freeze({ factor, width: Math.ceil(width / factor), height: Math.ceil(height / factor) }));
}
