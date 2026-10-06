import { ApiError } from '../../core/errors';

/**
 * Имя типа, для которого стабильный отпечаток невозможен: либо
 * нет перечисляемых свойств (JSON.stringify даёт {}), либо тело
 * отправляется транспортом в собственном формате (FormData, Blob,
 * File, ArrayBuffer, TypedArray, ReadableStream, URLSearchParams).
 * null для остальных значений.
 *
 * Проверка через Object.prototype.toString, а не instanceof:
 * instanceof не работает между realm, а тела часто приходят
 * из iframe или worker. ArrayBuffer.isView cross-realm.
 */
function detectUnsupportedType(value: unknown): string | null {
  if (value === null || typeof value !== 'object') return null;

  switch (Object.prototype.toString.call(value)) {
    case '[object FormData]':
      return 'FormData';
    case '[object Blob]':
      return 'Blob';
    // File расширяет Blob, но имеет собственный Symbol.toStringTag
    // и собственный тег. Разные имена в сообщении об ошибке точнее
    // отражают, что именно пришло в тело запроса.
    case '[object File]':
      return 'File';
    case '[object ArrayBuffer]':
      return 'ArrayBuffer';
    case '[object ReadableStream]':
      return 'ReadableStream';
    case '[object URLSearchParams]':
      return 'URLSearchParams';
    case '[object Map]':
      return 'Map';
    case '[object Set]':
      return 'Set';
    case '[object WeakMap]':
      return 'WeakMap';
    case '[object WeakSet]':
      return 'WeakSet';
    case '[object RegExp]':
      return 'RegExp';
    case '[object Error]':
      return 'Error';
  }

  if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(value)) {
    return 'TypedArray';
  }

  return null;
}

/**
 * true для значений, для которых стабильный отпечаток возможен.
 *
 * undefined и null дают true: отсутствие тела - стабильное состояние.
 * FormData, Blob, File, ArrayBuffer, TypedArray, ReadableStream,
 * URLSearchParams, Map, Set, WeakMap, WeakSet, RegExp и Error
 * дают false: отпечаток либо невозможен, либо бесполезен
 * (createSessionSource сгенерирует новый ключ без сохранения).
 */
export function isSerializableBody(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  return detectUnsupportedType(value) === null;
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
 * @throws ApiError с кодом BODY_SERIALIZATION_ERROR при циклических
 *   ссылках, BigInt и типах без перечисляемых свойств: FormData,
 *   Blob, File, ArrayBuffer, TypedArray, ReadableStream,
 *   URLSearchParams, Map, Set, WeakMap, WeakSet, RegExp, Error.
 *   Сырой TypeError нормализуется в тот же код, что и в prepareBody,
 *   чтобы приложение обрабатывало один класс ошибок.
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
  // Проверка до toJSON: контракт "несериализуемые типы отклоняются"
  // не должен обходиться через пользовательский toJSON.
  const unsupported = detectUnsupportedType(value);
  if (unsupported !== null) {
    throw new TypeError(`Cannot serialize ${unsupported} to a stable JSON string`);
  }

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
