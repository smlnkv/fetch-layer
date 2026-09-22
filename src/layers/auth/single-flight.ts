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

    this.inFlight = fn().finally(() => {
      this.inFlight = null;
    });

    return this.inFlight;
  }
}
