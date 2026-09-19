import type { Plugin } from 'cordis';
export interface PluginContract { readonly ready: boolean; }
declare module 'cordis' { interface Context { __SERVICE__: PluginContract; } }
/** Replace the placeholder service with this plugin's typed domain API. */
export function __SERVICE__Plugin(): Plugin.Object {
  return {
    name: 'provider.__SLUG__', provide: ['__SERVICE__'],
    apply(ctx) {
      ctx.effect(function* () {
        const service: PluginContract = Object.freeze({ ready: true });
        // Yield owned-resource disposal here, before providing the service.
        yield ctx.provide('__SERVICE__', service);
      });
    },
  };
}
