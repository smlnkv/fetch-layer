import { describe, expect, it, vi } from 'vitest';

import { createMemoryStorage, toApiError } from '../src/index';
import { createSessionSource } from '../src/layers/idempotency/index';

import { createMockFetch, createTestClient } from './helpers';

describe('integration - полный pipeline', () => {
  it('401 -> refresh -> 5xx -> retry с одним Idempotency-Key', async () => {
    const keys: string[] = [];

    let attempt = 0;
    const mock = createMockFetch((_, __, headers) => {
      keys.push(headers['idempotency-key'] ?? '');
      attempt++;

      if (attempt === 1) {
        return { status: 401, body: { code: 'SESSION_INVALID' } };
      }
      if (attempt === 2) {
        return { status: 500, body: {} };
      }
      return { body: { ok: true } };
    });

    const source = createSessionSource({ storage: createMemoryStorage() });

    const client = createTestClient({
      fetch: mock.fetch,
      auth: {
        provider: {
          getAuthHeaders: () => ({ Authorization: 'Bearer old' }),
          refresh: async () => ({
            status: 'success',
            headers: { Authorization: 'Bearer new' },
          }),
        },
      },
      retry: { maxAttempts: 3, sleep: () => Promise.resolve() },
      idempotency: { source },
    });

    await client.post('/orders', { total: 100 });

    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(1);
  });
});

describe('integration - параллельные запросы', () => {
  it('single-flight: параллельные 401 запускают один refresh; ключи зависят от тела', async () => {
    let refreshCount = 0;
    let token = 'old';
    const keys: string[] = [];

    const mock = createMockFetch((_, __, headers) => {
      if (headers.authorization === 'Bearer old') {
        return { status: 401, body: { code: 'SESSION_INVALID' } };
      }
      keys.push(headers['idempotency-key'] ?? '');
      return { body: { ok: true } };
    });

    const client = createTestClient({
      fetch: mock.fetch,
      auth: {
        provider: {
          getAuthHeaders: () => ({ Authorization: `Bearer ${token}` }),
          refresh: async () => {
            refreshCount++;
            await new Promise((resolve) => setTimeout(resolve, 10));
            token = 'new';
            return {
              status: 'success',
              headers: { Authorization: `Bearer ${token}` },
            };
          },
        },
      },
      retry: { maxAttempts: 3, sleep: () => Promise.resolve() },
      idempotency: { source: createSessionSource({ storage: createMemoryStorage() }) },
    });

    // Разные тела - разные ключи.
    await Promise.all([
      client.post('/orders', { n: 1 }),
      client.post('/orders', { n: 2 }),
      client.post('/orders', { n: 3 }),
    ]);

    expect(refreshCount).toBe(1);
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(3);
  });
});

describe('integration - circuit breaker + retry', () => {
  it('открытый circuit не повторяется retry-слоем', async () => {
    let attempts = 0;
    let refreshCalls = 0;

    const mock = createMockFetch(() => {
      attempts++;
      return { status: 401, body: { code: 'SESSION_INVALID' } };
    });

    const client = createTestClient({
      fetch: mock.fetch,
      auth: {
        provider: {
          getAuthHeaders: () => ({ Authorization: 'Bearer token' }),
          refresh: async () => {
            refreshCalls++;
            return {
              status: 'temporarily-failed',
              error: new TypeError('Network down'),
            };
          },
        },
        circuitBreakerMs: 60_000,
      },
      retry: { maxAttempts: 3, sleep: () => Promise.resolve() },
    });

    // Первый запрос: 401 -> refresh (temporarily-failed) -> circuit открыт.
    await expect(client.get('/a')).rejects.toBeDefined();
    expect(refreshCalls).toBe(1);
    const attemptsAfterFirst = attempts;

    // Второй запрос: circuit открыт, refresh не вызывается.
    // REFRESH_CIRCUIT_OPEN не retryable: попыток больше не будет.
    await expect(client.get('/b')).rejects.toMatchObject({
      code: 'REFRESH_CIRCUIT_OPEN',
    });
    expect(refreshCalls).toBe(1);
    expect(attempts).toBe(attemptsAfterFirst + 1);
  });
});

describe('integration - отмена', () => {
  it('отмена во время retry не запускает следующую попытку', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      let attempts = 0;

      const mock = createMockFetch(() => {
        attempts++;
        return { status: 500, body: {} };
      });

      const client = createTestClient({
        fetch: mock.fetch,
        retry: {
          maxAttempts: 5,
          sleep: (ms, signal) =>
            new Promise((resolve, reject) => {
              const timer = setTimeout(resolve, ms);
              signal?.addEventListener(
                'abort',
                () => {
                  clearTimeout(timer);
                  reject(new DOMException('Aborted', 'AbortError'));
                },
                { once: true },
              );
            }),
        },
      });

      const promise = client.get('/users', { signal: controller.signal });
      promise.catch(() => {});

      await vi.advanceTimersByTimeAsync(200);
      controller.abort();

      try {
        await promise;
        expect.fail('should have thrown');
      } catch (e) {
        expect(toApiError(e).isCancelled).toBe(true);
      }

      expect(attempts).toBeLessThanOrEqual(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
