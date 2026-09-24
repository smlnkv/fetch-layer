/**
 * Регистр имён заголовков не имеет значения по спецификации: модуль
 * нормализует его при чтении и слиянии, сохраняя исходный вид имени
 * в результирующем объекте.
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
 * Приводит Headers или массив пар к Record<string, string>. Для
 * Record возвращает исходный объект без копии. Нужна для вызовов
 * из JS, где RequestConfig.headers может прийти в формате Fetch API.
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
 * Значение заголовка, регистр имени игнорируется. Унаследованные
 * свойства не читаются. Принимает Record, Headers или массив пар:
 * нормализация выполняется внутри, TS-потребитель передаёт Record.
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
 * Устанавливает заголовок, удаляя другие варианты того же имени
 * с иным регистром. Двух заголовков с одним смыслом быть не должно.
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
 * Сливает несколько наборов заголовков в один. Более поздние
 * источники переопределяют более ранние, регистр нормализуется.
 * Если в первом объекте был content-type, а во втором Content-Type,
 * в результате останется только один - из второго источника.
 *
 * Принимает Record, Headers и массив пар: нормализация внутри,
 * TS-потребитель передаёт Record.
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
