/**
 * Встроенный формат тела ошибки. Если задан parseErrorBody,
 * то он имеет приоритет.
 *
 * - flat: плоский { code, message, fields, requestId }. По умолчанию.
 * - content: вложенный { content: { code, message, fields } }.
 * - error: вложенный { error: { code, message } }.
 * - rfc7807: RFC 7807 Problem Details.
 */
export type ErrorBodyFormat = 'flat' | 'content' | 'error' | 'rfc7807';

export type ErrorBodyParser = (raw: unknown) => ParsedErrorBody;

/**
 * Все поля опциональны: парсер может извлечь что угодно или ничего.
 * Оригинальное тело в любом случае доступно в ApiError.rawBody.
 *
 * @internal
 */
export interface ParsedErrorBody {
  code?: string;
  message?: string;
  fields?: Record<string, string>;
  requestId?: string;
  details?: unknown;
}

/**
 * Приоритет: parseErrorBody, если задан, иначе errorBodyFormat,
 * иначе плоский формат.
 *
 * @internal
 */
export function buildErrorParser(options: {
  parseErrorBody?: ErrorBodyParser;
  errorBodyFormat?: ErrorBodyFormat;
}): ErrorBodyParser {
  if (options.parseErrorBody) return options.parseErrorBody;

  switch (options.errorBodyFormat) {
    case 'content':
      return parseContentFormat;
    case 'error':
      return parseErrorWrapperFormat;
    case 'rfc7807':
      return parseRfc7807Format;
    case 'flat':
    default:
      return defaultParseErrorBody;
  }
}

/**
 * Оставляет только строковые значения: контракт ApiError.fields
 * требует Record<string, string>. Нестроковые значения (массивы, объекты)
 * отбрасываются, полный оригинал остаётся в rawBody.
 */
function parseFields(raw: unknown): Record<string, string> | undefined {
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
 * Понимает плоский JSON-объект, plain-text строку (как message)
 * и всё остальное (пустой результат).
 */
function defaultParseErrorBody(raw: unknown): ParsedErrorBody {
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

function parseContentFormat(raw: unknown): ParsedErrorBody {
  if (!raw || typeof raw !== 'object') return {};

  const b = (raw as { content?: unknown }).content;
  if (!b || typeof b !== 'object') return {};

  const c = b as Record<string, unknown>;
  return {
    code: typeof c.code === 'string' ? c.code : undefined,
    message: typeof c.message === 'string' ? c.message : undefined,
    fields: parseFields(c.fields),
  };
}

function parseErrorWrapperFormat(raw: unknown): ParsedErrorBody {
  if (!raw || typeof raw !== 'object') return {};

  const b = (raw as { error?: unknown }).error;
  if (!b || typeof b !== 'object') return {};

  const e = b as Record<string, unknown>;
  return {
    code: typeof e.code === 'string' ? e.code : undefined,
    message: typeof e.message === 'string' ? e.message : undefined,
  };
}

/**
 * type становится code, detail - message (с fallback на title),
 * instance и status уходят в details.
 */
function parseRfc7807Format(raw: unknown): ParsedErrorBody {
  if (!raw || typeof raw !== 'object') return {};

  const b = raw as Record<string, unknown>;
  const type = typeof b.type === 'string' ? b.type : undefined;
  const title = typeof b.title === 'string' ? b.title : undefined;
  const detail = typeof b.detail === 'string' ? b.detail : undefined;
  const instance = typeof b.instance === 'string' ? b.instance : undefined;
  const status = typeof b.status === 'number' ? b.status : undefined;

  return {
    code: type,
    message: detail ?? title,
    details: instance !== undefined || status !== undefined ? { instance, status } : undefined,
  };
}
