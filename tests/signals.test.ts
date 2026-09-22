// Тесты shared/signals.ts.

import { describe, expect, it, vi } from 'vitest';

import { setAbortTimeout, sleep, throwIfAborted } from '../src/shared/signals';

describe('sleep', () => {
  it('завершается через указанное время', async () => {
    vi.useFakeTimers();
    try {
      const promise = sleep(100);
      let done = false;
      void promise.then(() => {
        done = true;
      });

      await vi.advanceTimersByTimeAsync(50);
      expect(done).toBe(false);

      await vi.advanceTimersByTimeAsync(60);
      await promise;
      expect(done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('сохраняет причину отмены', async () => {
    const controller1 = new AbortController();
    controller1.abort();
    await expect(sleep(100, controller1.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });

    vi.useFakeTimers();
    try {
      const timeoutReason = new DOMException('Timeout', 'TimeoutError');
      const controller2 = new AbortController();
      const promise = sleep(1000, controller2.signal);
      promise.catch(() => {});
      await vi.advanceTimersByTimeAsync(100);
      controller2.abort(timeoutReason);
      await expect(promise).rejects.toBe(timeoutReason);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('throwIfAborted', () => {
  it('ошибка AbortError только для отменённого сигнала', () => {
    expect(() => throwIfAborted(new AbortController().signal)).not.toThrow();
    expect(() => throwIfAborted(undefined)).not.toThrow();

    const controller = new AbortController();
    controller.abort();
    expect(() => throwIfAborted(controller.signal)).toThrowError(
      expect.objectContaining({ name: 'AbortError' }),
    );
  });
});

describe('setAbortTimeout', () => {
  it('срабатывает через указанное время с TimeoutError, clear предотвращает', async () => {
    vi.useFakeTimers();
    try {
      const { signal } = setAbortTimeout(100);
      expect(signal.aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(150);
      expect(signal.aborted).toBe(true);
      expect((signal.reason as DOMException).name).toBe('TimeoutError');

      const { signal: signal2, clear } = setAbortTimeout(100);
      clear();
      await vi.advanceTimersByTimeAsync(200);
      expect(signal2.aborted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
