/**
 * Определение потоковых тел запроса. Используется транспортом
 * (установка duplex: 'half'), слоем идемпотентности (распознавание
 * несериализуемых тел) и retry-слоем (отказ от повторов одноразовых
 * потоков).
 */

/**
 * Web ReadableStream. Проверка через Object.prototype.toString,
 * а не instanceof: работает между realm, у потока нет перечисляемых
 * свойств (stableSerialize вернул бы '{}' для любого потока, и два
 * разных потока получили бы одинаковый отпечаток ключа), а глобальный
 * конструктор может отсутствовать в окружении.
 */
export function isReadableStreamBody(value: unknown): value is ReadableStream<Uint8Array> {
  return (
    typeof ReadableStream !== 'undefined' &&
    Object.prototype.toString.call(value) === '[object ReadableStream]'
  );
}

/**
 * Форма Node.js stream.Readable, достаточная для передачи в fetch.
 * Fetch в Node 20+ принимает async iterable как тело.
 *
 * Duck-typing, а не instanceof: stream.Readable может приходить
 * из другого realm или из другой версии модуля stream. Проверяются
 * три признака: pipe, on и Symbol.asyncIterator. Web ReadableStream
 * под эту проверку не подходит: у него нет pipe, а есть
 * pipeTo/pipeThrough.
 */
export interface NodeReadableLike {
  pipe: (...args: unknown[]) => unknown;
  on: (...args: unknown[]) => unknown;
  [Symbol.asyncIterator]: () => AsyncIterator<unknown>;
}

export function isNodeReadableBody(value: unknown): value is NodeReadableLike {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string | symbol, unknown>;
  return (
    typeof candidate['pipe'] === 'function' &&
    typeof candidate['on'] === 'function' &&
    typeof candidate[Symbol.asyncIterator] === 'function'
  );
}

/**
 * Любой потоковый body: Web ReadableStream или Node.js stream.Readable.
 * Используется транспортом для установки duplex: 'half'.
 */
export function isStreamingBody(value: unknown): boolean {
  return isReadableStreamBody(value) || isNodeReadableBody(value);
}
