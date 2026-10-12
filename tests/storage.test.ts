// Тесты shared/storage.ts: createMemoryStorage, fromWebStorage.

import { describe, expect, it } from 'vitest';

import { createMemoryStorage, fromWebStorage } from '../src/shared/storage';

describe('createMemoryStorage', () => {
  it('сохраняет, читает, перезаписывает, удаляет', () => {
    const storage = createMemoryStorage();

    storage.setItem('key', 'value');
    expect(storage.getItem('key')).toBe('value');

    storage.setItem('key', 'value2');
    expect(storage.getItem('key')).toBe('value2');

    storage.removeItem('key');
    expect(storage.getItem('key')).toBeNull();
  });
});

function createFakeStorage(overrides: Partial<Storage> = {}): Storage {
  const map = new Map<string, string>();

  const storage = {
    getItem: (k: string): string | null => map.get(k) ?? null,
    setItem: (k: string, v: string): void => {
      map.set(k, v);
    },
    removeItem: (k: string): void => {
      map.delete(k);
    },
    ...overrides,
  };

  return storage as Storage;
}

describe('fromWebStorage', () => {
  it('getItem возвращает null при сбое, setItem ошибку, removeItem игнорирует', () => {
    const failingGet = createFakeStorage({
      getItem: () => {
        throw new DOMException('Private mode', 'SecurityError');
      },
    });
    expect(fromWebStorage(failingGet).getItem('key')).toBeNull();

    const failingSet = createFakeStorage({
      setItem: () => {
        throw new DOMException('Quota exceeded', 'QuotaExceededError');
      },
    });
    expect(() => fromWebStorage(failingSet).setItem('key', 'value')).toThrow();

    const failingRemove = createFakeStorage({
      removeItem: () => {
        throw new DOMException('Forbidden', 'SecurityError');
      },
    });
    expect(() => fromWebStorage(failingRemove).removeItem('key')).not.toThrow();
  });
});
