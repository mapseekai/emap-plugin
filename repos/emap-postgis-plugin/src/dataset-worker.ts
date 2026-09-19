import { getDefaultMapshaperAdapter } from '@mapseekai/emap';
import { wkbToDataset } from './dataset.js';
import { PostgisError } from './errors.js';
import type { WkbQueryResult, DatasetOptions } from './wkb-types.js';
const scope = globalThis as unknown as {
  onmessage: (event: MessageEvent<{ result: WkbQueryResult; options: DatasetOptions }>) => void;
  postMessage(value: unknown): void;
};
scope.onmessage = async ({ data }) => {
  try {
    const { dataset } = wkbToDataset(data.result, data.options);
    // The generic mapshaper session restorer cannot resolve EPSG init files.
    // Keep CRS in the query envelope; the host's public source service resolves it.
    if (dataset.info) delete dataset.info.crs_string;
    const packed = await getDefaultMapshaperAdapter().exportDatasetsToPack([dataset], { compact: false });
    scope.postMessage({ ok: true, packed });
  } catch (error) {
    scope.postMessage({ ok: false, code: error instanceof PostgisError ? error.code : 'CONVERSION_FAILED',
      message: error instanceof Error ? error.message : 'WKB conversion failed' });
  }
};
