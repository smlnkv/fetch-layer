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
 * ClientOptions fields for the base transport. createClient passes
 * options here without layers and warn.
 *
 * @internal
 */
export interface TransportOptions {
  /** Base address. */
  baseUrl: string;

  /** Request timeout in milliseconds. Defaults to 10000. */
  timeoutMs?: number;

  /** fetch function. Defaults to the global one. */
  fetch?: typeof fetch;

  /** Cookie mode. */
  credentials?: RequestCredentials;

  /**
   * Headers for all requests. Merged with per-request headers at the
   * bottom of the pipeline; per-request headers and headers from
   * layers override defaultHeaders.
   */
  defaultHeaders?: HeadersInit;

  /** Query array format. */
  queryArrayFormat?: QueryArrayFormat;

  /** Query object format. */
  queryObjectFormat?: QueryObjectFormat;

  /**
   * Custom error body parser. Defaults to flat shape:
   * { code, message, fields } or a plain-text string as message.
   */
  parseErrorBody?: ErrorBodyParser;
}

/**
 * Accept header value for a response type. json and text get their
 * MIME types, everything else falls back to * / *.
 */
function acceptFor(responseType: ResponseType): string {
  if (responseType === 'json') return 'application/json';
  if (responseType === 'text') return 'text/plain';
  return '*/*';
}

/**
 * Base request function: fetch, response parsing, error
 * normalization. Takes ResolvedRequestConfig with headers in Record.
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

    // Timer starts before try: buildUrl and prepareBody are inside
    // try too, and finally must see timeout in any branch.
    const effectiveTimeoutMs = config.timeoutMs ?? defaultTimeoutMs;
    const timeout = setAbortTimeout(effectiveTimeoutMs);

    // AbortSignal.any preserves the reason: timeout stays TimeoutError,
    // not AbortError. Listeners are garbage collected, no cleanup needed.
    const signal = config.signal
      ? AbortSignal.any([config.signal, timeout.signal])
      : timeout.signal;

    try {
      const url = buildUrl(
        baseUrl,
        config.path,
        config.query,
        config.queryArrayFormat ?? defaultArrayFormat,
        config.queryObjectFormat ?? defaultObjectFormat,
      );

      // HEAD and OPTIONS have no body, cannot parse as JSON.
      const defaultResponseType: ResponseType =
        method === 'HEAD' || method === 'OPTIONS' ? 'text' : 'json';
      const responseType: ResponseType = config.responseType ?? defaultResponseType;

      const includeMeta = config.includeResponseMeta === true;

      const defaultAccept = acceptFor(responseType);

      // Order: Accept -> defaultHeaders -> config.headers. Headers
      // from layers (Idempotency-Key, Authorization) override
      // defaultHeaders, so a stray Idempotency-Key in defaultHeaders
      // does not break deduplication.
      const headers = mergeHeaders({ Accept: defaultAccept }, defaultHeaders, config.headers);

      const { body, contentType } = prepareBody(config.body);
      if (contentType !== undefined && getHeader(headers, 'Content-Type') === undefined) {
        setHeader(headers, 'Content-Type', contentType);
      }

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

      // Streaming body requires duplex: 'half', without it fetch
      // throws TypeError.
      if (isStreamingBody(body)) {
        (init as RequestInit & { duplex: 'half' }).duplex = 'half';
      }

      // TypeError around fetch means network error. Only here:
      // elsewhere the source is unknown.
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

      // 204 and 304 have no body. Checked before response.ok: 304
      // is not in the ok range.
      if (response.status === 204 || response.status === 304) {
        if (includeMeta) {
          return { data: undefined, meta } as unknown as T;
        }
        return undefined as T;
      }

      if (!response.ok) {
        const rawBody = await readBodyAsJsonOrText(response, signal);
        const parsed = errorParser(rawBody);
        throw new ApiError({
          kind: 'http',
          status: response.status,
          code: parsed.code ?? `HTTP_${response.status}`,
          message: parsed.message ?? `HTTP ${response.status}`,
          fields: parsed.fields,
          requestId: meta.requestId,
          retryAfterMs: meta.retryAfterMs,
          rawBody,
          details: parsed.details,
          isUncertain: response.status >= 500,
        });
      }

      // HEAD and OPTIONS return only metadata: body is discarded
      // even if server sent one.
      if (!response.body || method === 'HEAD' || method === 'OPTIONS') {
        if (includeMeta) {
          return { data: undefined, meta } as unknown as T;
        }
        return undefined as T;
      }

      const data = await parseResponse(response, responseType, signal);

      if (includeMeta) {
        return { data, meta } as unknown as T;
      }

      return data as T;
    } catch (e) {
      // ApiError (http, parse, network, timeout, abort) is thrown
      // inside try, so toApiError is idempotent.
      throw toApiError(e);
    } finally {
      timeout.clear();
    }
  };
}
