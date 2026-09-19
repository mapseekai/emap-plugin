import type { Plugin } from 'cordis';
import { GdalService } from './service.js';
import type { GdalContract } from './service.js';
import type { GdalPluginOptions } from './types.js';

declare module 'cordis' {
  interface Context { gdal: GdalContract; }
}
/** Native Cordis provider; installing it does not initialize WASM. */
export function gdalPlugin(options: GdalPluginOptions = {}): Plugin.Object {
  return {
    name: 'provider.gdal',
    provide: ['gdal'],
    apply(ctx) {
      ctx.effect(function* () {
        const service = new GdalService(options);
        yield () => service.dispose();
        yield ctx.provide('gdal', service);
      });
    },
  };
}
