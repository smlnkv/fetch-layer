import { ApiError } from '../../core/errors';
import { isSerializableBody } from '../../shared/classify-body';
import { assertInteger } from '../../shared/validators';

import { stableSerialize } from './serialize';

import type { IdempotencyContext, IdempotencyOutcome, IdempotencySource } from './types';
import type { QueryParams } from '../../core/types';
import type { StorageLike } from '../../shared/storage';

export interface SessionSourceOptions {
  /**
   * Storage. Wrap localStorage and sessionStorage in fromWebStorage,
   * use createMemoryStorage for Node.
   */
  storage: StorageLike;

  /** Key of the record object. Defaults to idempotency:session. */
  storageKey?: string;

  /**
   * Key generator. Defaults to crypto.randomUUID. Can be replaced
   * for tests or non-standard schemes.
   */
  generateKey?: () => string;

  /**
   * Max entries, defaults to 100. When exceeded, the least recently
   * used record is dropped.
   *
   * A record is a triple (scope, query, fingerprint): one scope with
   * different bodies takes several.
   */
  maxEntries?: number;
}

interface StoredEntry {
  key: string;
  lastUsedAt: number;
}

/**
 * Storage format: JSON.stringify(scope)|query|bodyHash -> record.
 * Scope is escaped via JSON.stringify, so `|` inside scope does not
 * collide with the separator.
 */
type Store = Record<string, StoredEntry>;

/**
 * Key source on top of a synchronous StorageLike.
 *
 * If a key exists for the triple (scope, query, fingerprint), it is
 * returned and its last-used time is updated. If the body or query
 * changed, or the pair is new, a new key is generated. On success
 * and definite-failure the record is deleted, on indefinite-failure
 * it is kept for the retry.
 *
 * Ready factories for sessionStorage, localStorage and memory live
 * in fetch-layers/layers.
 *
 * @throws Error if maxEntries is below 1.
 */
export function createSessionSource(options: SessionSourceOptions): IdempotencySource {
  const {
    storage,
    storageKey = 'idempotency:session',
    generateKey = defaultGenerateKey,
    maxEntries = 100,
  } = options;

  assertInteger(maxEntries, 'createSessionSource: maxEntries', 1);

  /**
   * On corrupt data starts from an empty object: the key will be
   * generated anew.
   */
  const read = (): Store => {
    const raw = storage.getItem(storageKey);
    if (!raw) return {};

    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Store)
        : {};
    } catch {
      return {};
    }
  };

  /**
   * On write error throws ApiError with kind storage: the client
   * must not send a request without a way to retry correctly.
   */
  const write = (store: Store): void => {
    try {
      storage.setItem(storageKey, JSON.stringify(store));
    } catch (e) {
      throw new ApiError({
        kind: 'storage',
        code: 'IDEMPOTENCY_STORAGE_ERROR',
        message: 'Failed to save idempotency key to storage',
        cause: e,
      });
    }
  };

  /**
   * null for a non-serializable body: a stable fingerprint is
   * impossible, the source generates a new key without saving it.
   */
  const entryKey = (context: IdempotencyContext): string | null => {
    if (!isSerializableBody(context.body)) return null;

    const scope = context.scope ?? `${context.method} ${context.path}`;
    const queryPart = serializeQueryForFingerprint(context.query);

    const parts = [JSON.stringify(scope)];
    if (queryPart !== '') parts.push(queryPart);
    parts.push(stableSerialize(context.body));

    return parts.join('|');
  };

  const validateKey = (key: unknown): string => {
    if (typeof key !== 'string' || key.trim() === '') {
      throw new ApiError({
        kind: 'serialize',
        code: 'IDEMPOTENCY_KEY_INVALID',
        message: 'Idempotency key generator returned an empty string',
      });
    }
    return key;
  };

  return {
    nextKey(context) {
      const key = entryKey(context);

      // For a non-serializable body a new key on every call, not
      // stored: otherwise a retry with a different body of the same
      // type could reuse the key.
      if (key === null) {
        return validateKey(generateKey());
      }

      const store = read();
      const existing = store[key];

      // Refresh the last-used time so the active key is not evicted
      // on overflow.
      if (existing) {
        store[key] = { key: existing.key, lastUsedAt: Date.now() };
        write(store);
        return existing.key;
      }

      const newKey = validateKey(generateKey());
      store[key] = { key: newKey, lastUsedAt: Date.now() };

      const keys = Object.keys(store);
      if (keys.length > maxEntries) {
        keys.sort((a, b) => (store[a]?.lastUsedAt ?? 0) - (store[b]?.lastUsedAt ?? 0));
        const toRemove = keys.slice(0, keys.length - maxEntries);
        for (const k of toRemove) delete store[k];
      }

      write(store);
      return newKey;
    },

    resolve(context, outcome: IdempotencyOutcome) {
      if (outcome === 'indefinite-failure') return;

      const key = entryKey(context);

      // A non-serializable body was not stored, nothing to delete.
      if (key === null) return;

      const store = read();
      if (store[key]) {
        delete store[key];
        write(store);
      }
    },
  };
}

/**
 * Query params fingerprint. undefined and null are skipped: they do
 * not go into the URL and so do not affect the fingerprint. An empty
 * result means query is not part of the fingerprint.
 */
function serializeQueryForFingerprint(query: QueryParams | undefined): string {
  if (!query) return '';

  const filtered: Record<string, unknown> = {};
  let hasAny = false;

  for (const key of Object.keys(query)) {
    const value = query[key];
    if (value !== undefined && value !== null) {
      filtered[key] = value;
      hasAny = true;
    }
  }

  return hasAny ? stableSerialize(filtered) : '';
}

/** @throws Error if crypto.randomUUID is not available. */
function defaultGenerateKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  throw new Error(
    'crypto.randomUUID is not available. fetch-layers requires Node >= 20 or a modern browser.',
  );
}
