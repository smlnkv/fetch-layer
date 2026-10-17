/**
 * All library errors are normalized to ApiError: the app handles
 * them in one place instead of parsing Response in every catch.
 */

/**
 * Error category. Affects handling strategy.
 *
 * - network: no connection (network, DNS, CORS);
 * - timeout: request did not finish in time, including token refresh;
 * - http: status outside 2xx;
 * - parse: response body could not be parsed;
 * - abort: cancelled via AbortSignal;
 * - serialize: body or fingerprint could not be serialized,
 *   or idempotency key is invalid (IDEMPOTENCY_KEY_INVALID);
 * - storage: idempotency key was not saved;
 * - unknown: everything else, including AUTH_PROVIDER_ERROR,
 *   REFRESH_CIRCUIT_OPEN and INVALID_REQUEST_CONFIG.
 */
export type ApiErrorKind =
  'network' | 'timeout' | 'http' | 'parse' | 'abort' | 'serialize' | 'storage' | 'unknown';

/** Codes that isAuthError and isRetryable treat as auth. */
const AUTH_ERROR_CODES = new Set([
  'AUTH_PROVIDER_ERROR',
  'REFRESH_TIMEOUT',
  'REFRESH_CIRCUIT_OPEN',
]);

/**
 * Single error class for the library.
 *
 * Library codes:
 *
 * - ABORTED, TIMEOUT, NETWORK_ERROR, PARSE_ERROR,
 *   BODY_SERIALIZATION_ERROR - transport;
 * - AUTH_PROVIDER_ERROR, REFRESH_TIMEOUT, REFRESH_CIRCUIT_OPEN - auth;
 * - IDEMPOTENCY_STORAGE_ERROR, IDEMPOTENCY_KEY_INVALID - idempotency;
 * - INVALID_REQUEST_CONFIG - request config failed validation
 *   (empty path, timeoutMs < 100).
 *
 * Other codes come from server response body.
 */
export class ApiError extends Error {
  readonly kind: ApiErrorKind;

  /** HTTP status. 0 if no response (network, timeout, abort). */
  readonly status: number;

  /** Code: server-side or from the list above. */
  readonly code: string;

  /**
   * Form field errors. Key is field name, value is error text.
   * Non-string values are dropped, full original stays in rawBody.
   */
  readonly fields?: Record<string, string>;

  /** X-Request-Id, if server returned one. */
  readonly requestId?: string;

  /** Retry-After in milliseconds, if present. */
  readonly retryAfterMs?: number;

  /** Response body as is. Useful for non-standard formats. */
  readonly rawBody?: unknown;

  /** Details from error parser. undefined for flat shape. */
  readonly details?: unknown;

  /**
   * true if server-side operation state is unknown.
   *
   * - network, timeout: request may not have arrived or response
   *   may be lost;
   * - 5xx: server may have partially applied operation before failing;
   * - parse on 2xx or 5xx: response body is unknown;
   * - 408/429: false, server explicitly did not accept operation;
   * - parse on 4xx: false, server explicitly rejected operation.
   *
   * For safe retry decisions use isRetryable.
   */
  readonly isUncertain: boolean;

  constructor(params: {
    kind: ApiErrorKind;
    message: string;
    status?: number;
    code?: string;
    fields?: Record<string, string>;
    requestId?: string;
    retryAfterMs?: number;
    rawBody?: unknown;
    details?: unknown;
    isUncertain?: boolean;
    cause?: unknown;
  }) {
    super(params.message, { cause: params.cause });
    this.name = 'ApiError';
    this.kind = params.kind;
    this.status = params.status ?? 0;
    this.code = params.code ?? 'UNKNOWN';
    this.fields = params.fields;
    this.requestId = params.requestId;
    this.retryAfterMs = params.retryAfterMs;
    this.rawBody = params.rawBody;
    this.details = params.details;
    this.isUncertain = params.isUncertain ?? false;
  }

  /** true for kind network and timeout. No response from server. */
  get isNetwork(): boolean {
    return this.kind === 'network' || this.kind === 'timeout';
  }

  /** true for kind abort: cancelled by the app via AbortSignal. */
  get isCancelled(): boolean {
    return this.kind === 'abort';
  }

  /**
   * Auth-related: status 401 or 403, or code AUTH_PROVIDER_ERROR,
   * REFRESH_TIMEOUT or REFRESH_CIRCUIT_OPEN.
   */
  get isAuthError(): boolean {
    return AUTH_ERROR_CODES.has(this.code) || this.status === 401 || this.status === 403;
  }

  /**
   * true for network, timeout, 408, 429 and 5xx.
   *
   * false for abort, auth errors (401, 403, AUTH_PROVIDER_ERROR,
   * REFRESH_TIMEOUT, REFRESH_CIRCUIT_OPEN) and other 4xx.
   */
  get isRetryable(): boolean {
    if (this.kind === 'abort') return false;
    if (AUTH_ERROR_CODES.has(this.code)) return false;
    if (this.isNetwork) return true;
    if (this.status === 408) return true;
    if (this.status === 429) return true;
    return this.status >= 500 && this.status < 600;
  }

  /**
   * 4xx. Overlaps with isAuthError: 401 and 403 match both. To
   * separate auth, check isAuthError first.
   */
  get isClientError(): boolean {
    return this.status >= 400 && this.status < 500;
  }

  /** 5xx. Retry after some time may help. */
  get isServerError(): boolean {
    return this.status >= 500 && this.status < 600;
  }

  /** status === 409. */
  get isConflict(): boolean {
    return this.status === 409;
  }
}

/**
 * Normalizes any exception to ApiError. Returns the same object if
 * input is already an ApiError.
 *
 * AbortError, TimeoutError and SyntaxError are detected by name,
 * not via instanceof: an error from another realm (iframe, worker)
 * has a different constructor.
 *
 * TypeError becomes unknown here: source is unknown. classifyFetchError
 * classifies it as a network error.
 */
export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;

  if (isNamedError(error, 'AbortError')) {
    return new ApiError({
      kind: 'abort',
      message: 'Request aborted',
      code: 'ABORTED',
    });
  }

  if (isNamedError(error, 'TimeoutError')) {
    return new ApiError({
      kind: 'timeout',
      message: 'Request timeout',
      code: 'TIMEOUT',
      isUncertain: true,
    });
  }

  if (isNamedError(error, 'SyntaxError')) {
    return new ApiError({
      kind: 'parse',
      message: 'Failed to parse response',
      code: 'PARSE_ERROR',
      isUncertain: false,
      cause: error,
    });
  }

  if (isErrorLike(error)) {
    return new ApiError({
      kind: 'unknown',
      message: error.message,
      cause: error,
    });
  }

  return new ApiError({
    kind: 'unknown',
    message: 'Unknown error',
    cause: error,
  });
}

/**
 * Like toApiError, but TypeError is classified as a network error.
 * Use only around fetch or provider.refresh: elsewhere the source
 * of a TypeError is unknown.
 *
 * @internal
 */
export function classifyFetchError(error: unknown): ApiError {
  if (isNamedError(error, 'TypeError')) {
    return new ApiError({
      kind: 'network',
      message: 'Network error',
      code: 'NETWORK_ERROR',
      isUncertain: true,
      cause: error,
    });
  }
  return toApiError(error);
}

/**
 * Exception with given name. Name check instead of instanceof
 * DOMException: in another environment global DOMException may be
 * absent or a different class.
 *
 * @internal
 */
export function isNamedError(value: unknown, name: string): value is { name: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'name' in value &&
    (value as { name: unknown }).name === name
  );
}

function isErrorLike(value: unknown): value is Error {
  if (typeof value !== 'object' || value === null) return false;
  if (!('message' in value)) return false;
  return typeof (value as { message: unknown }).message === 'string';
}
