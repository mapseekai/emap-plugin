import { GdalError } from './errors.js';
import { filename } from './validation.js';
import type { GdalWorkerClient } from './worker-client.js';
import type { GdalOutput } from './types.js';
export interface NativePath { local: string; all?: NativePath[]; }
interface NativeFile { path: string; size: number; }
const mime: Record<string, string> = { tif: 'image/tiff', tiff: 'image/tiff', ovr: 'image/tiff',
  png: 'image/png', jpg: 'image/jpeg', geojson: 'application/geo+json', json: 'application/geo+json',
  csv: 'text/csv', gpkg: 'application/geopackage+sqlite3' };
export async function collectOutput(client: GdalWorkerClient, output: NativePath,
  warnings: readonly string[], budget: number): Promise<GdalOutput> {
  if (!output || typeof output.local !== 'string' || !output.local.startsWith('/output/'))
    throw new GdalError('GDAL_OUTPUT_INVALID', 'GDAL returned an invalid output path');
  const listed = await client.call<NativeFile[]>('getOutputFiles');
  if (!Array.isArray(listed) || !listed.length || listed.length > 256)
    throw new GdalError('GDAL_OUTPUT_INVALID', 'No output or too many sidecars');
  let total = 0;
  const paths = new Set<string>();
  for (const item of listed) {
    if (!item || typeof item.path !== 'string' || !item.path.startsWith('/output/'))
      throw new GdalError('GDAL_OUTPUT_INVALID', 'Unexpected output path');
    filename(item.path.slice(8));
    if (paths.has(item.path) || !Number.isSafeInteger(item.size) || item.size < 0)
      throw new GdalError('GDAL_OUTPUT_INVALID', 'Invalid output metadata');
    paths.add(item.path);
    total += item.size;
    if (total > budget) throw new GdalError('GDAL_OUTPUT_BUDGET', `Output exceeds ${budget} bytes`);
  }
  if (!listed.find((item) => item.path === output.local)?.size)
    throw new GdalError('GDAL_OUTPUT_INVALID', 'Primary output is missing or empty');
  const files: File[] = [];
  let primary: File | undefined;
  for (const item of listed) {
    const bytes = await client.call<Uint8Array>('getFileBytes', item.path);
    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== item.size)
      throw new GdalError('GDAL_OUTPUT_INVALID', 'Unexpected output bytes');
    const name = item.path.slice(8);
    const ext = name.split('.').pop()?.toLowerCase() ?? '';
    const file = new File([bytes as Uint8Array<ArrayBuffer>], name,
      { type: mime[ext] ?? 'application/octet-stream' });
    files.push(file);
    if (item.path === output.local) primary = file;
  }
  return Object.freeze({ primary: primary!, files: Object.freeze(files),
    warnings: Object.freeze([...warnings]) });
}
