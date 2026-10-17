/**
 * Synchronous key-value storage. Compatible with localStorage and
 * sessionStorage. Async storages (IndexedDB, AsyncStorage) need an
 * adapter with a synchronous API.
 *
 * setItem must throw on write failure: without a saved key, a retry
 * after a lost response creates a duplicate. Reads and deletes are
 * not critical: getItem returns null, removeItem ignores errors.
 */
export interface StorageLike {
  /**
   * Value by key or null. Also null on read error: missing key and
   * read error cannot be told apart.
   */
  getItem(key: string): string | null;

  /**
   * Saves a value.
   *
   * @throws When the write is impossible (QuotaExceededError,
   *   read-only mode). The caller must abort the operation.
   */
  setItem(key: string, value: string): void;

  /** Removes a value. Missing key and delete errors are ignored. */
  removeItem(key: string): void;
}

/**
 * In-memory storage. Lives as long as the process; data is lost
 * after page reload.
 */
export function createMemoryStorage(): StorageLike {
  const map = new Map<string, string>();

  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

/**
 * Adapter over localStorage or sessionStorage.
 *
 * Browser storages may be unavailable or misbehave: Safari private
 * mode, quota overflow, disabled cookies.
 *
 * - getItem: null on error, the old record is not reused;
 * - removeItem: errors are ignored, cleanup is not critical;
 * - setItem: throws, the operation must be aborted.
 */
export function fromWebStorage(webStorage: Storage): StorageLike {
  return {
    getItem: (key) => {
      try {
        return webStorage.getItem(key);
      } catch {
        return null;
      }
    },

    setItem: (key, value) => {
      // No try/catch: a write error must reach the caller.
      webStorage.setItem(key, value);
    },

    removeItem: (key) => {
      try {
        webStorage.removeItem(key);
      } catch {
        // Cleanup is not critical.
      }
    },
  };
}
