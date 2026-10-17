/**
 * The only HTTP date format allowed by RFC 7231: IMF-fixdate like
 * "Sun, 06 Nov 1994 08:49:37 GMT".
 *
 * Full shape check is needed: Date.parse() in V8 is too liberal.
 * '+5', ' 5 ', '-5 GMT', 'garbage GMT' it accepts as valid dates
 * from the distant past, Retry-After would turn into 0, and the
 * protection against request floods would be gone. Weekdays and
 * months are listed explicitly: RFC allows only these values.
 */
const IMF_FIXDATE_RE =
  /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/**
 * Milliseconds until retry, or undefined for empty and unparseable
 * header.
 *
 * The function only parses the header, minimum delay is set by
 * withRetry. Numeric format is checked strictly (/^\d+$/): without
 * this, '1e3', '0x10', '+5', '1.5' would pass as valid numbers.
 *
 * Leading and trailing OWS is trimmed before checks: RFC 7230
 * allows spaces around header value.
 */
export function parseRetryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;

  const trimmed = header.trim();

  if (/^\d+$/.test(trimmed)) {
    return Math.max(0, Number(trimmed) * 1000);
  }

  if (!IMF_FIXDATE_RE.test(trimmed)) {
    return undefined;
  }

  const timestamp = Date.parse(trimmed);
  if (Number.isFinite(timestamp)) {
    return Math.max(0, timestamp - Date.now());
  }

  return undefined;
}
