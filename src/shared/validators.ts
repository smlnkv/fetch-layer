/**
 * Минимальная задержка между повторами. Защищает от нулевой
 * задержки и от сервера, ответившего Retry-After: 0.
 */
export const MIN_RETRY_MS = 100;

export function assertInteger(value: unknown, name: string, min: number): asserts value is number {
  if (!Number.isInteger(value) || (value as number) < min) {
    throw new Error(`${name} must be an integer >= ${min}, got ${String(value)}`);
  }
}

export function assertNonNegativeNumber(value: unknown, name: string): asserts value is number {
  if (!Number.isFinite(value) || (value as number) < 0) {
    throw new Error(`${name} must be a non-negative number, got ${String(value)}`);
  }
}

export function assertPositiveNumber(value: unknown, name: string): asserts value is number {
  if (!Number.isFinite(value) || (value as number) <= 0) {
    throw new Error(`${name} must be a positive number, got ${String(value)}`);
  }
}

export function assertNonEmptyString(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
}

/**
 * Не даёт задержке стать меньше min. NaN и Infinity тоже дают min.
 */
export function clampDelay(ms: number, min: number): number {
  if (!Number.isFinite(ms)) return min;
  return Math.max(min, ms);
}
