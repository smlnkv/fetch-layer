import { ApiError, toApiError } from './core/errors';
import { applyLayers, runAttach, validateLayerOrder } from './core/layer';
import { assertNonEmptyString } from './shared/validators';
import { mergeHeaders } from './transport/headers';
import { createBaseRequest, type TransportOptions } from './transport/transport';

import type { Layer, LayerContext } from './core/layer';
import type {
  Client,
  HttpMethod,
  InternalRequestConfig,
  RequestConfig,
  RequestOptions,
  ResolvedRequestConfig,
  ResponseWithMeta,
} from './core/types';

const MIN_TIMEOUT_MS = 100;

/**
 * Internal request function. Public client.request takes RequestConfig
 * without includeResponseMeta.
 */
type PublicRequestFn = <T = unknown>(config: InternalRequestConfig) => Promise<T>;

/** Client options: TransportOptions plus warn and layers. */
export interface ClientOptions extends TransportOptions {
  /**
   * Where misuse warnings go. Defaults to console.warn, null disables.
   */
  warn?: ((message: string) => void) | null;

  /**
   * Client layers. Empty by default. Order and stage are described
   * in Layer.
   */
  layers?: readonly Layer[];
}

/**
 * Converts public RequestConfig to internal shape: headers are
 * normalized to Record. undefined stays undefined, so layers do not
 * see an empty object instead of missing headers.
 */
function resolveConfig(config: InternalRequestConfig): ResolvedRequestConfig {
  return {
    ...config,
    headers: config.headers ? mergeHeaders(config.headers) : undefined,
  };
}

/**
 * Validates timeoutMs: number >= MIN_TIMEOUT_MS. Separate from
 * assertPositiveNumber: different threshold and message.
 */
function assertTimeout(value: unknown, prefix: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < MIN_TIMEOUT_MS) {
    throw new Error(
      `${prefix}: timeoutMs must be a number >= ${MIN_TIMEOUT_MS} ms, got ${String(value)}`,
    );
  }
}

/**
 * undefined means console.warn, null disables, a function is used
 * as is.
 *
 * The default is wrapped in an arrow function: console.warn as a
 * method depends on `this`, and the pipeline calls it without context.
 */
function resolveWarn(value: ClientOptions['warn']): ((message: string) => void) | undefined {
  if (value === undefined) return (message) => console.warn(message);
  if (value === null) return undefined;
  return value;
}

/**
 * Builds the pipeline from base transport and layers, validates
 * order.
 *
 * @throws Error on invalid config: empty baseUrl, invalid or too
 *   small timeoutMs, unavailable fetch, layer order violation.
 */
export function createClient(options: ClientOptions): Client {
  validateOptions(options);

  const layers = options.layers ?? [];

  validateLayerOrder(layers);

  const warn = resolveWarn(options.warn);

  const context: LayerContext = {
    warn,
  };

  const baseRequest = createBaseRequest(options);
  const { pipeline, states } = applyLayers(baseRequest, layers, context);

  const wrapped: PublicRequestFn = async <T>(config: InternalRequestConfig): Promise<T> => {
    const resolved = resolveConfig(config);

    let finalConfig: ResolvedRequestConfig;
    try {
      assertNonEmptyString(resolved.path, 'client: path');

      if (resolved.timeoutMs !== undefined) {
        assertTimeout(resolved.timeoutMs, 'client');
      }

      // Method is uppercased: layers (withIdempotency, withRetry)
      // compare it to POST, PUT and others. Fetch normalizes anyway,
      // but layers get the config before fetch.
      finalConfig = {
        ...resolved,
        method: (resolved.method ?? 'GET').toUpperCase() as HttpMethod,
      };
    } catch (e) {
      throw new ApiError({
        kind: 'unknown',
        code: 'INVALID_REQUEST_CONFIG',
        message: e instanceof Error ? e.message : String(e),
        cause: e,
      });
    }

    // Custom layers may throw errors other than ApiError. Contract:
    // everything thrown by the client is normalized. toApiError is
    // idempotent and returns the same object for transport errors.
    try {
      return await pipeline<T>(finalConfig);
    } catch (e) {
      throw toApiError(e);
    }
  };

  const client = makeClient(wrapped);
  runAttach(layers, states, client);

  return client;
}

/**
 * Validation at client creation, not at first request.
 */
function validateOptions(options: ClientOptions): void {
  assertNonEmptyString(options.baseUrl, 'createClient: baseUrl');

  if (options.timeoutMs !== undefined) {
    assertTimeout(options.timeoutMs, 'createClient');
  }

  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error(
      'createClient: fetch is not available. Pass it via the fetch option ' +
        'or use an environment with a global fetch (Node >= 20, modern browser).',
    );
  }
}

function makeBodyless(request: PublicRequestFn, method: HttpMethod) {
  return <T>(path: string, options?: RequestOptions): Promise<T> =>
    request<T>({ ...options, path, method });
}

function makeBody(request: PublicRequestFn, method: HttpMethod) {
  return <T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> =>
    request<T>({ ...options, path, method, body });
}

function makeMetaOnly(request: PublicRequestFn, method: 'HEAD' | 'OPTIONS') {
  return (path: string, options?: RequestOptions): Promise<ResponseWithMeta<undefined>> =>
    request<ResponseWithMeta<undefined>>({
      ...options,
      path,
      method,
      includeResponseMeta: true,
    });
}

function makeClient(request: PublicRequestFn): Client {
  return {
    request: <T>(config: RequestConfig) => request<T>(config),
    requestWithMeta: <T>(config: RequestConfig) =>
      request<ResponseWithMeta<T>>({ ...config, includeResponseMeta: true }),

    get: makeBodyless(request, 'GET'),
    post: makeBody(request, 'POST'),
    put: makeBody(request, 'PUT'),
    patch: makeBody(request, 'PATCH'),
    delete: makeBody(request, 'DELETE'),

    head: makeMetaOnly(request, 'HEAD'),
    options: makeMetaOnly(request, 'OPTIONS'),
  };
}
