import { ApiError } from '../../core/errors';

/**
 * false для типов, которые сериализуются в {}: у них нет перечисляемых
 * свойств, и два разных тела дали бы один отпечаток ключа
 * идемпотентности. Это FormData, Blob, ArrayBuffer, TypedArray,
 * ReadableStream, URLSearchParams.
 *
 * undefined и null дают true: отсутствие тела - стабильное состояние.
 *
 * Проверки через Object.prototype.toString, а не instanceof:
 * instanceof не работает между realm, а тела часто приходят
 * из iframe или worker. ArrayBuffer.isView cross-realm -
 * это статический метод.
 */
export function isSerializableBody(value: unknown): boolean {
  if (value === undefined || value === null) return true;

  if (
    typeof FormData !== 'undefined' &&
    Object.prototype.toString.call(value) === '[object FormData]'
  ) {
    return false;
  }
  if (typeof Blob !== 'undefined' && Object.prototype.toString.call(value) === '[object Blob]') {
    return false;
  }
  if (
    typeof ArrayBuffer !== 'undefined' &&
    Object.prototype.toString.call(value) === '[object ArrayBuffer]'
  ) {
    return false;
  }
  if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(value)) return false;
  if (
    typeof ReadableStream !== 'undefined' &&
    Object.prototype.toString.call(value) === '[object ReadableStream]'
  ) {
    return false;
  }
  if (
    typeof URLSearchParams !== 'undefined' &&
    Object.prototype.toString.call(value) === '[object URLSearchParams]'
  ) {
    return false;
  }

  return true;
}

/**
 * Стабильная сериализация значения. Ключи объектов сортируются
 * в алфавитном порядке, поэтому результат не зависит от порядка
 * вставки. В остальном поведение совпадает с JSON.stringify.
 *
 * Тот же алгоритм, что использует встроенный createSessionSource
 * для отпечатков тел. Совпадает с ним по формату, поэтому подходит
 * для кастомных IdempotencySource.
 *
 * Map и Set сериализуются как {}: у них нет перечисляемых свойств.
 * Два разных Map с одинаковыми размерами дадут одинаковый отпечаток.
 * Если тело содержит Map или Set, преобразуйте его в массив пар
 * перед вычислением отпечатка.
 *
 * @throws ApiError с кодом BODY_SERIALIZATION_ERROR при циклических
 *   ссылках или BigInt. Сырой TypeError нормализуется в тот же код,
 *   что и в prepareBody, чтобы приложение обрабатывало один класс
 *   ошибок.
 *
 * @public
 * @stableSince 0.1.0
 */
export function stableSerialize(value: unknown): string {
  try {
    return serialize(value, new WeakSet<object>());
  } catch (e) {
    if (e instanceof TypeError) {
      throw new ApiError({
        kind: 'serialize',
        code: 'BODY_SERIALIZATION_ERROR',
        message: 'Failed to serialize value',
        cause: e,
      });
    }
    throw e;
  }
}

/**
 * seen отслеживает объекты на текущем пути обхода. Это позволяет
 * отличать общую ссылку (один объект в разных ветках, допустима)
 * от циклической (объект ссылается сам на себя, запрещена -
 * выбрасывается TypeError).
 *
 * Объект добавляется в seen до обхода полей и удаляется после,
 * поэтому "посещён" здесь означает "находится в стеке рекурсии
 * прямо сейчас".
 */
function serialize(value: unknown, seen: WeakSet<object>): string {
  // Как в JSON.stringify: позволяет работать с Date, URL и другими
  // типами, у которых toJSON определён.
  if (value && typeof value === 'object') {
    const toJSON = (value as { toJSON?: () => unknown }).toJSON;
    if (typeof toJSON === 'function') {
      value = toJSON.call(value);
    }
  }

  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }

  const obj = value as object;
  if (seen.has(obj)) {
    throw new TypeError('Converting circular structure to JSON');
  }
  seen.add(obj);

  try {
    if (Array.isArray(obj)) {
      const parts: string[] = new Array(obj.length);
      for (let i = 0; i < obj.length; i++) {
        const item = obj[i];
        parts[i] =
          item === undefined || typeof item === 'function' || typeof item === 'symbol'
            ? 'null'
            : serialize(item, seen);
      }
      return '[' + parts.join(',') + ']';
    }

    const record = obj as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const parts: string[] = [];
    for (const key of keys) {
      const v = record[key];
      if (v === undefined || typeof v === 'function' || typeof v === 'symbol') {
        continue;
      }
      parts.push(JSON.stringify(key) + ':' + serialize(v, seen));
    }
    return '{' + parts.join(',') + '}';
  } finally {
    // Убираем из стека: это разрешает общие ссылки и запрещает
    // только настоящие циклы.
    seen.delete(obj);
  }
}
