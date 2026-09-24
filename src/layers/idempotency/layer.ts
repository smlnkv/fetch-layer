import { type ApiError, toApiError } from '../../core/errors';
import { isMutatingMethod } from '../../shared/method';
import { getHeader, mergeHeaders, setHeader } from '../../transport/headers';

import type { IdempotencyContext, IdempotencyOutcome, IdempotencySource } from './types';
import type { Layer, LayerWrapResult } from '../../core/layer';
import type { RequestConfig, RequestFn } from '../../core/types';

export interface IdempotencyOptions {
  /**
   * Имя заголовка. По умолчанию Idempotency-Key. Некоторые серверы
   * используют другое имя, например X-Idempotency-Key.
   *
   * Если меняется имя, то необходимо указать его же в withRetry
   * (опция idempotencyHeaderName): иначе предупреждение о
   * небезопасном повторе не распознает заголовок.
   */
  headerName?: string;
}

/**
 * Слой идемпотентности.
 *
 * Для изменяющих методов (POST, PUT, PATCH, DELETE) добавляет
 * заголовок идемпотентности со значением от источника. Если
 * приложение установило заголовок само, слой не вмешивается.
 * После завершения операции сообщает источнику исход.
 *
 * Стоит снаружи retry-слоя: ключ генерируется один раз на всю
 * операцию, включая повторы, и resolve вызывается один раз.
 */
export function withIdempotency(
  source: IdempotencySource,
  options: IdempotencyOptions = {},
): Layer {
  const { headerName = 'Idempotency-Key' } = options;

  return {
    name: 'withIdempotency',
    stage: 3,

    wrap(next: RequestFn): LayerWrapResult {
      const fn: RequestFn = async function idempotencyRequest<T>(
        config: RequestConfig,
      ): Promise<T> {
        const method = config.method ?? 'GET';

        if (!isMutatingMethod(method) || config.skipIdempotency) {
          return next<T>(config);
        }

        // Пустая строка и whitespace-only считаются "не установлено".
        const existingKey = getHeader(config.headers, headerName);
        if (existingKey !== undefined && existingKey.trim() !== '') {
          return next<T>(config);
        }

        const context: IdempotencyContext = {
          path: config.path,
          method,
          body: config.body,
          query: config.query,
          scope: config.idempotencyScope,
        };

        // Ошибка хранилища: без сохранённого ключа запрос отправлять
        // нельзя, иначе повтор создаст дубликат.
        let key: string;
        try {
          key = source.nextKey(context);
        } catch (e) {
          throw toApiError(e);
        }

        // mergeHeaders нормализует Headers и массив пар к объекту.
        // Spread для Headers дал бы {}.
        const enrichedHeaders = mergeHeaders(config.headers);
        setHeader(enrichedHeaders, headerName, key);

        const enriched: RequestConfig = {
          ...config,
          headers: enrichedHeaders,
        };

        try {
          const result = await next<T>(enriched);
          safeResolve(source, context, 'success');
          return result;
        } catch (e) {
          const err = toApiError(e);
          safeResolve(source, context, classifyOutcome(err));
          throw err;
        }
      };

      return { fn };
    },
  };
}

/**
 * 4xx кроме 408 и 429: сервер явно отверг операцию, повтор
 * не поможет. Всё остальное: состояние операции неизвестно.
 */
function classifyOutcome(error: ApiError): IdempotencyOutcome {
  if (error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429) {
    return 'definite-failure';
  }
  return 'indefinite-failure';
}

/**
 * Падение resolve не подменяет результат операции: успешный запрос
 * важнее очистки хранилища.
 */
function safeResolve(
  source: IdempotencySource,
  context: IdempotencyContext,
  outcome: IdempotencyOutcome,
): void {
  if (!source.resolve) return;
  try {
    source.resolve(context, outcome);
  } catch {
    // Ошибка очистки не влияет на результат запроса.
  }
}
