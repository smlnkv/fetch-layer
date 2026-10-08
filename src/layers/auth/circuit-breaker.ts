import { safeCall } from '../../shared/safe-call';
import { unrefTimer } from '../../shared/timers';

export interface CircuitBreakerCallbacks {
  onOpen?: () => void;
  onClose?: () => void;
}

/**
 * После временного сбоя блокирует новые попытки refresh на заданное
 * время. Без предохранителя каждый новый 401 запускал бы новую
 * попытку, и недоступный провайдер получал бы поток запросов.
 *
 * Колбэки onOpen и onClose вызываются ровно один раз на переход
 * состояния.
 */
export class CircuitBreaker {
  private openUntil = 0;
  private isOpen = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly callbacks: CircuitBreakerCallbacks;

  constructor(callbacks: CircuitBreakerCallbacks = {}) {
    this.callbacks = callbacks;
  }

  /**
   * true, если предохранитель блокирует refresh. Если время
   * блокировки истекло, закрывает и возвращает false.
   */
  isBlocking(): boolean {
    if (!this.isOpen) return false;

    if (Date.now() >= this.openUntil) {
      this.close();
      return false;
    }

    return true;
  }

  /**
   * Открывает предохранитель на durationMs. Повторный вызов
   * продлевает блокировку, но onOpen второй раз не вызывается.
   *
   * В Node таймер не удерживает event loop (unref), чтобы процесс
   * мог завершиться.
   *
   * @throws Error если durationMs не положительное число. Нулевая
   *   или отрицательная длительность открыла бы предохранитель
   *   сразу в закрытом состоянии.
   */
  open(durationMs: number): void {
    if (!Number.isFinite(durationMs) || durationMs <= 0) {
      throw new Error(
        `CircuitBreaker.open: durationMs must be a positive number, got ${String(durationMs)}`,
      );
    }

    const wasOpen = this.isOpen && Date.now() < this.openUntil;

    this.openUntil = Date.now() + durationMs;
    this.isOpen = true;

    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => this.close(), durationMs);
    unrefTimer(this.timer);

    if (!wasOpen) {
      safeCall(() => this.callbacks.onOpen?.());
    }
  }

  /**
   * Закрывает предохранитель и очищает таймер. Идемпотентно:
   * повторный вызов на закрытом предохранителе ничего не делает
   * и не вызывает onClose.
   */
  close(): void {
    if (!this.isOpen) return;

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    this.isOpen = false;
    this.openUntil = 0;

    safeCall(() => this.callbacks.onClose?.());
  }
}
