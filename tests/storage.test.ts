// Тесты shared/storage.ts: createMemoryStorage, fromWebStorage.

import { describe, expect, it } from 'vitest';

import { createMemoryStorage, fromWebStorage } from '../src/shared/storage';

describe('createMemoryStorage', () => {
  it('сохраняет, читает, перезаписывает', () => {
    const storage = createMemoryStorage();
    storage.setItem('key', 'value');
    expect(storage.getItem('key')).toBe('value');

    storage.setItem('key', 'value2');
    expect(storage.getItem('key')).toBe('value2');
  });

  it('null для отсутствующего ключа, удаление идемпотентно', () => {
    const storage = createMemoryStorage();
    expect(storage.getItem('missing')).toBeNull();
    expect(() => storage.removeItem('missing')).not.toThrow();

    storage.setItem('key', 'value');
    storage.removeItem('key');
    expect(storage.getItem('key')).toBeNull();
  });

  it('изолировано между экземплярами', () => {
    const storage1 = createMemoryStorage();
    const storage2 = createMemoryStorage();

    storage1.setItem('key', 'value1');
    storage2.setItem('key', 'value2');

    expect(storage1.getItem('key')).toBe('value1');
    expect(storage2.getItem('key')).toBe('value2');
  });
});

function createFakeStorage(overrides: Partial<Storage> = {}): Storage {
  const map = new Map<string, string>();

  const storage = {
    get length() {
      return map.size;
    },
    key(i: number): string | null {
      return Array.from(map.keys())[i] ?? null;
    },
    getItem(k: string): string | null {
      return map.get(k) ?? null;
    },
    setItem(k: string, v: string): void {
      map.set(k, v);
    },
    removeItem(k: string): void {
      map.delete(k);
    },
    clear(): void {
      map.clear();
    },
    ...overrides,
  };

  return storage as Storage;
}

describe('fromWebStorage', () => {
  it('делегирует обычные операции в базовое хранилище', () => {
    const web = createFakeStorage();
    const storage = fromWebStorage(web);

    storage.setItem('key', 'value');
    expect(storage.getItem('key')).toBe('value');
    expect(web.getItem('key')).toBe('value');

    storage.removeItem('key');
    expect(storage.getItem('key')).toBeNull();
    expect(storage.getItem('missing')).toBeNull();
  });

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
