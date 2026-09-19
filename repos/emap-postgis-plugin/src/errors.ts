export class PostgisError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400) {
    super(message); this.name = 'PostgisError';
  }
}
export function assertActive(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new DOMException('Cancelled', 'AbortError');
}
export function integer(value: unknown, fallback: number, min: number, max: number, label: string): number {
  const result = value === undefined ? fallback : value;
  if (typeof result !== 'number' || !Number.isSafeInteger(result) || result < min || result > max)
    throw new PostgisError('INVALID_ARGUMENT', `${label} must be an integer in [${min}, ${max}]`);
  return result;
}
