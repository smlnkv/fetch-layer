import { ApiError } from '../../core/errors';
import { classifyBody, getTypeName, isSerializableKind } from '../../shared/classify-body';

/**
 * Stable value serialization. Object keys are sorted alphabetically:
 * the result does not depend on insertion order. Otherwise behavior
 * matches JSON.stringify, including toJSON returning undefined.
 *
 * @throws ApiError with code BODY_SERIALIZATION_ERROR on circular
 *   refs, BigInt and non-serializable types: FormData, Blob, File,
 *   ArrayBuffer, TypedArray, ReadableStream, Node.js stream.Readable,
 *   URLSearchParams, Map, Set, WeakMap, WeakSet, RegExp, Error.
 */
export function stableSerialize(value: unknown): string {
  try {
    return serialize(value, new WeakSet<object>()) ?? 'null';
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError({
      kind: 'serialize',
      code: 'BODY_SERIALIZATION_ERROR',
      message: 'Failed to serialize value',
      cause: e,
    });
  }
}

/**
 * Returns undefined for values JSON.stringify skips: undefined,
 * functions, Symbol. seen is the recursion stack: it tells a shared
 * reference (allowed) from a cycle (forbidden).
 */
function serialize(value: unknown, seen: WeakSet<object>): string | undefined {
  // Check before toJSON: the "non-serializable types are rejected"
  // contract must not be bypassed via a custom toJSON.
  const kind = classifyBody(value);
  if (!isSerializableKind(kind)) {
    throw new TypeError(`Cannot serialize ${getTypeName(value)} to a stable JSON string`);
  }

  // Same as JSON.stringify: works with Date, URL and other types
  // that have toJSON.
  if (value && typeof value === 'object') {
    const toJSON = (value as { toJSON?: () => unknown }).toJSON;
    if (typeof toJSON === 'function') {
      value = toJSON.call(value);

      // toJSON may return Map, Set, Blob or another non-serializable
      // type. Without the check the value would go through recursion
      // and turn into {}, giving different bodies the same fingerprint.
      const afterKind = classifyBody(value);
      if (!isSerializableKind(afterKind)) {
        throw new TypeError(`toJSON returned ${getTypeName(value)}: cannot serialize`);
      }
    }
  }

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
    // Remove from the stack: this allows shared references and
    // forbids real cycles.
    seen.delete(obj);
  }
}
