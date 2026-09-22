import type { HttpMethod } from '../core/types';

/**
 * Изменяющие методы. Для них имеет смысл идемпотентность
 * и предупреждение о небезопасном повторе.
 */
export function isMutatingMethod(method: HttpMethod): boolean {
  return method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
}
