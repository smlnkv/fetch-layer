import { ApiError } from '../../core/errors';
import { classifyBody, getTypeName, isSerializableKind } from '../../shared/classify-body';

/**
 * Стабильная сериализация значения. Ключи объектов сортируются
 * в алфавитном порядке, поэтому результат не зависит от порядка
 * вставки. В остальном поведение совпадает с JSON.stringify,
 * включая обработку toJSON, возвращающего undefined.
 *
 * Правило допустимых типов то же, что у prepareBody в транспорте:
 * значение должно быть сериализуемо в JSON как есть и после вызова
 * toJSON. Иначе два разных тела получили бы одинаковый отпечаток
 * и, значит, один ключ идемпотентности.
 *
 * @throws ApiError с кодом BODY_SERIALIZATION_ERROR при циклических
 *   ссылках, BigInt и типах, не сериализуемых в JSON: FormData, Blob,
 *   File, ArrayBuffer, TypedArray, ReadableStream, Node.js
 *   stream.Readable, URLSearchParams, Map, Set, WeakMap, WeakSet,
 *   RegExp, Error.
 *
 * @public
 */
export function stableSerialize(value: unknown): string {
  try {
    return serialize(value, new WeakSet<object>()) ?? 'null';
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
 *
 * Возвращает undefined для значений, которые JSON.stringify
 * пропускает: undefined, функции, Symbol. Родитель решает, как
 * поступить - пропустить свойство объекта или записать null
 * в массиве.
 */
function serialize(value: unknown, seen: WeakSet<object>): string | undefined {
  // Проверка до toJSON: контракт "несериализуемые типы отклоняются"
  // не должен обходиться через пользовательский toJSON.
  const kind = classifyBody(value);
  if (!isSerializableKind(kind)) {
    throw new TypeError(`Cannot serialize ${getTypeName(value)} to a stable JSON string`);
  }

  // Как в JSON.stringify: позволяет работать с Date, URL и другими
  // типами, у которых toJSON определён.
  if (value && typeof value === 'object') {
    const toJSON = (value as { toJSON?: () => unknown }).toJSON;
    if (typeof toJSON === 'function') {
      value = toJSON.call(value);

      // Повторная проверка после toJSON, как в prepareJsonBody.
      // toJSON может вернуть Map, Set, Blob или другой несериализуемый
      // тип. Без этой проверки значение прошло бы через рекурсию
      // и превратилось в {}, дав одинаковый отпечаток разным телам.
      const afterKind = classifyBody(value);
      if (!isSerializableKind(afterKind)) {
        throw new TypeError(`toJSON returned ${getTypeName(value)}: cannot serialize`);
      }
    }
  }

  // Значения, которые JSON.stringify пропускает. Родитель решает,
  // как поступить: свойство объекта опускается, элемент массива
  // становится null.
  if (value === undefined) return undefined;
  if (typeof value === 'function' || typeof value === 'symbol') return undefined;

  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
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
        parts[i] = serialize(item, seen) ?? 'null';
      }
      return '[' + parts.join(',') + ']';
    }

    const record = obj as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const parts: string[] = [];
    for (const key of keys) {
      const serialized = serialize(record[key], seen);
      if (serialized === undefined) continue;
      parts.push(JSON.stringify(key) + ':' + serialized);
    }
    return '{' + parts.join(',') + '}';
  } finally {
    // Убираем из стека: это разрешает общие ссылки и запрещает
    // только настоящие циклы.
    seen.delete(obj);
  }
}
