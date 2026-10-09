import { parseFlatErrorBody } from '../core/error-body';
import { ApiError, classifyFetchError, toApiError } from '../core/errors';
import { isStreamingBody } from '../shared/classify-body';
import { setAbortTimeout, throwIfAborted } from '../shared/signals';

import { parseResponse, prepareBody, readBodyAsJsonOrText } from './body';
import { getHeader, mergeHeaders, setHeader } from './headers';
import { parseRetryAfterMs } from './retry-after';
import { buildUrl } from './url';

import type { ErrorBodyParser } from '../core/error-body';
import type {
  QueryArrayFormat,
  QueryObjectFormat,
  RequestFn,
  ResolvedRequestConfig,
  ResponseMeta,
  ResponseType,
} from '../core/types';

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Подмножество полей ClientOptions для базового транспорта.
 * createClient передаёт сюда опции без слоёв и warn.
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

  /**
   * Заголовки для всех запросов. Сливаются с per-request headers
   * в самом низу pipeline: per-request и сгенерированные слоями
   * заголовки переопределяют defaultHeaders.
   */
  defaultHeaders?: HeadersInit;

  /** Формат массивов в query-параметрах. */
  queryArrayFormat?: QueryArrayFormat;

  /** Формат объектов в query-параметрах. */
  queryObjectFormat?: QueryObjectFormat;

  /**
   * Кастомный парсер тела ошибки. По умолчанию используется
   * плоский формат: { code, message, fields, requestId } или
   * plain-text строка как message.
   *
   * Для встроенных форматов (content, error, rfc7807) подключите
   * их из fetch-layer/error-body:
   *
   * ```ts
   * import { errorBodyParsers } from 'fetch-layer/error-body';
   *
   * const client = createClient({
   *   baseUrl: '/api',
   *   parseErrorBody: errorBodyParsers.rfc7807,
   * });
   * ```
   */
  parseErrorBody?: ErrorBodyParser;
}

/**
 * Создаёт базовую функцию запроса: fetch, разбор ответа,
 * нормализация ошибок. Принимает ResolvedRequestConfig: заголовки
 * уже нормализованы в Record.
 */
export function createBaseRequest(options: TransportOptions): RequestFn {
  const {
    baseUrl,
    timeoutMs: defaultTimeoutMs = DEFAULT_TIMEOUT_MS,
    fetch: fetchImpl = globalThis.fetch,
    credentials: defaultCredentials,
    defaultHeaders,
    queryArrayFormat: defaultArrayFormat = 'repeat',
    queryObjectFormat: defaultObjectFormat = 'brackets',
  } = options;

  const errorParser = options.parseErrorBody ?? parseFlatErrorBody;

  return async function baseRequest<T>(config: ResolvedRequestConfig): Promise<T> {
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

    // Порядок слияния: Accept -> defaultHeaders -> config.headers.
    // Сгенерированные слоями заголовки (Idempotency-Key, Authorization)
    // переопределяют defaultHeaders, поэтому случайный Idempotency-Key
    // в defaultHeaders не сломает дедупликацию.
    const headers = mergeHeaders({ Accept: defaultAccept }, defaultHeaders, config.headers);

    // prepareBody вне try: ошибка сериализации тела выбрасывается
    // до формирования финальных заголовков.
    const { body, contentType } = prepareBody(config.body);
    if (contentType !== undefined && getHeader(headers, 'Content-Type') === undefined) {
      setHeader(headers, 'Content-Type', contentType);
    }

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
        if (includeMeta) {
          return { data: undefined, meta } as unknown as T;
        }
        return undefined as T;
      }

      const data = await parseResponse(response, responseType);

      if (includeMeta) {
        return { data, meta } as unknown as T;
      }

      return data as T;
    } catch (e) {
      // Всё, что не ApiError, нормализуется здесь. Внутри try
      // уже выбрасываются ApiError (http, parse, network, timeout,
      // abort), поэтому toApiError идемпотентен.
      throw toApiError(e);
    } finally {
      timeout.clear();
    }
  };
}
