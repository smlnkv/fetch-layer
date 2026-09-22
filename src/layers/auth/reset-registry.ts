import type { Client } from '../../core/types';

/**
 * Реестр reset-функций по объекту клиента. WeakMap, а не свойство
 * на объекте клиента: реестр не путается с публичным API
 * и привязка идёт к самому объекту, а не к его копии.
 *
 * Если в бандле окажутся две версии библиотеки, каждая получит
 * свой реестр.
 */
const registry = new WeakMap<Client, () => void>();

/**
 * Привязывает функцию сброса к объекту клиента. Вызывается
 * из withAuth через Layer.attach после создания клиента.
 *
 * @internal
 */
export function attachReset(client: Client, reset: () => void): void {
  registry.set(client, reset);
}

/**
 * Сбрасывает предохранитель обновления токена на указанном клиенте.
 * Используется, когда приложение знает, что проблема устранена:
 * пользователь вошёл заново и ждать автоматического закрытия
 * предохранителя не нужно.
 *
 * @returns true, если сброс выполнен. false, если клиент не имеет
 *   авторизации или это не тот объект, что вернул createClient
 *   (например, spread-копия).
 */
export function resetRefreshCircuit(client: Client): boolean {
  const fn = registry.get(client);
  if (!fn) return false;
  fn();
  return true;
}
