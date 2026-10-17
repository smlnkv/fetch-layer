import { ApiError, classifyFetchError } from '../../core/errors';
import { unrefTimer } from '../../shared/timers';

import { CircuitBreaker } from './circuit-breaker';
import { SingleFlight } from './single-flight';

import type { RefreshResult, SessionProvider } from './types';

const DEFAULT_REFRESH_TIMEOUT_MS = 30_000;

/**
 * Internal refresh result. Differs from public RefreshResult by
 * cooldown status: a successful refresh happened less than
 * circuitBreakerMs ago. Handled inside withAuth, never leaves the
 * library.
 */
export type RefreshManagerResult = RefreshResult | { status: 'cooldown' };

/** Breaker state callbacks. Source is AuthOptions. */
export interface RefreshManagerCallbacks {
  onCircuitOpen?: () => void;
  onCircuitClose?: () => void;
}

/**
 * Token refresh manager. One per client.
 *
 * Three mechanisms: single-flight (one refresh for concurrent 401s),
 * breaker (blocking after a failure) and cooldown (no second refresh
 * right after a successful one).
 */
export class RefreshManager {
  private readonly circuit: CircuitBreaker;
  private readonly singleFlight = new SingleFlight<RefreshManagerResult>();
  private readonly refreshTimeoutMs: number;

  /** Last successful refresh time. Used for cooldown. */
  private lastSuccessfulRefreshAt = 0;

  /**
   * Grows on every reset(). doRefresh remembers the value before
   * await and compares after. If reset() ran during refresh, the
   * result is not written to lastSuccessfulRefreshAt.
   */
  private resetCount = 0;

  /**
   * Signals passed to provider.refresh. Needed to tell a 401 inside
   * refresh from a regular 401: such request must not start refresh
   * again.
   */
  private readonly refreshSignals = new WeakSet<AbortSignal>();

  constructor(
    callbacks: RefreshManagerCallbacks = {},
    refreshTimeoutMs = DEFAULT_REFRESH_TIMEOUT_MS,
  ) {
    this.circuit = new CircuitBreaker({
      onOpen: callbacks.onCircuitOpen,
      onClose: callbacks.onCircuitClose,
    });
    this.refreshTimeoutMs = refreshTimeoutMs;
  }

  /**
   * Resets the breaker, cooldown and forgets the current refresh.
   * Called via resetRefreshCircuit when the app knows the problem is
   * gone.
   *
   * Forgetting must happen before closing the breaker: otherwise the
   * next 401 joins the previous promise and reset has no effect.
   */
  reset(): void {
    this.resetCount++;
    this.lastSuccessfulRefreshAt = 0;
    this.singleFlight.forget();
    this.circuit.close();
  }

  /**
   * true if signal was created inside the current doRefresh: the
   * request was initiated by the provider, not by the app.
   */
  isRefreshSignal(signal: AbortSignal | undefined): boolean {
    return signal !== undefined && this.refreshSignals.has(signal);
  }

  /**
   * Refreshes the session or joins the current refresh.
   *
   * @param circuitBreakerMs - breaker duration and cooldown window.
   */
  refresh(provider: SessionProvider, circuitBreakerMs: number): Promise<RefreshManagerResult> {
    if (this.circuit.isBlocking()) {
      return Promise.resolve({
        status: 'temporarily-failed',
        error: new ApiError({
          kind: 'unknown',
          code: 'REFRESH_CIRCUIT_OPEN',
          message: 'Token refresh is temporarily unavailable',
          isUncertain: false,
        }),
      });
    }

    const now = Date.now();
    if (this.lastSuccessfulRefreshAt > 0 && now - this.lastSuccessfulRefreshAt < circuitBreakerMs) {
      return Promise.resolve({ status: 'cooldown' });
    }

    return this.singleFlight.run(() => this.doRefresh(provider, circuitBreakerMs));
  }

  /**
   * Calls provider.refresh with a timeout and classifies the result.
   * TypeError around provider.refresh is a network error: the
   * implementation usually calls fetch inside.
   *
   * Returns a normalized error in temporarily-failed: withAuth must
   * not call toApiError again.
   */
  private async doRefresh(
    provider: SessionProvider,
    circuitBreakerMs: number,
  ): Promise<RefreshManagerResult> {
    const resetCountAtStart = this.resetCount;

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;

    // The timeout rejects the promise on its own, regardless of
    // whether the implementation listens to signal. controller.abort
    // is a hint to it.
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const reason = new DOMException('Refresh timeout', 'TimeoutError');
        controller.abort(reason);
        reject(reason);
      }, this.refreshTimeoutMs);

      unrefTimer(timer);
    });

    timeoutPromise.catch(() => {});

    let result: RefreshResult;

    try {
      this.refreshSignals.add(controller.signal);
      const providerPromise = provider.refresh(controller.signal);

      // After the timeout the race is already settled, but the
      // provider may reject later. Without catch this is an
      // unhandledRejection.
      providerPromise.catch(() => {});

      result = await Promise.race([providerPromise, timeoutPromise]);
    } catch (e) {
      const err = classifyFetchError(e);

      // Refresh timeout is a failure, open the breaker.
      if (err.kind === 'timeout') {
        this.circuit.open(circuitBreakerMs);
        return {
          status: 'temporarily-failed',
          error: new ApiError({
            kind: 'timeout',
            code: 'REFRESH_TIMEOUT',
            message: 'Token refresh timed out',
            isUncertain: true,
          }),
        };
      }

      // Cancel is not a network failure, do not open the breaker.
      if (err.isCancelled) {
        return { status: 'temporarily-failed', error: err };
      }

      // 401 or 403 from refresh means the session is dead.
      if (err.status === 401 || err.status === 403) {
        return {
          status: 'definitely-failed',
          reason: err.status === 403 ? 'refresh-forbidden' : 'refresh-rejected',
        };
      }

      // Network or 5xx from the auth server - open the breaker.
      // unknown and parse are more likely a bug in refresh: a false
      // open would hide the cause under REFRESH_CIRCUIT_OPEN.
      if (err.kind === 'network' || err.isServerError) {
        this.circuit.open(circuitBreakerMs);
      }

      return { status: 'temporarily-failed', error: err };
    } finally {
      clearTimeout(timer);
    }

    if (result.status === 'temporarily-failed') {
      const err = classifyFetchError(result.error);
      if (!err.isCancelled) {
        this.circuit.open(circuitBreakerMs);
      }
      return { status: 'temporarily-failed', error: err };
    }

    if (result.status === 'success') {
      // reset() during refresh: do not write lastSuccessfulRefreshAt,
      // cooldown must not apply to the next 401.
      if (this.resetCount === resetCountAtStart) {
        this.lastSuccessfulRefreshAt = Date.now();
      }
    }

    return result;
  }
}
