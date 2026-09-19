import { cancellationReason, GdalError, messageOf } from './errors.js';
import type { GdalDrivers, GdalPluginOptions, GdalWorkerPort } from './types.js';
interface Pending { resolve(value: unknown): void; reject(error: unknown): void; }
export interface GdalAssets { worker: URL; wasm: URL; data: URL; }
export function resolveAssets(options: GdalPluginOptions): GdalAssets {
  const host = typeof document !== 'undefined' ? document.baseURI : import.meta.url;
  const text = options.assetPath?.toString();
  const base = text === undefined ? new URL('./assets/gdal/', import.meta.url)
    : new URL(text.endsWith('/') ? text : `${text}/`, host);
  return {
    worker: options.workerUrl ? new URL(options.workerUrl, host) : new URL('gdal3.js', base),
    wasm: options.wasmUrl ? new URL(options.wasmUrl, host) : new URL('gdal3WebAssembly.wasm', base),
    data: options.dataUrl ? new URL(options.dataUrl, host) : new URL('gdal3WebAssembly.data', base),
  };
}
/** Version-pinned adapter for the upstream classic Worker protocol, not its global singleton proxy. */
export class GdalWorkerClient {
  private readonly pending = new Map<string | number, Pending>();
  private sequence = 1;
  private disposed = false;
  private removeAbort = () => {};
  constructor(private readonly worker: GdalWorkerPort, signal: AbortSignal) {
    worker.onmessage = (event) => {
      const response = event.data as { id?: string | number; success?: boolean; data?: unknown } | null;
      if (!response || response.id === undefined) return;
      const call = this.pending.get(response.id);
      if (!call) return;
      if (typeof response.success !== 'boolean') {
        this.dispose(new GdalError('GDAL_WORKER_PROTOCOL', 'Malformed GDAL Worker response'));
        return;
      }
      this.pending.delete(response.id);
      if (response.success) call.resolve(response.data);
      else call.reject(new GdalError('GDAL_OPERATION_FAILED', messageOf(response.data), { cause: response.data }));
    };
    worker.onerror = (event) => {
      event.preventDefault?.();
      this.dispose(new GdalError('GDAL_WORKER_ERROR', event.message || 'GDAL Worker failed to load or crashed'));
    };
    worker.onmessageerror = () => this.dispose(new GdalError('GDAL_WORKER_PROTOCOL', 'Cannot deserialize GDAL Worker response'));
    const abort = () => this.dispose(cancellationReason(signal));
    this.removeAbort = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  }
  initialize(assets: GdalAssets, environment: Readonly<Record<string, string>>): Promise<GdalDrivers> {
    return this.send('onload', { func: 'constructor', params: { config: {
      useWorker: false, paths: { wasm: assets.wasm.href, data: assets.data.href }, env: { ...environment },
    } } });
  }
  call<T>(func: string, ...params: unknown[]): Promise<T> {
    const id = this.sequence++;
    return this.send(id, { id, func, params });
  }
  private send<T>(id: string | number, message: unknown): Promise<T> {
    if (this.disposed) return Promise.reject(new GdalError('GDAL_WORKER_CLOSED', 'GDAL Worker is closed'));
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject });
      try { this.worker.postMessage(message); }
      catch (error) { this.dispose(new GdalError('GDAL_WORKER_PROTOCOL', messageOf(error), { cause: error })); }
    });
  }
  dispose(error: Error = new GdalError('GDAL_WORKER_CLOSED', 'GDAL Worker closed')): void {
    if (this.disposed) return;
    this.disposed = true;
    this.removeAbort();
    this.worker.onmessage = null;
    this.worker.onerror = null;
    this.worker.onmessageerror = null;
    this.worker.terminate();
    for (const call of this.pending.values()) call.reject(error);
    this.pending.clear();
  }
}
