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
  | 'file'
  | 'array-buffer'
  | 'typed-array'
  | 'readable-stream'
  | 'node-readable'
  | 'url-search-params'
  | 'map'
  | 'set'
  | 'weak-map'
  | 'weak-set'
  | 'regexp'
  | 'error';

/**
 * Подмножество BodyKind, которое JSON.stringify превратил бы в {}
 * или в бессмысленное значение. Type guard: после isUnsupportedKind
 * компилятор знает, что kind не входит в этот набор, и switch
 * по остальным категориям становится исчерпывающим.
 */
export type UnsupportedKind = 'map' | 'set' | 'weak-map' | 'weak-set' | 'regexp' | 'error';

/**
 * File наследуется от Blob, но имеет собственный Symbol.toStringTag.
 * Отдельная категория нужна для сообщений об ошибках: разработчик,
 * передавший File, должен видеть File, а не Blob. Обрабатываются
 * они одинаково.
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
    case '[object File]':
      return 'file';
    case '[object Blob]':
      return 'blob';
    case '[object ArrayBuffer]':
      return 'array-buffer';
    case '[object ReadableStream]':
      return 'readable-stream';
    case '[object URLSearchParams]':
      return 'url-search-params';
    case '[object Map]':
      return 'map';
    case '[object Set]':
      return 'set';
    case '[object WeakMap]':
      return 'weak-map';
    case '[object WeakSet]':
      return 'weak-set';
    case '[object RegExp]':
      return 'regexp';
    case '[object Error]':
      return 'error';
  }

  if (typeof value === 'string') return 'string';

  if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(value)) {
    return 'typed-array';
  }

  if (isNodeReadableBody(value)) return 'node-readable';

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
 * true для типов, которые JSON.stringify превратил бы в {} на верхнем
 * уровне. Транспорт отклоняет их до отправки: без этой проверки
 * сервер получил бы пустой объект вместо данных.
 */
export function isUnsupportedKind(kind: BodyKind): kind is UnsupportedKind {
  return (
    kind === 'map' ||
    kind === 'set' ||
    kind === 'weak-map' ||
    kind === 'weak-set' ||
    kind === 'regexp' ||
    kind === 'error'
  );
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
  const kind = classifyBody(value);
  return kind === 'readable-stream' || kind === 'node-readable';
}

const KIND_NAMES: Record<BodyKind, string> = {
  undefined: 'undefined',
  json: 'object',
  string: 'string',
  'form-data': 'FormData',
  blob: 'Blob',
  file: 'File',
  'array-buffer': 'ArrayBuffer',
  'typed-array': 'TypedArray',
  'readable-stream': 'ReadableStream',
  'node-readable': 'NodeReadable',
  'url-search-params': 'URLSearchParams',
  map: 'Map',
  set: 'Set',
  'weak-map': 'WeakMap',
  'weak-set': 'WeakSet',
  regexp: 'RegExp',
  error: 'Error',
};

/**
 * Человекочитаемое имя категории для сообщений об ошибках.
 * Отдельная от BodyKind, потому что категория - это про логику,
 * а имя - про текст, который увидит разработчик.
 */
export function bodyKindName(kind: BodyKind): string {
  return KIND_NAMES[kind];
}

interface NodeReadableLike {
  pipe: (...args: unknown[]) => unknown;
  on: (...args: unknown[]) => unknown;
  [Symbol.asyncIterator]: () => AsyncIterator<unknown>;
}

function isNodeReadableBody(value: unknown): value is NodeReadableLike {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string | symbol, unknown>;
  return (
    typeof candidate['pipe'] === 'function' &&
    typeof candidate['on'] === 'function' &&
    typeof candidate[Symbol.asyncIterator] === 'function'
  );
}
