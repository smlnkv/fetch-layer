import type { RequestConfig } from './types';

/**
 * Все HTTP-ошибки приводятся к одному классу ApiError, чтобы
 * приложение обрабатывало их в одной точке, а не разбирало
 * Response в каждом catch.
 */

/**
 * Природа ошибки. Влияет на стратегию обработки.
 *
 * - network: нет соединения (сеть, DNS, CORS);
 * - timeout: запрос не успел завершиться, включая refresh токена;
 * - http: статус вне диапазона 2xx;
 * - parse: тело ответа не удалось разобрать;
 * - abort: запрос отменён через AbortSignal по инициативе приложения;
 * - serialize: не удалось сериализовать тело запроса, отпечаток
 *   тела для идемпотентности или вернуть валидный ключ
 *   (IDEMPOTENCY_KEY_INVALID);
 * - storage: не удалось сохранить ключ идемпотентности в хранилище;
 * - unknown: ошибка, которую не удалось классифицировать (включая
 *   AUTH_PROVIDER_ERROR и REFRESH_CIRCUIT_OPEN).
 */
export type ApiErrorKind =
  'network' | 'timeout' | 'http' | 'parse' | 'abort' | 'serialize' | 'storage' | 'unknown';

/**
 * Коды, которые библиотека относит к auth. Используются в геттерах
 * isAuthError и isRetryable.
 */
const AUTH_ERROR_CODES = new Set([
  'AUTH_PROVIDER_ERROR',
  'REFRESH_TIMEOUT',
  'REFRESH_CIRCUIT_OPEN',
  'REFRESH_COOLDOWN',
]);

/**
 * Унифицированная ошибка библиотеки.
 *
 * Коды, которые устанавливает клиент:
 *
 * - ABORTED, TIMEOUT, NETWORK_ERROR, PARSE_ERROR,
 *   BODY_SERIALIZATION_ERROR - транспорт;
 * - AUTH_PROVIDER_ERROR, REFRESH_TIMEOUT, REFRESH_CIRCUIT_OPEN,
 *   REFRESH_COOLDOWN - авторизация;
 * - IDEMPOTENCY_STORAGE_ERROR, IDEMPOTENCY_KEY_INVALID -
 *   идемпотентность.
 *
 * Любые другие коды приходят от сервера в теле ответа.
 */
export class ApiError extends Error {
  readonly kind: ApiErrorKind;

  /**
   * HTTP-статус ответа. 0, если ответа не было (сеть, таймаут,
   * отмена).
   */
  readonly status: number;

  /** Код ошибки: от сервера или из списка выше. */
  readonly code: string;

  /**
   * Ошибки отдельных полей формы. Ключ - имя поля, значение -
   * текст ошибки. Значения гарантированно строковые: парсеры
   * отбрасывают массивы и вложенные объекты, полный оригинал
   * остаётся в rawBody.
   */
  readonly fields?: Record<string, string>;

  /**
   * Значение заголовка X-Request-Id, если сервер его вернул.
   * По нему можно найти запрос в логах сервера.
   */
  readonly requestId?: string;

  /**
   * Значение заголовка Retry-After в миллисекундах, если он был.
   */
  readonly retryAfterMs?: number;

  /**
   * Оригинальное тело ответа как есть. Полезно, когда формат
   * ошибки отличается от того, что умеет разбирать клиент
   * по умолчанию.
   */
  readonly rawBody?: unknown;

  /**
   * Структурированные детали, извлечённые парсером. Заполняется,
   * когда включён errorBodyFormat (например, для RFC 7807 - поля
   * instance и status). Для плоского формата остаётся undefined.
   */
  readonly details?: unknown;

  /**
   * true, если ответа от сервера нет: сетевые ошибки, таймауты, 5xx.
   *
   * Для 408 и 429 остаётся false: сервер ответил. Свойство про
   * доставку, а не про состояние операции. Для решений о повторе
   * используйте isRetryable.
   */
  readonly isUncertain: boolean;

  /**
   * Конфиг, отправленный в сеть. Заполняется транспортом для ошибок,
   * возникших во время сетевого запроса: заголовки здесь финальные,
   * включая Accept, Content-Type, а также добавленные слоями auth
   * и идемпотентности. Для ошибок, возникших до транспорта
   * (например, при сериализации тела или в слое), остаётся undefined.
   *
   * body и headers содержат исходные данные запроса: тело - пароли
   * и персональные данные, заголовки - Authorization, Cookie,
   * X-API-Key. Не передавайте config целиком в системы логирования
   * и трейсинга без фильтрации.
   */
  config?: RequestConfig;

  constructor(params: {
    kind: ApiErrorKind;
    message: string;
    status?: number;
    code?: string;
    fields?: Record<string, string>;
    requestId?: string;
    retryAfterMs?: number;
    rawBody?: unknown;
    details?: unknown;
    isUncertain?: boolean;
    cause?: unknown;
  }) {
    super(params.message, { cause: params.cause });
    this.name = 'ApiError';
    this.kind = params.kind;
    this.status = params.status ?? 0;
    this.code = params.code ?? 'UNKNOWN';
    this.fields = params.fields;
    this.requestId = params.requestId;
    this.retryAfterMs = params.retryAfterMs;
    this.rawBody = params.rawBody;
    this.details = params.details;
    this.isUncertain = params.isUncertain ?? false;
  }

  /**
   * true для kind network и kind timeout. Ответа от сервера не было.
   * Ошибка REFRESH_TIMEOUT тоже даёт true: refresh не дождался
   * ответа.
   */
  get isNetwork(): boolean {
    return this.kind === 'network' || this.kind === 'timeout';
  }

  /**
   * true для kind abort. Запрос отменён через AbortSignal
   * по инициативе приложения.
   */
  get isCancelled(): boolean {
    return this.kind === 'abort';
  }

  /**
   * Ошибка связана с авторизацией.
   *
   * true для:
   * - ответов 401 и 403 (status);
   * - кодов AUTH_PROVIDER_ERROR, REFRESH_TIMEOUT,
   *   REFRESH_CIRCUIT_OPEN, REFRESH_COOLDOWN.
   */
  get isAuthError(): boolean {
    return AUTH_ERROR_CODES.has(this.code) || this.status === 401 || this.status === 403;
  }

  /**
   * true для:
   * - сетевых ошибок (kind network);
   * - таймаутов (kind timeout);
   * - 408 и 429;
   * - 5xx (500-599).
   *
   * false для:
   * - отмены (kind abort);
   * - ошибок авторизации: 401, 403 и кодов AUTH_PROVIDER_ERROR,
   *   REFRESH_TIMEOUT, REFRESH_CIRCUIT_OPEN, REFRESH_COOLDOWN;
   * - остальных 4xx.
   */
  get isRetryable(): boolean {
    if (this.kind === 'abort') return false;
    if (AUTH_ERROR_CODES.has(this.code)) return false;
    if (this.isNetwork) return true;
    if (this.status === 408) return true;
    if (this.status === 429) return true;
    return this.status >= 500 && this.status < 600;
  }

  /**
   * 4xx. Эквивалент status >= 400 && status < 500.
   *
   * Пересекается с isAuthError: ответы 401 и 403 попадают в оба
   * геттера. Если нужно отделить auth от остальных клиентских
   * ошибок, проверяйте isAuthError первым.
   */
  get isClientError(): boolean {
    return this.status >= 400 && this.status < 500;
  }

  /**
   * 5xx. Эквивалент status >= 500 && status < 600.
   * Повтор через некоторое время может помочь.
   */
  get isServerError(): boolean {
    return this.status >= 500 && this.status < 600;
  }

  /**
   * Конфликт версии ресурса: сервер ответил 409.
   * Эквивалент status === 409.
   */
  get isConflict(): boolean {
    return this.status === 409;
  }
}

/**
 * Приводит любое исключение к ApiError. Если на вход уже пришёл
 * ApiError, возвращает его же (функция безопасна для повторного
 * вызова).
 *
 * Распознаёт AbortError, TimeoutError и SyntaxError по name, а не
 * через instanceof: ошибка из чужого realm (iframe, worker) имеет
 * другой конструктор, и проверка через instanceof вернула бы false.
 *
 * TypeError здесь не классифицируется как сетевая ошибка - его
 * источник неизвестен. Это делает classifyFetchError в контексте
 * вокруг fetch-подобного вызова. Всё остальное становится
 * ApiError с kind unknown.
 */
export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;

  if (isNamedError(error, 'AbortError')) {
    return new ApiError({
      kind: 'abort',
      message: 'Request aborted',
      code: 'ABORTED',
    });
  }

  if (isNamedError(error, 'TimeoutError')) {
    return new ApiError({
      kind: 'timeout',
      message: 'Request timeout',
      code: 'TIMEOUT',
      isUncertain: true,
    });
  }

  if (isNamedError(error, 'SyntaxError')) {
    return new ApiError({
      kind: 'parse',
      message: 'Failed to parse response',
      code: 'PARSE_ERROR',
      isUncertain: false,
      cause: error,
    });
  }

  if (isErrorLike(error)) {
    return new ApiError({
      kind: 'unknown',
      message: error.message,
      cause: error,
    });
  }

  return new ApiError({
    kind: 'unknown',
    message: 'Unknown error',
    cause: error,
  });
}

/**
 * Отличается от toApiError одной веткой: TypeError здесь означает
 * сетевую ошибку. Это верно в контексте вокруг fetch(url, init)
 * или provider.refresh, который обычно вызывает fetch внутри.
 *
 * В остальных местах TypeError может прийти от любой операции,
 * и там его классифицирует toApiError как unknown.
 *
 * @internal
 */
export function classifyFetchError(error: unknown): ApiError {
  if (isNamedError(error, 'TypeError')) {
    return new ApiError({
      kind: 'network',
      message: 'Network error',
      code: 'NETWORK_ERROR',
      isUncertain: true,
      cause: error,
    });
  }
  return toApiError(error);
}

/**
 * Исключение с указанным именем. Проверка по name, а не через
 * instanceof DOMException: в разных средах глобальный DOMException
 * может отсутствовать или быть другим классом.
 *
 * @internal
 */
export function isNamedError(value: unknown, name: string): value is { name: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'name' in value &&
    (value as { name: unknown }).name === name
  );
}

function isErrorLike(value: unknown): value is Error {
  if (typeof value !== 'object' || value === null) return false;
  if (!('message' in value)) return false;
  return typeof (value as { message: unknown }).message === 'string';
}
