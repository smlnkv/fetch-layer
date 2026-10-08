import { ApiError } from '../core/errors';
import {
  bodyKindName,
  classifyBody,
  isSerializableKind,
  isUnsupportedKind,
} from '../shared/classify-body';

import type { ResponseType } from '../core/types';

class UnsupportedBodyTypeError extends TypeError {
  readonly typeName: string;

  constructor(typeName: string) {
    super('Unsupported body type');
    this.typeName = typeName;
  }
}

function unsupportedBodyError(name: string): ApiError {
  return new ApiError({
    kind: 'serialize',
    code: 'BODY_SERIALIZATION_ERROR',
    message:
      `Unsupported value in request body: ${name}. ` +
      `Convert it to a plain object or an array before sending.`,
  });
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
 * Для стримов Content-Type не выставляется: поток может содержать
 * бинарные данные, текст, JSON Lines. Приложение задаёт тип явно,
 * если он важен для сервера.
 *
 * @throws ApiError с кодом BODY_SERIALIZATION_ERROR, если тело
 *   содержит Map, Set, WeakMap, WeakSet, RegExp или Error на верхнем
 *   уровне, либо любое значение, не сериализуемое в JSON, на любом
 *   уровне вложенности: Blob, File, FormData, ArrayBuffer, TypedArray,
 *   ReadableStream, URLSearchParams. JSON.stringify превратил бы
 *   их в {}, и сервер получил бы пустой объект вместо данных.
 */
export function prepareBody(value: unknown): PreparedBody {
  const kind = classifyBody(value);

  if (isUnsupportedKind(kind)) {
    throw unsupportedBodyError(bodyKindName(kind));
  }

  switch (kind) {
    case 'undefined':
      return { body: undefined, contentType: undefined };

    case 'form-data':
      return { body: value as BodyInit, contentType: undefined };

    case 'blob':
    case 'file': {
      const blob = value as Blob;
      return {
        body: value as BodyInit,
        contentType: blob.type || 'application/octet-stream',
      };
    }

    case 'array-buffer':
    case 'typed-array':
      return { body: value as BodyInit, contentType: 'application/octet-stream' };

    case 'readable-stream':
    case 'node-readable':
      return { body: value as BodyInit, contentType: undefined };

    case 'url-search-params':
      return {
        body: value as BodyInit,
        contentType: 'application/x-www-form-urlencoded;charset=UTF-8',
      };

    case 'string':
      return { body: value as string, contentType: undefined };

    case 'json':
      return prepareJsonBody(value);
  }
}

function prepareJsonBody(value: unknown): PreparedBody {
  try {
    const json = JSON.stringify(value, (_key, val) => {
      const kind = classifyBody(val);
      if (!isSerializableKind(kind)) {
        throw new UnsupportedBodyTypeError(bodyKindName(kind));
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
      throw unsupportedBodyError(e.typeName);
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
