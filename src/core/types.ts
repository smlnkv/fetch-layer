export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

/**
 * Формат разбора успешного ответа. Для text, blob, arrayBuffer
 * и stream трансформации не применяются: тело отдаётся как есть.
 *
 * - json: пустое тело даёт undefined, а не ошибку;
 * - text: для CSV, HTML, plain text;
 * - blob: бинарные данные с MIME-типом;
 * - arrayBuffer: бинарные данные без MIME-типа;
 * - stream: ReadableStream<Uint8Array>, для больших файлов и SSE.
 */
export type ResponseType = 'json' | 'text' | 'blob' | 'arrayBuffer' | 'stream';

/**
 * Числа и boolean сериализуются в строку автоматически.
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
 * HTTP-метаданные ответа. Возвращаются из requestWithMeta, head
 * и options.
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

  /**
   * Заголовки запроса. Принимает Record, Headers или массив пар.
   * Имена регистронезависимы. Внутри нормализуется в Record.
   */
  headers?: HeadersInit;

  query?: QueryParams;

  /**
   * Сигнал отмены. Объединяется с внутренним таймаутом: срабатывает
   * по первому из двух, с сохранением причины.
   */
  signal?: AbortSignal;

  /**
   * Таймаут запроса в миллисекундах. Переопределяет timeoutMs
   * клиента для этого запроса. Значение должно быть не меньше 100.
   */
  timeoutMs?: number;

  /**
   * Пропустить добавление заголовков авторизации и обработку 401.
   * Для запросов, которые создают сессию.
   */
  skipAuth?: boolean;

  /** Пропустить автоматические повторы. */
  skipRetry?: boolean;

  /**
   * Пропустить добавление заголовка идемпотентности: приложение
   * само управляет ключом.
   */
  skipIdempotency?: boolean;

  /** Явная область идемпотентности. По умолчанию "${method} ${path}". */
  idempotencyScope?: string;

  /** Формат разбора тела ответа. По умолчанию json. */
  responseType?: ResponseType;

  /** Режим отправки cookies: omit, same-origin или include. */
  credentials?: RequestCredentials;

  /**
   * Выставляется requestWithMeta, head и options.
   *
   * @internal
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
   * signal, credentials и duplex игнорируются.
   */
  fetchOptions?: Partial<
    Omit<RequestInit, 'method' | 'headers' | 'body' | 'signal' | 'credentials' | 'duplex'>
  >;
}

/**
 * Внутренний конфиг: заголовки нормализованы в Record. Этот тип
 * получают слои и транспорт после того, как client.ts вызвал
 * mergeHeaders на публичном RequestConfig.
 */
export interface ResolvedRequestConfig extends Omit<RequestConfig, 'headers'> {
  headers?: Record<string, string>;

  /**
   * Устанавливается withIdempotency. Свидетельствует, что к запросу
   * применён ключ идемпотентности. withRetry читает маркер, чтобы
   * решить, безопасен ли повтор мутирующего метода.
   *
   * Поле заполняется и когда withIdempotency сгенерировал ключ,
   * и когда приложение задало его вручную. headerName хранится
   * для отладки, withRetry на него не опирается.
   *
   * @internal
   */
  idempotency?: { headerName: string; key: string };
}

/**
 * RequestConfig без обязательных path, method и body. Используется
 * в методах вида client.get, где path и method задаются самим
 * методом, а body передаётся отдельным аргументом.
 */
export type RequestOptions = Omit<
  RequestConfig,
  'path' | 'method' | 'body' | 'includeResponseMeta'
>;

/**
 * Низкоуровневая функция запроса, из которой строится pipeline.
 * Слои оборачивают друг друга: последний в массиве получает базовый
 * транспорт, каждый предыдущий - результат следующего.
 */
export type RequestFn = <T = unknown>(config: ResolvedRequestConfig) => Promise<T>;

/**
 * HTTP-клиент. Создаётся функцией createClient.
 *
 * get, post, put, patch, delete возвращают распарсенное тело.
 * head и options возвращают { data, meta }: тела у них нет,
 * метаданные - основной результат. requestWithMeta даёт доступ
 * к метаданным для любого HTTP-метода.
 */
export interface Client {
  /** Запрос с любым HTTP-методом. */
  request: <T = unknown>(config: RequestConfig) => Promise<T>;

  /** Запрос с метаданными ответа: { data, meta }. */
  requestWithMeta: <T = unknown>(config: RequestConfig) => Promise<ResponseWithMeta<T>>;

  get: <T = unknown>(path: string, options?: RequestOptions) => Promise<T>;
  post: <T = unknown>(path: string, body?: unknown, options?: RequestOptions) => Promise<T>;
  put: <T = unknown>(path: string, body?: unknown, options?: RequestOptions) => Promise<T>;
  patch: <T = unknown>(path: string, body?: unknown, options?: RequestOptions) => Promise<T>;

  /**
   * Принимает необязательное тело. HTTP-спецификация называет
   * семантику тела в DELETE неопределённой, но многие API её
   * поддерживают.
   */
  delete: <T = unknown>(path: string, body?: unknown, options?: RequestOptions) => Promise<T>;

  /** Только заголовки. Тела нет, data всегда undefined. */
  head: (path: string, options?: RequestOptions) => Promise<ResponseWithMeta<undefined>>;

  /** Доступные методы для ресурса. Тела нет, data всегда undefined. */
  options: (path: string, options?: RequestOptions) => Promise<ResponseWithMeta<undefined>>;
}
