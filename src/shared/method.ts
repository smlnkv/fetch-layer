import type { HttpMethod } from '../core/types';

/**
 * Mutating methods. Idempotency and unsafe retry warning apply to
 * them.
 */
export function isMutatingMethod(method: HttpMethod): boolean {
  return method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
}
