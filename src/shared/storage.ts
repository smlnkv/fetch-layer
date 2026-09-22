/**
 * Минимальный интерфейс синхронного key-value хранилища.
 *
 * Совместим с localStorage и sessionStorage браузера. Для асинхронных
 * хранилищ (IndexedDB, AsyncStorage) нужен адаптер с синхронным API.
 *
 * Реализации должны выбрасывать исключение из setItem, если запись
 * не удалась: без сохранённого ключа повтор после потери ответа
 * создаст дубликат. Ошибки чтения и удаления не критичны:
 * getItem вернёт null, removeItem ничего не сделает.
 */
export interface StorageLike {
  /**
   * Значение по ключу или null. Может вернуть null и при ошибке
   * чтения: отличить "нет ключа" от "ошибка чтения" нельзя.
   */
  getItem(key: string): string | null;

  /**
   * Сохраняет значение.
   *
   * @throws Может выбросить, если запись невозможна:
   *   QuotaExceededError, хранилище только для чтения. Вызывающий
   *   код должен прервать операцию.
   */
  setItem(key: string, value: string): void;

  /**
   * Удаляет значение. Если ключа нет, ничего не делает.
   * Ошибки удаления игнорируются.
   */
  removeItem(key: string): void;
}

/**
 * Хранилище в оперативной памяти. Данные живут, пока живёт процесс.
 * Для восстановления после перезагрузки страницы не подходит.
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
 * Адаптер над localStorage или sessionStorage браузера.
 *
 * Браузерные хранилища могут быть недоступны или работать
 * некорректно: приватный режим Safari, переполнение квоты,
 * отключённые cookies.
 *
 * - getItem возвращает null при ошибке. Переиспользовать старую
 *   запись нельзя, будет создана новая;
 * - removeItem игнорирует ошибки: очистка идёт фоном;
 * - setItem выбрасывает исключение. Если ключ не сохранён,
 *   вызывающий код должен отказаться от операции.
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
      // Без try/catch: если запись не удалась, исключение должно
      // дойти до вызывающего кода.
      webStorage.setItem(key, value);
    },

    removeItem: (key) => {
      try {
        webStorage.removeItem(key);
      } catch {
        // Очистка идёт в фоне, неудача не критична.
      }
    },
  };
}
