// Тесты хуков: onRequest, onBeforeSend, onResponse, onError, onRetry
// и порядок их вызова.

import { describe, expect, it, vi } from 'vitest';

import { createMockFetch, createTestClient, createTestSessionProvider } from './helpers';

import type { ApiError, RequestConfig, ResponseMeta } from '../src/index';

describe('onRequest', () => {
  it('вызывается один раз с config; undefined - использовать исходный', async () => {
    const onRequest1 = vi.fn((config: RequestConfig) => config);
    const mock1 = createMockFetch(() => ({ body: {} }));
    const client1 = createTestClient({
      fetch: mock1.fetch,
      hooks: { onRequest: onRequest1 },
    });
    await client1.get('/users');
    expect(onRequest1).toHaveBeenCalledTimes(1);
    expect(onRequest1.mock.calls[0]?.[0].path).toBe('/users');

    const mock2 = createMockFetch(() => ({ body: {} }));
    const client2 = createTestClient({
      fetch: mock2.fetch,
      hooks: { onRequest: () => undefined },
    });
    await client2.get('/users');
    expect(mock2.calls[0]?.method).toBe('GET');
  });

  it('может добавить заголовки', async () => {
    const mock = createMockFetch(() => ({ body: {} }));
    const client = createTestClient({
      fetch: mock.fetch,
      hooks: {
        onRequest: (config) => ({
          ...config,
          headers: { ...config.headers, 'X-Correlation-Id': 'corr-123' },
        }),
      },
    });

    await client.get('/users');

    expect(mock.calls[0]?.headers['x-correlation-id']).toBe('corr-123');
  });

  it('падение не ломает запрос', async () => {
    const mock = createMockFetch(() => ({ body: { ok: true } }));
    const client = createTestClient({
      fetch: mock.fetch,
      hooks: {
        onRequest: () => {
          throw new Error('Hook failed');
        },
      },
    });

    expect(await client.get('/users')).toEqual({ ok: true });
    expect(mock.calls).toHaveLength(1);
  });
});

describe('onBeforeSend', () => {
  it('вызывается перед fetch после всех слоёв', async () => {
    const onBeforeSend = vi.fn();
    const mock = createMockFetch(() => ({ body: { ok: true } }));
    const client = createTestClient({
      fetch: mock.fetch,
      auth: { provider: createTestSessionProvider({ headers: { Authorization: 'Bearer x' } }) },
      hooks: { onBeforeSend },
    });

    await client.get('/users');

    expect(onBeforeSend).toHaveBeenCalledTimes(1);
    const [config] = onBeforeSend.mock.calls[0] as [RequestConfig];
    expect(config.path).toBe('/users');
    expect(config.method).toBe('GET');
  });

  it('видит финальные заголовки: Authorization от withAuth', async () => {
    // Ключевая цель хука - onRequest заголовки auth не видит
    // (вызывается до слоёв), а onBeforeSend - видит.
    const captured: Record<string, string>[] = [];
    const mock = createMockFetch(() => ({ body: {} }));
    const client = createTestClient({
      fetch: mock.fetch,
      auth: {
        provider: createTestSessionProvider({ headers: { Authorization: 'Bearer token-1' } }),
      },
      hooks: {
        onBeforeSend: (config) => {
          captured.push(config.headers ?? {});
        },
      },
    });

    await client.get('/users');

    expect(captured).toHaveLength(1);
    expect(captured[0]?.Authorization).toBe('Bearer token-1');
  });

  it('видит финальные заголовки: Idempotency-Key от withIdempotency', async () => {
    const captured: Record<string, string>[] = [];
    const mock = createMockFetch(() => ({ body: {} }));
    const client = createTestClient({
      fetch: mock.fetch,
      idempotency: { source: { nextKey: () => 'key-42' } },
      hooks: {
        onBeforeSend: (config) => {
          captured.push(config.headers ?? {});
        },
      },
    });

    await client.post('/orders', { total: 100 });

    expect(captured).toHaveLength(1);
    expect(captured[0]?.['Idempotency-Key']).toBe('key-42');
  });

  it('видит Accept и Content-Type, добавленные транспортом', async () => {
    const captured: Record<string, string>[] = [];
    const mock = createMockFetch(() => ({ body: {} }));
    const client = createTestClient({
      fetch: mock.fetch,
      hooks: {
        onBeforeSend: (config) => {
          captured.push(config.headers ?? {});
        },
      },
    });

    await client.get('/users');
    expect(captured[0]?.Accept).toBe('application/json');

    await client.post('/orders', { total: 100 });
    expect(captured[1]?.['Content-Type']).toBe('application/json');
  });

  it('вызывается перед каждой попыткой повтора', async () => {
    const onBeforeSend = vi.fn();
    let attempts = 0;
    const mock = createMockFetch(() => {
      attempts++;
      if (attempts < 3) return { status: 500, body: {} };
      return { body: { ok: true } };
    });

    const client = createTestClient({
      fetch: mock.fetch,
      retry: { maxAttempts: 3, sleep: () => Promise.resolve() },
      hooks: { onBeforeSend },
    });

    await client.get('/users');

    // Три попытки: две неудачных и одна успешная.
    expect(onBeforeSend).toHaveBeenCalledTimes(3);
  });

  it('падение не ломает запрос', async () => {
    const mock = createMockFetch(() => ({ body: { ok: true } }));
    const client = createTestClient({
      fetch: mock.fetch,
      hooks: {
        onBeforeSend: () => {
          throw new Error('Hook failed');
        },
      },
    });

    expect(await client.get('/users')).toEqual({ ok: true });
    expect(mock.calls).toHaveLength(1);
  });
});

describe('onResponse', () => {
  it('вызывается после успешного ответа с meta, включая 204', async () => {
    const onResponse1 = vi.fn();
    const mock1 = createMockFetch(() => ({ status: 201, body: {} }));
    const client1 = createTestClient({
      fetch: mock1.fetch,
      hooks: { onResponse: onResponse1 },
    });
    await client1.get('/users');
    expect(onResponse1).toHaveBeenCalledTimes(1);
    const [, meta] = onResponse1.mock.calls[0] as [RequestConfig, ResponseMeta];
    expect(meta.status).toBe(201);

    const onResponse2 = vi.fn();
    const mock2 = createMockFetch(() => ({ status: 204 }));
    const client2 = createTestClient({
      fetch: mock2.fetch,
      hooks: { onResponse: onResponse2 },
    });
    await client2.delete('/users/1');
    expect(onResponse2).toHaveBeenCalledTimes(1);
  });

  it('не вызывается для ошибок', async () => {
    const onResponse = vi.fn();

    const mock = createMockFetch(() => ({ status: 500, body: {} }));
    const client = createTestClient({
      fetch: mock.fetch,
      hooks: { onResponse },
    });

    await expect(client.get('/users')).rejects.toBeDefined();

    expect(onResponse).not.toHaveBeenCalled();
  });

  it('падение не ломает запрос', async () => {
    const mock = createMockFetch(() => ({ body: { ok: true } }));
    const client = createTestClient({
      fetch: mock.fetch,
      hooks: {
        onResponse: () => {
          throw new Error('Hook failed');
        },
      },
    });

    expect(await client.get('/users')).toEqual({ ok: true });
  });
});

describe('onError', () => {
  it('получает сетевые и отменённые ошибки', async () => {
    const onError1 = vi.fn();
    const mock1 = createMockFetch(() => {
      throw new TypeError('Network down');
    });
    const client1 = createTestClient({ fetch: mock1.fetch, hooks: { onError: onError1 } });
    await expect(client1.get('/users')).rejects.toBeDefined();
    expect(onError1).toHaveBeenCalledTimes(1);
    const [, netErr] = onError1.mock.calls[0] as [RequestConfig, ApiError];
    expect(netErr.kind).toBe('network');

    const onError2 = vi.fn();
    const mock2 = createMockFetch(() => ({ body: {} }));
    const client2 = createTestClient({ fetch: mock2.fetch, hooks: { onError: onError2 } });
    const controller = new AbortController();
    controller.abort();
    await expect(client2.get('/users', { signal: controller.signal })).rejects.toBeDefined();
    expect(onError2).toHaveBeenCalledTimes(1);
    const [, abortErr] = onError2.mock.calls[0] as [RequestConfig, ApiError];
    expect(abortErr.isCancelled).toBe(true);
  });

  it('падение не подменяет исходную ошибку', async () => {
    const mock = createMockFetch(() => ({ status: 400, body: {} }));
    const client = createTestClient({
      fetch: mock.fetch,
      hooks: {
        onError: () => {
          throw new Error('Hook failed');
        },
      },
    });

    await expect(client.get('/users')).rejects.toMatchObject({ status: 400 });
  });
});

describe('порядок вызова хуков', () => {
  it('onRequest -> onBeforeSend -> onRetry -> onBeforeSend -> onRetry -> onBeforeSend -> onError', async () => {
    const order: string[] = [];

    const mock = createMockFetch(() => ({ status: 500, body: {} }));
    const client = createTestClient({
      fetch: mock.fetch,
      retry: { maxAttempts: 3, sleep: () => Promise.resolve() },
      hooks: {
        onRequest: (config) => {
          order.push('request');
          return config;
        },
        onBeforeSend: () => {
          order.push('beforesend');
        },
        onRetry: (config) => {
          order.push('retry');
          return config;
        },
        onError: () => {
          order.push('error');
        },
      },
    });

    await expect(client.get('/users')).rejects.toBeDefined();

    expect(order).toEqual([
      'request',
      'beforesend',
      'retry',
      'beforesend',
      'retry',
      'beforesend',
      'error',
    ]);
  });

  it('onRequest -> onBeforeSend -> onRetry -> ... -> onResponse при успехе после повторов', async () => {
    const order: string[] = [];

    let attempts = 0;
    const mock = createMockFetch(() => {
      attempts++;
      if (attempts < 3) return { status: 500, body: {} };
      return { body: { ok: true } };
    });

    const client = createTestClient({
      fetch: mock.fetch,
      retry: { maxAttempts: 3, sleep: () => Promise.resolve() },
      hooks: {
        onRequest: (config) => {
          order.push('request');
          return config;
        },
        onBeforeSend: () => {
          order.push('beforesend');
        },
        onRetry: (config) => {
          order.push('retry');
          return config;
        },
        onResponse: () => {
          order.push('response');
        },
      },
    });

    await client.get('/users');

    expect(order).toEqual([
      'request',
      'beforesend',
      'retry',
      'beforesend',
      'retry',
      'beforesend',
      'response',
    ]);
  });

  it('onRequest не видит заголовки auth, onBeforeSend видит', async () => {
    const capturedInRequest: Record<string, string>[] = [];
    const capturedInBeforeSend: Record<string, string>[] = [];

    const mock = createMockFetch(() => ({ body: {} }));
    const client = createTestClient({
      fetch: mock.fetch,
      auth: {
        provider: createTestSessionProvider({ headers: { Authorization: 'Bearer x' } }),
      },
      hooks: {
        onRequest: (config) => {
          capturedInRequest.push(config.headers ?? {});
          return config;
        },
        onBeforeSend: (config) => {
          capturedInBeforeSend.push(config.headers ?? {});
        },
      },
    });

    await client.get('/users');

    expect(capturedInRequest[0]?.Authorization).toBeUndefined();
    expect(capturedInBeforeSend[0]?.Authorization).toBe('Bearer x');
  });
});
