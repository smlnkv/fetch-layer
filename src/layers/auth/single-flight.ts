/**
 * Если несколько вызовов run происходят до завершения первого,
 * все получают результат одного промиса. После завершения следующий
 * run запускает новую операцию.
 *
 * Используется RefreshManager: параллельные 401 не должны запускать
 * несколько refresh.
 */
export class SingleFlight<T> {
  private inFlight: Promise<T> | null = null;

  /**
   * Запускает операцию или присоединяется к текущей.
   *
   * @param fn - выполнится, если операции ещё нет.
   * @returns для параллельных вызовов тот же промис, что и у первого.
   */
  run(fn: () => Promise<T>): Promise<T> {
    if (this.inFlight) {
      return this.inFlight;
    }

    const promise = fn().finally(() => {
      // Ссылка могла быть обнулена через forget и заменена новым
      // промисом от run. Тогда трогать её нельзя.
      if (this.inFlight === promise) {
        this.inFlight = null;
      }
    });

    this.inFlight = promise;
    return promise;
  }

  /**
   * Забывает текущий промис. Ожидающие его вызовы продолжат ждать:
   * отменить промис в JS нельзя. Следующий run запустит новую
   * операцию, не присоединяясь к прежней.
   */
  forget(): void {
    this.inFlight = null;
  }
}
