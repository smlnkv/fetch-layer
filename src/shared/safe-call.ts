/**
 * Для колбэков приложения (логгер, хуки): их падение не должно
 * ломать запрос. Вместо исключения возвращается undefined.
 */
export function safeCall<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}
