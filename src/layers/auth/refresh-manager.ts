import { ApiError, classifyFetchError } from '../../core/errors';

import { CircuitBreaker } from './circuit-breaker';
import { SingleFlight } from './single-flight';

import type { RefreshResult, SessionProvider } from './types';

const DEFAULT_REFRESH_TIMEOUT_MS = 30_000;

/**
 * Внутренний результат refresh. Отличается от публичного
 * RefreshResult наличием статуса cooldown: успешный refresh был
 * меньше circuitBreakerMs назад. Обрабатывается внутри withAuth,
 * наружу не выходит.
 */
export type RefreshManagerResult = RefreshResult | { status: 'cooldown' };

/**
 * Колбэки состояния предохранителя. Источник - AuthOptions.
 */
export interface RefreshManagerCallbacks {
  onCircuitOpen?: () => void;
  onCircuitClose?: () => void;
}

/**
 * Менеджер обновления токена. Один на клиент.
 *
 * Решает три задачи:
 *
 * 1. Single-flight: параллельные 401 запускают один refresh.
 * 2. Предохранитель: после временного сбоя новые попытки
 *    блокируются на circuitBreakerMs.
 * 3. Cooldown: успешный refresh не повторяется в пределах
 *    circuitBreakerMs. Pipeline idempotency -> retry -> auth может
 *    снова получить 401 в рамках одной операции; без cooldown это
 *    запускает второй refresh.
 *
 * Таймаут refresh ограничен refreshTimeoutMs. Вызов завершается
 * по таймауту, даже если реализация SessionProvider не слушает
 * переданный signal.
 */
export class RefreshManager {
  private readonly circuit: CircuitBreaker;
  private readonly singleFlight = new SingleFlight<RefreshManagerResult>();
  private readonly refreshTimeoutMs: number;

  /**
   * Время последнего успешного refresh. Используется для cooldown.
   */
  private lastSuccessfulRefreshAt = 0;

  constructor(
    callbacks: RefreshManagerCallbacks = {},
    refreshTimeoutMs = DEFAULT_REFRESH_TIMEOUT_MS,
  ) {
    this.circuit = new CircuitBreaker({
      onOpen: callbacks.onCircuitOpen,
      onClose: callbacks.onCircuitClose,
    });
    this.refreshTimeoutMs = refreshTimeoutMs;
  }

  /**
   * Сбрасывает предохранитель и забывает текущий refresh.
   * Вызывается через resetRefreshCircuit, когда приложение знает,
   * что проблема устранена.
   *
   * Забыть нужно до закрытия предохранителя: иначе следующий 401
   * присоединится к прежнему промису, и сброс не даст эффекта.
   */
  reset(): void {
    this.singleFlight.forget();
    this.circuit.close();
  }

  /**
   * Обновляет сессию или присоединяется к текущему обновлению.
   *
   * @param circuitBreakerMs - длительность предохранителя
   *  и окна cooldown.
   */
  refresh(provider: SessionProvider, circuitBreakerMs: number): Promise<RefreshManagerResult> {
    if (this.circuit.isBlocking()) {
      return Promise.resolve({
        status: 'temporarily-failed',
        error: new ApiError({
          kind: 'unknown',
          code: 'REFRESH_CIRCUIT_OPEN',
          message: 'Token refresh is temporarily unavailable',
          isUncertain: false,
        }),
      });
    }

    const now = Date.now();
    if (this.lastSuccessfulRefreshAt > 0 && now - this.lastSuccessfulRefreshAt < circuitBreakerMs) {
      return Promise.resolve({ status: 'cooldown' });
    }

    return this.singleFlight.run(() => this.doRefresh(provider, circuitBreakerMs));
  }

  /**
   * Вызывает provider.refresh с таймаутом и классифицирует результат.
   *
   * TypeError вокруг provider.refresh означает сетевую ошибку:
   * реализация обычно делает fetch внутри. Тот же контекст, что
   * и в транспорте вокруг fetchImpl.
   *
   * Возвращает нормализованный error в ветке temporarily-failed:
   * withAuth не должен вызывать toApiError повторно.
   */
  private async doRefresh(
    provider: SessionProvider,
    circuitBreakerMs: number,
  ): Promise<RefreshManagerResult> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;

    // Таймаут отклоняет промис сам, независимо от того, слушает ли
    // реализация signal. controller.abort - подсказка ей.
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const reason = new DOMException('Refresh timeout', 'TimeoutError');
        controller.abort(reason);
        reject(reason);
      }, this.refreshTimeoutMs);

      if (typeof timer === 'object' && typeof (timer as { unref?: unknown }).unref === 'function') {
        (timer as { unref: () => void }).unref();
      }
    });

    timeoutPromise.catch(() => {});

    let result: RefreshResult;

    try {
      result = await Promise.race([provider.refresh(controller.signal), timeoutPromise]);
    } catch (e) {
      const err = classifyFetchError(e);

      // Таймаут refresh - сбой, открываем предохранитель.
      if (err.kind === 'timeout') {
        this.circuit.open(circuitBreakerMs);
        return {
          status: 'temporarily-failed',
          error: new ApiError({
            kind: 'timeout',
            code: 'REFRESH_TIMEOUT',
            message: 'Token refresh timed out',
            isUncertain: true,
          }),
        };
      }

      // Отмена - не сбой сети, предохранитель не открываем.
      if (err.isCancelled) {
        return { status: 'temporarily-failed', error: err };
      }

      // 401 или 403 от обновления - сессия мертва.
      if (err.status === 401 || err.status === 403) {
        return {
          status: 'definitely-failed',
          reason: err.status === 403 ? 'refresh-forbidden' : 'refresh-rejected',
        };
      }

      this.circuit.open(circuitBreakerMs);
      return { status: 'temporarily-failed', error: err };
    } finally {
      clearTimeout(timer);
    }

    if (result.status === 'temporarily-failed') {
      const err = classifyFetchError(result.error);
      if (!err.isCancelled) {
        this.circuit.open(circuitBreakerMs);
      }
      return { status: 'temporarily-failed', error: err };
    }

    if (result.status === 'success') {
      this.lastSuccessfulRefreshAt = Date.now();
    }

    return result;
  }
}
