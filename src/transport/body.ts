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
 * contentType === undefined: transport does not set the header. No
 * body, or the browser decides (FormData with boundary), or the app
 * set its own.
 */
export interface PreparedBody {
  body: BodyInit | undefined;
  contentType: string | undefined;
}

/**
 * Prepares body for fetch. Returns body and recommended Content-Type.
 * Explicit Content-Type from the app is not overwritten.
 *
 * Streams get no Content-Type: a stream may carry binary data, text,
 * JSON Lines. The type is set by the app when it matters to server.
 *
 * @throws ApiError with code BODY_SERIALIZATION_ERROR if body
 *   contains Map, Set, WeakMap, WeakSet, RegExp or Error at top
 *   level, or any value not JSON-serializable at any nesting level:
 *   Blob, File, FormData, ArrayBuffer, TypedArray, ReadableStream,
 *   URLSearchParams. JSON.stringify would turn them into {}, and
 *   server would get empty object instead of data.
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
 * Parses response body according to responseType.
 *
 * For json, empty body gives undefined, invalid - PARSE_ERROR with
 * content-type in the message. For 2xx and 5xx the error is marked
 * isUncertain: true, for 4xx - false.
 *
 * @param signal - abort during read is classified as abort or
 *   timeout, not as parse error. For the stream branch, abort is
 *   checked before returning the body: otherwise the caller would
 *   get a stream after the timeout already fired.
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
 * Error body: text, then JSON.parse.
 *
 * Returns parsed value or the original string, null if body is empty
 * or read failed.
 *
 * @param signal - abort during read is thrown as ApiError, not
 *   returned as null.
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
