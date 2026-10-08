import { toApiError } from './core/errors';
import { runOnError, runOnRequest } from './core/hooks';
import { applyLayers, runAttach, validateLayerOrder } from './core/layer';
import { safeCall } from './shared/safe-call';
import { assertNonEmptyString, assertPositiveNumber } from './shared/validators';
import { mergeHeaders } from './transport/headers';
import { createBaseRequest, type TransportOptions } from './transport/transport';

import type { Layer, LayerContext, Logger } from './core/layer';
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

/**
 * Логгер по умолчанию: пустой объект. Библиотека не пишет в console
 * без явного запроса. Передайте свой logger, чтобы получать
 * предупреждения и ошибки через него.
 */
const defaultLogger: Logger = {};

/** Настройки клиента: все поля TransportOptions плюс logger и layers. */
export interface ClientOptions extends TransportOptions {
  /**
   * Логгер для внутренних сообщений. По умолчанию не задан:
   * библиотека молчит. Передайте свой logger, чтобы получать
   * предупреждения и ошибки через него. Пустой объект эквивалентен
   * отсутствию логгера.
   */
  logger?: Logger;

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
 * хуки не видели пустой объект вместо отсутствия заголовков.
 */
function resolveConfig(config: RequestConfig): ResolvedRequestConfig {
  return {
    ...config,
    headers: config.headers ? mergeHeaders(config.headers) : undefined,
  };
}

/**
 * Собирает pipeline из базового транспорта и слоёв, валидирует
 * порядок. Поверх pipeline - обёртка с onRequest (один раз
 * на операцию) и onError (один раз на финальную ошибку).
 *
 * @throws Error если конфигурация некорректна: пустой baseUrl,
 *   неположительный или слишком маленький timeoutMs, недоступный
 *   fetch, layers не массив, нарушение порядка слоёв, дубликаты
 *   имён, дубликаты stage.
 */
export function createClient(options: ClientOptions): Client {
  validateOptions(options);

  const layers = options.layers ?? [];
  const logger = options.logger ?? defaultLogger;

  validateLayerOrder(layers);

  const context: LayerContext = {
    hooks: options.hooks,
    logger,
  };

  const baseRequest = createBaseRequest(options);
  const { pipeline, states } = applyLayers(baseRequest, layers, context);

  const wrapped: PublicRequestFn = async <T>(config: RequestConfig): Promise<T> => {
    const resolved = resolveConfig(config);
    const hooked = runOnRequest(options.hooks, resolved);

    // Проверяем поля после onRequest, а не исходные.
    assertNonEmptyString(hooked.path, 'client: path');

    if (hooked.timeoutMs !== undefined) {
      assertPositiveNumber(hooked.timeoutMs, 'client: timeoutMs');
      if (hooked.timeoutMs < MIN_TIMEOUT_MS) {
        throw new Error(`client: timeoutMs must be at least ${MIN_TIMEOUT_MS} ms`);
      }
    }

    // Нормализуем метод до верхнего регистра: слои (withIdempotency,
    // withRetry) сравнивают его со строками 'POST', 'PUT' и другими.
    // Fetch нормализует сам, но слои получают конфиг до fetch.
    const finalConfig: ResolvedRequestConfig = {
      ...hooked,
      method: (hooked.method ?? 'GET').toUpperCase() as HttpMethod,
    };

    const method = finalConfig.method as HttpMethod;
    const t0 = Date.now();

    try {
      const result = await pipeline<T>(finalConfig);
      safeCall(() =>
        logger.debug?.(`[fetch-layer] ${method} ${finalConfig.path} ok in ${Date.now() - t0}ms`),
      );
      return result;
    } catch (e) {
      const error = toApiError(e);

      safeCall(() =>
        logger.debug?.(
          `[fetch-layer] ${method} ${finalConfig.path} failed in ${Date.now() - t0}ms: ${error.code}`,
        ),
      );

      if (!error.isCancelled) {
        safeCall(() =>
          logger.error?.(`[fetch-layer] ${method} ${finalConfig.path}: ${error.message}`),
        );
      }

      // Транспорт прикрепляет к ошибке свой финальный конфиг с
      // Accept и Content-Type. Если ошибка возникла до транспорта,
      // config остаётся undefined, и onError получает конфиг,
      // прошедший через onRequest.
      runOnError(options.hooks, error.config ?? finalConfig, error);
      throw error;
    }
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
    assertPositiveNumber(options.timeoutMs, 'createClient: timeoutMs');
    if (options.timeoutMs < MIN_TIMEOUT_MS) {
      throw new Error(`createClient: timeoutMs must be at least ${MIN_TIMEOUT_MS} ms`);
    }
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
