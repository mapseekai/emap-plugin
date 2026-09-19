import type { Plugin } from 'cordis';
import type { RasterMetadata, GeoTIFFAddOptions } from '@mapseekai/emap/geotiff';
import type {} from './plugin.js';
import { abortError, GdalError } from './errors.js';
import type { OverviewOptions, PyramidResult, TaskOptions } from './types.js';
export interface GdalRasterAddOptions extends TaskOptions {
  readonly pyramid?: Omit<OverviewOptions, 'outputName'>;
  readonly geoTIFF?: Omit<GeoTIFFAddOptions, 'overviewFile' | 'signal'>;
}
export interface GdalRasterContract {
  addFile(id: string, file: File, options?: GdalRasterAddOptions): Promise<{
    metadata: RasterMetadata; pyramid: PyramidResult;
  }>;
}
declare module 'cordis' { interface Context { gdalRaster: GdalRasterContract; } }
/** Build a sidecar and attach it using emap's public GeoTIFF service. */
export function gdalGeoTIFFPlugin(): Plugin.Object {
  return {
    name: 'feature.gdal.geotiff', inject: ['gdal', 'geoTIFF', 'raster'], provide: ['gdalRaster'],
    apply(ctx) {
      ctx.effect(function* () {
        const lifetime = new AbortController(), loading = new Set<string>();
        const owned = new WeakSet<RasterMetadata>();
        const raster = ctx.raster, geoTIFF = ctx.geoTIFF, gdal = ctx.gdal;
        yield () => {
          lifetime.abort(abortError(new Error('GDAL GeoTIFF feature unloaded')));
          const failures: unknown[] = [];
          for (const layer of raster.getLayers()) {
            if (!owned.has(layer.metadata)) continue;
            try { raster.remove(layer.id); } catch (error) { failures.push(error); }
          }
          if (failures.length) throw new AggregateError(failures, 'Could not release raster layers');
        };
        yield ctx.provide('gdalRaster', {
          async addFile(id, file, options = {}) {
            if (lifetime.signal.aborted || options.signal?.aborted) throw abortError();
            if (!id || loading.has(id) || raster.getLayers().some((layer) => layer.id === id))
              throw new GdalError('GDAL_LAYER_ID', 'Layer id is empty, loaded or loading');
            const controller = new AbortController();
            const abort = () => controller.abort(abortError(options.signal?.reason ?? lifetime.signal.reason));
            lifetime.signal.addEventListener('abort', abort, { once: true });
            options.signal?.addEventListener('abort', abort, { once: true });
            loading.add(id);
            try {
              const pyramid = await gdal.buildOverviews(file,
                { ...options.pyramid, outputName: `${file.name}.ovr` },
                { signal: controller.signal, timeoutMs: options.timeoutMs, onProgress: options.onProgress });
              controller.signal.throwIfAborted();
              const metadata = await geoTIFF.addFile(id, file, {
                ...options.geoTIFF, overviewFile: pyramid.overviewFile, signal: controller.signal,
              });
              if (controller.signal.aborted) {
                if (raster.getLayers().some((layer) => layer.id === id && layer.metadata === metadata)) raster.remove(id);
                throw abortError(controller.signal.reason);
              }
              owned.add(metadata);
              return { metadata, pyramid };
            } finally {
              loading.delete(id);
              lifetime.signal.removeEventListener('abort', abort);
              options.signal?.removeEventListener('abort', abort);
            }
          },
        } satisfies GdalRasterContract);
      });
    },
  };
}
