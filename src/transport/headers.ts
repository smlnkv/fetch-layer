/**
 * Регистр имён заголовков не имеет значения по спецификации: модуль
 * нормализует его при чтении и слиянии, сохраняя исходный вид имени
 * в результирующем объекте.
 */

/**
 * Значение заголовка, регистр имени игнорируется. Унаследованные
 * свойства не читаются.
 */
export function getHeader(
  headers: Record<string, string> | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;

  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return headers[key];
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
 */
export function mergeHeaders(
  ...sources: Array<Record<string, string> | undefined>
): Record<string, string> {
  const result: Record<string, string> = {};
  const seen = new Map<string, string>();

  for (const source of sources) {
    if (!source) continue;
    for (const key in source) {
      const value = source[key];
      if (value === undefined) continue;

      const lower = key.toLowerCase();
      const previousKey = seen.get(lower);

      if (previousKey !== undefined && previousKey !== key) {
        delete result[previousKey];
      }

      seen.set(lower, key);
      result[key] = value;
    }
  }

  return result;
}
