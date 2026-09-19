import type { GdalWorkerPort } from '../../src/types.js';
export class FakeWorker implements GdalWorkerPort {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  readonly messages: unknown[] = [];
  terminated = false;
  constructor(readonly hang = false) {}
  postMessage(message: unknown): void {
    this.messages.push(message);
    if (this.hang) return;
    const request = message as { id?: number; func: string };
    queueMicrotask(() => {
      if (this.terminated) return;
      this.onmessage?.({ data: { id: request.func === 'constructor' ? 'onload' : request.id,
        success: true, data: { raster: { GTiff: {} }, vector: { GeoJSON: {} } },
      } } as MessageEvent);
    });
  }
  terminate(): void { this.terminated = true; }
}
