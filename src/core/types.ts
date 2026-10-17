export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

/**
 * Format for parsing successful responses. Defaults to json.
 *
 * - json: empty body returns undefined, not an error;
 * - text: CSV, HTML, plain text;
 * - blob: binary data with a MIME type;
 * - arrayBuffer: binary data without a MIME type;
 * - stream: ReadableStream<Uint8Array>.
 */
export type ResponseType = 'json' | 'text' | 'blob' | 'arrayBuffer' | 'stream';

/** Numbers and booleans are stringified automatically. */
export type QueryParamPrimitive = string | number | boolean;

/**
 * Primitive, array of primitives, or nested object. undefined and
 * null are skipped.
 */
export type QueryParamValue =
  | QueryParamPrimitive
  | undefined
  | null
  | Array<QueryParamPrimitive | undefined | null>
  | QueryParamObject;

export interface QueryParamObject {
  [key: string]: QueryParamValue;
}

export type QueryParams = Record<string, QueryParamValue>;

/**
 * - repeat: ?ids=1&ids=2. Default.
 * - brackets: ?ids[]=1&ids[]=2.
 * - comma: ?ids=1,2.
 */
export type QueryArrayFormat = 'repeat' | 'brackets' | 'comma';

/**
 * - brackets: ?filter[status]=active. Default.
 * - dots: ?filter.status=active.
 */
export type QueryObjectFormat = 'brackets' | 'dots';

/**
 * HTTP response metadata. Returned by requestWithMeta, head and
 * options.
 */
export interface ResponseMeta {
  status: number;

  headers: Headers;

  /** X-Request-Id, if server returned one. */
  requestId?: string;

  /** Retry-After in milliseconds, uncapped. */
  retryAfterMs?: number;
}

export interface ResponseWithMeta<T> {
  data: T;
  meta: ResponseMeta;
}

/**
 * Request configuration. In shorthand methods like client.get,
 * path, method and body are set by the method and are not part
 * of RequestOptions.
 */
export interface RequestConfig {
  /**
   * Path relative to baseUrl, e.g. `/orders`. Without a query
   * string: pass params via query.
   *
   * Segments are encoded automatically: `/users/John Doe` goes out
   * as `/users/John%20Doe`.
   */
  path: string;

  /** Defaults to GET. */
  method?: HttpMethod;

  /**
   * Body format is inferred from the type: JSON object and array
   * are sent as JSON, FormData as multipart, Blob and File as
   * binary data, ArrayBuffer and TypedArray as
   * application/octet-stream, ReadableStream as a stream,
   * URLSearchParams as form-urlencoded, string as is.
   *
   * An explicit Content-Type is not overwritten.
   */
  body?: unknown;

  /**
   * Request headers: Record, Headers or an array of pairs. Header
   * names are case-insensitive.
   */
  headers?: HeadersInit;

  query?: QueryParams;

  /**
   * Abort signal. Merged with the internal timeout: whichever fires
   * first wins, the reason is preserved.
   */
  signal?: AbortSignal;

  /**
   * Request timeout in ms. Overrides the client's timeoutMs for this
   * request. Must be >= 100.
   */
  timeoutMs?: number;

  /**
   * Skip auth and 401 handling. For requests that create a session.
   */
  skipAuth?: boolean;

  /** Skip automatic retries. */
  skipRetry?: boolean;

  /** Skip adding idempotency header. */
  skipIdempotency?: boolean;

  /** Explicit idempotency scope. Defaults to "${method} ${path}". */
  idempotencyScope?: string;

  /** Format for parsing response body. Defaults to json. */
  responseType?: ResponseType;

  /** Cookie mode: omit, same-origin or include. */
  credentials?: RequestCredentials;

  /** Query array format. Overrides the client setting. */
  queryArrayFormat?: QueryArrayFormat;

  /** Query object format. Overrides the client setting. */
  queryObjectFormat?: QueryObjectFormat;

  /**
   * Extra fetch options. method, headers, body, signal, credentials
   * and duplex are ignored.
   */
  fetchOptions?: Partial<
    Omit<RequestInit, 'method' | 'headers' | 'body' | 'signal' | 'credentials' | 'duplex'>
  >;
}

/**
 * Config with response metadata flag. Used inside requestWithMeta,
 * head and options: the public RequestConfig does not expose it,
 * otherwise a stray call from JS could get ResponseWithMeta instead
 * of a plain body.
 *
 * @internal
 */
export interface InternalRequestConfig extends RequestConfig {
  includeResponseMeta?: true;
}

/**
 * Internal config: headers are normalized to Record. Layers and
 * transport receive this type after client.ts called mergeHeaders
 * on the public RequestConfig.
 */
export interface ResolvedRequestConfig extends Omit<InternalRequestConfig, 'headers'> {
  headers?: Record<string, string>;

  /**
   * Set by withIdempotency. withRetry reads the marker to decide
   * whether retrying a mutating method is safe.
   *
   * The field is set both when withIdempotency generated a key and
   * when the app sets it manually. headerName is for debugging,
   * withRetry does not rely on it.
   *
   * @internal
   */
  idempotency?: { headerName: string; key: string };
}

/**
 * RequestConfig without path, method and body. Used in shorthand
 * methods like client.get.
 */
export type RequestOptions = Omit<RequestConfig, 'path' | 'method' | 'body'>;

/** Low-level request function that the pipeline is built from. */
export type RequestFn = <T = unknown>(config: ResolvedRequestConfig) => Promise<T>;

/**
 * HTTP client. Created by createClient.
 *
 * get, post, put, patch, delete return parsed body. head and
 * options return { data, meta }: no body, metadata is the main
 * result. requestWithMeta exposes metadata for any HTTP method.
 */
export interface Client {
  /** Request with any HTTP method. */
  request: <T = unknown>(config: RequestConfig) => Promise<T>;

  /** Request with response metadata: { data, meta }. */
  requestWithMeta: <T = unknown>(config: RequestConfig) => Promise<ResponseWithMeta<T>>;

  get: <T = unknown>(path: string, options?: RequestOptions) => Promise<T>;
  post: <T = unknown>(path: string, body?: unknown, options?: RequestOptions) => Promise<T>;
  put: <T = unknown>(path: string, body?: unknown, options?: RequestOptions) => Promise<T>;
  patch: <T = unknown>(path: string, body?: unknown, options?: RequestOptions) => Promise<T>;

  /**
   * Accepts an optional body. HTTP spec leaves DELETE body semantics
   * undefined, but many APIs support it.
   */
  delete: <T = unknown>(path: string, body?: unknown, options?: RequestOptions) => Promise<T>;

  /** Headers only. data is always undefined. */
  head: (path: string, options?: RequestOptions) => Promise<ResponseWithMeta<undefined>>;

  /** Allowed methods for a resource. data is always undefined. */
  options: (path: string, options?: RequestOptions) => Promise<ResponseWithMeta<undefined>>;
}
