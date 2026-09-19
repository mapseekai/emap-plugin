import type { ConversionOptions, DatasetConverter, DatasetQueryResult, WkbQueryResult } from './wkb-types.js';
import type { PackedSession } from '@mapseekai/emap';
import { PostgisError, assertActive, integer } from './errors.js';
export function createDatasetConverter(options: ConversionOptions = {}): DatasetConverter {
  const pending = new Set<AbortController>(); let disposed = false;
  const timeout = integer(options.timeoutMs, 30000, 1, 300000, 'conversion.timeoutMs');
  const concurrency = integer(options.maxConcurrent, 2, 1, 8, 'conversion.maxConcurrent');
  const settings = { layerName: options.layerName, noTopology: options.noTopology,
    maxVertices: options.maxVertices, maxGeometryBytes: options.maxGeometryBytes };
  return {
    async convert(result, call = {}) {
      if (disposed) throw new PostgisError('DISPOSED', 'Dataset converter is disposed');
      if (pending.size >= concurrency) throw new PostgisError('BUSY', 'Too many concurrent dataset conversions');
      const task = new AbortController(); pending.add(task);
      const cancel = () => task.abort(call.signal?.reason);
      call.signal?.addEventListener('abort', cancel, { once: true }); if (call.signal?.aborted) cancel();
      const timer = setTimeout(() => task.abort(new DOMException('Conversion timed out', 'TimeoutError')), timeout);
      let worker: Worker | undefined; let onAbort = () => {};
      const aborted = new Promise<never>((_, reject) => {
        onAbort = () => { worker?.terminate(); reject(task.signal.reason); };
        task.signal.addEventListener('abort', onAbort, { once: true }); if (task.signal.aborted) onAbort();
      });
      const execute = async (): Promise<DatasetQueryResult> => {
        assertActive(task.signal);
        const useWorker = options.worker !== false && typeof Worker !== 'undefined';
        if (!useWorker) {
          if (options.worker !== false && typeof window !== 'undefined') throw new PostgisError('WORKER_REQUIRED', 'This browser needs Worker support');
          const { wkbToDataset } = await import('./dataset.js'); assertActive(task.signal);
          return wkbToDataset(result, settings);
        }
        worker = new Worker(options.workerUrl ?? new URL('./dataset-worker.js', import.meta.url), { type: 'module' });
        const packed = await new Promise<PackedSession>((resolve, reject) => {
          worker!.onmessage = ({ data }) => data.ok ? resolve(data.packed) : reject(new PostgisError(data.code ?? 'CONVERSION_FAILED', data.message ?? 'WKB conversion failed'));
          worker!.onerror = () => reject(new PostgisError('WORKER_FAILED', 'Dataset Worker failed; check its URL and CSP'));
          worker!.onmessageerror = () => reject(new PostgisError('WORKER_FAILED', 'Invalid Worker message'));
          worker!.postMessage({ result, options: settings });
        });
        assertActive(task.signal);
        const { getDefaultMapshaperAdapter } = await import('@mapseekai/emap'); assertActive(task.signal);
        const restored = await getDefaultMapshaperAdapter().restoreSessionData(packed); assertActive(task.signal);
        if (restored.datasets.length !== 1) throw new PostgisError('INVALID_RESPONSE', 'Expected one packed dataset');
        restored.datasets[0].info = { ...restored.datasets[0].info, crs_string: `EPSG:${result.srid}` };
        const { rows: _rows, ...metadata } = result;
        return { ...metadata, dataset: restored.datasets[0] };
      };
      try { const converted = await Promise.race([execute(), aborted]); assertActive(task.signal); return converted; }
      finally {
        worker?.terminate(); clearTimeout(timer); pending.delete(task);
        call.signal?.removeEventListener('abort', cancel); task.signal.removeEventListener('abort', onAbort);
      }
    },
    async convertPages(pages, call = {}) {
      if (disposed) throw new PostgisError('DISPOSED','Dataset converter is disposed');
      if (pending.size >= concurrency) throw new PostgisError('BUSY','Too many concurrent dataset conversions');
      const task=new AbortController();pending.add(task);
      const cancel=()=>task.abort(call.signal?.reason);
      call.signal?.addEventListener('abort',cancel,{once:true});if(call.signal?.aborted)cancel();
      const streamSettings={...settings,maxVertices:settings.maxVertices??10000000,maxGeometryBytes:settings.maxGeometryBytes??268435456};
      let worker: Worker|undefined;let serial=0;let last: WkbQueryResult|undefined;let total=0;
      let builder: ReturnType<typeof import('./dataset.js')['createWkbDatasetBuilder']>|undefined;
      const useWorker=options.worker!==false && typeof Worker!=='undefined';
      const rpc=(op: 'append'|'finish', result: WkbQueryResult): Promise<any>=>new Promise((resolve,reject)=>{
        assertActive(task.signal);const id=++serial;
        const aborted=()=>{worker?.terminate();clean();reject(task.signal.reason);};
        const timer=setTimeout(()=>{worker?.terminate();clean();reject(new PostgisError('TIMEOUT','数据转换超时，请缩小读取范围。'));},timeout);
        const clean=()=>{clearTimeout(timer);task.signal.removeEventListener('abort',aborted);};
        task.signal.addEventListener('abort',aborted,{once:true});
        worker!.onmessage=({data})=>{if(data.id!==id)return;clean();data.ok?resolve(data):reject(new PostgisError(data.code??'CONVERSION_FAILED',data.message??'Stream conversion failed'));};
        worker!.onerror=worker!.onmessageerror=()=>{clean();reject(new PostgisError('WORKER_FAILED','Dataset Worker failed'));};
        try { worker!.postMessage({id,op,result,options:streamSettings}); } catch(error) { clean();reject(error); }
      });
      try {
        assertActive(task.signal);
        if(useWorker)worker=new Worker(options.workerUrl??new URL('./dataset-worker.js',import.meta.url),{type:'module'});
        else if(options.worker!==false && typeof window!=='undefined')throw new PostgisError('WORKER_REQUIRED','This browser needs Worker support');
        for await(const page of pages){
          assertActive(task.signal);last=page;total+=page.rowCount;
          if(worker)await rpc('append',page);
          else{
            if(!builder){const {createWkbDatasetBuilder}=await import('./dataset.js');assertActive(task.signal);builder=createWkbDatasetBuilder(page,streamSettings);}
            builder.append(page);
          }
          assertActive(task.signal);call.onProgress?.({rowsRead:total});
        }
        if(!last)throw new PostgisError('INCOMPLETE_STREAM','Stream contained no verified completion');
        assertActive(task.signal);
        if(!worker)return builder!.finish(last);
        const result=await rpc('finish',last);assertActive(task.signal);
        const {getDefaultMapshaperAdapter}=await import('@mapseekai/emap');assertActive(task.signal);
        const restored=await getDefaultMapshaperAdapter().restoreSessionData(result.packed);assertActive(task.signal);
        if(restored.datasets.length!==1)throw new PostgisError('INVALID_RESPONSE','Expected one packed dataset');
        restored.datasets[0].info={...restored.datasets[0].info,crs_string:`EPSG:${last.srid}`};
        return {...result.metadata,dataset:restored.datasets[0]};
      } finally {
        worker?.terminate();pending.delete(task);task.abort();call.signal?.removeEventListener('abort',cancel);
      }
    },
    dispose() {
      disposed = true;
      for (const task of pending) task.abort(new DOMException('Plugin unloaded', 'AbortError'));
      pending.clear();
    },
  };
}
