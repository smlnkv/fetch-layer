import { ApiError, isNamedError, toApiError } from '../../core/errors';
import { safeCall } from '../../shared/safe-call';
import { throwIfAborted } from '../../shared/signals';
import { assertPositiveNumber } from '../../shared/validators';
import { mergeHeaders } from '../../transport/headers';

import { RefreshManager } from './refresh-manager';
import { attachReset } from './reset-registry';

import type { SessionExpiredReason, SessionProvider } from './types';
import type { Layer, LayerContext, LayerWrapResult } from '../../core/layer';
import type { RequestFn, ResolvedRequestConfig } from '../../core/types';

const DEFAULT_CIRCUIT_BREAKER_MS = 5000;
const DEFAULT_REFRESH_TIMEOUT_MS = 30_000;

export interface AuthOptions {
  /** Required. */
  provider: SessionProvider;

  /**
   * Called on final session expiry. The app decides what to do:
   * show a modal, redirect, nothing. Exceptions are ignored: a
   * callback failure does not replace the original 401.
   */
  onSessionExpired?: (reason: SessionExpiredReason) => void;

  /**
   * Blocking duration after a temporary refresh failure, in
   * milliseconds. Defaults to 5000. Must be positive.
   *
   * Used by the breaker (blocks new refreshes after a failure) and
   * by cooldown (blocks a second refresh right after a successful
   * one).
   */
  circuitBreakerMs?: number;

  /**
   * Timeout of a single refresh attempt, in milliseconds. Defaults
   * to 30000.
   *
   * The provider gets an AbortSignal and may pass it to its fetch.
   * If the signal is ignored, the library-side timeout does not
   * fire: bound refresh in SessionProvider.refresh instead.
   */
  refreshTimeoutMs?: number;

  /**
   * Called when the token refresh breaker opens. The breaker opens
   * after a temporary refresh failure and blocks new attempts for
   * circuitBreakerMs.
   */
  onCircuitOpen?: () => void;

  /**
   * Called when the breaker closes. Closes either after
   * circuitBreakerMs or manually via resetRefreshCircuit(client).
   */
  onCircuitClose?: () => void;
}

/**
 * Auth layer.
 *
 * Adds headers from provider before each request. On 401 starts a
 * token refresh and retries the original request once. On a temporary
 * refresh failure rethrows the error without logging the user out. On
 * a final failure calls onSessionExpired.
 *
 * Refresh starts only on 401: 403 does not trigger it.
 *
 * If a successful refresh happened less than circuitBreakerMs ago and
 * the request got 401 again, the layer retries with the current
 * headers without a new refresh.
 *
 * Layer is a template: if the same object is passed to two
 * createClient calls, each gets its own RefreshManager.
 */
export function withAuth(options: AuthOptions): Layer {
  const {
    provider,
    onSessionExpired,
    circuitBreakerMs = DEFAULT_CIRCUIT_BREAKER_MS,
    refreshTimeoutMs = DEFAULT_REFRESH_TIMEOUT_MS,
  } = options;

  assertPositiveNumber(circuitBreakerMs, 'withAuth: circuitBreakerMs');
  assertPositiveNumber(refreshTimeoutMs, 'withAuth: refreshTimeoutMs');

  return {
    name: 'withAuth',
    stage: 1,

    wrap(next: RequestFn, context: LayerContext): LayerWrapResult {
      const manager = new RefreshManager(
        {
          onCircuitOpen: () => {
            safeCall(() => options.onCircuitOpen?.());
          },
          onCircuitClose: () => {
            safeCall(() => options.onCircuitClose?.());
          },
        },
        refreshTimeoutMs,
      );

      const fn: RequestFn = async function authRequest<T>(
        config: ResolvedRequestConfig,
      ): Promise<T> {
        if (config.skipAuth) {
          return next<T>(config);
        }

        throwIfAborted(config.signal);

        const authHeaders = await safeGetAuthHeaders(provider);
        const withAuthConfig: ResolvedRequestConfig = {
          ...config,
          headers: mergeHeaders(config.headers, authHeaders),
        };

        try {
          return await next<T>(withAuthConfig);
        } catch (e) {
          const err = toApiError(e);

          if (err.status !== 401) throw err;

          throwIfAborted(config.signal);

          // 401 inside provider.refresh: a second refresh through
          // SingleFlight would return the same promise and loop the
          // call. Rethrow 401 without onSessionExpired.
          if (manager.isRefreshSignal(config.signal)) {
            safeCall(() =>
              context.warn?.(
                '[fetch-layers] withAuth: 401 inside provider.refresh. ' +
                  'Use a separate client without withAuth for the refresh endpoint.',
              ),
            );
            throw err;
          }

          const outcome = await manager.refresh(provider, circuitBreakerMs);

          if (outcome.status === 'temporarily-failed') {
            throw toApiError(outcome.error);
          }

          if (outcome.status === 'definitely-failed') {
            safeClear(provider);
            safeCall(() => onSessionExpired?.(outcome.reason));
            throw err;
          }

          // cooldown: retry with current headers, no refresh. A
          // second 401 means a dead session - same as success.
          if (outcome.status === 'cooldown') {
            throwIfAborted(config.signal);
            const currentHeaders = await safeGetAuthHeaders(provider);

            try {
              return await next<T>({
                ...config,
                headers: mergeHeaders(config.headers, currentHeaders),
              });
            } catch (retryError) {
              const retryErr = toApiError(retryError);

              if (retryErr.status === 401) {
                safeClear(provider);
                safeCall(() => onSessionExpired?.('token-rejected'));
              }

              throw retryErr;
            }
          }

          // success: retry with headers from refresh if present:
          // closes the race when state is not updated yet.
          throwIfAborted(config.signal);

          const newHeaders = outcome.headers ?? (await safeGetAuthHeaders(provider));

          try {
            return await next<T>({
              ...config,
              headers: mergeHeaders(config.headers, newHeaders),
            });
          } catch (retryError) {
            const retryErr = toApiError(retryError);

            if (retryErr.status === 401) {
              safeClear(provider);
              safeCall(() => onSessionExpired?.('token-rejected'));
            }

            throw retryErr;
          }
        }
      };

      return { fn, state: manager };
    },

    attach(client, state): void {
      if (!(state instanceof RefreshManager)) return;
      attachReset(client, () => state.reset());
    },
  };
}

/**
 * A getAuthHeaders failure turns into ApiError with code
 * AUTH_PROVIDER_ERROR: the request is not sent. AbortError is
 * rethrown as abort.
 */
async function safeGetAuthHeaders(provider: SessionProvider): Promise<Record<string, string>> {
  try {
    const headers = await provider.getAuthHeaders();
    if (!headers || typeof headers !== 'object') return {};
    return headers;
  } catch (e) {
    if (isNamedError(e, 'AbortError')) {
      throw new ApiError({
        kind: 'abort',
        code: 'ABORTED',
        message: 'Request aborted',
        cause: e,
      });
    }
    throw new ApiError({
      kind: 'unknown',
      code: 'AUTH_PROVIDER_ERROR',
      message: 'Auth provider failed to return headers',
      cause: e,
    });
  }
}

/** A clear failure does not replace the original 401. */
function safeClear(provider: SessionProvider): void {
  try {
    provider.clear?.();
  } catch {
    // A clear failure does not replace the original error.
  }
}
