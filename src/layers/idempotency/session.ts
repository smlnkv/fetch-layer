import { ApiError } from '../../core/errors';
import { isSerializableBody } from '../../shared/classify-body';
import { assertInteger } from '../../shared/validators';

import { stableSerialize } from './serialize';

import type { IdempotencyContext, IdempotencyOutcome, IdempotencySource } from './types';
import type { QueryParams } from '../../core/types';
import type { StorageLike } from '../../shared/storage';

export interface SessionSourceOptions {
  /**
   * Хранилище. Обычно sessionStorage, обёрнутый в fromWebStorage.
   * В Node используется createMemoryStorage.
   */
  storage: StorageLike;

  /** Ключ объекта с записями в хранилище. По умолчанию idempotency:session. */
  storageKey?: string;

  /**
   * Генератор ключей. По умолчанию crypto.randomUUID. Можно
   * подменить для тестов или нестандартных схем идентификаторов.
   */
  generateKey?: () => string;

  /**
   * Максимум записей в хранилище, по умолчанию 100. При превышении
   * удаляется самая старая по времени использования.
   *
   * Запись - это тройка (scope, query, отпечаток тела), поэтому один
   * scope с разными телами занимает несколько записей.
   */
  maxEntries?: number;
}

/**
 * Ключ идемпотентности плюс время последнего использования - для
 * вытеснения при переполнении.
 */
interface StoredEntry {
  key: string;
  lastUsedAt: number;
}

/**
 * Формат хранилища: JSON.stringify(scope)|query|bodyHash -> запись.
 * Scope экранируется через JSON.stringify, чтобы символ `|` внутри
 * scope не давал коллизий с разделителем. query - стабильный
 * отпечаток query-параметров, тоже JSON-строка.
 */
type Store = Record<string, StoredEntry>;

/**
 * Источник ключей на базе синхронного хранилища. Все ключи живут
 * в одном JSON-объекте.
 *
 * Если для тройки (scope, query, отпечаток тела) уже есть ключ,
 * возвращается он и обновляется время использования. Если тело
 * или query изменились, либо пары ещё нет - генерируется новый.
 * При success и definite-failure запись удаляется, при
 * indefinite-failure - сохраняется для повтора.
 *
 * Для типовых хранилищ (sessionStorage, localStorage, память) лучше
 * готовые фабрики из fetch-layer/layers. createSessionSource нужен
 * для кастомных StorageLike.
 *
 * @throws Error если maxEntries меньше 1.
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
   * При повреждённых данных начинает с пустого объекта: это
   * безопаснее, чем падать, ключ будет сгенерирован заново.
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
   * Если запись не удалась, выбрасывает ApiError с kind storage:
   * клиент не должен отправлять запрос без возможности корректного
   * повтора.
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
   * Возвращает null для несериализуемого тела: стабильный отпечаток
   * невозможен, источник сгенерирует новый ключ без сохранения.
   *
   * Если stableSerialize не сможет сериализовать тело (циклическая
   * ссылка, BigInt), выбросит ApiError с кодом
   * BODY_SERIALIZATION_ERROR.
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

  /**
   * Пустая строка и whitespace-only считаются невалидным ключом,
   * так же как в withIdempotency.
   */
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

      // Для несериализуемого тела - новый ключ на каждый вызов,
      // в хранилище не сохраняем: иначе повтор с другим телом
      // того же типа мог бы переиспользовать ключ.
      if (key === null) {
        return validateKey(generateKey());
      }

      const store = read();
      const existing = store[key];

      // Обновляем время использования, чтобы активный ключ
      // не был вытеснен при переполнении.
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

      // Несериализуемое тело не записывалось, удалять нечего.
      // Если тело стало несериализуемым между nextKey и resolve
      // (мутация), запись останется до вытеснения по maxEntries.
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
 * Стабильный отпечаток query-параметров. undefined и null
 * пропускаются: они не попадают в URL, значит и на отпечаток
 * не влияют. Пустой результат (нет query или все значения
 * пропущены) означает, что query в отпечаток не включается.
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

/**
 * @throws Error если crypto.randomUUID недоступен.
 */
function defaultGenerateKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  throw new Error(
    'crypto.randomUUID is not available. fetch-layer requires Node >= 20 or a modern browser.',
  );
}
