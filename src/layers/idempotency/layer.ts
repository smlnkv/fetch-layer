import { type ApiError, toApiError } from '../../core/errors';
import { isMutatingMethod } from '../../shared/method';
import { getHeader, mergeHeaders, setHeader } from '../../transport/headers';

import type { IdempotencyContext, IdempotencyOutcome, IdempotencySource } from './types';
import type { Layer, LayerWrapResult } from '../../core/layer';
import type { RequestFn, ResolvedRequestConfig } from '../../core/types';

export interface IdempotencyOptions {
  /**
   * Header name. Defaults to Idempotency-Key. Some servers use
   * X-Idempotency-Key.
   */
  headerName?: string;
}

/**
 * For mutating methods adds the idempotency header with the value
 * from the source. If the app set the header itself, the layer does
 * not interfere. After completion reports the outcome to the source.
 *
 * Sits outside the retry layer: the key is generated once for the
 * whole operation, including retries, resolve is called once.
 *
 * Marks the config with an idempotency marker so withRetry does not
 * emit a false unsafe retry warning. The marker is set both for a
 * generated key and for a manual one.
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
        config: ResolvedRequestConfig,
      ): Promise<T> {
        const method = config.method ?? 'GET';

        if (!isMutatingMethod(method) || config.skipIdempotency) {
          return next<T>(config);
        }

        // Empty string and whitespace-only count as "not set".
        const existingKey = getHeader(config.headers, headerName);
        if (existingKey !== undefined && existingKey.trim() !== '') {
          return next<T>({
            ...config,
            idempotency: { headerName, key: existingKey },
          });
        }

        const context: IdempotencyContext = {
          path: config.path,
          method,
          body: config.body,
          query: config.query,
          scope: config.idempotencyScope,
        };

        // Storage error: without a saved key the request must not be
        // sent, otherwise a retry creates a duplicate.
        let key: string;
        try {
          key = source.nextKey(context);
        } catch (e) {
          throw toApiError(e);
        }

        // mergeHeaders normalizes Headers and array of pairs to an
        // object. Spread on Headers would give {}.
        const enrichedHeaders = mergeHeaders(config.headers);
        setHeader(enrichedHeaders, headerName, key);

        const enriched: ResolvedRequestConfig = {
          ...config,
          headers: enrichedHeaders,
          idempotency: { headerName, key },
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
 * 4xx except 408 and 429: the server explicitly rejected the
 * operation, a retry will not help. Anything else - operation state
 * is unknown.
 */
function classifyOutcome(error: ApiError): IdempotencyOutcome {
  if (error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429) {
    return 'definite-failure';
  }
  return 'indefinite-failure';
}

/** A resolve failure does not replace the operation result. */
function safeResolve(
  source: IdempotencySource,
  context: IdempotencyContext,
  outcome: IdempotencyOutcome,
): void {
  if (!source.resolve) return;
  try {
    source.resolve(context, outcome);
  } catch {
    // A resolve failure does not replace the operation result.
  }
}
