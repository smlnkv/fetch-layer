/**
 * When several run calls arrive before the first one finishes, they
 * all get the result of one promise. After it finishes, the next run
 * starts a new operation.
 *
 * Used by RefreshManager: concurrent 401s must not start several
 * refreshes.
 */
export class SingleFlight<T> {
  private inFlight: Promise<T> | null = null;

  /**
   * Starts an operation or joins the current one.
   *
   * @returns the same promise as the first call for concurrent callers.
   */
  run(fn: () => Promise<T>): Promise<T> {
    if (this.inFlight) {
      return this.inFlight;
    }

    const promise = fn().finally(() => {
      // The reference may have been nulled by forget and replaced by
      // a new promise from run. Then it must not be touched.
      if (this.inFlight === promise) {
        this.inFlight = null;
      }
    });

    this.inFlight = promise;
    return promise;
  }

  /**
   * Forgets the current promise. Callers waiting on it keep waiting:
   * a promise cannot be cancelled in JS. The next run starts a new
   * operation.
   */
  forget(): void {
    this.inFlight = null;
  }
}
