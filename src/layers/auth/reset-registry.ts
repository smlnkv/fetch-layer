import type { Client } from '../../core/types';

/**
 * Registry of reset functions keyed by client object. WeakMap, not a
 * property on the client: the registry does not overlap with public
 * API, binding is to the object itself, not to a copy. Two library
 * versions in one bundle get a registry each.
 */
const registry = new WeakMap<Client, () => void>();

/**
 * Binds a reset function to the client object. Called from withAuth
 * via Layer.attach after client creation.
 *
 * @internal
 */
export function attachReset(client: Client, reset: () => void): void {
  registry.set(client, reset);
}

/**
 * Resets the token refresh breaker on the given client.
 *
 * @returns true if the reset ran. false if the client has no auth or
 *   is not the object returned by createClient (e.g. a spread copy).
 */
export function resetRefreshCircuit(client: Client): boolean {
  const fn = registry.get(client);
  if (!fn) return false;
  fn();
  return true;
}
