import type {
  QueryArrayFormat,
  QueryObjectFormat,
  QueryParamValue,
  QueryParams,
} from '../core/types';

/**
 * Квадратные скобки [ и ] остаются читаемыми: filter[status]=active
 * вместо filter%5Bstatus%5D=active.
 */
function encodeQueryKey(key: string): string {
  return encodeURIComponent(key).replace(/%5B/g, '[').replace(/%5D/g, ']');
}

function encodeQueryValue(value: string): string {
  return encodeURIComponent(value);
}

/**
 * Кодирует path посегментно, сохраняя разделители /. Каждый сегмент
 * сначала декодируется, потом кодируется: это делает функцию
 * идемпотентной для уже закодированных сегментов (John%20Doe
 * не превращается в John%2520Doe).
 *
 * Если сегмент содержит невалидную escape-последовательность,
 * декодирование падает, и сегмент кодируется как есть.
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
 * Сериализует одно значение в набор строк key=value. Рекурсивно
 * обходит вложенные объекты и массивы.
 *
 * undefined и null пропускаются, пустые массивы и объекты тоже.
 * Ключи объектов сортируются в алфавитном порядке.
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
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

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
 * Строит URL из baseUrl, path и query-параметров.
 *
 * Ключи query-параметров сортируются в алфавитном порядке, включая
 * вложенные. Завершающие слеши у baseUrl снимаются, ведущий у path
 * тоже: /api/ + /users и /api + users дают /api/users.
 *
 * path кодируется посегментно: пробелы и специальные символы
 * внутри сегмента экранируются, разделители / сохраняются.
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
