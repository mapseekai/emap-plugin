# Public integration patterns

Read only the section needed for the task; general ownership and repository rules
remain in [SKILL.md](../SKILL.md). These examples target the project's installed
emap `0.13.0` baseline, not an assertion about every future emap version.

## Public imports and services

Use package entry points; the installed package's `exports` and declaration files
are authoritative. Never import its private `src` or unexported `dist` paths.

| Public entry | Purpose |
| --- | --- |
| `@mapseekai/emap` | `Emap`, `Control`, dataset types and main public API |
| `@mapseekai/emap/context` | Cordis identity and runtime diagnostics |
| `@mapseekai/emap/services` | Service contracts, format/capability types and Context declarations |
| `@mapseekai/emap/plugins` | Public feature helpers such as `formatPlugin` |
| `@mapseekai/emap/geotiff` | Optional GeoTIFF/raster integration and its types |
| `@mapseekai/emap/duckdb`, `/maplibre`, `/arrow` | Optional integrations; inspect their own exports |

For a Feature that accesses core services, include their type declarations:

```typescript
import type {} from '@mapseekai/emap/services';
```

This loads types only; it does not install providers. Declare every required service
in `inject` and compose the matching providers in the host.

Core groups include `document` / `layers` / `source` / `sourceFactory` (data),
`view` / `projection` / `scale` (camera and CRS), `selection` / `history` / `mutation`
/ `editState` (editing), `query` / `ops` / `attributes` (processing), `surface` /
`render` / `signals` / `mapEvents` (rendering and events), and `interaction` /
`shortcuts` / `controls` / `formats` / `capabilities` (features).
Optional `raster`, `geoTIFF`, `duckDb` and `mapLibre` services require their providers.
Use public services for layer resolution, projection, transactions and selection;
never reproduce host rendering/geometry logic or mutate host datasets behind them.

## Vector format feature

The codec is pure binary I/O, not a map or DOM service. The registry is instance-local.
Prefer the public helper, which gives the registration native plugin ownership:

```typescript
import { formatPlugin } from '@mapseekai/emap/plugins';
import type { DatasetFormatPlugin } from '@mapseekai/emap/services';
export const createFormatFeature = (codec: DatasetFormatPlugin) => formatPlugin(codec);
```

A codec provides `name`, dotless `extensions`, `importBinary(bytes, filename)` returning
`Promise<MapshaperDataset>`, an `exportFormats` map returning `ExportedFormatFile[]`,
and optional `mimeTypes`. Use the installed exported type rather than a duplicate.
When registering manually, bind `ctx.formats.register(codec)`'s disposer through
`ctx.effect` and declare `inject: ['formats']`. Test unregister during an import.
The codec signature has no `AbortSignal` in this baseline; do not invent one or assume
registry disposal preempts arbitrary native code. Arrange owned-resource cancellation.

## Control and interaction

`Control` is exported from `@mapseekai/emap`. `onAdd` receives a bounded
`ControlContext`, not the complete Emap object or a Cordis Context. Do not assume
`map.ctx` is available inside a control. Declare dependencies in `inject`.

```typescript
import type { Control } from '@mapseekai/emap';
export function zoomControl(): Control {
  let release: (() => void) | undefined;
  return {
    inject: ['view'],
    onAdd(map) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = '+';
      button.setAttribute('aria-label', 'Zoom in');
      const zoom = () => map.zoomIn();
      button.addEventListener('click', zoom);
      release = () => button.removeEventListener('click', zoom);
      return button;
    },
    onRemove() { release?.(); release = undefined; },
  };
}
```

The host calls `await map.addControl(zoomControl(), 'top-right')`; controls are child
plugins whose removal owns `onRemove` cleanup. Create a fresh control per map.
DOM listeners belong to controls; engine signals use `ctx.mapEvents` / public
interaction services with subscriptions owned by the plugin. Do not install a
parallel raw-DOM event pipeline or patch private handler implementations.

## AI/UI capability

Use `CapabilityDefinition` from `@mapseekai/emap/services` (also publicly exported
by `@mapseekai/emap/ai`). Register inside a native Feature with `inject: ['capabilities']`
and a `ctx.effect`-owned disposer. Add every domain service used by execution to
`inject` too; schema registration must not hide a runtime dependency.

The descriptor has `id`, `title`, `description`, `category`, `inputSchema`, `effects`,
`undoable`, `cost`, `crs`, and optional `keywords`, `whenToUse`, `avoidWhen`.
IDs match `/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/`; effects describe real `read`, `document`,
`selection`, `view` or `external` effects, not just whether an operation returns data.
`execute(input, context)` must honor `context.signal` and `context.assertActive()`
and use domain services for mutations, preserving transactions and stale-result checks.

Host `authorizeCapability` controls agent write effects. Never accept authorization
from model-generated arguments or automatically expose arbitrary GDAL CLI arguments,
URLs or output destinations to agents. Keep low-level processing separate from a
narrow, validated capability. Test invalid input, denial, success, cancellation and
unload through the public capability service in the plugin's own test suite.
Do not invent an unavailable host code-generation command for this repository.

## Raster and native-runtime reference

A raster file is not a vector `DatasetFormatPlugin` dataset. Keep processing APIs
independent from optional map attachment. The local GDAL implementation demonstrates
[this Provider](../../../../repos/emap-gdal-plugin/src/plugin.ts) and
[this GeoTIFF Feature](../../../../repos/emap-gdal-plugin/src/geotiff.ts), using only
public emap services. Read its [guide](../../../../repos/emap-gdal-plugin/README.md)
only when working on native raster processing or the GDAL plugin.

Deploy matched JS/WASM/data assets with correct URLs, MIME and Worker/CSP support.
Declare output ownership, source-file preservation, cancellation, task budgets and
unload behavior explicitly. Test with real assets rather than mocks alone. GDAL's
external `.ovr`, task-scoped Workers and per-task output limits are implementation
choices of that plugin, not capabilities or limits promised for every future plugin.
