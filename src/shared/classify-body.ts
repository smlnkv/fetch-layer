/**
 * Request body classifier. Transport uses the category to decide
 * how to prepare body for fetch; idempotency layer - whether a
 * stable fingerprint can be computed.
 *
 * Check via Object.prototype.toString, not instanceof: instanceof
 * does not work across realms, and bodies often come from iframe
 * or worker.
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
 * Categories that JSON.stringify would turn into {} or a meaningless
 * value. Nested values of these categories are rejected in
 * prepareJsonBody.
 */
export type UnsupportedKind = 'unsupported';

/**
 * Anything not in the known categories is treated as json:
 * primitives except string, arrays, plain objects, Date, BigInt.
 * BigInt is rejected at JSON.stringify.
 *
 * Blob and File are handled the same way. Node.js stream.Readable
 * has no own tag and is detected by duck-typing: pipe, on,
 * Symbol.asyncIterator. Web ReadableStream does not match: it has
 * no pipe.
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
 * true for undefined, json and string. Used by idempotency and by
 * recursive check of nested values.
 */
export function isSerializableKind(kind: BodyKind): boolean {
  return kind === 'undefined' || kind === 'json' || kind === 'string';
}

/**
 * true for types that JSON.stringify would turn into {} already at
 * the top level. Transport rejects them before sending.
 */
export function isUnsupportedKind(kind: BodyKind): kind is UnsupportedKind {
  return kind === 'unsupported';
}

export function isSerializableBody(value: unknown): boolean {
  return isSerializableKind(classifyBody(value));
}

/**
 * true for streaming bodies. Streams are single-use: a second fetch
 * throws TypeError. Transport sets duplex: 'half' based on this flag,
 * retry layer disables retries.
 */
export function isStreamingBody(value: unknown): boolean {
  return classifyBody(value) === 'stream';
}

/**
 * Type name for error messages. Relies on Symbol.toStringTag and
 * duck-typing for Node.js stream. Separate from BodyKind: category
 * describes handling logic, name is what the developer sees.
 */
export function getTypeName(value: unknown): string {
  if (isNodeReadable(value)) return 'NodeReadable';
  return Object.prototype.toString.call(value).slice(8, -1);
}

interface NodeReadableLike {
  pipe: (...args: unknown[]) => unknown;
  on: (...args: unknown[]) => unknown;
  [Symbol.asyncIterator](): AsyncIterator<unknown>;
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
