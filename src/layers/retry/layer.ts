import { type ApiError, toApiError } from '../../core/errors';
import { isStreamingBody } from '../../shared/classify-body';
import { isMutatingMethod } from '../../shared/method';
import { safeCall } from '../../shared/safe-call';
import { sleep as defaultSleep, throwIfAborted } from '../../shared/signals';
import {
  assertInteger,
  assertNonNegativeNumber,
  clampDelay,
  MIN_RETRY_MS,
} from '../../shared/validators';
import { getHeader } from '../../transport/headers';

import type { Layer, LayerContext, LayerWrapResult } from '../../core/layer';
import type { RequestFn, ResolvedRequestConfig } from '../../core/types';

/**
 * Default idempotency header name. Used by the unsafe retry warning
 * when withIdempotency is not wired up but the app set the key
 * manually. An idempotency marker in the config skips the header
 * check.
 */
const DEFAULT_IDEMPOTENCY_HEADER = 'Idempotency-Key';

export interface RetryOptions {
  /**
   * Max attempts, including the first one. Defaults to 3, minimum 1.
   */
  maxAttempts?: number;

  /**
   * Initial delay in milliseconds. Defaults to 300. Values below
   * MIN_RETRY_MS are raised to the minimum.
   */
  baseDelayMs?: number;

  /**
   * Upper bound of the delay. Defaults to 10000. Caps the computed
   * delay and acts as threshold for Retry-After: if the server asked
   * for more, the retry is skipped.
   *
   * Must be >= baseDelayMs after it was raised to MIN_RETRY_MS,
   * otherwise withRetry throws.
   */
  maxDelayMs?: number;

  /**
   * Spread around the computed delay, defaults to 0.15 (+-15%).
   * 0 disables the spread, 1 gives +-100%. Not applied to
   * Retry-After. Value in [0, 1].
   */
  jitterRatio?: number;

  /**
   * Warn about a mutating retry without idempotency header. Defaults
   * to true.
   *
   * No warning when withIdempotency applied a key, the app set
   * Idempotency-Key itself, or passed skipIdempotency: true. Once per
   * method and root path segment: for DELETE /sessions/123 the root
   * segment is sessions.
   */
  warnOnUnsafeRetry?: boolean;

  /** Retry network errors (kind network). Defaults to true. */
  retryOnNetwork?: boolean;

  /**
   * Retry timeouts (kind timeout). Defaults to true. For unsafe
   * methods a retry without Idempotency-Key may create a duplicate.
   */
  retryOnTimeout?: boolean;

  /**
   * Retry policy. Defaults to isRetryable, adjusted by retryOnNetwork
   * and retryOnTimeout. Cancel and auth errors are not retried even
   * if the function returns true.
   *
   * On callback failure the default policy is used, the error goes
   * to warn.
   *
   * @param attempt - failed attempt number, 1-based.
   */
  shouldRetry?: (error: ApiError, attempt: number) => boolean;

  /**
   * Delay before retry. Not applied when the server sent Retry-After.
   * Result is clamped to [MIN_RETRY_MS, maxDelayMs].
   *
   * On callback failure the default delay is used, the error goes
   * to warn.
   *
   * @param attempt - failed attempt number, 1-based.
   */
  computeDelay?: (attempt: number, error: ApiError) => number;

  /**
   * Before each retry. May return a new config (e.g. replace
   * Idempotency-Key on 409) or stop retries by returning
   * skipRetry: true - the error is rethrown at once.
   *
   * @param attempt - attempt number from 1. First retry: attempt === 1.
   */
  onBeforeRetry?: (
    config: ResolvedRequestConfig,
    attempt: number,
    error: ApiError,
  ) => ResolvedRequestConfig | void;

  /** Pause between attempts. Defaults to setTimeout with abort. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/**
 * First path segment: for "/orders/123" it is "orders". Dedup key
 * for the warning: dynamic ids inside one resource collapse,
 * different resources give different keys.
 */
function rootSegment(path: string): string {
  const trimmed = path.replace(/^\/+/, '');
  const slash = trimmed.indexOf('/');
  return slash === -1 ? trimmed : trimmed.slice(0, slash);
}

/**
 * Automatic retry layer.
 *
 * Retries network errors, timeouts, 5xx, 408 and 429. Does not retry
 * cancel, auth errors and other 4xx.
 *
 * Delays are exponential with +-15% spread (300, 600, 1200 ms), upper
 * bound is maxDelayMs.
 *
 * Retry-After from the response replaces the computed delay. If the
 * value is above maxDelayMs, the retry is skipped: the server asks to
 * wait longer than the app is ready to.
 *
 * Retries are disabled for streaming bodies: a stream is single-use,
 * a second fetch throws TypeError, which transport takes for a
 * network error.
 *
 * @throws Error on invalid options.
 */
export function withRetry(options: RetryOptions = {}): Layer {
  const {
    maxAttempts = 3,
    baseDelayMs: rawBaseDelayMs = 300,
    maxDelayMs: rawMaxDelayMs = 10_000,
    jitterRatio = 0.15,
    warnOnUnsafeRetry = true,
    retryOnNetwork = true,
    retryOnTimeout = true,
    shouldRetry,
    computeDelay,
    onBeforeRetry,
    sleep = defaultSleep,
  } = options;

  assertInteger(maxAttempts, 'withRetry: maxAttempts', 1);
  assertNonNegativeNumber(rawBaseDelayMs, 'withRetry: baseDelayMs');
  assertNonNegativeNumber(rawMaxDelayMs, 'withRetry: maxDelayMs');

  if (!Number.isFinite(jitterRatio) || jitterRatio < 0 || jitterRatio > 1) {
    throw new Error(
      `withRetry: jitterRatio must be a number in [0, 1], got ${String(jitterRatio)}`,
    );
  }

  const baseDelayMs = clampDelay(rawBaseDelayMs, MIN_RETRY_MS);

  if (rawMaxDelayMs < baseDelayMs) {
    throw new Error(
      `withRetry: maxDelayMs (${rawMaxDelayMs}) must be >= baseDelayMs (${baseDelayMs})`,
    );
  }

  const maxDelayMs = rawMaxDelayMs;

  /**
   * Default retries everything isRetryable allows, but network and
   * timeout are filtered by separate options: timeouts can be turned
   * off while network retries stay on.
   */
  const defaultShouldRetry = (err: ApiError): boolean => {
    if (!err.isRetryable) return false;
    if (err.kind === 'network' && !retryOnNetwork) return false;
    if (err.kind === 'timeout' && !retryOnTimeout) return false;
    return true;
  };

  /** 1-based: first retry gets base delay, second - doubled. */
  const defaultCompute = (attempt: number): number => {
    const jitter = 1 - jitterRatio + Math.random() * jitterRatio * 2;
    return baseDelayMs * 2 ** (attempt - 1) * jitter;
  };

  const retryPolicy = shouldRetry ?? defaultShouldRetry;
  const delayPolicy = computeDelay ?? defaultCompute;

  return {
    name: 'withRetry',
    stage: 2,

    wrap(next: RequestFn, context: LayerContext): LayerWrapResult {
      // Set inside wrap: each createClient gets its own instance, even
      // if the same Layer is passed to several clients.
      const warnedUnsafeRetry = new Set<string>();
      const warn = context.warn;

      const warnUnsafeRetryOnce = (key: string, message: string): void => {
        if (warnedUnsafeRetry.has(key)) return;
        warnedUnsafeRetry.add(key);
        safeCall(() => warn?.(message));
      };

      let warnedStreamNoRetry = false;

      const fn: RequestFn = async function retryRequest<T>(
        initialConfig: ResolvedRequestConfig,
      ): Promise<T> {
        if (initialConfig.skipRetry) {
          return next<T>(initialConfig);
        }

        // A stream is single-use: fetch takes it on the first send,
        // a retry throws TypeError, transport takes it for a network
        // error.
        if (isStreamingBody(initialConfig.body)) {
          if (!warnedStreamNoRetry) {
            warnedStreamNoRetry = true;
            safeCall(() =>
              warn?.(
                '[fetch-layers] withRetry is enabled, but the request body is a stream. ' +
                  'Streams are single-use; retries are disabled for this request. ' +
                  'Use skipRetry: true to silence this warning, or pre-buffer the stream.',
              ),
            );
          }
          return next<T>(initialConfig);
        }

        const method = initialConfig.method ?? 'GET';

        // Marker is set by withIdempotency. If missing, check the
        // header: the app could set the key manually.
        const hasIdempotencyKey =
          initialConfig.idempotency !== undefined ||
          getHeader(initialConfig.headers, DEFAULT_IDEMPOTENCY_HEADER) !== undefined;

        // Before the first attempt: the warning is about config, not
        // about an actual retry.
        if (
          warnOnUnsafeRetry &&
          isMutatingMethod(method) &&
          !hasIdempotencyKey &&
          !initialConfig.skipIdempotency
        ) {
          warnUnsafeRetryOnce(
            `retry-unsafe:${method}:${rootSegment(initialConfig.path)}`,
            `[fetch-layers] Retry is enabled for ${method} ${initialConfig.path} ` +
              `without the ${DEFAULT_IDEMPOTENCY_HEADER} header. On a network failure ` +
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

            let retryDecision: boolean;
            try {
              retryDecision = retryPolicy(err, failedAttempt);
            } catch (policyError) {
              safeCall(() =>
                warn?.(
                  `[fetch-layers] withRetry: shouldRetry threw, falling back to default. ` +
                    `${policyError instanceof Error ? policyError.message : String(policyError)}`,
                ),
              );
              retryDecision = defaultShouldRetry(err);
            }

            if (!retryDecision) throw err;

            // Retry-After takes priority: if the server asked for more
            // than maxDelayMs, skip the retry.
            let delay: number;
            if (err.retryAfterMs !== undefined) {
              if (err.retryAfterMs > maxDelayMs) throw err;
              delay = clampDelay(err.retryAfterMs, MIN_RETRY_MS);
            } else {
              let computed: number;
              try {
                computed = delayPolicy(failedAttempt, err);
              } catch (policyError) {
                safeCall(() =>
                  warn?.(
                    `[fetch-layers] withRetry: computeDelay threw, falling back to default. ` +
                      `${policyError instanceof Error ? policyError.message : String(policyError)}`,
                  ),
                );
                computed = defaultCompute(failedAttempt);
              }

              delay = Math.min(clampDelay(computed, MIN_RETRY_MS), maxDelayMs);
            }

            // onBeforeRetry may replace the config or stop retries via
            // skipRetry: true.
            config = safeCall(() => onBeforeRetry?.(config, failedAttempt, err)) ?? config;
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
