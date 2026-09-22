import { ApiError, isNamedError, toApiError } from '../../core/errors';
import { safeCall } from '../../shared/safe-call';
import { throwIfAborted } from '../../shared/signals';
import { assertPositiveNumber } from '../../shared/validators';
import { mergeHeaders } from '../../transport/headers';

import { RefreshManager } from './refresh-manager';
import { attachReset } from './reset-registry';

import type { SessionExpiredReason, SessionProvider } from './types';
import type { Layer, LayerContext, LayerWrapResult } from '../../core/layer';
import type { RequestConfig, RequestFn } from '../../core/types';

const DEFAULT_CIRCUIT_BREAKER_MS = 5000;
const DEFAULT_REFRESH_TIMEOUT_MS = 30_000;

export interface AuthOptions {
  /** Провайдер сессии. Обязателен. */
  provider: SessionProvider;

  /**
   * Вызывается при окончательном истечении сессии. Приложение само
   * решает, что делать: показать модалку, сделать редирект, ничего.
   *
   * Исключения игнорируются: падение колбэка не подменяет исходную
   * ошибку 401.
   */
  onSessionExpired?: (reason: SessionExpiredReason) => void;

  /**
   * Длительность блокировки после временного сбоя обновления,
   * в миллисекундах. По умолчанию 5000. Должна быть положительной.
   *
   * Используется в двух механизмах RefreshManager:
   * - предохранитель: блокирует новые refresh после временного сбоя;
   * - cooldown: блокирует повторный refresh сразу после успешного
   *   обновления (защита от амплификации в pipeline
   *   idempotency -> retry -> auth).
   */
  circuitBreakerMs?: number;

  /**
   * Таймаут одной попытки refresh, в миллисекундах. По умолчанию
   * 30000. Провайдер получает AbortSignal и может передать его
   * в свой fetch.
   *
   * Если провайдер игнорирует signal, таймаут не сработает: fetch
   * внутри провайдера продолжит выполняться. В этом случае
   * ограничьте refresh на стороне SessionProvider.refresh.
   */
  refreshTimeoutMs?: number;

  /**
   * Вызывается, когда предохранитель обновления токена открывается.
   * Предохранитель открывается после временного сбоя refresh и
   * блокирует новые попытки на circuitBreakerMs миллисекунд.
   */
  onCircuitOpen?: () => void;

  /**
   * Вызывается, когда предохранитель закрывается. Закрывается либо
   * по истечении circuitBreakerMs, либо вручную через
   * resetRefreshCircuit(client).
   */
  onCircuitClose?: () => void;
}

/**
 * Слой авторизации.
 *
 * Перед каждым запросом добавляет заголовки от provider. При 401
 * запускает обновление токена и повторяет исходный запрос один раз.
 * При временном сбое refresh пробрасывает ошибку, не разлогинивая
 * пользователя. При окончательном провале вызывает onSessionExpired.
 *
 * Refresh запускается только при 401: 403 не инициирует обновление,
 * токен валиден, у пользователя просто нет доступа к ресурсу.
 *
 * Если успешный refresh был меньше circuitBreakerMs назад, а запрос
 * снова получил 401, слой повторяет запрос с текущими заголовками
 * без нового refresh.
 *
 * Layer - шаблон: если один и тот же объект передан в два createClient,
 * каждый получит свой независимый RefreshManager. Менеджер создаётся
 * внутри wrap и передаётся в attach через state.
 */
export function withAuth(options: AuthOptions): Layer {
  const {
    provider,
    onSessionExpired,
    circuitBreakerMs = DEFAULT_CIRCUIT_BREAKER_MS,
    refreshTimeoutMs = DEFAULT_REFRESH_TIMEOUT_MS,
  } = options;

  assertPositiveNumber(circuitBreakerMs, 'withAuth: circuitBreakerMs');
  assertPositiveNumber(refreshTimeoutMs, 'withAuth: refreshTimeoutMs');

  return {
    name: 'withAuth',
    stage: 1,

    wrap(next: RequestFn, context: LayerContext): LayerWrapResult {
      const manager = new RefreshManager(
        {
          onCircuitOpen: () => {
            safeCall(() => options.onCircuitOpen?.());
            safeCall(() => context.logger?.info?.('[fetch-layer] refresh circuit opened'));
          },
          onCircuitClose: () => {
            safeCall(() => options.onCircuitClose?.());
            safeCall(() => context.logger?.info?.('[fetch-layer] refresh circuit closed'));
          },
        },
        refreshTimeoutMs,
      );

      const fn: RequestFn = async function authRequest<T>(config: RequestConfig): Promise<T> {
        if (config.skipAuth) {
          return next<T>(config);
        }

        throwIfAborted(config.signal);

        const authHeaders = await safeGetAuthHeaders(provider);
        const withAuthConfig: RequestConfig = {
          ...config,
          headers: mergeHeaders(config.headers, authHeaders),
        };

        try {
          return await next<T>(withAuthConfig);
        } catch (e) {
          const err = toApiError(e);

          if (err.status !== 401) throw err;

          throwIfAborted(config.signal);

          const outcome = await manager.refresh(provider, circuitBreakerMs);

          if (outcome.status === 'temporarily-failed') {
            // toApiError идемпотентен: RefreshManager уже нормализовал
            // ошибку, повторный вызов вернёт тот же ApiError.
            throw toApiError(outcome.error);
          }

          if (outcome.status === 'definitely-failed') {
            safeClear(provider);
            safeCall(() => onSessionExpired?.(outcome.reason));
            throw err;
          }

          // cooldown: успешный refresh был меньше circuitBreakerMs
          // назад. Повторяем с текущими заголовками без вызова
          // refresh и без onSessionExpired.
          if (outcome.status === 'cooldown') {
            throwIfAborted(config.signal);
            const currentHeaders = await safeGetAuthHeaders(provider);
            return next<T>({
              ...config,
              headers: mergeHeaders(config.headers, currentHeaders),
            });
          }

          // success: повтор после успешного обновления. Заголовки
          // берём из refresh, если они там есть: это устраняет гонку,
          // когда реализация ещё не успела обновить своё состояние.
          safeCall(() => context.logger?.info?.('[fetch-layer] token refreshed'));

          throwIfAborted(config.signal);

          const newHeaders = outcome.headers ?? (await safeGetAuthHeaders(provider));

          try {
            return await next<T>({
              ...config,
              headers: mergeHeaders(config.headers, newHeaders),
            });
          } catch (retryError) {
            const retryErr = toApiError(retryError);

            // Новый токен тоже отвергнут - сессия мертва.
            if (retryErr.status === 401) {
              safeClear(provider);
              safeCall(() => onSessionExpired?.('token-rejected'));
            }

            throw retryErr;
          }
        }
      };

      return { fn, state: manager };
    },

    attach(client, state): void {
      // state - то, что wrap вернул для этого же клиента.
      // Проверяем тип: unknown не даёт гарантий, даже если мы сами
      // положили туда RefreshManager.
      if (!(state instanceof RefreshManager)) return;
      attachReset(client, () => state.reset());
    },
  };
}

/**
 * Падение getAuthHeaders превращается в ApiError с кодом
 * AUTH_PROVIDER_ERROR. Запрос не отправляется: явная ошибка
 * авторизации лучше, чем запрос без токена и 401 от сервера.
 *
 * AbortError пробрасывается как abort: это осознанная отмена,
 * а не сбой провайдера.
 */
async function safeGetAuthHeaders(provider: SessionProvider): Promise<Record<string, string>> {
  try {
    const headers = await provider.getAuthHeaders();
    if (!headers || typeof headers !== 'object') return {};
    return headers;
  } catch (e) {
    if (isNamedError(e, 'AbortError')) {
      throw new ApiError({
        kind: 'abort',
        code: 'ABORTED',
        message: 'Request aborted',
        cause: e,
      });
    }
    throw new ApiError({
      kind: 'unknown',
      code: 'AUTH_PROVIDER_ERROR',
      message: 'Auth provider failed to return headers',
      cause: e,
    });
  }
}

/**
 * Падение clear не подменяет исходную ошибку 401.
 */
function safeClear(provider: SessionProvider): void {
  try {
    provider.clear?.();
  } catch {
    // Падение clear не подменяет исходную ошибку.
  }
}
