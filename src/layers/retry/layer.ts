import { type ApiError, toApiError } from '../../core/errors';
import { runOnRetry } from '../../core/hooks';
import { isMutatingMethod } from '../../shared/method';
import { safeCall } from '../../shared/safe-call';
import { sleep as defaultSleep, throwIfAborted } from '../../shared/signals';
import { isStreamingBody } from '../../shared/streams';
import {
  assertInteger,
  assertNonNegativeNumber,
  clampDelay,
  MIN_RETRY_MS,
} from '../../shared/validators';
import { getHeader } from '../../transport/headers';

import type { Layer, LayerContext, LayerWrapResult } from '../../core/layer';
import type { RequestConfig, RequestFn } from '../../core/types';

export interface RetryOptions {
  /**
   * Максимальное количество попыток, включая первую. По умолчанию 3,
   * минимум 1.
   */
  maxAttempts?: number;

  /**
   * Начальная задержка в миллисекундах. По умолчанию 300. Значения
   * ниже MIN_RETRY_MS поднимаются до минимума.
   */
  baseDelayMs?: number;

  /**
   * Верхняя граница задержки. По умолчанию 10000. Ограничивает
   * вычисленную задержку backoff и служит порогом для Retry-After:
   * если сервер запросил больше, повтор не выполняется.
   */
  maxDelayMs?: number;

  /**
   * Разброс вокруг вычисленной задержки, по умолчанию 0.15 (+-15%).
   * 0 отключает разброс. Не применяется к Retry-After.
   */
  jitterRatio?: number;

  /**
   * Предупреждать о повторе мутирующего запроса без заголовка
   * идемпотентности. По умолчанию true.
   *
   * Предупреждение не выводится, если приложение задало заголовок
   * само или передало skipIdempotency: true. Выводится один раз
   * на метод и корневой сегмент пути: для DELETE /sessions/123
   * корневой сегмент - sessions.
   */
  warnOnUnsafeRetry?: boolean;

  /**
   * Имя заголовка идемпотентности для проверки в предупреждении.
   * Укажите то же значение, что и в withIdempotency, если используете
   * кастомное. По умолчанию Idempotency-Key.
   */
  idempotencyHeaderName?: string;

  /**
   * Повторять ли сетевые ошибки (kind network). По умолчанию true.
   */
  retryOnNetwork?: boolean;

  /**
   * Повторять ли таймауты (kind timeout). По умолчанию true.
   * Таймаут означает, что ответа от сервера не было; повтор уместен,
   * если операция идемпотентна. Для небезопасных методов
   * (POST) повтор без Idempotency-Key может создать дубликат.
   */
  retryOnTimeout?: boolean;

  /**
   * Политика повтора. По умолчанию error.isRetryable с учётом
   * retryOnNetwork и retryOnTimeout. Ошибки авторизации и отмены
   * не повторяются, даже если функция вернёт true.
   *
   * Падение колбэка не подменяет исходную ошибку: применяется
   * та же политика, что и без колбэка.
   *
   * @param attempt - номер провалившейся попытки, считая с 1.
   */
  shouldRetry?: (error: ApiError, attempt: number) => boolean;

  /**
   * Вычисляет задержку перед повтором. Не применяется, если сервер
   * прислал Retry-After. Результат ограничивается диапазоном
   * [MIN_RETRY_MS, maxDelayMs].
   *
   * Падение колбэка не подменяет исходную ошибку: применяется
   * та же задержка, что и без колбэка.
   *
   * @param attempt - номер провалившейся попытки, считая с 1.
   */
  computeDelay?: (attempt: number, error: ApiError) => number;

  /** Пауза между попытками. По умолчанию setTimeout с отменой. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/**
 * Первый сегмент пути: для "/orders/123" это "orders". Служит
 * ключом дедупликации предупреждения: динамические id внутри
 * одного ресурса схлопываются, разные ресурсы дают разные ключи.
 */
function rootSegment(path: string): string {
  const trimmed = path.replace(/^\/+/, '');
  const slash = trimmed.indexOf('/');
  return slash === -1 ? trimmed : trimmed.slice(0, slash);
}

/**
 * Слой автоматических повторов.
 *
 * Повторяет при временных сбоях: сетевые ошибки, таймауты, 5xx,
 * 408 и 429. Не повторяет отмену, ошибки авторизации и остальные
 * 4xx: сервер явно отверг операцию.
 *
 * Задержки по умолчанию экспоненциальные с разбросом +-15%
 * (300, 600, 1200 мс). Верхняя граница - maxDelayMs.
 *
 * Retry-After из ответа используется вместо экспоненциальной
 * задержки. Если значение больше maxDelayMs, повтор не выполняется:
 * сервер просит подождать дольше, чем приложение готово ждать.
 *
 * Для потоковых тел (Web ReadableStream, Node.js stream.Readable)
 * повторы отключены: поток одноразовый, повторный fetch бросит
 * TypeError, который транспорт классифицирует как сетевую ошибку.
 *
 * @throws Error если параметры конфигурации некорректны.
 */
export function withRetry(options: RetryOptions = {}): Layer {
  const {
    maxAttempts = 3,
    baseDelayMs: rawBaseDelayMs = 300,
    maxDelayMs: rawMaxDelayMs = 10_000,
    jitterRatio = 0.15,
    warnOnUnsafeRetry = true,
    idempotencyHeaderName = 'Idempotency-Key',
    retryOnNetwork = true,
    retryOnTimeout = true,
    computeDelay,
    sleep = defaultSleep,
  } = options;

  assertInteger(maxAttempts, 'withRetry: maxAttempts', 1);
  assertNonNegativeNumber(rawBaseDelayMs, 'withRetry: baseDelayMs');
  assertNonNegativeNumber(rawMaxDelayMs, 'withRetry: maxDelayMs');
  assertNonNegativeNumber(jitterRatio, 'withRetry: jitterRatio');

  const baseDelayMs = clampDelay(rawBaseDelayMs, MIN_RETRY_MS);
  const maxDelayMs = Math.max(baseDelayMs, rawMaxDelayMs);

  /**
   * По умолчанию повторяем всё, что isRetryable, но network и timeout
   * фильтруются отдельными опциями. Это позволяет приложению
   * отключить повтор таймаутов, сохранив повторы сети.
   */
  const defaultShouldRetry = (err: ApiError): boolean => {
    if (!err.isRetryable) return false;
    if (err.kind === 'network' && !retryOnNetwork) return false;
    if (err.kind === 'timeout' && !retryOnTimeout) return false;
    return true;
  };

  /**
   * Начинается с 1: первый повтор даёт базовую задержку, второй -
   * удвоенную.
   */
  const defaultCompute = (attempt: number): number => {
    const jitter = 1 - jitterRatio + Math.random() * jitterRatio * 2;
    return baseDelayMs * 2 ** (attempt - 1) * jitter;
  };

  return {
    name: 'withRetry',
    stage: 2,

    wrap(next: RequestFn, context: LayerContext): LayerWrapResult {
      // Set живёт внутри wrap: каждый createClient получает свой
      // экземпляр, даже если один Layer передан в несколько клиентов.
      const warnedUnsafeRetry = new Set<string>();
      const logger = context.logger;

      const warnUnsafeRetryOnce = (key: string, message: string): void => {
        if (warnedUnsafeRetry.has(key)) return;
        warnedUnsafeRetry.add(key);
        safeCall(() => logger?.warn?.(message));
      };

      let warnedStreamNoRetry = false;

      const fn: RequestFn = async function retryRequest<T>(
        initialConfig: RequestConfig,
      ): Promise<T> {
        if (initialConfig.skipRetry) {
          return next<T>(initialConfig);
        }

        // Стрим одноразовый: fetch забирает его при первой отправке,
        // повторная выбрасывает TypeError. Транспорт классифицирует
        // его как network error, что маскирует настоящую причину.
        if (isStreamingBody(initialConfig.body)) {
          if (!warnedStreamNoRetry) {
            warnedStreamNoRetry = true;
            safeCall(() =>
              logger?.warn?.(
                '[fetch-layer] withRetry is enabled, but the request body is a stream. ' +
                  'Streams are single-use; retries are disabled for this request. ' +
                  'Use skipRetry: true to silence this warning, or pre-buffer the stream.',
              ),
            );
          }
          return next<T>(initialConfig);
        }

        const method = initialConfig.method ?? 'GET';
        const hasIdempotencyKey =
          getHeader(initialConfig.headers, idempotencyHeaderName) !== undefined;

        // Проверяем до первой попытки: предупреждение относится
        // к конфигурации, а не к факту повтора.
        if (
          warnOnUnsafeRetry &&
          isMutatingMethod(method) &&
          !hasIdempotencyKey &&
          !initialConfig.skipIdempotency
        ) {
          warnUnsafeRetryOnce(
            `retry-unsafe:${method}:${rootSegment(initialConfig.path)}`,
            `[fetch-layer] Retry is enabled for ${method} ${initialConfig.path} ` +
              `without the ${idempotencyHeaderName} header. On a network failure ` +
              `the retry may create a duplicate. Add the header or disable retry ` +
              `with skipRetry.`,
          );
        }

        let config = initialConfig;

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
          throwIfAborted(config.signal);

          try {
            return await next<T>(config);
          } catch (e) {
            const err = toApiError(e);

            if (err.isCancelled) throw err;
            if (err.isAuthError) throw err;
            if (attempt === maxAttempts - 1) throw err;

            const failedAttempt = attempt + 1;

            const retryDecision =
              safeCall(() =>
                options.shouldRetry
                  ? options.shouldRetry(err, failedAttempt)
                  : defaultShouldRetry(err),
              ) ?? defaultShouldRetry(err);

            if (!retryDecision) throw err;

            // Retry-After имеет приоритет: если сервер запросил
            // больше maxDelayMs, повтор не выполняем.
            let delay: number;
            if (err.retryAfterMs !== undefined) {
              if (err.retryAfterMs > maxDelayMs) throw err;
              delay = clampDelay(err.retryAfterMs, MIN_RETRY_MS);
            } else {
              const computed =
                safeCall(() =>
                  computeDelay ? computeDelay(failedAttempt, err) : defaultCompute(failedAttempt),
                ) ?? defaultCompute(failedAttempt);

              delay = Math.min(clampDelay(computed, MIN_RETRY_MS), maxDelayMs);
            }

            config = runOnRetry(context.hooks, config, failedAttempt, err);

            // onRetry вернул конфиг со skipRetry: следующей попытки
            // не будет. Проверяем до sleep, чтобы не ждать зря.
            if (config.skipRetry) throw err;

            await sleep(delay, config.signal);
          }
        }

        throw new Error('withRetry: unexpected exit from retry loop');
      };

      return { fn };
    },
  };
}
