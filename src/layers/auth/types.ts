/**
 * Session expiry reason. Passed to onSessionExpired.
 *
 * - refresh-rejected: server rejected token refresh (401);
 * - refresh-forbidden: server forbade refresh (403);
 * - token-rejected: after a successful refresh the new token was
 *   rejected too.
 */
export type SessionExpiredReason = 'refresh-rejected' | 'refresh-forbidden' | 'token-rejected';

/**
 * Session refresh result.
 *
 * success. Token refreshed. If headers is set, the client uses it for
 * the retry, otherwise calls getAuthHeaders. Prefer returning
 * headers: this closes the race when the state is not updated yet
 * but the request is already retrying.
 *
 * definitely-failed. Session is dead. The client calls
 * onSessionExpired and rethrows the original 401.
 *
 * temporarily-failed. Session may still be alive. The client
 * rethrows the error but does not call onSessionExpired or clear.
 *
 * error is any value. The client normalizes it: TypeError becomes
 * network, AbortError and TimeoutError - the matching kind,
 * everything else - unknown.
 */
export type RefreshResult =
  | { status: 'success'; headers?: Record<string, string> }
  | { status: 'definitely-failed'; reason: SessionExpiredReason }
  | { status: 'temporarily-failed'; error: unknown };

/**
 * Auth provider. Implemented by the app: the library does not store
 * tokens, it only asks for ready headers.
 *
 * refresh must not use the client with withAuth: a 401 from the
 * refresh endpoint would go back into withAuth. A separate client
 * without layers is described in RECIPES.
 */
export interface SessionProvider {
  /**
   * Auth headers: one or several (Authorization, X-CSRF-Token,
   * X-API-Key). May be async.
   *
   * @throws On error the client wraps the exception in ApiError with
   *   code AUTH_PROVIDER_ERROR and does not send the request.
   */
  getAuthHeaders(): Record<string, string> | Promise<Record<string, string>>;

  /**
   * Refreshes the session. Called on 401. Concurrent 401s produce one
   * refresh call, the rest wait for its result.
   *
   * @param signal - abort on refreshTimeoutMs. Pass it to your fetch:
   *   fetch(url, { signal }). Optional: a provider without it still
   *   matches the interface, but will not be aborted on timeout.
   */
  refresh(signal?: AbortSignal): Promise<RefreshResult>;

  /**
   * Resets session state. Called on definitely-failed. Exceptions
   * are ignored. Must be idempotent.
   */
  clear?(): void;
}
