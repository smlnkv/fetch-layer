/**
 * Calls unref on the timer if present. In Node this lets the process
 * exit without waiting for the timer. In the browser setTimeout
 * returns a number with no unref.
 */
export function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  if (
    typeof timer === 'object' &&
    timer !== null &&
    typeof (timer as { unref?: unknown }).unref === 'function'
  ) {
    (timer as { unref: () => void }).unref();
  }
}
