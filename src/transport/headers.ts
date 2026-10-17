/**
 * Header name case does not matter per spec: the module normalizes
 * it when reading and merging, keeping the original name in the
 * result.
 */

function isHeaders(value: unknown): value is Headers {
  return (
    typeof Headers !== 'undefined' && Object.prototype.toString.call(value) === '[object Headers]'
  );
}

function isPairArray(value: unknown): value is ReadonlyArray<readonly [string, string]> {
  return Array.isArray(value);
}

/**
 * Converts Headers or an array of pairs to Record<string, string>.
 * Record is returned as is, no copy.
 */
function normalizeHeaders(input: unknown): Record<string, string> {
  if (isHeaders(input)) {
    const result: Record<string, string> = {};
    input.forEach((value, key) => {
      result[key] = value;
    });
    return result;
  }

  if (isPairArray(input)) {
    const result: Record<string, string> = {};
    for (const pair of input) {
      if (Array.isArray(pair) && pair.length >= 2) {
        result[pair[0]] = pair[1];
      }
    }
    return result;
  }

  return (input ?? {}) as Record<string, string>;
}

/**
 * Header value. Inherited properties are not read.
 */
export function getHeader(headers: unknown, name: string): string | undefined {
  if (!headers) return undefined;

  const record = normalizeHeaders(headers);
  const lower = name.toLowerCase();
  for (const key of Object.keys(record)) {
    if (key.toLowerCase() === lower) return record[key];
  }
  return undefined;
}

/**
 * Sets a header, removing variants with a different case. Two headers
 * with the same meaning must not exist.
 */
export function setHeader(headers: Record<string, string>, name: string, value: string): void {
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower && key !== name) {
      delete headers[key];
    }
  }
  headers[name] = value;
}

/**
 * Merges header sets. Later sources override earlier ones, case is
 * normalized. If the first had content-type and the second
 * Content-Type, only one remains - from the second source.
 */
export function mergeHeaders(...sources: unknown[]): Record<string, string> {
  const result: Record<string, string> = {};
  const seen = new Map<string, string>();

  for (const source of sources) {
    if (!source) continue;

    if (isHeaders(source) || isPairArray(source)) {
      const record = normalizeHeaders(source);
      for (const key of Object.keys(record)) {
        mergeEntry(result, seen, key, record[key]);
      }
      continue;
    }

    if (typeof source !== 'object') continue;
    for (const key of Object.keys(source as Record<string, string>)) {
      const value = (source as Record<string, string>)[key];
      mergeEntry(result, seen, key, value);
    }
  }

  return result;
}

function mergeEntry(
  result: Record<string, string>,
  seen: Map<string, string>,
  key: string,
  value: string | undefined,
): void {
  if (value === undefined) return;

  const lower = key.toLowerCase();
  const previousKey = seen.get(lower);

  if (previousKey !== undefined && previousKey !== key) {
    delete result[previousKey];
  }

  seen.set(lower, key);
  result[key] = value;
}
