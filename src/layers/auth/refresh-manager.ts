import { ApiError, classifyFetchError } from '../../core/errors';
import { unrefTimer } from '../../shared/timers';

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

  /**
   * Растёт при каждом reset(). doRefresh запоминает значение до
   * await, после - сравнивает. Если reset() был во время refresh,
   * результат не записывается в lastSuccessfulRefreshAt: сброс
   * обнуляет cooldown, следующий 401 запускает refresh.
   */
  private resetCount = 0;

  /**
   * Signals, переданные в provider.refresh. Нужны, чтобы отличить
   * 401 внутри refresh от обычного 401: такой запрос инициирован
   * самим refresh и не должен снова запускать refresh.
   */
  private readonly refreshSignals = new WeakSet<AbortSignal>();

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
   * Сбрасывает предохранитель, cooldown и забывает текущий refresh.
   * Вызывается через resetRefreshCircuit, когда приложение знает,
   * что проблема устранена.
   *
   * Забыть нужно до закрытия предохранителя: иначе следующий 401
   * присоединится к прежнему промису, и сброс не даст эффекта.
   */
  reset(): void {
    this.resetCount++;
    this.lastSuccessfulRefreshAt = 0;
    this.singleFlight.forget();
    this.circuit.close();
  }

  /**
   * true, если signal создан внутри текущего doRefresh. Запрос
   * с таким signal инициирован провайдером, а не приложением.
   */
  isRefreshSignal(signal: AbortSignal | undefined): boolean {
    return signal !== undefined && this.refreshSignals.has(signal);
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
    const resetCountAtStart = this.resetCount;

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

      unrefTimer(timer);
    });

    timeoutPromise.catch(() => {});

    let result: RefreshResult;

    try {
      this.refreshSignals.add(controller.signal);
      const providerPromise = provider.refresh(controller.signal);

      // После таймаута race уже разрешён, а провайдер может
      // отклониться позже. Без catch это unhandledRejection.
      providerPromise.catch(() => {});

      result = await Promise.race([providerPromise, timeoutPromise]);
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

      // Сетевой сбой или 5xx от auth-сервера - открываем
      // предохранитель. Остальные ошибки (unknown, parse) скорее
      // всего баг в реализации refresh, а не сбой сервера. Ложное
      // открытие замаскировало бы реальную причину под
      // REFRESH_CIRCUIT_OPEN на circuitBreakerMs миллисекунд.
      if (err.kind === 'network' || err.isServerError) {
        this.circuit.open(circuitBreakerMs);
      }

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
      // Если во время refresh был вызван reset(), не записываем
      // lastSuccessfulRefreshAt: сброс означает, что cooldown
      // не должен применяться к следующему 401.
      if (this.resetCount === resetCountAtStart) {
        this.lastSuccessfulRefreshAt = Date.now();
      }
    }

    return result;
  }
}
