import { createMemoryStorage, fromWebStorage } from '../../shared/storage';

import { createSessionSource } from './session';

import type { IdempotencySource } from './types';

/**
 * Источник ключей на базе sessionStorage браузера. Хранилище
 * изолировано между вкладками: два заказа из двух вкладок - две
 * разные операции с разными ключами. Для дедупликации между
 * вкладками используйте localStorageSource.
 *
 * @throws Error если sessionStorage недоступен: SSR, Web Worker,
 *   Cloudflare Workers, отключённые cookies. Ошибка выбрасывается
 *   сразу при вызове фабрики, а не при первом запросе: так её
 *   проще связать с местом в коде.
 *
 * Для SSR, Web Worker, Cloudflare Workers используйте
 * memoryStorageSource или свой источник поверх Redis, KV,
 * IndexedDB.
 */
export function sessionStorageSource(): IdempotencySource {
  return createSessionSource({
    storage: fromWebStorage(getSessionStorage()),
  });
}

/**
 * Источник ключей на базе localStorage браузера. Хранилище общее
 * для всех вкладок: одна и та же операция с одним телом из разных
 * вкладок получит один ключ и на сервере будет распознана
 * как дубликат.
 *
 * @throws Error если localStorage недоступен: SSR, Web Worker,
 *   Cloudflare Workers, отключённые cookies. Ошибка выбрасывается
 *   сразу при вызове фабрики, а не при первом запросе.
 *
 * В приватном режиме Safari localStorage может быть недоступен
 * или вести себя непредсказуемо. fromWebStorage обрабатывает
 * ошибки чтения и очистки, но setItem в таком режиме может
 * выбросить QuotaExceededError. Если это критично, используйте
 * sessionStorageSource.
 *
 * Для SSR, Web Worker, Cloudflare Workers используйте
 * memoryStorageSource или свой источник поверх Redis, KV,
 * IndexedDB.
 */
export function localStorageSource(): IdempotencySource {
  return createSessionSource({
    storage: fromWebStorage(getLocalStorage()),
  });
}

/**
 * Источник ключей на базе хранилища в памяти. Данные живут, пока
 * живёт процесс: при перезагрузке страницы теряются. Для тестов,
 * SSR, Web Worker, Cloudflare Workers и одноразовых операций.
 */
export function memoryStorageSource(): IdempotencySource {
  return createSessionSource({
    storage: createMemoryStorage(),
  });
}

/**
 * Глобальный sessionStorage или понятная ошибка вместо невнятного
 * TypeError при первом обращении к хранилищу.
 */
function getSessionStorage(): Storage {
  if (typeof sessionStorage === 'undefined') {
    throw new Error(
      'sessionStorageSource is not available outside a browser. ' +
        'For SSR and tests use memoryStorageSource.',
    );
  }
  return sessionStorage;
}

function getLocalStorage(): Storage {
  if (typeof localStorage === 'undefined') {
    throw new Error(
      'localStorageSource is not available outside a browser. ' +
        'For SSR and tests use memoryStorageSource.',
    );
  }
  return localStorage;
}
