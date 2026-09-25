// Тесты retry-слоя через createClient.

import { describe, expect, it, vi } from 'vitest';

import { withRetry } from '../src/layers/index';

import { createMockFetch, createTestClient } from './helpers';

import type { ApiError, Client } from '../src/index';

const createSleepSpy = () =>
  vi.fn<(ms: number, signal?: AbortSignal) => Promise<void>>(() => Promise.resolve());

const noSleep = (): Promise<void> => Promise.resolve();

interface RetryClientOptions {
  fetch: typeof fetch;
  maxAttempts?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  shouldRetry?: (error: ApiError, attempt: number) => boolean;
  computeDelay?: (attempt: number, error: ApiError) => number;
  warnOnUnsafeRetry?: boolean;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitterRatio?: number;
  retryOnNetwork?: boolean;
  retryOnTimeout?: boolean;
}

function createRetryClient(options: RetryClientOptions): Client {
  return createTestClient({
    fetch: options.fetch,
    retry: {
      maxAttempts: options.maxAttempts,
      sleep: options.sleep,
      shouldRetry: options.shouldRetry,
      computeDelay: options.computeDelay,
      warnOnUnsafeRetry: options.warnOnUnsafeRetry,
      baseDelayMs: options.baseDelayMs,
      maxDelayMs: options.maxDelayMs,
      jitterRatio: options.jitterRatio,
      retryOnNetwork: options.retryOnNetwork,
      retryOnTimeout: options.retryOnTimeout,
    },
  });
}

describe('retry - повтор на 5xx', () => {
  it('повторяет и завершается успехом', async () => {
    let attempts = 0;
    const mock = createMockFetch(() => {
      attempts++;
      if (attempts < 3) return { status: 500, body: { code: 'SERVER_ERROR' } };
      return { body: { id: '1' } };
    });

    const client = createRetryClient({
      fetch: mock.fetch,
      maxAttempts: 3,
      sleep: noSleep,
    });

    const result = await client.get<{ id: string }>('/users');

    expect(result).toEqual({ id: '1' });
    expect(attempts).toBe(3);
  });

  it('ошибка после исчерпания maxAttempts, при maxAttempts=1 не повторять', async () => {
    let attempts1 = 0;
    const mock1 = createMockFetch(() => {
      attempts1++;
      return { status: 500, body: { code: 'SERVER_ERROR' } };
    });
    const client1 = createRetryClient({
      fetch: mock1.fetch,
      maxAttempts: 2,
      sleep: noSleep,
    });
    await expect(client1.get('/users')).rejects.toMatchObject({ status: 500 });
    expect(attempts1).toBe(2);

    let attempts2 = 0;
    const mock2 = createMockFetch(() => {
      attempts2++;
      return { status: 500, body: {} };
    });
    const client2 = createRetryClient({
      fetch: mock2.fetch,
      maxAttempts: 1,
      sleep: noSleep,
    });
    await expect(client2.get('/users')).rejects.toBeDefined();
    expect(attempts2).toBe(1);
  });
});

describe('retry - сеть и таймаут', () => {
  it('повторяет при network error и timeout по умолчанию', async () => {
    let attempts1 = 0;
    const mock1 = createMockFetch(() => {
      attempts1++;
      if (attempts1 < 2) throw new TypeError('Network down');
      return { body: { ok: true } };
    });
    const client1 = createRetryClient({
      fetch: mock1.fetch,
      maxAttempts: 3,
      sleep: noSleep,
    });
    expect(await client1.get('/users')).toEqual({ ok: true });
    expect(attempts1).toBe(2);

    let attempts2 = 0;
    const mock2 = createMockFetch(() => {
      attempts2++;
      if (attempts2 < 2) throw new DOMException('Timeout', 'TimeoutError');
      return { body: { ok: true } };
    });
    const client2 = createRetryClient({
      fetch: mock2.fetch,
      maxAttempts: 3,
      sleep: noSleep,
    });
    await client2.get('/users');
    expect(attempts2).toBe(2);
  });
});

describe('retry - retryOnNetwork и retryOnTimeout', () => {
  it('retryOnNetwork: false не повторяет network, но повторяет timeout', async () => {
    let attempts1 = 0;
    const mock1 = createMockFetch(() => {
      attempts1++;
      throw new TypeError('Network down');
    });
    const client1 = createRetryClient({
      fetch: mock1.fetch,
      maxAttempts: 3,
      sleep: noSleep,
      retryOnNetwork: false,
    });
    await expect(client1.get('/users')).rejects.toMatchObject({ kind: 'network' });
    expect(attempts1).toBe(1);

    let attempts2 = 0;
    const mock2 = createMockFetch(() => {
      attempts2++;
      if (attempts2 < 2) throw new DOMException('Timeout', 'TimeoutError');
      return { body: { ok: true } };
    });
    const client2 = createRetryClient({
      fetch: mock2.fetch,
      maxAttempts: 3,
      sleep: noSleep,
      retryOnNetwork: false,
    });
    await client2.get('/users');
    expect(attempts2).toBe(2);
  });

  it('retryOnTimeout: false не повторяет timeout, но повторяет network', async () => {
    let attempts1 = 0;
    const mock1 = createMockFetch(() => {
      attempts1++;
      throw new DOMException('Timeout', 'TimeoutError');
    });
    const client1 = createRetryClient({
      fetch: mock1.fetch,
      maxAttempts: 3,
      sleep: noSleep,
      retryOnTimeout: false,
    });
    await expect(client1.get('/users')).rejects.toMatchObject({ kind: 'timeout' });
    expect(attempts1).toBe(1);

    let attempts2 = 0;
    const mock2 = createMockFetch(() => {
      attempts2++;
      if (attempts2 < 2) throw new TypeError('Network down');
      return { body: { ok: true } };
    });
    const client2 = createRetryClient({
      fetch: mock2.fetch,
      maxAttempts: 3,
      sleep: noSleep,
      retryOnTimeout: false,
    });
    await client2.get('/users');
    expect(attempts2).toBe(2);
  });

  it('обе опции false: не повторяет ни network, ни timeout, но повторяет 5xx', async () => {
    let attempts1 = 0;
    const mock1 = createMockFetch(() => {
      attempts1++;
      throw new TypeError('Network down');
    });
    const client1 = createRetryClient({
      fetch: mock1.fetch,
      maxAttempts: 3,
      sleep: noSleep,
      retryOnNetwork: false,
      retryOnTimeout: false,
    });
    await expect(client1.get('/users')).rejects.toBeDefined();
    expect(attempts1).toBe(1);

    let attempts2 = 0;
    const mock2 = createMockFetch(() => {
      attempts2++;
      if (attempts2 < 2) return { status: 500, body: {} };
      return { body: { ok: true } };
    });
    const client2 = createRetryClient({
      fetch: mock2.fetch,
      maxAttempts: 3,
      sleep: noSleep,
      retryOnNetwork: false,
      retryOnTimeout: false,
    });
    await client2.get('/users');
    expect(attempts2).toBe(2);
  });

  it('shouldRetry приложения полностью заменяет дефолт', async () => {
    // Пользовательский shouldRetry не композируется с retryOnNetwork
    // и retryOnTimeout. Он получает ApiError и решает сам.
    let attempts = 0;
    const mock = createMockFetch(() => {
      attempts++;
      throw new TypeError('Network down');
    });

    const client = createRetryClient({
      fetch: mock.fetch,
      maxAttempts: 3,
      sleep: noSleep,
      retryOnNetwork: false,
      shouldRetry: () => true,
    });

    // Пользовательский shouldRetry разрешает повтор, несмотря на
    // retryOnNetwork: false.
    await expect(client.get('/users')).rejects.toBeDefined();
    expect(attempts).toBe(3);
  });
});

describe('retry - 408 и 429', () => {
  it('повторяет на 408 и 429', async () => {
    for (const status of [408, 429]) {
      let attempts = 0;
      const mock = createMockFetch(() => {
        attempts++;
        if (attempts < 2) return { status, body: {} };
        return { body: { ok: true } };
      });

      const client = createRetryClient({
        fetch: mock.fetch,
        maxAttempts: 3,
        sleep: noSleep,
      });

      await client.get('/users');
      expect(attempts).toBe(2);
    }
  });
});

describe('retry - не повторяет', () => {
  it('на 4xx кроме 408 и 429', async () => {
    for (const status of [400, 404, 422]) {
      let attempts = 0;
      const mock = createMockFetch(() => {
        attempts++;
        return { status, body: {} };
      });

      const client = createRetryClient({
        fetch: mock.fetch,
        maxAttempts: 3,
        sleep: noSleep,
      });

      await expect(client.get('/users')).rejects.toMatchObject({ status });
      expect(attempts).toBe(1);
    }
  });

  it('отменённый запрос', async () => {
    let attempts = 0;
    const mock = createMockFetch(() => {
      attempts++;
      return { body: {} };
    });

    const client = createRetryClient({
      fetch: mock.fetch,
      maxAttempts: 3,
      sleep: noSleep,
    });

    const controller = new AbortController();
    controller.abort();

    await expect(client.get('/users', { signal: controller.signal })).rejects.toBeDefined();
    expect(attempts).toBe(0);
  });

  it('при skipRetry: true', async () => {
    let attempts = 0;
    const mock = createMockFetch(() => {
      attempts++;
      return { status: 500, body: {} };
    });

    const client = createRetryClient({
      fetch: mock.fetch,
      maxAttempts: 3,
      sleep: noSleep,
    });

    await expect(client.get('/users', { skipRetry: true })).rejects.toBeDefined();
    expect(attempts).toBe(1);
  });

  it('auth-ошибки, даже если shouldRetry: true', async () => {
    for (const status of [401, 403]) {
      let attempts = 0;
      const mock = createMockFetch(() => {
        attempts++;
        return { status, body: {} };
      });

      const client = createRetryClient({
        fetch: mock.fetch,
        maxAttempts: 3,
        sleep: noSleep,
        shouldRetry: () => true,
      });

      await expect(client.get('/users')).rejects.toBeDefined();
      expect(attempts).toBe(1);
    }
  });
});

describe('retry - Retry-After', () => {
  it('использует значение заголовка как есть, без jitter', async () => {
    const sleep = createSleepSpy();
    let attempts = 0;
    const mock = createMockFetch(() => {
      attempts++;
      if (attempts === 1) {
        return { status: 503, headers: { 'retry-after': '3' }, body: {} };
      }
      return { body: { ok: true } };
    });

    const client = createRetryClient({
      fetch: mock.fetch,
      maxAttempts: 3,
      sleep,
      jitterRatio: 0.5,
      baseDelayMs: 100,
    });

    await client.get('/users');

    expect(attempts).toBe(2);
    expect(sleep.mock.calls[0]?.[0]).toBe(3000);
  });

  it('не повторяет, если Retry-After превышает maxDelayMs', async () => {
    const sleep = createSleepSpy();
    let attempts = 0;
    const mock = createMockFetch(() => {
      attempts++;
      return { status: 503, headers: { 'retry-after': '9999' }, body: {} };
    });

    const client = createRetryClient({
      fetch: mock.fetch,
      maxAttempts: 3,
      sleep,
      maxDelayMs: 10_000,
    });

    await expect(client.get('/users')).rejects.toMatchObject({ status: 503 });

    expect(attempts).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('повторяет на границе Retry-After === maxDelayMs', async () => {
    const sleep = createSleepSpy();
    let attempts = 0;
    const mock = createMockFetch(() => {
      attempts++;
      if (attempts === 1) {
        return { status: 503, headers: { 'retry-after': '10' }, body: {} };
      }
      return { body: { ok: true } };
    });

    const client = createRetryClient({
      fetch: mock.fetch,
      maxAttempts: 3,
      sleep,
      maxDelayMs: 10_000,
    });

    await client.get('/users');

    expect(attempts).toBe(2);
    expect(sleep.mock.calls[0]?.[0]).toBe(10_000);
  });
});

describe('retry - shouldRetry', () => {
  it('false отключает повторы, err.status === 409 разрешает повтор', async () => {
    let attempts1 = 0;
    const mock1 = createMockFetch(() => {
      attempts1++;
      return { status: 500, body: {} };
    });
    const client1 = createRetryClient({
      fetch: mock1.fetch,
      maxAttempts: 3,
      sleep: noSleep,
      shouldRetry: () => false,
    });
    await expect(client1.get('/users')).rejects.toBeDefined();
    expect(attempts1).toBe(1);

    let attempts2 = 0;
    const mock2 = createMockFetch(() => {
      attempts2++;
      if (attempts2 < 2) return { status: 409, body: {} };
      return { body: { ok: true } };
    });
    const client2 = createRetryClient({
      fetch: mock2.fetch,
      maxAttempts: 3,
      sleep: noSleep,
      shouldRetry: (err) => err.status === 409,
    });
    await client2.get('/users');
    expect(attempts2).toBe(2);
  });
});

describe('retry - computeDelay', () => {
  it('использует computeDelay и ограничивает задержку снизу MIN_RETRY_MS', async () => {
    const sleep1 = createSleepSpy();
    let attempts1 = 0;
    const mock1 = createMockFetch(() => {
      attempts1++;
      if (attempts1 < 2) return { status: 500, body: {} };
      return { body: { ok: true } };
    });
    const client1 = createRetryClient({
      fetch: mock1.fetch,
      maxAttempts: 3,
      sleep: sleep1,
      computeDelay: () => 1234,
    });
    await client1.get('/users');
    expect(sleep1.mock.calls[0]?.[0]).toBe(1234);

    const sleep2 = createSleepSpy();
    let attempts2 = 0;
    const mock2 = createMockFetch(() => {
      attempts2++;
      if (attempts2 < 2) return { status: 500, body: {} };
      return { body: { ok: true } };
    });
    const client2 = createRetryClient({
      fetch: mock2.fetch,
      maxAttempts: 3,
      sleep: sleep2,
      computeDelay: () => 10,
    });
    await client2.get('/users');
    expect(sleep2.mock.calls[0]?.[0]).toBeGreaterThanOrEqual(100);
  });

  it('получает attempt с 1-based нумерацией', async () => {
    const attempts: number[] = [];

    const mock = createMockFetch(() => ({ status: 500, body: {} }));

    const client = createRetryClient({
      fetch: mock.fetch,
      maxAttempts: 3,
      sleep: noSleep,
      computeDelay: (attempt) => {
        attempts.push(attempt);
        return 100;
      },
    });

    await expect(client.get('/users')).rejects.toBeDefined();
    expect(attempts).toEqual([1, 2]);
  });
});

describe('retry - экспоненциальная задержка', () => {
  it('увеличивает задержку между попытками и обрезает по maxDelayMs', async () => {
    const sleep1 = createSleepSpy();
    const mock1 = createMockFetch(() => ({ status: 500, body: {} }));
    const client1 = createRetryClient({
      fetch: mock1.fetch,
      maxAttempts: 3,
      sleep: sleep1,
      jitterRatio: 0,
      baseDelayMs: 300,
    });
    await expect(client1.get('/users')).rejects.toBeDefined();
    expect(sleep1).toHaveBeenCalledTimes(2);
    expect(sleep1.mock.calls[0]?.[0]).toBe(300);
    expect(sleep1.mock.calls[1]?.[0]).toBe(600);

    const sleep2 = createSleepSpy();
    const mock2 = createMockFetch(() => ({ status: 500, body: {} }));
    const client2 = createRetryClient({
      fetch: mock2.fetch,
      maxAttempts: 5,
      sleep: sleep2,
      jitterRatio: 0,
      baseDelayMs: 1000,
      maxDelayMs: 2000,
    });
    await expect(client2.get('/users')).rejects.toBeDefined();
    for (const call of sleep2.mock.calls) {
      expect(call[0]).toBeLessThanOrEqual(2000);
    }
  });
});

describe('retry - валидация конфигурации', () => {
  it('ошибка для некорректных значений', () => {
    expect(() => withRetry({ maxAttempts: 0 })).toThrow(/maxAttempts/);
    expect(() => withRetry({ baseDelayMs: -1 })).toThrow(/baseDelayMs/);
    expect(() => withRetry({ jitterRatio: -0.1 })).toThrow(/jitterRatio/);
  });
});

describe('retry - warnOnUnsafeRetry', () => {
  it('предупреждает о небезопасном повторе POST', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const mock = createMockFetch(() => ({ status: 500, body: {} }));
    const client = createRetryClient({
      fetch: mock.fetch,
      maxAttempts: 2,
      sleep: noSleep,
      warnOnUnsafeRetry: true,
    });

    await expect(client.post('/orders', {})).rejects.toBeDefined();

    expect(warn).toHaveBeenCalled();
    expect(warn.mock.calls[0]?.[0]).toMatch(/POST.*\/orders/);
    warn.mockRestore();
  });

  it('не предупреждает при отключённом warn, заданном ключе, безопасном методе, skipIdempotency или кастомном имени заголовка', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const mock1 = createMockFetch(() => ({ status: 500, body: {} }));
      const client1 = createRetryClient({
        fetch: mock1.fetch,
        maxAttempts: 2,
        sleep: noSleep,
        warnOnUnsafeRetry: false,
      });
      await expect(client1.post('/orders', {})).rejects.toBeDefined();

      const mock2 = createMockFetch(() => ({ status: 500, body: {} }));
      const client2 = createRetryClient({
        fetch: mock2.fetch,
        maxAttempts: 2,
        sleep: noSleep,
        warnOnUnsafeRetry: true,
      });
      await expect(
        client2.post('/orders', {}, { headers: { 'Idempotency-Key': 'test-key' } }),
      ).rejects.toBeDefined();

      const mock3 = createMockFetch(() => ({ status: 500, body: {} }));
      const client3 = createRetryClient({
        fetch: mock3.fetch,
        maxAttempts: 2,
        sleep: noSleep,
        warnOnUnsafeRetry: true,
      });
      await expect(client3.get('/users')).rejects.toBeDefined();

      const mock4 = createMockFetch(() => ({ status: 500, body: {} }));
      const client4 = createRetryClient({
        fetch: mock4.fetch,
        maxAttempts: 2,
        sleep: noSleep,
        warnOnUnsafeRetry: true,
      });
      await expect(client4.post('/orders', {}, { skipIdempotency: true })).rejects.toBeDefined();

      const mock5 = createMockFetch(() => ({ status: 500, body: {} }));
      const client5 = createTestClient({
        fetch: mock5.fetch,
        retry: { maxAttempts: 2, sleep: noSleep, warnOnUnsafeRetry: true },
        idempotency: {
          source: { nextKey: () => 'auto-key' },
          headerName: 'X-Idempotency-Key',
        },
      });
      await expect(client5.post('/orders', {})).rejects.toBeDefined();

      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('предупреждает один раз на клиента', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const mock = createMockFetch(() => ({ status: 500, body: {} }));
      const client = createRetryClient({
        fetch: mock.fetch,
        maxAttempts: 2,
        sleep: noSleep,
        warnOnUnsafeRetry: true,
      });

      await expect(client.post('/orders', { a: 1 })).rejects.toBeDefined();
      await expect(client.post('/orders', { a: 2 })).rejects.toBeDefined();
      await expect(client.post('/orders', { a: 3 })).rejects.toBeDefined();

      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('разные ресурсы дают отдельные предупреждения, id внутри ресурса не дают', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const mock = createMockFetch(() => ({ status: 500, body: {} }));
      const client = createRetryClient({
        fetch: mock.fetch,
        maxAttempts: 2,
        sleep: noSleep,
        warnOnUnsafeRetry: true,
      });

      await expect(client.delete('/sessions/1')).rejects.toBeDefined();
      await expect(client.delete('/sessions/2')).rejects.toBeDefined();
      await expect(client.delete('/sessions/3')).rejects.toBeDefined();
      expect(warn).toHaveBeenCalledTimes(1);

      await expect(client.delete('/orders/1')).rejects.toBeDefined();
      await expect(client.delete('/orders/2')).rejects.toBeDefined();
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('retry - onRetry hook', () => {
  it('onRetry вызывается перед каждой попыткой, attempt начинается с 1', async () => {
    const onRetry = vi.fn();

    const mock = createMockFetch(() => ({ status: 500, body: {} }));
    const client = createTestClient({
      fetch: mock.fetch,
      retry: { maxAttempts: 3, sleep: noSleep },
      hooks: { onRetry },
    });

    await expect(client.get('/users')).rejects.toBeDefined();

    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry.mock.calls[0]?.[1]).toBe(1);
    expect(onRetry.mock.calls[1]?.[1]).toBe(2);
  });

  it('onRetry может изменить конфиг', async () => {
    let secondRequestHeader: string | undefined;

    const mock = createMockFetch((_, __, headers) => {
      if (headers['x-retry']) {
        secondRequestHeader = headers['x-retry'];
        return { body: { ok: true } };
      }
      return { status: 500, body: {} };
    });

    const client = createTestClient({
      fetch: mock.fetch,
      retry: { maxAttempts: 3, sleep: noSleep },
      hooks: {
        onRetry: (config) => ({
          ...config,
          headers: { ...config.headers, 'X-Retry': '1' },
        }),
      },
    });

    await client.get('/users');

    expect(secondRequestHeader).toBe('1');
  });

  it('onRetry может остановить повторы через skipRetry', async () => {
    let attempts = 0;
    const mock = createMockFetch(() => {
      attempts++;
      return { status: 500, body: {} };
    });

    const client = createTestClient({
      fetch: mock.fetch,
      retry: { maxAttempts: 5, sleep: noSleep },
      hooks: {
        onRetry: (config) => ({ ...config, skipRetry: true }),
      },
    });

    await expect(client.get('/users')).rejects.toMatchObject({ status: 500 });
    expect(attempts).toBe(1);
  });

  it('падение onRetry не ломает запрос', async () => {
    const mock = createMockFetch(() => ({ status: 500, body: {} }));

    const client = createTestClient({
      fetch: mock.fetch,
      retry: { maxAttempts: 2, sleep: noSleep },
      hooks: {
        onRetry: () => {
          throw new Error('hook error');
        },
      },
    });

    await expect(client.get('/users')).rejects.toMatchObject({ status: 500 });
  });
});
