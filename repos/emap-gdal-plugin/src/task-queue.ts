import { abortError, cancellationReason, GdalError, positiveInteger } from './errors.js';
import type { TaskOptions, TaskPhase } from './types.js';
type Emit = (phase: TaskPhase) => void;
interface Job {
  controller: AbortController;
  execute: (signal: AbortSignal, emit: Emit) => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  cleanup: () => void;
  emit: Emit;
  timeout: number;
}
/** FIFO with bounded admission. A cancelled queued job never allocates a Worker. */
export class TaskQueue {
  private nextId = 1;
  private readonly waiting: Job[] = [];
  private active?: Job;
  private closed = false;
  constructor(private readonly maxPending = 8, private readonly timeout = 300000) {
    positiveInteger(maxPending, 'maxPendingTasks', 256);
    positiveInteger(timeout, 'timeoutMs', 2147483647);
  }
  get pending(): number { return this.waiting.length + (this.active ? 1 : 0); }
  enqueue<T>(operation: string, options: TaskOptions,
    execute: (signal: AbortSignal, emit: Emit) => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new GdalError('GDAL_DISPOSED', 'GDAL service has been disposed'));
    if (options.signal?.aborted) return Promise.reject(abortError(options.signal.reason));
    if (this.pending >= this.maxPending) return Promise.reject(new GdalError('GDAL_QUEUE_FULL', 'Too many pending GDAL tasks'));
    const timeout = positiveInteger(options.timeoutMs ?? this.timeout, 'timeoutMs', 2147483647);
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const controller = new AbortController();
      const emit: Emit = (phase) => {
        try { options.onProgress?.(Object.freeze({ id, operation, phase })); }
        catch { /* Observers must not break resource ownership or corrupt the queue. */ }
      };
      const cancel = () => {
        controller.abort(abortError(options.signal?.reason));
        const index = this.waiting.indexOf(job);
        if (index >= 0) {
          this.waiting.splice(index, 1);
          job.cleanup();
          emit('cancelled');
          reject(abortError(options.signal?.reason));
        }
      };
      const job: Job = { controller, execute, resolve: (value) => resolve(value as T), reject,
        emit, timeout, cleanup: () => options.signal?.removeEventListener('abort', cancel) };
      this.waiting.push(job);
      options.signal?.addEventListener('abort', cancel, { once: true });
      emit('queued');
      this.pump();
    });
  }
  private pump(): void {
    if (this.closed || this.active) return;
    const job = this.waiting.shift();
    if (!job) return;
    this.active = job;
    const { signal } = job.controller;
    const timer = setTimeout(() => job.controller.abort(new GdalError('GDAL_TIMEOUT', 'GDAL task exceeded its execution timeout')), job.timeout);
    let removeAbort = () => {};
    const aborted = new Promise<never>((_, reject) => {
      const abort = () => reject(cancellationReason(signal));
      signal.addEventListener('abort', abort, { once: true });
      removeAbort = () => signal.removeEventListener('abort', abort);
      if (signal.aborted) abort();
    });
    const work = Promise.resolve().then(() => {
      if (signal.aborted) throw cancellationReason(signal);
      return job.execute(signal, job.emit);
    });
    const release = () => {
      clearTimeout(timer);
      removeAbort();
      job.cleanup();
      this.active = undefined;
    };
    const fail = (error: unknown) => {
      release();
      job.emit(error instanceof Error && error.name === 'AbortError' ? 'cancelled' : 'failed');
      job.reject(error);
      this.pump();
    };
    void Promise.race([work, aborted]).then((result) => {
      if (signal.aborted) { fail(cancellationReason(signal)); return; }
      release();
      job.emit('completed');
      job.resolve(result);
      this.pump();
    }, fail);
  }
  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    const error = abortError(new Error('GDAL plugin unloaded'));
    this.active?.controller.abort(error);
    for (const job of this.waiting.splice(0)) {
      job.controller.abort(error);
      job.cleanup();
      job.emit('cancelled');
      job.reject(error);
    }
  }
}
