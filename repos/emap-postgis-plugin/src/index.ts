import type { Plugin } from 'cordis';
import { createPostgisClient } from './client.js';
import type { PostgisContract, PostgisOptions } from './types.js';
export { createPostgisClient } from './client.js';
export { PostgisError } from './errors.js';
export type * from './types.js';
declare module 'cordis' { interface Context { postgis: PostgisContract; } }
export function postgisPlugin(options: PostgisOptions): Plugin.Object {
  return {
    name: 'provider.postgis', provide: ['postgis'],
    apply(ctx) {
      ctx.effect(function* () {
        const service = createPostgisClient(options);
        yield () => service.dispose();
        yield ctx.provide('postgis', service);
      });
    },
  };
}
