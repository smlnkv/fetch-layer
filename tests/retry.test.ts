// Тесты retry-слоя через createClient.

import { Readable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { withRetry, type RetryOptions } from '../src/layers/index';

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
  onBeforeRetry?: RetryOptions['onBeforeRetry'];
  warnOnUnsafeRetry?: boolean;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitterRatio?: number;
  retryOnNetwork?: boolean;
  retryOnTimeout?: boolean;
  warn?: (message: string) => void;
}

function createRetryClient(options: RetryClientOptions): Client {
  return createTestClient({
    fetch: options.fetch,
    retry: {
      maxAttempts: options.maxAttempts,
      sleep: options.sleep,
      shouldRetry: options.shouldRetry,
      computeDelay: options.computeDelay,
      onBeforeRetry: options.onBeforeRetry,
      warnOnUnsafeRetry: options.warnOnUnsafeRetry,
      baseDelayMs: options.baseDelayMs,
      maxDelayMs: options.maxDelayMs,
      jitterRatio: options.jitterRatio,
      retryOnNetwork: options.retryOnNetwork,
      retryOnTimeout: options.retryOnTimeout,
    },
    warn: options.warn,
  });
}

describe('retry - повтор на 5xx и сеть', () => {
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
  it('false отключает повторы соответствующего kind, но остальные сохраняются', async () => {
    // retryOnNetwork: false, timeout повторяется.
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

    // retryOnTimeout: false, network повторяется.
    let attempts2 = 0;
    const mock2 = createMockFetch(() => {
      attempts2++;
      throw new DOMException('Timeout', 'TimeoutError');
    });
    const client2 = createRetryClient({
      fetch: mock2.fetch,
      maxAttempts: 3,
      sleep: noSleep,
      retryOnTimeout: false,
    });
    await expect(client2.get('/users')).rejects.toMatchObject({ kind: 'timeout' });
    expect(attempts2).toBe(1);

    // Обе false: сетевые ошибки не повторяются, 5xx повторяется.
    let attempts3 = 0;
    const mock3 = createMockFetch(() => {
      attempts3++;
      if (attempts3 < 2) return { status: 500, body: {} };
      return { body: { ok: true } };
    });
    const client3 = createRetryClient({
      fetch: mock3.fetch,
      maxAttempts: 3,
      sleep: noSleep,
      retryOnNetwork: false,
      retryOnTimeout: false,
    });
    await client3.get('/users');
    expect(attempts3).toBe(2);
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
  it('4xx кроме 408 и 429, отменённые запросы, skipRetry: true', async () => {
    // 4xx.
    for (const status of [400, 404, 422]) {
      let attempts = 0;
      const mock = createMockFetch(() => {
        attempts++;
        return { status, body: {} };
      });
      const client = createRetryClient({ fetch: mock.fetch, maxAttempts: 3, sleep: noSleep });
      await expect(client.get('/users')).rejects.toMatchObject({ status });
      expect(attempts).toBe(1);
    }

    // Отменённый запрос: попытки не начинаются.
    let attempts2 = 0;
    const mock2 = createMockFetch(() => {
      attempts2++;
      return { body: {} };
    });
    const client2 = createRetryClient({ fetch: mock2.fetch, maxAttempts: 3, sleep: noSleep });
    const controller = new AbortController();
    controller.abort();
    await expect(client2.get('/users', { signal: controller.signal })).rejects.toBeDefined();
    expect(attempts2).toBe(0);

    // skipRetry: true.
    let attempts3 = 0;
    const mock3 = createMockFetch(() => {
      attempts3++;
      return { status: 500, body: {} };
    });
    const client3 = createRetryClient({ fetch: mock3.fetch, maxAttempts: 3, sleep: noSleep });
    await expect(client3.get('/users', { skipRetry: true })).rejects.toBeDefined();
    expect(attempts3).toBe(1);
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

  it('не повторяет, если Retry-After превышает maxDelayMs; повторяет на границе', async () => {
    // Превышает maxDelayMs - не повторяем.
    const sleep1 = createSleepSpy();
    const mock1 = createMockFetch(() => ({
      status: 503,
      headers: { 'retry-after': '9999' },
      body: {},
    }));
    const client1 = createRetryClient({
      fetch: mock1.fetch,
      maxAttempts: 3,
      sleep: sleep1,
      maxDelayMs: 10_000,
    });
    await expect(client1.get('/users')).rejects.toMatchObject({ status: 503 });
    expect(sleep1).not.toHaveBeenCalled();

    // На границе - повторяем.
    const sleep2 = createSleepSpy();
    let attempts = 0;
    const mock2 = createMockFetch(() => {
      attempts++;
      if (attempts === 1) {
        return { status: 503, headers: { 'retry-after': '10' }, body: {} };
      }
      return { body: { ok: true } };
    });
    const client2 = createRetryClient({
      fetch: mock2.fetch,
      maxAttempts: 3,
      sleep: sleep2,
      maxDelayMs: 10_000,
    });
    await client2.get('/users');
    expect(attempts).toBe(2);
    expect(sleep2.mock.calls[0]?.[0]).toBe(10_000);
  });
});

describe('retry - shouldRetry', () => {
  it('false отключает повторы; err.status === 409 разрешает повтор', async () => {
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

  it('падение shouldRetry: warn и fallback на дефолтную политику', async () => {
    const warn = vi.fn();
    let attempts = 0;
    const mock = createMockFetch(() => {
      attempts++;
      if (attempts < 2) return { status: 500, body: {} };
      return { body: { ok: true } };
    });

    const client = createRetryClient({
      fetch: mock.fetch,
      maxAttempts: 3,
      sleep: noSleep,
      shouldRetry: () => {
        throw new Error('boom');
      },
      warn,
    });

    await client.get('/users');

    // Fallback на defaultShouldRetry: 500 повторяется.
    expect(attempts).toBe(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(/shouldRetry threw/);
    expect(warn.mock.calls[0]?.[0]).toMatch(/boom/);
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

  it('падение computeDelay: warn и fallback на дефолтную задержку', async () => {
    const warn = vi.fn();
    const sleep = createSleepSpy();
    let attempts = 0;
    const mock = createMockFetch(() => {
      attempts++;
      if (attempts < 2) return { status: 500, body: {} };
      return { body: { ok: true } };
    });

    const client = createRetryClient({
      fetch: mock.fetch,
      maxAttempts: 3,
      sleep,
      jitterRatio: 0,
      baseDelayMs: 300,
      computeDelay: () => {
        throw new Error('boom');
      },
      warn,
    });

    await client.get('/users');

    // Fallback на defaultCompute: baseDelayMs * 2^0 = 300.
    expect(attempts).toBe(2);
    expect(sleep.mock.calls[0]?.[0]).toBe(300);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(/computeDelay threw/);
    expect(warn.mock.calls[0]?.[0]).toMatch(/boom/);
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

describe('retry - onBeforeRetry', () => {
  it('вызывается перед каждой попыткой; может изменить конфиг или остановить повторы', async () => {
    // Считает попытки с 1-based нумерацией.
    const calls: number[] = [];
    const mock1 = createMockFetch(() => ({ status: 500, body: {} }));
    const client1 = createRetryClient({
      fetch: mock1.fetch,
      maxAttempts: 3,
      sleep: noSleep,
      onBeforeRetry: (_config, attempt) => {
        calls.push(attempt);
      },
    });
    await expect(client1.get('/users')).rejects.toBeDefined();
    expect(calls).toEqual([1, 2]);

    // Может изменить конфиг.
    let secondRequestHeader: string | undefined;
    const mock2 = createMockFetch((_, __, headers) => {
      if (headers['x-retry']) {
        secondRequestHeader = headers['x-retry'];
        return { body: { ok: true } };
      }
      return { status: 500, body: {} };
    });
    const client2 = createRetryClient({
      fetch: mock2.fetch,
      maxAttempts: 3,
      sleep: noSleep,
      onBeforeRetry: (config) => ({
        ...config,
        headers: { ...config.headers, 'X-Retry': '1' },
      }),
    });
    await client2.get('/users');
    expect(secondRequestHeader).toBe('1');

    // Может остановить повторы через skipRetry.
    let attempts3 = 0;
    const mock3 = createMockFetch(() => {
      attempts3++;
      return { status: 500, body: {} };
    });
    const client3 = createRetryClient({
      fetch: mock3.fetch,
      maxAttempts: 5,
      sleep: noSleep,
      onBeforeRetry: (config) => ({ ...config, skipRetry: true }),
    });
    await expect(client3.get('/users')).rejects.toMatchObject({ status: 500 });
    expect(attempts3).toBe(1);
  });

  it('падение onBeforeRetry не ломает запрос', async () => {
    let attempts = 0;
    const mock = createMockFetch(() => {
      attempts++;
      return { status: 500, body: {} };
    });

    const client = createRetryClient({
      fetch: mock.fetch,
      maxAttempts: 3,
      sleep: noSleep,
      onBeforeRetry: () => {
        throw new Error('hook error');
      },
    });

    await expect(client.get('/users')).rejects.toMatchObject({ status: 500 });
    expect(attempts).toBe(3);
  });
});

describe('retry - warnOnUnsafeRetry', () => {
  it('предупреждает о небезопасном повторе POST', async () => {
    const warn = vi.fn();
    const mock = createMockFetch(() => ({ status: 500, body: {} }));
    const client = createRetryClient({
      fetch: mock.fetch,
      maxAttempts: 2,
      sleep: noSleep,
      warnOnUnsafeRetry: true,
      warn,
    });

    await expect(client.post('/orders', {})).rejects.toBeDefined();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(/POST.*\/orders/);
  });

  it('не предупреждает при безопасных условиях', async () => {
    const warn = vi.fn();

    // warnOnUnsafeRetry: false
    const mock1 = createMockFetch(() => ({ status: 500, body: {} }));
    const client1 = createRetryClient({
      fetch: mock1.fetch,
      maxAttempts: 2,
      sleep: noSleep,
      warnOnUnsafeRetry: false,
      warn,
    });
    await expect(client1.post('/orders', {})).rejects.toBeDefined();

    // Ручной Idempotency-Key.
    const mock2 = createMockFetch(() => ({ status: 500, body: {} }));
    const client2 = createRetryClient({
      fetch: mock2.fetch,
      maxAttempts: 2,
      sleep: noSleep,
      warnOnUnsafeRetry: true,
      warn,
    });
    await expect(
      client2.post('/orders', {}, { headers: { 'Idempotency-Key': 'test-key' } }),
    ).rejects.toBeDefined();

    // GET.
    const mock3 = createMockFetch(() => ({ status: 500, body: {} }));
    const client3 = createRetryClient({
      fetch: mock3.fetch,
      maxAttempts: 2,
      sleep: noSleep,
      warnOnUnsafeRetry: true,
      warn,
    });
    await expect(client3.get('/users')).rejects.toBeDefined();

    // skipIdempotency: true.
    const mock4 = createMockFetch(() => ({ status: 500, body: {} }));
    const client4 = createRetryClient({
      fetch: mock4.fetch,
      maxAttempts: 2,
      sleep: noSleep,
      warnOnUnsafeRetry: true,
      warn,
    });
    await expect(client4.post('/orders', {}, { skipIdempotency: true })).rejects.toBeDefined();

    // withIdempotency с кастомным именем: маркер подавляет warn.
    const mock5 = createMockFetch(() => ({ status: 500, body: {} }));
    const client5 = createTestClient({
      fetch: mock5.fetch,
      retry: { maxAttempts: 2, sleep: noSleep, warnOnUnsafeRetry: true },
      idempotency: {
        source: { nextKey: () => 'auto-key' },
        headerName: 'X-Idempotency-Key',
      },
      warn,
    });
    await expect(client5.post('/orders', {})).rejects.toBeDefined();

    expect(warn).not.toHaveBeenCalled();
  });

  it('дедупликация: один раз на метод и корневой сегмент пути', async () => {
    const warn = vi.fn();
    const mock = createMockFetch(() => ({ status: 500, body: {} }));
    const client = createRetryClient({
      fetch: mock.fetch,
      maxAttempts: 2,
      sleep: noSleep,
      warnOnUnsafeRetry: true,
      warn,
    });

    // Один и тот же ресурс - одно предупреждение.
    await expect(client.post('/orders', { a: 1 })).rejects.toBeDefined();
    await expect(client.post('/orders', { a: 2 })).rejects.toBeDefined();
    await expect(client.post('/orders', { a: 3 })).rejects.toBeDefined();
    expect(warn).toHaveBeenCalledTimes(1);

    // Разные ресурсы - разные предупреждения; динамические id внутри
    // одного ресурса схлопываются.
    await expect(client.delete('/sessions/1')).rejects.toBeDefined();
    await expect(client.delete('/sessions/2')).rejects.toBeDefined();
    await expect(client.delete('/sessions/3')).rejects.toBeDefined();
    expect(warn).toHaveBeenCalledTimes(2);

    await expect(client.delete('/orders/1')).rejects.toBeDefined();
    await expect(client.delete('/orders/2')).rejects.toBeDefined();
    expect(warn).toHaveBeenCalledTimes(3);
  });
});

describe('retry - потоковые тела', () => {
  it('не повторяет стримы при ошибках', async () => {
    // Web ReadableStream + network error.
    let attempts1 = 0;
    const mock1 = createMockFetch(() => {
      attempts1++;
      throw new TypeError('Network down');
    });
    const warn1 = vi.fn();
    const client1 = createRetryClient({
      fetch: mock1.fetch,
      maxAttempts: 3,
      sleep: noSleep,
      warn: warn1,
    });
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data'));
        controller.close();
      },
    });
    await expect(client1.post('/upload', stream)).rejects.toMatchObject({
      kind: 'network',
      code: 'NETWORK_ERROR',
    });
    expect(attempts1).toBe(1);
    expect(warn1).toHaveBeenCalledTimes(1);
    expect(warn1.mock.calls[0]?.[0]).toMatch(/stream/);

    // Node stream.Readable + 5xx.
    let attempts2 = 0;
    const mock2 = createMockFetch(() => {
      attempts2++;
      return { status: 500, body: {} };
    });
    const client2 = createRetryClient({
      fetch: mock2.fetch,
      maxAttempts: 3,
      sleep: noSleep,
    });
    await expect(client2.post('/upload', Readable.from(['data']))).rejects.toMatchObject({
      status: 500,
    });
    expect(attempts2).toBe(1);
  });

  it('warn про стрим выводится один раз на клиент', async () => {
    const mock = createMockFetch(() => {
      throw new TypeError('Network down');
    });
    const warn = vi.fn();
    const client = createRetryClient({
      fetch: mock.fetch,
      maxAttempts: 3,
      sleep: noSleep,
      warn,
    });

    await expect(client.post('/upload', Readable.from(['a']))).rejects.toBeDefined();
    await expect(client.post('/upload', Readable.from(['b']))).rejects.toBeDefined();
    await expect(client.post('/upload', Readable.from(['c']))).rejects.toBeDefined();

    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('skipRetry: true отключает и warn про стрим', async () => {
    let attempts = 0;
    const mock = createMockFetch(() => {
      attempts++;
      throw new TypeError('Network down');
    });
    const warn = vi.fn();
    const client = createRetryClient({
      fetch: mock.fetch,
      maxAttempts: 3,
      sleep: noSleep,
      warn,
    });

    await expect(
      client.post('/upload', Readable.from(['a']), { skipRetry: true }),
    ).rejects.toBeDefined();

    expect(attempts).toBe(1);
    expect(warn).not.toHaveBeenCalled();
  });
});
