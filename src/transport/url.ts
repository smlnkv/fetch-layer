import type {
  QueryArrayFormat,
  QueryObjectFormat,
  QueryParamValue,
  QueryParams,
} from '../core/types';

/**
 * Square brackets stay readable: filter[status]=active instead
 * of filter%5Bstatus%5D=active.
 */
function encodeQueryKey(key: string): string {
  return encodeURIComponent(key).replace(/%5B/g, '[').replace(/%5D/g, ']');
}

function encodeQueryValue(value: string): string {
  return encodeURIComponent(value);
}

/**
 * Encodes path per segment, keeping / separators. A segment is
 * decoded first, then encoded: the function is idempotent for
 * already encoded segments, John%20Doe does not become John%2520Doe.
 *
 * On invalid escape sequence the segment is encoded as is.
 */
function encodePath(path: string): string {
  return path
    .split('/')
    .map((segment) => {
      if (segment === '') return '';
      try {
        return encodeURIComponent(decodeURIComponent(segment));
      } catch {
        return encodeURIComponent(segment);
      }
    })
    .join('/');
}

function isQueryObject(value: QueryParamValue): value is { [key: string]: QueryParamValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Serializes a single value into key=value strings. Recursively
 * walks nested objects and arrays. undefined and null are skipped,
 * empty arrays and objects too. Object keys are sorted alphabetically.
 */
export function serializeQueryValue(
  key: string,
  value: QueryParamValue,
  arrayFormat: QueryArrayFormat,
  objectFormat: QueryObjectFormat,
): string[] {
  if (value === undefined || value === null) return [];

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return [`${encodeQueryKey(key)}=${encodeQueryValue(String(value))}`];
  }

  if (Array.isArray(value)) {
    const filtered = value.filter((v) => v !== undefined && v !== null);
    if (filtered.length === 0) return [];

    switch (arrayFormat) {
      case 'repeat':
        return filtered.map((v) => `${encodeQueryKey(key)}=${encodeQueryValue(String(v))}`);
      case 'brackets':
        return filtered.map((v) => `${encodeQueryKey(`${key}[]`)}=${encodeQueryValue(String(v))}`);
      case 'comma':
        return [
          `${encodeQueryKey(key)}=${filtered.map((v) => encodeQueryValue(String(v))).join(',')}`,
        ];
    }
  }

  if (isQueryObject(value)) {
    const entries = Object.entries(value).sort(([a], [b]) => Number(a > b) - Number(a < b));

    switch (objectFormat) {
      case 'brackets': {
        const parts: string[] = [];
        for (const [k, v] of entries) {
          parts.push(...serializeQueryValue(`${key}[${k}]`, v, arrayFormat, objectFormat));
        }
        return parts;
      }
      case 'dots': {
        const parts: string[] = [];
        for (const [k, v] of entries) {
          parts.push(...serializeQueryValue(`${key}.${k}`, v, arrayFormat, objectFormat));
        }
        return parts;
      }
    }
  }

  return [];
}

/**
 * Builds URL from baseUrl, path and query params.
 *
 * Query param keys are sorted alphabetically, including nested ones.
 * Trailing slashes on baseUrl are stripped, leading on path too:
 * /api/ + /users and /api + users both give /api/users.
 */
export function buildUrl(
  baseUrl: string,
  path: string,
  query?: QueryParams,
  arrayFormat: QueryArrayFormat = 'repeat',
  objectFormat: QueryObjectFormat = 'brackets',
): string {
  const trimmedBase = baseUrl.replace(/\/+$/, '');
  const trimmedPath = path.replace(/^\//, '');
  const url = `${trimmedBase}/${encodePath(trimmedPath)}`;

  if (!query) return url;

  const parts: string[] = [];
  for (const key of Object.keys(query).sort()) {
    const segments = serializeQueryValue(key, query[key], arrayFormat, objectFormat);
    for (const segment of segments) parts.push(segment);
  }

  return parts.length > 0 ? `${url}?${parts.join('&')}` : url;
}
