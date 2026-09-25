import { buildErrorParser } from '../core/error-body';
import { ApiError, classifyFetchError, toApiError } from '../core/errors';
import { runOnBeforeSend, runOnResponse } from '../core/hooks';
import { setAbortTimeout, throwIfAborted } from '../shared/signals';

import { isStreamingBody, parseResponse, prepareBody, readBodyAsJsonOrText } from './body';
import { getHeader, mergeHeaders, setHeader } from './headers';
import { parseRetryAfterMs } from './retry-after';
import { buildUrl } from './url';

import type { ErrorBodyFormat, ErrorBodyParser } from '../core/error-body';
import type {
  Hooks,
  QueryArrayFormat,
  QueryObjectFormat,
  RequestConfig,
  RequestFn,
  ResponseMeta,
  ResponseType,
} from '../core/types';

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Подмножество полей ClientOptions для базового транспорта.
 * createClient передаёт сюда опции без слоёв и логгера.
 *
 * @internal
 */
export interface TransportOptions {
  /** Базовый адрес сервера. */
  baseUrl: string;

  /** Таймаут запроса в миллисекундах. По умолчанию 10000. */
  timeoutMs?: number;

  /** Функция fetch. По умолчанию глобальная. */
  fetch?: typeof fetch;

  /** Режим отправки cookies. */
  credentials?: RequestCredentials;

  /** Формат массивов в query-параметрах. */
  queryArrayFormat?: QueryArrayFormat;

  /** Формат объектов в query-параметрах. */
  queryObjectFormat?: QueryObjectFormat;

  /** Встроенный формат тела ошибки. */
  errorBodyFormat?: ErrorBodyFormat;

  /** Кастомный парсер тела ошибки. Приоритет над errorBodyFormat. */
  parseErrorBody?: ErrorBodyParser;

  /**
   * Колбэки жизненного цикла. Транспорт вызывает onBeforeSend
   * и onResponse, остальные - createClient и слои.
   */
  hooks?: Hooks;
}

/**
 * Создаёт базовую функцию запроса: fetch, разбор ответа,
 * нормализация ошибок.
 */
export function createBaseRequest(options: TransportOptions): RequestFn {
  const {
    baseUrl,
    timeoutMs: defaultTimeoutMs = DEFAULT_TIMEOUT_MS,
    fetch: fetchImpl = globalThis.fetch,
    credentials: defaultCredentials,
    queryArrayFormat: defaultArrayFormat = 'repeat',
    queryObjectFormat: defaultObjectFormat = 'brackets',
    hooks,
  } = options;

  const errorParser = buildErrorParser({
    parseErrorBody: options.parseErrorBody,
    errorBodyFormat: options.errorBodyFormat,
  });

  return async function baseRequest<T>(config: RequestConfig): Promise<T> {
    throwIfAborted(config.signal);

    const method = config.method ?? 'GET';
    const url = buildUrl(
      baseUrl,
      config.path,
      config.query,
      config.queryArrayFormat ?? defaultArrayFormat,
      config.queryObjectFormat ?? defaultObjectFormat,
    );

    // У HEAD и OPTIONS тела нет, парсить как JSON нельзя.
    const defaultResponseType: ResponseType =
      method === 'HEAD' || method === 'OPTIONS' ? 'text' : 'json';
    const responseType: ResponseType = config.responseType ?? defaultResponseType;

    const includeMeta = config.includeResponseMeta === true;

    const defaultAccept =
      responseType === 'json' ? 'application/json' : responseType === 'text' ? 'text/plain' : '*/*';

    const headers = mergeHeaders({ Accept: defaultAccept }, config.headers);

    const { body, contentType } = prepareBody(config.body);
    if (contentType !== undefined && getHeader(headers, 'Content-Type') === undefined) {
      setHeader(headers, 'Content-Type', contentType);
    }

    // Заголовки здесь финальные: с Accept и Content-Type. Тот же
    // объект видят onBeforeSend и onResponse, он же прикрепляется
    // к ApiError, возникшей при отправке.
    const finalConfig: RequestConfig = { ...config, headers };

    const effectiveTimeoutMs = config.timeoutMs ?? defaultTimeoutMs;
    const timeout = setAbortTimeout(effectiveTimeoutMs);

    // AbortSignal.any сохраняет причину сработавшего сигнала:
    // таймаут остаётся TimeoutError, а не становится AbortError.
    // cleanup не нужен: слушатели собираются сборщиком мусора.
    const signal = config.signal
      ? AbortSignal.any([config.signal, timeout.signal])
      : timeout.signal;

    try {
      const init: RequestInit = {
        ...config.fetchOptions,
        method,
        headers,
        body,
        signal,
      };

      const effectiveCredentials = config.credentials ?? defaultCredentials;
      if (effectiveCredentials !== undefined) {
        init.credentials = effectiveCredentials;
      }

      // Потоковое тело (Web ReadableStream или Node.js stream.Readable)
      // требует duplex: 'half'. Без него fetch выбрасывает TypeError.
      if (isStreamingBody(body)) {
        (init as RequestInit & { duplex: 'half' }).duplex = 'half';
      }

      runOnBeforeSend(hooks, finalConfig);

      // TypeError вокруг fetch означает сетевую ошибку. Только
      // здесь: в остальных местах источник TypeError неизвестен.
      let response: Response;
      try {
        response = await fetchImpl(url, init);
      } catch (e) {
        throw classifyFetchError(e);
      }

      const meta: ResponseMeta = {
        status: response.status,
        headers: response.headers,
        requestId: response.headers.get('X-Request-Id') ?? undefined,
        retryAfterMs: parseRetryAfterMs(response.headers.get('Retry-After')),
      };

      // 204 и 304 - тела нет. Проверяем до response.ok так как
      // 304 не входит в диапазон ok.
      if (response.status === 204 || response.status === 304) {
        runOnResponse(hooks, finalConfig, meta);
        if (includeMeta) {
          return { data: undefined, meta } as unknown as T;
        }
        return undefined as T;
      }

      if (!response.ok) {
        const rawBody = await readBodyAsJsonOrText(response);
        const parsed = errorParser(rawBody);
        throw new ApiError({
          kind: 'http',
          status: response.status,
          code: parsed.code ?? `HTTP_${response.status}`,
          message: parsed.message ?? `HTTP ${response.status}`,
          fields: parsed.fields,
          requestId: parsed.requestId ?? meta.requestId,
          retryAfterMs: meta.retryAfterMs,
          rawBody,
          details: parsed.details,
          isUncertain: response.status >= 500,
        });
      }

      // Тело может отсутствовать и при 2xx: HEAD с 200, DELETE без тела.
      if (!response.body) {
        runOnResponse(hooks, finalConfig, meta);
        if (includeMeta) {
          return { data: undefined, meta } as unknown as T;
        }
        return undefined as T;
      }

      const data = await parseResponse(response, responseType);

      runOnResponse(hooks, finalConfig, meta);

      if (includeMeta) {
        return { data, meta } as unknown as T;
      }

      return data as T;
    } catch (e) {
      // finalConfig прикрепляется ко всем ошибкам внутри блока:
      // onError в client.ts увидит тот же конфиг, что и onBeforeSend.
      const err = toApiError(e);
      err.config = finalConfig;
      throw err;
    } finally {
      timeout.clear();
    }
  };
}
