export { createClient, type ClientOptions } from './client';

export { ApiError, toApiError, type ApiErrorKind } from './core/errors';

export type { Layer, LayerContext } from './core/layer';

export type { ErrorBodyParser } from './core/error-body';

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
