/** Fields extracted by error parser. */
type ErrorBodyContent = {
  code?: string;
  message?: string;
  fields?: Record<string, string>;
  details?: unknown;
};

/**
 * Error body parser. Passed to ClientOptions.parseErrorBody when
 * server returns errors in a format other than flat. What is not
 * extracted stays undefined, full body is in ApiError.rawBody.
 */
export type ErrorBodyParser = (raw: unknown) => ErrorBodyContent;

/**
 * Keeps only string values: ApiError.fields promises
 * Record<string, string>. Non-string values are dropped, the full
 * original stays in rawBody.
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
 * Default parser: flat JSON object or plain-text string.
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
