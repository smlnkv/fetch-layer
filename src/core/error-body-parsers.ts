import { parseFields } from './error-body';

import type { ParsedErrorBody } from './error-body';

/**
 * Встроенные парсеры тела ошибки, кроме плоского формата (он
 * в ядре как дефолт). Подключаются через fetch-layer/error-body:
 *
 * ```ts
 * import { errorBodyParsers } from 'fetch-layer/error-body';
 *
 * const client = createClient({
 *   baseUrl: '/api',
 *   parseErrorBody: errorBodyParsers.rfc7807,
 * });
 * ```
 *
 * Пользователь, использующий плоский формат, не платит за эти
 * парсеры: они живут в отдельном entry и не попадают в бандл.
 *
 * @public
 */
export const errorBodyParsers = {
  /**
   * { content: { code, message, fields } }. Встречается
   * в Spring Boot и других Java-фреймворках.
   */
  content: parseContentFormat,

  /**
   * { error: { code, message } }. Встречается в некоторых
   * Go-фреймворках.
   */
  error: parseErrorWrapperFormat,

  /**
   * RFC 7807 Problem Details:
   * { type, title, detail, instance, status }.
   *
   * type становится code, detail (или title, если detail нет) -
   * message, instance и status уходят в details.
   */
  rfc7807: parseRfc7807Format,
} as const;

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
