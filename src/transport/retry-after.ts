/**
 * Единственный формат HTTP-даты, разрешённый RFC 7231:
 * IMF-fixdate вида "Sun, 06 Nov 1994 08:49:37 GMT".
 *
 * Полная проверка формы нужна, потому что Date.parse() в V8 слишком
 * либерален: '+5', ' 5 ', '-5 GMT', 'garbage GMT' он принимает как
 * валидные даты из далёкого прошлого. Тогда Retry-After превратился
 * бы в 0, и защита от шквала запросов пропала бы. Дни недели
 * и месяцы перечислены явно: RFC допускает только эти значения.
 */
const IMF_FIXDATE_RE =
  /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/**
 * Миллисекунды до повтора или undefined, если заголовок пустой
 * и не разбирается.
 *
 * Функция только разбирает заголовок. Минимальную задержку
 * определяет withRetry. Числовой формат проверяется строго
 * (/^\d+$/), чтобы не пропустить '1e3', '0x10', '+5', '1.5' и другие
 * значения, которые Number молча принимает.
 */
export function parseRetryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;

  if (/^\d+$/.test(header)) {
    return Math.max(0, Number(header) * 1000);
  }

  if (!IMF_FIXDATE_RE.test(header)) {
    return undefined;
  }

  const timestamp = Date.parse(header);
  if (Number.isFinite(timestamp)) {
    return Math.max(0, timestamp - Date.now());
  }

  return undefined;
}
