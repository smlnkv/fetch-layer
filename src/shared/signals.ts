import { unrefTimer } from './timers';

/**
 * Выбрасывает AbortError, если сигнал отменён.
 */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException('Request aborted', 'AbortError');
  }
}

/**
 * Причина отмены. AbortController.abort принимает любое значение,
 * поэтому reason может оказаться строкой или числом. Для таких
 * значений подставляется AbortError: классификатор ошибок
 * распознаёт отмену по имени, иначе она стала бы kind unknown.
 */
function abortReason(signal: AbortSignal, fallback: string): unknown {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  return new DOMException(fallback, 'AbortError');
}

/**
 * Пауза с поддержкой отмены. Сохраняет reason отменённого сигнала:
 * таймаут остаётся kind timeout, а не превращается в kind abort.
 *
 * Отклоняется с reason сигнала, если он задан, иначе с AbortError.
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
 * AbortSignal, срабатывающий через указанное время. Возвращает
 * функцию отмены таймера, если запрос завершился раньше.
 *
 * В Node таймер не удерживает event loop (unref), чтобы короткая
 * CLI-утилита не ждала полного истечения timeoutMs после завершения
 * запроса.
 *
 * Причина отмены: TimeoutError.
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
