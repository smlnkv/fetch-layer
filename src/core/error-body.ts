/**
 * Контентные поля ошибки, извлекаемые из тела ответа. Структурные
 * поля (kind, status, requestId, retryAfterMs) берёт транспорт,
 * здесь их нет.
 */
type ErrorBodyContent = {
  code?: string;
  message?: string;
  fields?: Record<string, string>;
  details?: unknown;
};

/**
 * Парсер тела ошибки. Приложение передаёт функцию в
 * ClientOptions.parseErrorBody, если сервер отдаёт ошибки
 * в формате, отличном от плоского.
 *
 * Все поля опциональны: что не извлечено - остаётся undefined,
 * полное тело доступно в ApiError.rawBody.
 *
 * @public
 */
export type ErrorBodyParser = (raw: unknown) => ErrorBodyContent;

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
 * Дефолтный парсер. Извлекает code, message, fields из плоского
 * JSON-объекта; plain-text строка становится message. Незнакомые
 * поля остаются undefined, полное тело - в rawBody.
 *
 * @internal
 */
export function parseFlatErrorBody(raw: unknown): ErrorBodyContent {
  if (typeof raw === 'string' && raw.length > 0) {
    return { message: raw };
  }

  if (raw && typeof raw === 'object') {
    const b = raw as Record<string, unknown>;
    return {
      code: typeof b.code === 'string' ? b.code : undefined,
      message: typeof b.message === 'string' ? b.message : undefined,
      fields: parseFields(b.fields),
    };
  }

  return {};
}
