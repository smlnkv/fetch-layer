// Тесты core/layer.ts: validateLayerOrder, дубликаты слоёв, stage,
// переиспользование Layer между клиентами.

import { describe, expect, it, vi } from 'vitest';

import { createClient, type Layer } from '../src/index';
import { withAuth, withRetry, withIdempotency } from '../src/layers/index';

import { createMockFetch, createTestSessionProvider } from './helpers';

import type { SessionProvider } from '../src/layers/auth/index';

describe('validateLayerOrder - порядок stage', () => {
  it('принимает правильный порядок и кастомные слои без stage', () => {
    const customLayer: Layer = {
      name: 'custom',
      wrap: (next) => ({ fn: next }),
    };

    expect(() =>
      createClient({
        baseUrl: '/api',
        layers: [
          customLayer,
          withIdempotency({ nextKey: () => 'k' }),
          withRetry({ maxAttempts: 1 }),
          withAuth({ provider: createTestSessionProvider() }),
        ],
      }),
    ).not.toThrow();
  });

  it('ошибка при нарушении порядка с подсказкой о встроенных stage', () => {
    let message = '';
    try {
      createClient({
        baseUrl: '/api',
        layers: [
          withAuth({ provider: createTestSessionProvider() }),
          withRetry({ maxAttempts: 1 }),
        ],
      });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/order/);
    expect(message).toMatch(/withIdempotency=3/);
    expect(message).toMatch(/stage 2\.5/);

    expect(() =>
      createClient({
        baseUrl: '/api',
        layers: [withRetry({ maxAttempts: 1 }), withIdempotency({ nextKey: () => 'k' })],
      }),
    ).toThrow(/order/);
  });

  it('принимает кастомный слой со stage 2.5 или 1.5 между встроенными', () => {
    const withMetrics: Layer = {
      name: 'withMetrics',
      stage: 2.5,
      wrap: (next) => ({ fn: next }),
    };
    const withLogging: Layer = {
      name: 'withLogging',
      stage: 1.5,
      wrap: (next) => ({ fn: next }),
    };

    expect(() =>
      createClient({
        baseUrl: '/api',
        layers: [
          withIdempotency({ nextKey: () => 'k' }),
          withMetrics,
          withRetry({ maxAttempts: 1 }),
          withLogging,
          withAuth({ provider: createTestSessionProvider() }),
        ],
      }),
    ).not.toThrow();
  });
});

describe('validateLayerOrder - дубликаты', () => {
  it('ошибка при дубликате слоя по name (встроенного и кастомного)', () => {
    expect(() =>
      createClient({
        baseUrl: '/api',
        layers: [withRetry({ maxAttempts: 1 }), withRetry({ maxAttempts: 1 })],
      }),
    ).toThrow(/more than once/);

    const custom: Layer = {
      name: 'withTiming',
      wrap: (next) => ({ fn: next }),
    };

    expect(() =>
      createClient({
        baseUrl: '/api',
        layers: [custom, custom],
      }),
    ).toThrow(/withTiming.*more than once/);
  });

  it('ошибка при дубликате stage', () => {
    const a: Layer = {
      name: 'withA',
      stage: 2,
      wrap: (next) => ({ fn: next }),
    };
    const b: Layer = {
      name: 'withB',
      stage: 2,
      wrap: (next) => ({ fn: next }),
    };

    expect(() =>
      createClient({
        baseUrl: '/api',
        layers: [a, b],
      }),
    ).toThrow(/withA.*withB.*stage 2/);
  });
});

describe('runAttach', () => {
  it('падение attach даёт ошибку с именем слоя и cause', () => {
    const original = new Error('boom');
    const withBrokenAttach: Layer = {
      name: 'withBrokenAttach',
      wrap: (next) => ({ fn: next }),
      attach() {
        throw original;
      },
    };

    let caught: unknown;
    try {
      createClient({
        baseUrl: '/api',
        layers: [withBrokenAttach],
      });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/withBrokenAttach/);
    expect((caught as Error).message).toMatch(/attach threw/);
    expect((caught as Error).message).toMatch(/boom/);
    expect((caught as Error).cause).toBe(original);
  });
});

describe('Layer как шаблон', () => {
  it('withAuth создаёт независимый RefreshManager на каждый клиент', async () => {
    let refreshCalls = 0;
    const provider: SessionProvider = {
      getAuthHeaders: () => ({ Authorization: 'Bearer token' }),
      refresh: async () => {
        refreshCalls++;
        return {
          status: 'temporarily-failed',
          error: new TypeError('Network down'),
        };
      },
    };

    const authLayer = withAuth({ provider, circuitBreakerMs: 60_000 });

    const mock1 = createMockFetch(() => ({ status: 401, body: {} }));
    const client1 = createClient({
      baseUrl: 'https://api.test',
      fetch: mock1.fetch,
      layers: [authLayer],
    });

    const mock2 = createMockFetch(() => ({ status: 401, body: {} }));
    const client2 = createClient({
      baseUrl: 'https://api.test',
      fetch: mock2.fetch,
      layers: [authLayer],
    });

    await expect(client1.get('/a')).rejects.toBeDefined();
    expect(refreshCalls).toBe(1);

    // Circuit client1 открыт. У client2 он должен быть закрыт,
    // это другой RefreshManager.
    await expect(client2.get('/b')).rejects.toBeDefined();
    expect(refreshCalls).toBe(2);
  });

  it('withRetry создаёт независимый warnedUnsafeRetry на каждый клиент', async () => {
    const warn = vi.fn();
    const retryLayer = withRetry({
      maxAttempts: 1,
      warnOnUnsafeRetry: true,
    });

    const mock1 = createMockFetch(() => ({ status: 500, body: {} }));
    const client1 = createClient({
      baseUrl: 'https://api.test',
      fetch: mock1.fetch,
      warn,
      layers: [retryLayer],
    });

    const mock2 = createMockFetch(() => ({ status: 500, body: {} }));
    const client2 = createClient({
      baseUrl: 'https://api.test',
      fetch: mock2.fetch,
      warn,
      layers: [retryLayer],
    });

    await expect(client1.post('/orders', {})).rejects.toBeDefined();
    await expect(client2.post('/orders', {})).rejects.toBeDefined();

    expect(warn).toHaveBeenCalledTimes(2);
  });
});
