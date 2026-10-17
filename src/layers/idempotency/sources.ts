import { createMemoryStorage, fromWebStorage } from '../../shared/storage';

import { createSessionSource } from './session';

import type { IdempotencySource } from './types';

/**
 * Key source on top of sessionStorage. Storage is isolated between
 * tabs: two orders from two tabs get different keys. For
 * deduplication across tabs use localStorageSource.
 *
 * Outside a browser use memoryStorageSource or your own source on
 * top of Redis, KV, IndexedDB.
 *
 * @throws Error if sessionStorage is not available: SSR, Workers,
 *   disabled cookies. The error is thrown when the factory is
 *   called, not on the first request.
 */
export function sessionStorageSource(): IdempotencySource {
  return createSessionSource({
    storage: fromWebStorage(getSessionStorage()),
  });
}

/**
 * Key source on top of localStorage. Storage is shared between all
 * tabs: one operation with one body from different tabs gets one key
 * and is recognized as a duplicate on the server.
 *
 * Outside a browser use memoryStorageSource or your own source on
 * top of Redis, KV, IndexedDB.
 *
 * @throws Error if localStorage is not available: SSR, Workers,
 *   disabled cookies. The error is thrown when the factory is
 *   called, not on the first request.
 */
export function localStorageSource(): IdempotencySource {
  return createSessionSource({
    storage: fromWebStorage(getLocalStorage()),
  });
}

/**
 * In-memory key source. Lives as long as the process; data is lost
 * on page reload. For tests, SSR, Workers and one-off operations.
 */
export function memoryStorageSource(): IdempotencySource {
  return createSessionSource({
    storage: createMemoryStorage(),
  });
}

function getSessionStorage(): Storage {
  if (typeof sessionStorage === 'undefined') {
    throw new Error(
      'sessionStorageSource is not available outside a browser. ' +
        'For SSR and tests use memoryStorageSource.',
    );
  }
  return sessionStorage;
}

function getLocalStorage(): Storage {
  if (typeof localStorage === 'undefined') {
    throw new Error(
      'localStorageSource is not available outside a browser. ' +
        'For SSR and tests use memoryStorageSource.',
    );
  }
  return localStorage;
}
