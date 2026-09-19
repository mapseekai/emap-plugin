import { getDefaultMapshaperAdapter } from '@mapseekai/emap';
import { wkbToDataset, createWkbDatasetBuilder } from './dataset.js';
import { PostgisError } from './errors.js';
import type { WkbQueryResult, DatasetOptions } from './wkb-types.js';
const scope = globalThis as unknown as {
  onmessage: (event: MessageEvent<{ id?: number; op?: 'append' | 'finish'; result: WkbQueryResult; options: DatasetOptions }>) => void;
  postMessage(value: unknown): void;
};
let builder: ReturnType<typeof createWkbDatasetBuilder> | undefined;
scope.onmessage = async ({ data }) => {
  try {
    if (data.op === 'append') {
      builder ??= createWkbDatasetBuilder(data.result,data.options);
      builder.append(data.result); scope.postMessage({ id:data.id,ok:true }); return;
    }
    const converted = data.op === 'finish' ? builder?.finish(data.result) : wkbToDataset(data.result,data.options);
    if (!converted) throw new PostgisError('INVALID_RESPONSE','No stream data received');
    const { dataset, ...metadata } = converted;
    builder = undefined;
    // The generic mapshaper session restorer cannot resolve EPSG init files.
    // Keep CRS in the query envelope; the host's public source service resolves it.
    if (dataset.info) delete dataset.info.crs_string;
    const packed = await getDefaultMapshaperAdapter().exportDatasetsToPack([dataset], { compact: false });
    scope.postMessage({ id:data.id, ok: true, packed, metadata });
  } catch (error) {
    builder = undefined;
    scope.postMessage({ id:data.id, ok: false, code: error instanceof PostgisError ? error.code : 'CONVERSION_FAILED',
      message: error instanceof Error ? error.message : 'WKB conversion failed' });
  }
};
