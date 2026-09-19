import type { Plugin } from 'cordis';
import type { LayerSpecification, TopologySource } from '@mapseekai/emap';
import type { SourceContract, SourceFactoryContract, LayerContract, ViewContract } from '@mapseekai/emap/services';
import type { PostgisContract, FeatureQueryRequest, DatasetQueryResult, RequestOptions } from './types.js';
import { PostgisError, assertActive } from './errors.js';
const defaultPaint = {
  "fill": {
    "fill-color": "#1677ff",
    "fill-opacity": 0.25
  },
  "line": {
    "line-color": "#1677ff",
    "line-width": 2
  },
  "circle": {
    "circle-color": "#fa8c16",
    "circle-radius": 5
  }
};
export interface LoadPostgisLayer {
  sourceId: string; query: FeatureQueryRequest; fitBounds?: boolean;
  paint?: { fill?: Extract<LayerSpecification, { type: 'fill' }>['paint']; line?: Extract<LayerSpecification, { type: 'line' }>['paint']; circle?: Extract<LayerSpecification, { type: 'circle' }>['paint'] };
}
export interface LoadedPostgisLayer { sourceId: string; layerIds: string[]; result: DatasetQueryResult; }
export interface PostgisLayersContract {
  load(input: LoadPostgisLayer, options?: RequestOptions): Promise<LoadedPostgisLayer>;
  remove(sourceId: string): void;
  list(): { sourceId: string; layerIds: string[] }[];
  dispose(): void;
}
interface Host { postgis: PostgisContract; sourceFactory: SourceFactoryContract; source: SourceContract; layers: LayerContract; view: ViewContract; }
declare module 'cordis' { interface Context { postgisLayers: PostgisLayersContract; } }
export function createPostgisLayers(host: Host): PostgisLayersContract {
  const { postgis, sourceFactory, source, layers, view } = host;
  const pending = new Map<string, AbortController>();
  const owned = new Map<string, { source: TopologySource; layers: LayerSpecification[] }>();
  let disposed = false;
  function cleanup(id: string, item: { source: TopologySource; layers: LayerSpecification[] }): void {
    for (const layer of item.layers) {
      const current = layers.getLayer(layer.id);
      // Host returns cloned specifications; compare owned, uniquely named bindings.
      if (current?.source === layer.source && current['source-layer'] === layer['source-layer'] && current.type === layer.type)
        layers.removeLayer(layer.id);
    }
    // Preserve replacements and sources adopted by unrelated layers.
    if (source.getSource(id) === item.source && !layers.getLayers().some((layer) => layer.source === id)) source.removeSource(id);
  }
  return {
    async load(input, options = {}) {
      if (disposed) throw new PostgisError('DISPOSED', 'PostGIS layers are disposed');
      const id = input.sourceId;
      if (typeof id !== 'string' || !/^[a-zA-Z0-9_-][a-zA-Z0-9_.:-]{0,127}$/.test(id)) throw new PostgisError('INVALID_SOURCE_ID', 'Use a source ID without path separators');
      if (pending.has(id) || owned.has(id) || source.getSource(id)) throw new PostgisError('SOURCE_CONFLICT', 'Source ID already exists or is loading');
      const task = new AbortController();
      const cancel = () => task.abort(options.signal?.reason);
      options.signal?.addEventListener('abort', cancel, { once: true });
      if (options.signal?.aborted) cancel();
      pending.set(id, task);
      let staged: { source: TopologySource; layers: LayerSpecification[] } | undefined;
      try {
        assertActive(task.signal);
        const result = await postgis.queryDataset(input.query, { signal: task.signal });
        assertActive(task.signal);
        if (!result.dataset.layers.some((layer) => layer.geometry_type && layer.shapes?.some(Boolean)))
          throw new PostgisError('NO_GEOMETRY', 'No drawable geometry; use queryDataset to inspect attributes');
        if (source.getSource(id)) throw new PostgisError('SOURCE_CONFLICT', 'Source appeared while query was pending');
        const ownerTag = crypto.randomUUID();
        for (const [i, layer] of result.dataset.layers.entries()) layer.name = `${layer.name ?? 'postgis'}_${ownerTag}_${i}`;
        const topology = sourceFactory.fromDataset(id, result.dataset);
        assertActive(task.signal); staged = { source: topology, layers: [] };
        await source.addSource(id, topology, { sourceCrs: `EPSG:${result.srid}` });
        const registered = source.getSource(id) as TopologySource | undefined;
        if (!registered) throw new PostgisError("SOURCE_FAILED", "emap did not register the source");
        staged.source = registered; assertActive(task.signal);
        for (const [index, item] of staged.source.getLayers().entries()) {
          const type = item.geometry_type === 'polygon' ? 'fill' : item.geometry_type === 'polyline' ? 'line' : item.geometry_type === 'point' ? 'circle' : undefined;
          if (!type) continue;
          const layerId = `${id}:${index}`;
          if (layers.getLayer(layerId)) throw new PostgisError('LAYER_CONFLICT', `Layer ID already exists: ${layerId}`);
          const layer = { id: layerId, source: id, ...(item.name ? { 'source-layer': item.name } : {}), type, paint: { ...defaultPaint[type], ...input.paint?.[type] } } as LayerSpecification;
          layers.addLayer(layer); const attached = layers.getLayer(layerId);
          if (!attached) throw new PostgisError('LAYER_FAILED', 'emap did not register the layer');
          staged.layers.push(attached);
        }
        if (!staged.layers.length) throw new PostgisError('NO_GEOMETRY', 'emap found no supported geometry layers');
        assertActive(task.signal); owned.set(id, staged);
        if (input.fitBounds !== false) view.setExtent(staged.source.getExtent());
        return { sourceId: id, layerIds: staged.layers.map((layer) => layer.id), result };
      } catch (error) {
        if (staged) cleanup(id, staged); owned.delete(id); throw error;
      } finally { pending.delete(id); options.signal?.removeEventListener('abort', cancel); }
    },
    remove(id) {
      pending.get(id)?.abort(new DOMException('Layer removed', 'AbortError'));
      const item = owned.get(id); if (item) cleanup(id, item); owned.delete(id);
    },
    list: () => [...owned].map(([sourceId, item]) => ({ sourceId, layerIds: item.layers.map((layer) => layer.id) })),
    dispose() {
      disposed = true;
      for (const task of pending.values()) task.abort(new DOMException('Plugin unloaded', 'AbortError'));
      for (const [id, item] of owned) cleanup(id, item); owned.clear();
    },
  };
}
export function postgisLayerPlugin(): Plugin.Object {
  return {
    name: 'feature.postgis.layers', provide: ['postgisLayers'],
    inject: ['postgis', 'sourceFactory', 'source', 'layers', 'view'],
    apply(ctx) {
      ctx.effect(function* () {
        const service = createPostgisLayers(ctx);
        yield () => service.dispose();
        yield ctx.provide('postgisLayers', service);
      });
    },
  };
}
