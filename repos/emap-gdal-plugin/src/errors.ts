export class GdalError extends Error {
  constructor(readonly code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'GdalError';
  }
}
export function abortError(reason?: unknown): DOMException {
  return reason instanceof DOMException && reason.name === 'AbortError'
    ? reason
    : new DOMException(reason instanceof Error ? reason.message : 'GDAL task cancelled', 'AbortError');
}
export function cancellationReason(signal: AbortSignal): Error {
  return signal.reason instanceof GdalError && signal.reason.code === 'GDAL_TIMEOUT'
    ? signal.reason : abortError(signal.reason);
}
export function messageOf(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(messageOf).join('; ');
  if (value && typeof value === 'object' && 'message' in value) return String(value.message);
  try { return JSON.stringify(value) ?? 'Unknown GDAL error'; }
  catch { return String(value); }
}
export function positiveInteger(value: number, name: string, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > max)
    throw new GdalError('GDAL_INVALID_INPUT', `${name} must be an integer between 1 and ${max}`);
  return value;
}
