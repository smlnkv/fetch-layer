/**
 * Тип парсера тела ошибки. Принимает распарсенное тело ответа
 * (объект, массив, строку) или null, возвращает извлечённые поля.
 *
 * @public
 */
export type ErrorBodyParser = (raw: unknown) => ParsedErrorBody;

/**
 * Результат парсинга тела ошибки. Все поля опциональны: парсер
 * может извлечь что угодно или ничего. Оригинальное тело в любом
 * случае доступно в ApiError.rawBody.
 *
 * @public
 */
export interface ParsedErrorBody {
  code?: string;
  message?: string;
  fields?: Record<string, string>;
  requestId?: string;
  details?: unknown;
}

/**
 * Оставляет только строковые значения: контракт ApiError.fields
 * требует Record<string, string>. Нестроковые значения (массивы,
 * объекты) отбрасываются, полный оригинал остаётся в rawBody.
 *
 * @internal
 */
export function parseFields(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;

  const result: Record<string, string> = {};
  let hasAny = false;

  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string') {
      result[key] = value;
      hasAny = true;
    }
  }

  return hasAny ? result : undefined;
}

/**
 * Парсер по умолчанию. Понимает плоский JSON-объект
 * { code, message, fields, requestId }, plain-text строку как
 * message и всё остальное как пустой результат.
 *
 * @public
 */
export function parseFlatErrorBody(raw: unknown): ParsedErrorBody {
  if (typeof raw === 'string' && raw.length > 0) {
    return { message: raw };
  }

  if (raw && typeof raw === 'object') {
    const b = raw as Record<string, unknown>;
    return {
      code: typeof b.code === 'string' ? b.code : undefined,
      message: typeof b.message === 'string' ? b.message : undefined,
      fields: parseFields(b.fields),
      requestId: typeof b.requestId === 'string' ? b.requestId : undefined,
    };
  }

  return {};
}
