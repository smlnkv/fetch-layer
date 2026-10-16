import { ApiError, toApiError } from '../core/errors';
import {
  classifyBody,
  getTypeName,
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
    throw unsupportedBodyError(getTypeName(value));
  }

  switch (kind) {
    case 'undefined':
      return { body: undefined, contentType: undefined };

    case 'form-data':
      return { body: value as BodyInit, contentType: undefined };

    case 'blob': {
      const blob = value as Blob;
      return {
        body: value as BodyInit,
        contentType: blob.type || 'application/octet-stream',
      };
    }

    case 'binary':
      return { body: value as BodyInit, contentType: 'application/octet-stream' };

    case 'stream':
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
        throw new UnsupportedBodyTypeError(getTypeName(val));
      }
      return val;
    });

    if (json === undefined) {
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
 * Разбирает тело ответа согласно responseType. Для stream
 * возвращает response.body или null.
 *
 * Для json пустое тело даёт undefined, невалидное - PARSE_ERROR
 * с указанием content-type. Для 2xx и 5xx ошибка помечается
 * isUncertain: true, для 4xx - false.
 *
 * @param signal - отмена во время чтения классифицируется как
 *   abort или timeout, а не как ошибка разбора. Для ветки stream
 *   отмена проверяется до возврата тела: иначе вызывающий получил
 *   бы поток при уже сработавшем таймауте.
 */
export async function parseResponse(
  response: Response,
  responseType: ResponseType,
  signal?: AbortSignal,
): Promise<unknown> {
  if (signal?.aborted) {
    throw toApiError(signal.reason);
  }

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
    if (signal?.aborted) {
      throw toApiError(signal.reason);
    }

    const contentType = response.headers.get('content-type');
    throw new ApiError({
      kind: 'parse',
      code: 'PARSE_ERROR',
      message: contentType
        ? `Failed to parse response body as ${responseType} (content-type: ${contentType})`
        : `Failed to parse response body as ${responseType}`,
      status: response.status,
      isUncertain: response.status < 400 || response.status >= 500,
      cause: e,
    });
  }
}

/**
 * Тело ошибки: текст, затем попытка JSON.parse. Возвращает
 * распарсенное значение или исходную строку, null - если тело
 * пустое или чтение не удалось.
 *
 * @param signal - отмена во время чтения пробрасывается как
 *   ApiError, а не возвращает null.
 */
export async function readBodyAsJsonOrText(
  response: Response,
  signal?: AbortSignal,
): Promise<unknown> {
  try {
    const text = await response.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  } catch {
    if (signal?.aborted) {
      throw toApiError(signal.reason);
    }
    return null;
  }
}
