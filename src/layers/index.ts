/**
 * Фасад для типового случая: фабрики слоёв и источники ключей
 * идемпотентности. Для глубокой настройки использовать подпути:
 * fetch-layer/auth, fetch-layer/idempotency, fetch-layer/storage.
 *
 * @example
 * import { createClient } from 'fetch-layer';
 * import {
 *   withAuth,
 *   withRetry,
 *   withIdempotency,
 *   sessionStorageSource,
 * } from 'fetch-layer/layers';
 *
 * const client = createClient({
 *   baseUrl: '/api',
 *   layers: [
 *     withIdempotency({ source: sessionStorageSource() }),
 *     withRetry({ maxAttempts: 3 }),
 *     withAuth({ provider: sessionProvider }),
 *   ],
 * });
 */

export type { Layer, LayerContext } from '../core/layer';

export { withRetry, type RetryOptions } from './retry/layer';

export { withAuth, type AuthOptions } from './auth/layer';

export { withIdempotency, type IdempotencyOptions } from './idempotency/layer';

export {
  sessionStorageSource,
  localStorageSource,
  memoryStorageSource,
} from './idempotency/sources';
