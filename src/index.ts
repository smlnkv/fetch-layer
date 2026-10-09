/**
 * Публичный API библиотеки.
 *
 * Подпути:
 * - fetch-layer/layers - фабрики встроенных слоёв и источники ключей;
 * - fetch-layer/auth - провайдер сессии и resetRefreshCircuit;
 * - fetch-layer/idempotency - IdempotencySource и createSessionSource;
 * - fetch-layer/retry - только слой повторов;
 * - fetch-layer/storage - адаптеры хранилища;
 * - fetch-layer/error-body - встроенные парсеры тела ошибки.
 *
 * Внутренние модули (pipeline слоёв, утилиты, парсеры тела ошибки)
 * не входят в публичное API: приложение не может нарушить порядок
 * обёрток.
 */

export { createClient, type ClientOptions } from './client';

export { ApiError, toApiError, type ApiErrorKind } from './core/errors';

export type { Layer, LayerContext } from './core/layer';

export type { ErrorBodyParser, ParsedErrorBody } from './core/error-body';

export { createMemoryStorage, fromWebStorage, type StorageLike } from './shared/storage';

export type {
  Client,
  HttpMethod,
  QueryArrayFormat,
  QueryObjectFormat,
  QueryParamObject,
  QueryParamPrimitive,
  QueryParamValue,
  QueryParams,
  RequestConfig,
  RequestFn,
  RequestOptions,
  ResolvedRequestConfig,
  ResponseMeta,
  ResponseType,
  ResponseWithMeta,
} from './core/types';
