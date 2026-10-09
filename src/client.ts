import { applyLayers, runAttach, validateLayerOrder } from './core/layer';
import { assertNonEmptyString } from './shared/validators';
import { mergeHeaders } from './transport/headers';
import { createBaseRequest, type TransportOptions } from './transport/transport';

import type { Layer, LayerContext } from './core/layer';
import type {
  Client,
  HttpMethod,
  RequestConfig,
  RequestOptions,
  ResolvedRequestConfig,
  ResponseWithMeta,
} from './core/types';

const MIN_TIMEOUT_MS = 100;

/**
 * Публичная функция запроса: принимает RequestConfig с любым
 * HeadersInit. Внутренний RequestFn работает с ResolvedRequestConfig,
 * где заголовки уже Record. Эти два типа несовместимы напрямую,
 * поэтому публичная функция вводится локально, без экспорта.
 */
type PublicRequestFn = <T = unknown>(config: RequestConfig) => Promise<T>;

/** Настройки клиента: все поля TransportOptions плюс warn и layers. */
export interface ClientOptions extends TransportOptions {
  /**
   * Приёмник предупреждений о неверном использовании API.
   * По умолчанию console.warn. Передайте null, чтобы отключить.
   */
  warn?: ((message: string) => void) | null;

  /**
   * Слои клиента. Применяются снаружи внутрь: первый в массиве
   * оборачивает все последующие, последний получает базовый транспорт.
   *
   * Встроенные слои идут в порядке withIdempotency -> withRetry ->
   * withAuth. Порядок валидируется при создании клиента.
   *
   * Если не заданы, клиент работает без слоёв.
   */
  layers?: readonly Layer[];
}

/**
 * Приводит публичный RequestConfig к внутреннему виду: заголовки
 * нормализуются в Record. undefined остаётся undefined, чтобы
 * слои не видели пустой объект вместо отсутствия заголовков.
 */
function resolveConfig(config: RequestConfig): ResolvedRequestConfig {
  return {
    ...config,
    headers: config.headers ? mergeHeaders(config.headers) : undefined,
  };
}

/**
 * Единая проверка timeoutMs: значение должно быть числом не меньше
 * MIN_TIMEOUT_MS. Отдельная от assertPositiveNumber, потому что
 * та даёт другое сообщение и другой порог.
 */
function assertTimeout(value: unknown, prefix: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < MIN_TIMEOUT_MS) {
    throw new Error(
      `${prefix}: timeoutMs must be a number >= ${MIN_TIMEOUT_MS} ms, got ${String(value)}`,
    );
  }
}

/**
 * Собирает pipeline из базового транспорта и слоёв, валидирует
 * порядок.
 *
 * @throws Error если конфигурация некорректна: пустой baseUrl,
 *   невалидный или слишком маленький timeoutMs, недоступный fetch,
 *   нарушение порядка слоёв, дубликаты имён, дубликаты stage.
 */
export function createClient(options: ClientOptions): Client {
  validateOptions(options);

  const layers = options.layers ?? [];

  validateLayerOrder(layers);

  // null отключает предупреждения; undefined - console.warn по умолчанию.
  const warn = options.warn === undefined ? console.warn : (options.warn ?? undefined);

  const context: LayerContext = {
    warn,
  };

  const baseRequest = createBaseRequest(options);
  const { pipeline, states } = applyLayers(baseRequest, layers, context);

  const wrapped: PublicRequestFn = async <T>(config: RequestConfig): Promise<T> => {
    const resolved = resolveConfig(config);

    assertNonEmptyString(resolved.path, 'client: path');

    if (resolved.timeoutMs !== undefined) {
      assertTimeout(resolved.timeoutMs, 'client');
    }

    // Нормализуем метод до верхнего регистра: слои (withIdempotency,
    // withRetry) сравнивают его со строками 'POST', 'PUT' и другими.
    // Fetch нормализует сам, но слои получают конфиг до fetch.
    const finalConfig: ResolvedRequestConfig = {
      ...resolved,
      method: (resolved.method ?? 'GET').toUpperCase() as HttpMethod,
    };

    return pipeline<T>(finalConfig);
  };

  const client = makeClient(wrapped);
  runAttach(layers, states, client);

  return client;
}

/**
 * Ошибка конфигурации обнаруживается при создании клиента,
 * а не при первом запросе.
 */
function validateOptions(options: ClientOptions): void {
  assertNonEmptyString(options.baseUrl, 'createClient: baseUrl');

  if (options.timeoutMs !== undefined) {
    assertTimeout(options.timeoutMs, 'createClient');
  }

  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error(
      'createClient: fetch is not available. Pass it via the fetch option ' +
        'or use an environment with a global fetch (Node >= 20, modern browser).',
    );
  }

  if (options.layers !== undefined && !Array.isArray(options.layers)) {
    throw new Error('createClient: layers must be an array');
  }
}

/**
 * Сокращённые методы (get, post и другие) вызывают функцию запроса
 * с добавленными path, method и body.
 */
function makeBodyless(request: PublicRequestFn, method: HttpMethod) {
  return <T>(path: string, options?: RequestOptions): Promise<T> =>
    request<T>({ ...options, path, method });
}

function makeBody(request: PublicRequestFn, method: HttpMethod) {
  return <T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> =>
    request<T>({ ...options, path, method, body });
}

function makeMetaOnly(request: PublicRequestFn, method: 'HEAD' | 'OPTIONS') {
  return (path: string, options?: RequestOptions): Promise<ResponseWithMeta<undefined>> =>
    request<ResponseWithMeta<undefined>>({
      ...options,
      path,
      method,
      includeResponseMeta: true,
    });
}

function makeClient(request: PublicRequestFn): Client {
  return {
    request: <T>(config: RequestConfig) => request<T>(config),
    requestWithMeta: <T>(config: RequestConfig) =>
      request<ResponseWithMeta<T>>({ ...config, includeResponseMeta: true }),

    get: makeBodyless(request, 'GET'),
    post: makeBody(request, 'POST'),
    put: makeBody(request, 'PUT'),
    patch: makeBody(request, 'PATCH'),
    delete: makeBody(request, 'DELETE'),

    head: makeMetaOnly(request, 'HEAD'),
    options: makeMetaOnly(request, 'OPTIONS'),
  };
}
