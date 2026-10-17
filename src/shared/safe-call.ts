/**
 * For app callbacks (logger, hooks): a failure does not break the
 * request. Returns undefined on error.
 */
export function safeCall<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}
