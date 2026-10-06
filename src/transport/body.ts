import { ApiError } from '../core/errors';

import type { ResponseType } from '../core/types';

/**
 * Проверки типов через Object.prototype.toString, а не instanceof:
 * instanceof не работает между realm - FormData из iframe или worker
 * не пройдёт проверку в родительском окне, конструкторы разные.
 * Глобальный конструктор тоже может отсутствовать, поэтому typeof.
 */
function isFormData(value: unknown): value is FormData {
  return (
    typeof FormData !== 'undefined' && Object.prototype.toString.call(value) === '[object FormData]'
  );
}

/**
 * File расширяет Blob в спецификации, но имеет собственный
 * Symbol.toStringTag = 'File'. Object.prototype.toString.call(file)
 * даёт '[object File]', а не '[object Blob]', поэтому проверка
 * только по тегу Blob пропускает File и он уходит в JSON.stringify
 * как '{}'. Принимаем оба тега.
 */
function isBlob(value: unknown): value is Blob {
  if (typeof Blob === 'undefined') return false;
  const tag = Object.prototype.toString.call(value);
  return tag === '[object Blob]' || tag === '[object File]';
}

function isArrayBuffer(value: unknown): value is ArrayBuffer {
  return (
    typeof ArrayBuffer !== 'undefined' &&
    Object.prototype.toString.call(value) === '[object ArrayBuffer]'
  );
}

function isURLSearchParams(value: unknown): value is URLSearchParams {
  return (
    typeof URLSearchParams !== 'undefined' &&
    Object.prototype.toString.call(value) === '[object URLSearchParams]'
  );
}

/**
 * У ReadableStream нет перечисляемых свойств: stableSerialize
 * вернул бы '{}' для любого потока, и два разных потока получили бы
 * одинаковый отпечаток ключа идемпотентности. Проверка через
 * Object.prototype.toString по той же причине, что и выше.
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
interface NodeReadableLike {
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

/**
 * Имя типа, у которого JSON.stringify даст {}: перечисляемых свойств
 * нет, и тело доедет до сервера пустым. Проверка через
 * Object.prototype.toString работает между realm.
 */
function detectJSONUnfriendlyType(value: unknown): string | null {
  if (value === null || typeof value !== 'object') return null;

  switch (Object.prototype.toString.call(value)) {
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
    default:
      return null;
  }
}

/**
 * Исключение, которое replacer JSON.stringify выбрасывает при
 * обнаружении неподдерживаемого типа. Отдельный класс отличает эту
 * ситуацию от других ошибок сериализации (BigInt, циклы): только
 * здесь известно имя типа, и сообщение об ошибке получает
 * конкретную подсказку.
 */
class UnsupportedBodyTypeError extends TypeError {
  readonly typeName: string;

  constructor(typeName: string) {
    super(`Request body contains a ${typeName}`);
    this.typeName = typeName;
  }
}

/**
 * contentType === undefined означает, что транспорт не должен
 * выставлять заголовок: либо тело отсутствует, либо решение
 * принимает браузер (FormData с boundary), либо приложение уже
 * задало свой.
 */
export interface PreparedBody {
  body: BodyInit | undefined;
  contentType: string | undefined;
}

/**
 * Определяет природу тела и готовит его для fetch. Возвращает тело
 * и рекомендованный Content-Type. Если приложение задало
 * Content-Type явно, транспорт его не перезаписывает.
 *
 * Для стримов (Web ReadableStream и Node.js stream.Readable)
 * Content-Type не выставляется: поток может содержать бинарные
 * данные, текст, JSON Lines. Приложение задаёт тип явно, если он
 * важен для сервера.
 *
 * @throws ApiError с кодом BODY_SERIALIZATION_ERROR, если тело
 *   не удалось сериализовать в JSON: циклические ссылки, BigInt,
 *   Map, Set, WeakMap, WeakSet, RegExp, Error. Для последних
 *   JSON.stringify вернул бы {}, и сервер получил бы пустой объект
 *   вместо данных. Проверка рекурсивная: неподдерживаемый тип
 *   на любом уровне вложенности отклоняет запрос.
 */
export function prepareBody(value: unknown): PreparedBody {
  if (value === undefined || value === null) {
    return { body: undefined, contentType: undefined };
  }

  // Content-Type подставит браузер с правильной boundary.
  if (isFormData(value)) {
    return { body: value, contentType: undefined };
  }

  if (isBlob(value)) {
    return {
      body: value,
      contentType: value.type || 'application/octet-stream',
    };
  }

  if (isArrayBuffer(value)) {
    return { body: value, contentType: 'application/octet-stream' };
  }

  // TypedArray (Uint8Array, Int32Array и другие) и DataView.
  // ArrayBuffer.isView cross-realm: это статический метод.
  if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(value)) {
    return { body: value as BodyInit, contentType: 'application/octet-stream' };
  }

  // Web ReadableStream. Транспорт добавит duplex: 'half' в
  // RequestInit, без него fetch выбрасывает TypeError.
  if (isReadableStreamBody(value)) {
    return { body: value, contentType: undefined };
  }

  // Node.js stream.Readable. Fetch в Node 20+ принимает его как
  // async iterable. Транспорт тоже установит duplex: 'half'.
  if (isNodeReadableBody(value)) {
    return { body: value as unknown as BodyInit, contentType: undefined };
  }

  if (isURLSearchParams(value)) {
    return {
      body: value,
      contentType: 'application/x-www-form-urlencoded;charset=UTF-8',
    };
  }

  // Content-Type для строки не навязываем: приложение может
  // отправить text/plain, text/csv, text/html и что угодно ещё.
  if (typeof value === 'string') {
    return { body: value, contentType: undefined };
  }

  try {
    const json = JSON.stringify(value, (_key, val) => {
      const unsupported = detectJSONUnfriendlyType(val);
      if (unsupported !== null) {
        throw new UnsupportedBodyTypeError(unsupported);
      }
      return val;
    });

    if (json === undefined) {
      // JSON.stringify(undefined), JSON.stringify(() => {}),
      // JSON.stringify(Symbol()) дают undefined. Значение не должно
      // было попасть сюда, но если это случилось - считаем ошибкой.
      throw new TypeError('JSON.stringify returned undefined');
    }

    return { body: json, contentType: 'application/json' };
  } catch (e) {
    if (e instanceof UnsupportedBodyTypeError) {
      throw new ApiError({
        kind: 'serialize',
        code: 'BODY_SERIALIZATION_ERROR',
        message:
          `Request body contains a ${e.typeName}. ` +
          `Convert it to a plain object or an array before sending.`,
      });
    }

    throw new ApiError({
      kind: 'serialize',
      code: 'BODY_SERIALIZATION_ERROR',
      message: 'Failed to serialize request body to JSON',
      cause: e,
    });
  }
}

/**
 * Разбирает тело успешного ответа согласно responseType. Для stream
 * возвращает response.body или null, если тела нет.
 *
 * Для json тело читается как текст, чтобы отличить пустой ответ
 * от невалидного. Пустая строка даёт undefined - это покрывает
 * DELETE и подобные эндпоинты, отвечающие 200 OK с Content-Length: 0.
 * Невалидный JSON даёт PARSE_ERROR.
 *
 * Проверка `!response.body` в transport.ts отсекает 204, 304 и HEAD
 * до вызова этой функции.
 *
 * @throws ApiError с кодом PARSE_ERROR, если тело не удалось
 *   разобрать. Например, сервер вернул HTML, а запрос ожидал JSON.
 */
export async function parseResponse(
  response: Response,
  responseType: ResponseType,
): Promise<unknown> {
  try {
    switch (responseType) {
      case 'json': {
        const text = await response.text();
        if (text === '') return undefined;
        return JSON.parse(text);
      }
      case 'text':
        return await response.text();
      case 'blob':
        return await response.blob();
      case 'arrayBuffer':
        return await response.arrayBuffer();
      case 'stream':
        return response.body;
    }
  } catch (e) {
    throw new ApiError({
      kind: 'parse',
      code: 'PARSE_ERROR',
      message: `Failed to parse response body as ${responseType}`,
      status: response.status,
      cause: e,
    });
  }
}

/**
 * Тело ошибки: сначала как текст, потом попытка разобрать как JSON.
 * В rawBody попадает либо распарсенный объект, либо исходная строка.
 *
 * Возвращает null, если тело пустое или чтение не удалось.
 */
export async function readBodyAsJsonOrText(response: Response): Promise<unknown> {
  try {
    const text = await response.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  } catch {
    return null;
  }
}
