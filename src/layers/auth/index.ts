/**
 * Публичный API модуля авторизации.
 *
 * Фабрика слоя withAuth живёт в fetch-layer/layers. Здесь - типы
 * контракта авторизации и resetRefreshCircuit.
 *
 * @example
 * import { resetRefreshCircuit } from 'fetch-layer/auth';
 *
 * // После ручного логина сбрасываем предохранитель,
 * // не дожидаясь автоматического закрытия:
 * resetRefreshCircuit(client);
 */

export type { RefreshResult, SessionExpiredReason, SessionProvider } from './types';

export type { AuthOptions } from './layer';

export { resetRefreshCircuit } from './reset-registry';
