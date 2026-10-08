/**
 * Вызов unref у таймера, если метод доступен. В Node это позволяет
 * процессу завершиться, не дожидаясь срабатывания таймера: короткая
 * CLI-утилита не висит полный timeoutMs после ответа. В браузере
 * setTimeout возвращает число, у которого unref нет.
 */
export function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  if (
    typeof timer === 'object' &&
    timer !== null &&
    typeof (timer as { unref?: unknown }).unref === 'function'
  ) {
    (timer as { unref: () => void }).unref();
  }
}
