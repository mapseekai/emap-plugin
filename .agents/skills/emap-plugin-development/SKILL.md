---
name: emap-plugin-development
description: Develop independently published emap plugin packages in the emap-plugin monorepo using native Cordis. Use for scaffolding a plugin, Provider/Service lifecycle, feature composition, format codecs, controls, interaction extensions, AI capabilities, or Emap.create integration. Not a guide for modifying emap core, publishing packages without authorization, or unrelated application work.
user-invocable: false
---

# Developing emap Plugins

This skill is maintained in the `emap-plugin` management repository. Start with
[repository rules](../../../AGENTS.md) and the target plugin's own instructions.
Do not resolve development guidance against a sibling host source checkout.
Only load [integration patterns](references/patterns.md) for the kind of plugin being changed.

## Repository and API boundaries

- `repos/<name>` is tracked by the root Git repository and has its own npm package, lockfile,
  version, tests and release cycle. Packages publish independently; Git history is shared.
- Create a plugin from the management root: `npm run new:plugin -- <slug>`.
  The [template](../../../templates/plugin/README.md) includes standalone development rules.
- `@mapseekai/emap` is a peer dependency. Use only its public package exports;
  inspect the installed version's declarations, not private source/deep imports.
- The current baseline is emap `0.14.1` and `cordis@4.0.0-rc.10`. Keep Cordis pinned
  as a peer and external to ESM bundles; do not upgrade it as incidental cleanup.
- Do not create nested Git repositories under `repos/`. Package build/runtime code must remain
  usable independently of root tooling, while development commits and pushes happen at the root.
- Ordinary plugin work must not patch host internals or invent a replacement SDK.
  A missing host extension point is a separate host change, not a deep-import workaround.

## Choose the plugin kind

emap plugins are native Cordis plugins; `map.ctx` is the Cordis `Context`.

| Need | Kind |
| --- | --- |
| Publish a typed service | Provider (`Plugin.Object` with `provide`) |
| Add behavior using existing services | Feature with explicit `inject` |
| Add vector import/export | Feature registering a `DatasetFormatPlugin` |
| Load or process raster files | Processing Provider plus optional raster/GeoTIFF Feature |
| Add UI or interaction | `Control` / Feature using public interaction services |
| Expose an AI/UI operation | Feature registering a `CapabilityDefinition` |

Compose with `Emap.create({ preset, plugins, excludePlugins })`, not new map classes.
Same-name plugins replace preset entries; choose names such as `provider.acme` or
`feature.acme.format` deliberately. Inject every service used; an optional provider
must be installed explicitly, not merely asserted to exist through TypeScript.

## Minimal Provider

```typescript
import type { Plugin } from 'cordis';
export interface CounterContract { value: number; }
declare module 'cordis' {
  interface Context { counter: CounterContract; }
}
export const counterPlugin: Plugin.Object = {
  name: 'provider.acme.counter',
  provide: ['counter'],
  apply(ctx) {
    ctx.effect(function* () {
      const counter: CounterContract = { value: 0 };
      yield ctx.provide('counter', counter);
    });
  },
};
export const readerPlugin: Plugin.Object = {
  name: 'feature.acme.reader',
  inject: ['counter'],
  apply(ctx) { console.log(ctx.counter.value); },
};
```

Export the service contract and make its Context augmentation reachable from the
package's public declaration entry. Do not create a second service container.

## Resource ownership and asynchronous work

`ctx.effect` binds resources to the plugin Fiber. Yield cleanup before providing a
service so reverse-order teardown revokes the service before disposing its resources:

```typescript
// Inside apply(ctx); acquireResource() stands for plugin-owned initialization.
ctx.effect(function* () {
  const resource = acquireResource();
  yield () => resource.dispose();
  yield ctx.provide('resource', resource);
});
```

- Bind listeners, subscriptions, timers, Workers and object URLs to their owner;
  no module-global native handles or cross-map mutable registries.
- Initialize WASM lazily and run heavy work in Workers. Bound queues and output
  sizes; distinguish output-copy budgets from actual native heap limits.
- Honor caller cancellation and plugin unload. Check for stale results after each
  asynchronous boundary and before changing a layer. Clean up only owned resources.
- Use `const fiber = ctx.plugin(plugin, config); await fiber.await();` when the
  caller needs the installed service. Use `dispose()`, `restart()` and `update()`
  on that Fiber; disposing a Provider suspends dependent consumers.
- `ctx.effect` does not automatically cancel arbitrary promises or native work.
  Implement and test cancellation, termination and recovery explicitly.
- Keep processing separate from map attachment and host persistence. A returned
  `File` must not silently become a saved file, upload or document mutation.

For GDAL-specific work only, read the [GDAL guide](../../../repos/emap-gdal-plugin/README.md)
and [verification record](../../../repos/emap-gdal-plugin/docs/verification.md).
Its task-scoped Worker and external `.ovr` policy are not requirements for all plugins.

## Verification and completion

Use the actual target `package.json`; management and plugin scripts are different:

```sh
# From the management repository:
node --test test/scaffold.test.mjs   # template / generator behavior
npm run verify                     # scaffold plus every registered plugin

# From repos/<plugin-name>:
npm run verify                     # that plugin's declared gates
```

The current GDAL gate includes type checks, unit/lifecycle tests, build, package
exports/assets and real browser WASM tests; a newly scaffolded plugin has a smaller
gate until its implementation needs more. Do not claim absent checks were run.

Unit tests are colocated as `foo.test.ts`; cross-module, browser, package and public
contract tests belong under `test/`. For behavior changes, reproduce failures first
and check install/unload/restart, dependency readiness, per-map isolation and stale
results. Test optional integrations and native assets with the real host/runtime.
Cross-bundle Cordis identity can be checked with `Context.is(map.ctx)`; diagnostics
are public exports of `@mapseekai/emap/context` (`inspectContext`, `inspectServices`,
`settleContext`). Run applicable checks again after fixes, not unrelated host suites.

For skill/document-only changes, inspect relative links, commands, triggers and
standalone-checkout behavior. Do not add tests solely to mirror prose. Template
changes additionally require the scaffold check. Report exactly which checks ran
and any blockers. Preserve unrelated work; no publishing, pushing, remote creation
or external data writes without authorization for that action.
