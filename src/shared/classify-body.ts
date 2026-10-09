/**
 * Единый классификатор тела запроса. Транспорт по категории решает,
 * как подготовить тело для fetch; слой идемпотентности - можно ли
 * вычислить стабильный отпечаток.
 *
 * Проверки через Object.prototype.toString, а не instanceof:
 * instanceof не работает между realm, а тела часто приходят
 * из iframe или worker.
 */

export type BodyKind =
  | 'undefined'
  | 'json'
  | 'string'
  | 'form-data'
  | 'blob'
  | 'binary'
  | 'stream'
  | 'url-search-params'
  | 'unsupported';

/**
 * Категории, которые JSON.stringify превратил бы в {} или
 * в бессмысленное значение. Вложенные значения этих категорий
 * отклоняются в prepareJsonBody.
 */
export type UnsupportedKind = 'unsupported';

/**
 * Blob и File обрабатываются одинаково, отдельная категория для
 * File не нужна: точное имя типа для сообщений об ошибках даёт
 * getTypeName.
 *
 * Node.js stream.Readable не имеет собственного тега и требует
 * duck-typing: проверяются pipe, on и Symbol.asyncIterator.
 * Web ReadableStream под эту проверку не подходит: у него нет pipe.
 *
 * Всё, что не попало в известные категории, считается json:
 * примитивы (кроме строки), массивы, plain-объекты, Date, BigInt.
 * BigInt отклонится на этапе JSON.stringify.
 */
export function classifyBody(value: unknown): BodyKind {
  if (value === undefined || value === null) return 'undefined';

  const tag = Object.prototype.toString.call(value);

  switch (tag) {
    case '[object FormData]':
      return 'form-data';
    case '[object Blob]':
    case '[object File]':
      return 'blob';
    case '[object ArrayBuffer]':
      return 'binary';
    case '[object ReadableStream]':
      return 'stream';
    case '[object URLSearchParams]':
      return 'url-search-params';
    case '[object Map]':
    case '[object Set]':
    case '[object WeakMap]':
    case '[object WeakSet]':
    case '[object RegExp]':
    case '[object Error]':
      return 'unsupported';
  }

  if (typeof value === 'string') return 'string';

  if (ArrayBuffer.isView(value)) return 'binary';

  if (isNodeReadable(value)) return 'stream';

  return 'json';
}

/**
 * true для тел, которые можно стабильно сериализовать: отсутствие
 * тела, JSON-совместимые значения, строки. Используется слоем
 * идемпотентности и рекурсивной проверкой вложенных значений.
 */
export function isSerializableKind(kind: BodyKind): boolean {
  return kind === 'undefined' || kind === 'json' || kind === 'string';
}

/**
 * true для типов, которые JSON.stringify превратил бы в {} на
 * верхнем уровне. Транспорт отклоняет их до отправки: без этой
 * проверки сервер получил бы пустой объект вместо данных.
 */
export function isUnsupportedKind(kind: BodyKind): kind is UnsupportedKind {
  return kind === 'unsupported';
}

export function isSerializableBody(value: unknown): boolean {
  return isSerializableKind(classifyBody(value));
}

/**
 * true для потоковых тел. Web ReadableStream и Node.js stream.Readable
 * одноразовые: после первой отправки повторный fetch выбросит
 * TypeError. Транспорт по этому признаку ставит duplex: 'half',
 * retry-слой отключает повторы.
 */
export function isStreamingBody(value: unknown): boolean {
  return classifyBody(value) === 'stream';
}

/**
 * Человекочитаемое имя типа для сообщений об ошибках. Опирается
 * на Symbol.toStringTag и duck-typing для Node.js stream.
 * Отдельная от BodyKind: категория описывает логику обработки,
 * имя - то, что увидит разработчик.
 */
export function getTypeName(value: unknown): string {
  if (isNodeReadable(value)) return 'NodeReadable';
  return Object.prototype.toString.call(value).slice(8, -1);
}

interface NodeReadableLike {
  pipe: (...args: unknown[]) => unknown;
  on: (...args: unknown[]) => unknown;
  [Symbol.asyncIterator]: () => AsyncIterator<unknown>;
}

function isNodeReadable(value: unknown): value is NodeReadableLike {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string | symbol, unknown>;
  return (
    typeof candidate['pipe'] === 'function' &&
    typeof candidate['on'] === 'function' &&
    typeof candidate[Symbol.asyncIterator] === 'function'
  );
}
