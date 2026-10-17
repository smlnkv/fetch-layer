import { unrefTimer } from './timers';

/** Throws AbortError if signal is aborted. */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException('Request aborted', 'AbortError');
  }
}

/**
 * Abort reason. AbortController.abort accepts any value, so reason
 * can be a string or a number. Such values get AbortError instead:
 * the error classifier detects abort by name, otherwise it would
 * become kind unknown.
 */
function abortReason(signal: AbortSignal, fallback: string): unknown {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  return new DOMException(fallback, 'AbortError');
}

/**
 * Cancellable pause. Preserves signal reason: timeout stays kind
 * timeout, not kind abort.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(abortReason(signal, 'Sleep aborted'));
  }

  if (!signal) {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal, 'Sleep aborted'));
    };

    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * AbortSignal with timeout. In Node the timer does not hold the
 * event loop (unref), so the process does not wait for full
 * timeoutMs after the request completes. Abort reason: TimeoutError.
 */
export function setAbortTimeout(ms: number): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('Timeout', 'TimeoutError')), ms);

  unrefTimer(timer);

  return {
    signal: controller.signal,
    clear: () => clearTimeout(timer),
  };
}
