import { safeCall } from '../../shared/safe-call';
import { unrefTimer } from '../../shared/timers';

export interface CircuitBreakerCallbacks {
  onOpen?: () => void;
  onClose?: () => void;
}

/**
 * After a temporary failure blocks new refresh attempts for a given
 * time: without the breaker, every new 401 would start a new attempt
 * and the auth server would get a stream of requests.
 *
 * onOpen and onClose are called exactly once per state transition.
 */
export class CircuitBreaker {
  private openUntil = 0;
  private isOpen = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly callbacks: CircuitBreakerCallbacks;

  constructor(callbacks: CircuitBreakerCallbacks = {}) {
    this.callbacks = callbacks;
  }

  /**
   * true if the breaker blocks refresh. If the blocking time has
   * passed, closes and returns false.
   */
  isBlocking(): boolean {
    if (!this.isOpen) return false;

    if (Date.now() >= this.openUntil) {
      this.close();
      return false;
    }

    return true;
  }

  /**
   * Opens the breaker for durationMs. A repeated call extends the
   * blocking, onOpen is not called again.
   *
   * In Node the timer does not hold the event loop (unref), so the
   * process can exit.
   *
   * @throws Error if durationMs is not a positive number: a zero or
   *   negative duration would open the breaker already in closed
   *   state.
   */
  open(durationMs: number): void {
    if (!Number.isFinite(durationMs) || durationMs <= 0) {
      throw new Error(
        `CircuitBreaker.open: durationMs must be a positive number, got ${String(durationMs)}`,
      );
    }

    const wasOpen = this.isOpen && Date.now() < this.openUntil;

    this.openUntil = Date.now() + durationMs;
    this.isOpen = true;

    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => this.close(), durationMs);
    unrefTimer(this.timer);

    if (!wasOpen) {
      safeCall(() => this.callbacks.onOpen?.());
    }
  }

  /**
   * Closes the breaker and clears the timer. Idempotent: a repeated
   * call on a closed breaker does nothing and does not call onClose.
   */
  close(): void {
    if (!this.isOpen) return;

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    this.isOpen = false;
    this.openUntil = 0;

    safeCall(() => this.callbacks.onClose?.());
  }
}
