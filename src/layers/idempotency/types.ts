import type { HttpMethod, QueryParams } from '../../core/types';

/** Input for the source: decide between a new key and the old one. */
export interface IdempotencyContext {
  path: string;

  method: HttpMethod;

  /** Feeds the fingerprint. */
  body: unknown;

  /**
   * Feeds the fingerprint: POST /orders?type=a and POST /orders?type=b
   * with the same body get different keys.
   */
  query?: QueryParams;

  /** Explicit scope. Defaults to "${method} ${path}". */
  scope?: string;
}

/**
 * - success: server confirmed, the key is no longer needed;
 * - definite-failure: 4xx except 408 and 429. The key can be released;
 * - indefinite-failure: network, timeout, 5xx, 408, 429, cancel.
 *   The key must be kept.
 */
export type IdempotencyOutcome = 'success' | 'definite-failure' | 'indefinite-failure';

/**
 * Idempotency key source. Implemented by the app or taken from
 * createSessionSource.
 *
 * Methods are synchronous: two parallel nextKey calls for the same
 * (scope, fingerprint) pair cannot both see that the key is missing.
 */
export interface IdempotencySource {
  /**
   * Key for the request: new or stored.
   *
   * @throws On storage error. The client wraps the exception in
   *   ApiError and does not send the request.
   */
  nextKey(context: IdempotencyContext): string;

  /**
   * Operation outcome. Releases the key on success and
   * definite-failure, keeps it on indefinite-failure. Exceptions
   * are ignored.
   */
  resolve?(context: IdempotencyContext, outcome: IdempotencyOutcome): void;
}
