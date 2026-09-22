import { toApiError } from './core/errors';
import { runOnError, runOnRequest } from './core/hooks';
import { applyLayers, runAttach, validateLayerOrder } from './core/layer';
import { assertNonEmptyString, assertPositiveNumber } from './shared/validators';
import { createBaseRequest, type TransportOptions } from './transport/transport';

import type { Layer, LayerContext, Logger } from './core/layer';
import type { Client, RequestConfig, RequestFn, RequestOptions } from './core/types';

const MIN_TIMEOUT_MS = 100;

/**
 * Логгер по умолчанию.
 *
 * debug и info отсутствуют - библиотека не должна писать в консоль
 * без запроса.
 */
const defaultLogger: Logger = {
  warn(message, ...args) {
    if (typeof console !== 'undefined' && typeof console.warn === 'function') {
      console.warn(message, ...args);
    }
  },
  error(message, ...args) {
    if (typeof console !== 'undefined' && typeof console.error === 'function') {
      console.error(message, ...args);
    }
  },
};

/** Настройки клиента: все поля TransportOptions плюс logger и layers. */
export interface ClientOptions extends TransportOptions {
  /**
   * Логгер для внутренних сообщений. По умолчанию warn и error
   * делегируют в console, debug и info молчат. Пустой объект
   * полностью отключает вывод.
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
 * Собирает pipeline из базового транспорта и слоёв, валидирует
 * порядок. Поверх pipeline - обёртка с onRequest (один раз
 * на операцию) и onError (один раз на финальную ошибку).
 *
 * @throws Error если конфигурация некорректна: пустой baseUrl,
 *   неположительный или слишком маленький timeoutMs, недоступный
 *   fetch, нарушение порядка слоёв, дубликаты слоёв.
 */
export function createClient(options: ClientOptions): Client {
  validateOptions(options);

  const layers = options.layers ?? [];
  const logger = options.logger ?? defaultLogger;

  validateLayerOrder(layers, logger);

  const context: LayerContext = {
    hooks: options.hooks,
    logger,
  };

  const baseRequest = createBaseRequest(options);
  const { pipeline, states } = applyLayers(baseRequest, layers, context);

  const wrapped: RequestFn = async <T>(config: RequestConfig): Promise<T> => {
    const finalConfig = runOnRequest(options.hooks, config);
    const method = finalConfig.method ?? 'GET';
    const t0 = Date.now();

    try {
      const result = await pipeline<T>(finalConfig);
      logger.debug?.(`[fetch-layer] ${method} ${finalConfig.path} ok in ${Date.now() - t0}ms`);
      return result;
    } catch (e) {
      const error = toApiError(e);

      logger.debug?.(
        `[fetch-layer] ${method} ${finalConfig.path} failed in ${Date.now() - t0}ms: ${error.code}`,
      );

      if (!error.isCancelled) {
        logger.error?.(`[fetch-layer] ${method} ${finalConfig.path}: ${error.message}`);
      }

      runOnError(options.hooks, finalConfig, error);
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

  if (options.layers !== undefined) {
    if (!Array.isArray(options.layers)) {
      throw new Error('createClient: layers must be an array');
    }

    for (let i = 0; i < options.layers.length; i++) {
      const layer: unknown = options.layers[i];
      if (!isLayerLike(layer)) {
        throw new Error(
          `createClient: layers[${i}] is not a valid Layer. ` +
            `Expected an object with a string "name" and a "wrap" function.`,
        );
      }
    }
  }
}

/**
 * Минимальная проверка формы слоя: name - строка, wrap - функция.
 * Полная типизация достигается через TypeScript, рантайм проверяет
 * только то, что слой не null и не мусор.
 */
function isLayerLike(value: unknown): value is Layer {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { name?: unknown; wrap?: unknown };
  return typeof candidate.name === 'string' && typeof candidate.wrap === 'function';
}

/**
 * Сокращённые методы (get, post и другие) вызывают функцию запроса
 * с добавленными path, method и body.
 */
function makeClient(request: RequestFn): Client {
  return {
    request: request as Client['request'],
    get: ((path: string, options?: RequestOptions) =>
      request({ ...options, path, method: 'GET' })) as Client['get'],
    post: ((path: string, body?: unknown, options?: RequestOptions) =>
      request({ ...options, path, method: 'POST', body })) as Client['post'],
    put: ((path: string, body?: unknown, options?: RequestOptions) =>
      request({ ...options, path, method: 'PUT', body })) as Client['put'],
    patch: ((path: string, body?: unknown, options?: RequestOptions) =>
      request({ ...options, path, method: 'PATCH', body })) as Client['patch'],
    // DELETE принимает тело: спецификация называет его семантику
    // неопределённой, но многие API (Keycloak, Java HttpClient,
    // Elasticsearch) это поддерживают.
    delete: ((path: string, body?: unknown, options?: RequestOptions) =>
      request({ ...options, path, method: 'DELETE', body })) as Client['delete'],
    head: ((path: string, options?: RequestOptions) =>
      request({ ...options, path, method: 'HEAD' })) as Client['head'],
    options: ((path: string, options?: RequestOptions) =>
      request({ ...options, path, method: 'OPTIONS' })) as Client['options'],
  };
}
