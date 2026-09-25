import type { ApiError } from './errors';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

/**
 * Формат разбора успешного ответа. Для text, blob, arrayBuffer
 * и stream трансформации не применяются: тело отдаётся как есть.
 *
 * - json: пустое тело даёт undefined, а не ошибку;
 * - text: для CSV, HTML, plain text;
 * - blob: бинарные данные с MIME-типом, для скачивания в браузере;
 * - arrayBuffer: бинарные данные без MIME-типа;
 * - stream: ReadableStream<Uint8Array>, для больших файлов и SSE.
 */
export type ResponseType = 'json' | 'text' | 'blob' | 'arrayBuffer' | 'stream';

/**
 * Примитивное значение. Числа и boolean сериализуются в строку
 * автоматически.
 */
export type QueryParamPrimitive = string | number | boolean;

/**
 * Примитив, массив примитивов, вложенный объект или undefined/null
 * (параметр пропускается).
 */
export type QueryParamValue =
  | QueryParamPrimitive
  | undefined
  | null
  | Array<QueryParamPrimitive | undefined | null>
  | QueryParamObject;

export interface QueryParamObject {
  [key: string]: QueryParamValue;
}

export type QueryParams = Record<string, QueryParamValue>;

/**
 * - repeat: ?ids=1&ids=2&ids=3. По умолчанию.
 * - brackets: ?ids[]=1&ids[]=2&ids[]=3.
 * - comma: ?ids=1,2,3.
 */
export type QueryArrayFormat = 'repeat' | 'brackets' | 'comma';

/**
 * - brackets: ?filter[status]=active. По умолчанию.
 * - dots: ?filter.status=active.
 */
export type QueryObjectFormat = 'brackets' | 'dots';

/**
 * Доступны, если в запросе указано includeResponseMeta: true.
 */
export interface ResponseMeta {
  status: number;

  /** Заголовки ответа как стандартный Headers. */
  headers: Headers;

  /** Значение X-Request-Id, если сервер его вернул. */
  requestId?: string;

  /**
   * Значение Retry-After в миллисекундах, если он был. Реальное
   * значение заголовка, без ограничения сверху.
   */
  retryAfterMs?: number;
}

export interface ResponseWithMeta<T> {
  data: T;
  meta: ResponseMeta;
}

/**
 * Конфигурация одного запроса. Передаётся в Client.request. В методах
 * вида client.get поля path, method и body задаются самим методом
 * и не входят в RequestOptions.
 */
export interface RequestConfig {
  /**
   * Путь относительно baseUrl, например `/orders`. Только путь,
   * без query-строки: параметры передаются через query.
   *
   * Пробелы и специальные символы внутри сегментов кодируются
   * автоматически: `/users/John Doe` уйдёт как `/users/John%20Doe`.
   */
  path: string;

  /** HTTP-метод. По умолчанию GET. */
  method?: HttpMethod;

  /**
   * Тело запроса. Формат определяется по типу значения: JSON-объект
   * или массив уходит как JSON, FormData как multipart/form-data,
   * Blob как бинарные данные, ArrayBuffer и TypedArray как
   * application/octet-stream, ReadableStream потоком, URLSearchParams
   * как x-www-form-urlencoded, строка как есть.
   *
   * Если Content-Type задан явно, клиент его не перезаписывает.
   */
  body?: unknown;

  /** Заголовки запроса. Имена регистронезависимы. */
  headers?: Record<string, string>;

  query?: QueryParams;

  /**
   * Сигнал отмены. Объединяется с внутренним таймаутом: срабатывает
   * по первому из двух, с сохранением причины.
   */
  signal?: AbortSignal;

  /**
   * Таймаут запроса в миллисекундах. Переопределяет timeoutMs
   * клиента для этого запроса. Значение должно быть положительным
   * и не меньше 100: меньшие отклоняются до отправки запроса.
   */
  timeoutMs?: number;

  /**
   * Пропустить добавление заголовков авторизации и обработку 401.
   * Для запросов, которые создают сессию: токена ещё нет, а 401
   * означает неверные данные, а не истёкшую сессию.
   */
  skipAuth?: boolean;

  /** Пропустить автоматические повторы. */
  skipRetry?: boolean;

  /**
   * Пропустить добавление заголовка идемпотентности: приложение
   * само управляет ключом или запрос не должен попадать
   * в дедупликацию.
   */
  skipIdempotency?: boolean;

  /**
   * Явная область идемпотентности. По умолчанию "${method} ${path}".
   */
  idempotencyScope?: string;

  /** Формат разбора тела ответа. По умолчанию json. */
  responseType?: ResponseType;

  /** Режим отправки cookies: omit, same-origin или include. */
  credentials?: RequestCredentials;

  /**
   * Литерал true: при его наличии клиент возвращает { data, meta }
   * вместо чистых данных. Отсутствие опции означает false. Передача
   * значения типа boolean не допускается: тип ответа должен быть
   * известен на этапе компиляции.
   */
  includeResponseMeta?: true;

  /**
   * Формат массивов в query. Переопределяет настройку клиента
   * для конкретного запроса.
   */
  queryArrayFormat?: QueryArrayFormat;

  /**
   * Формат объектов в query. Переопределяет настройку клиента
   * для конкретного запроса.
   */
  queryObjectFormat?: QueryObjectFormat;

  /**
   * Дополнительные параметры для fetch. Поля method, headers, body,
   * signal, credentials и duplex игнорируются: они управляются
   * клиентом.
   */
  fetchOptions?: Partial<
    Omit<RequestInit, 'method' | 'headers' | 'body' | 'signal' | 'credentials' | 'duplex'>
  >;
}

/**
 * RequestConfig без обязательных path, method и body. Используется
 * в методах вида client.get, где path и method задаются самим
 * методом, а body передаётся отдельным аргументом.
 */
export type RequestOptions = Omit<RequestConfig, 'path' | 'method' | 'body'>;

/**
 * Колбэки для расширения поведения клиента. Все поля опциональны.
 *
 * Все хуки синхронные и вызываются через safeCall: исключение
 * из колбэка не прерывает запрос. Отменить запрос хуком нельзя:
 * для этого есть AbortSignal.
 *
 * Конфиг, который получают onBeforeSend, onResponse и onError,
 * содержит финальные заголовки, включая Accept, Content-Type
 * и добавленные слоями Authorization и Idempotency-Key. Если ошибка
 * возникла до транспорта (например, при сериализации тела или
 * при валидации), onError получает конфиг без этих заголовков.
 *
 * Хуки предохранителя refresh (onCircuitOpen, onCircuitClose) живут
 * в AuthOptions, а не здесь.
 */
export interface Hooks {
  /**
   * Перед отправкой запроса. Один раз на логическую операцию,
   * до всех слоёв pipeline. При retry не повторяется: за это
   * отвечает onRetry.
   *
   * Может вернуть новый конфиг или undefined, чтобы оставить
   * исходный.
   */
  onRequest?: (config: RequestConfig) => RequestConfig | void;

  /**
   * Перед каждой отправкой в fetch, после всех слоёв. Получает
   * финальный конфиг: с заголовками auth, идемпотентности, Accept
   * и Content-Type. Вызывается и при retry, перед каждой попыткой.
   *
   * Возвращаемое значение игнорируется: конфиг на этом этапе уже
   * сформирован слоями. Для логирования и трейсинга.
   */
  onBeforeSend?: (config: RequestConfig) => void;

  /**
   * После успешного ответа: 2xx или 304. Ошибки сюда не попадают.
   * Вызывается один раз на финальный результат.
   *
   * Получает тот же финальный конфиг, что и onBeforeSend: с Accept,
   * Content-Type и заголовками слоёв.
   *
   * Тело может отсутствовать (204, 304, HEAD, OPTIONS): проверяйте
   * meta.status, если нужно.
   */
  onResponse?: (config: RequestConfig, meta: ResponseMeta) => void;

  /**
   * После финальной ошибки, один раз: после всех повторов
   * и попытки refresh. Промежуточные ошибки между повторами сюда
   * не попадают. Ошибки конфигурации тоже не попадают: они
   * выбрасываются до запроса.
   *
   * Если ошибка возникла во время сетевого запроса, config совпадает
   * с тем, что видел onBeforeSend, и дополнительно доступен
   * в error.config. Для ошибок до транспорта (сериализация тела,
   * валидация) config не содержит финальных заголовков.
   */
  onError?: (config: RequestConfig, error: ApiError) => void;

  /**
   * Перед каждой попыткой повтора. Может вернуть новый конфиг или
   * undefined, чтобы оставить текущий. Например, заменить
   * Idempotency-Key при 409.
   *
   * @param attempt - номер попытки с 1. Первый повтор: attempt === 1.
   */
  onRetry?: (config: RequestConfig, attempt: number, error: ApiError) => RequestConfig | void;
}

/**
 * Низкоуровневая функция запроса, из которой строится pipeline.
 * Её возвращают базовый транспорт и каждый слой. Слои оборачивают
 * друг друга: последний в массиве получает базовый транспорт,
 * каждый предыдущий - результат следующего.
 *
 * Функция не должна сама обрабатывать отмену, таймаут, разбор тела
 * и нормализацию ошибок: это делает базовый транспорт.
 *
 * @internal
 */
export type RequestFn = <T = unknown>(config: RequestConfig) => Promise<T>;

/**
 * Две перегрузки: с includeResponseMeta: true возвращается
 * ResponseWithMeta<T>, без него - чистый T.
 *
 * @internal
 */
interface RequestMethod {
  <T = unknown>(
    config: RequestConfig & { includeResponseMeta: true },
  ): Promise<ResponseWithMeta<T>>;
  <T = unknown>(config: RequestConfig): Promise<T>;
}

/**
 * Сигнатура методов без тела: get, head, options.
 *
 * @internal
 */
interface BodylessMethod {
  <T = unknown>(
    path: string,
    options: RequestOptions & { includeResponseMeta: true },
  ): Promise<ResponseWithMeta<T>>;
  <T = unknown>(path: string, options?: RequestOptions): Promise<T>;
}

/**
 * Сигнатура методов с телом: post, put, patch, delete.
 *
 * @internal
 */
interface BodyMethod {
  <T = unknown>(
    path: string,
    body: unknown,
    options: RequestOptions & { includeResponseMeta: true },
  ): Promise<ResponseWithMeta<T>>;
  <T = unknown>(path: string, body?: unknown, options?: RequestOptions): Promise<T>;
}

/**
 * HTTP-клиент. Единственная точка входа в API библиотеки.
 * Создаётся функцией createClient.
 *
 * Все методы поддерживают две формы вызова: без includeResponseMeta
 * возвращают чистые данные, с includeResponseMeta: true - обёртку
 * { data, meta }.
 */
export interface Client {
  /** Низкоуровневый запрос. Остальные методы вызывают его. */
  request: RequestMethod;

  get: BodylessMethod;
  post: BodyMethod;
  put: BodyMethod;
  patch: BodyMethod;

  /**
   * Принимает необязательное тело. HTTP-спецификация называет
   * семантику тела в DELETE неопределённой, но многие API
   * (Keycloak, Java HttpClient, Elasticsearch) её поддерживают.
   */
  delete: BodyMethod;

  /** Только заголовки, без тела. */
  head: BodylessMethod;

  /** Доступные методы для ресурса. */
  options: BodylessMethod;
}
