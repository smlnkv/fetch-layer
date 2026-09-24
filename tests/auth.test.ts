// Тесты auth-слоя через createClient: single-flight, состояния
// refresh, circuit breaker, cooldown, таймаут, resetRefreshCircuit.

import { describe, expect, it, vi } from 'vitest';

import { ApiError } from '../src/index';
import { resetRefreshCircuit, type SessionProvider } from '../src/layers/auth/index';

import { createMockFetch, createTestSessionProvider, createTestClient } from './helpers';

describe('auth - добавление заголовков', () => {
  it('добавляет один или несколько заголовков из провайдера', async () => {
    const provider1 = createTestSessionProvider({
      headers: { Authorization: 'Bearer token-1' },
    });
    const mock1 = createMockFetch(() => ({ body: { id: '1' } }));
    const client1 = createTestClient({ fetch: mock1.fetch, auth: { provider: provider1 } });
    await client1.get('/users/me');
    expect(mock1.calls[0]?.headers.authorization).toBe('Bearer token-1');

    const provider2 = createTestSessionProvider({
      headers: {
        Authorization: 'Bearer token-1',
        'X-CSRF-Token': 'csrf-1',
        'X-API-Key': 'key-1',
      },
    });
    const mock2 = createMockFetch(() => ({ body: null }));
    const client2 = createTestClient({ fetch: mock2.fetch, auth: { provider: provider2 } });
    await client2.get('/users');
    const headers = mock2.calls[0]?.headers;
    expect(headers?.authorization).toBe('Bearer token-1');
    expect(headers?.['x-csrf-token']).toBe('csrf-1');
    expect(headers?.['x-api-key']).toBe('key-1');
  });

  it('пропускает заголовки и refresh при skipAuth: true', async () => {
    const refresh = vi.fn(async () => ({
      status: 'success' as const,
      headers: { Authorization: 'Bearer new' },
    }));

    const provider: SessionProvider = {
      getAuthHeaders: () => ({ Authorization: 'Bearer old' }),
      refresh,
    };

    const mock = createMockFetch(() => ({ body: null }));
    const client = createTestClient({ fetch: mock.fetch, auth: { provider } });

    await client.post('/sessions', {}, { skipAuth: true });
    expect(mock.calls[0]?.headers.authorization).toBeUndefined();

    const mock401 = createMockFetch(() => ({
      status: 401,
      body: { code: 'SESSION_INVALID' },
    }));
    const client401 = createTestClient({ fetch: mock401.fetch, auth: { provider } });

    await expect(client401.post('/sessions', {}, { skipAuth: true })).rejects.toMatchObject({
      status: 401,
    });
    expect(refresh).not.toHaveBeenCalled();
  });

  it('поддерживает асинхронный getAuthHeaders', async () => {
    const provider: SessionProvider = {
      getAuthHeaders: async () => ({ Authorization: 'Bearer async-token' }),
      refresh: async () => ({ status: 'definitely-failed', reason: 'refresh-rejected' }),
    };

    const mock = createMockFetch(() => ({ body: null }));
    const client = createTestClient({ fetch: mock.fetch, auth: { provider } });

    await client.get('/users');

    expect(mock.calls[0]?.headers.authorization).toBe('Bearer async-token');
  });
});

describe('auth - ошибки провайдера', () => {
  it('преобразует sync и async ошибку getAuthHeaders в AUTH_PROVIDER_ERROR', async () => {
    const provider1: SessionProvider = {
      getAuthHeaders: () => {
        throw new Error('Provider failure');
      },
      refresh: async () => ({ status: 'definitely-failed', reason: 'refresh-rejected' }),
    };
    const mock1 = createMockFetch(() => ({ body: null }));
    const client1 = createTestClient({ fetch: mock1.fetch, auth: { provider: provider1 } });
    await expect(client1.get('/users')).rejects.toMatchObject({
      kind: 'unknown',
      code: 'AUTH_PROVIDER_ERROR',
    });
    expect(mock1.calls).toHaveLength(0);

    const provider2: SessionProvider = {
      getAuthHeaders: async () => {
        throw new Error('Async failure');
      },
      refresh: async () => ({ status: 'definitely-failed', reason: 'refresh-rejected' }),
    };
    const mock2 = createMockFetch(() => ({ body: null }));
    const client2 = createTestClient({ fetch: mock2.fetch, auth: { provider: provider2 } });
    await expect(client2.get('/users')).rejects.toMatchObject({
      kind: 'unknown',
      code: 'AUTH_PROVIDER_ERROR',
    });
  });

  it('AbortError из getAuthHeaders пробрасывается как kind abort, не AUTH_PROVIDER_ERROR', async () => {
    const provider: SessionProvider = {
      getAuthHeaders: () => {
        throw new DOMException('Aborted', 'AbortError');
      },
      refresh: async () => ({ status: 'definitely-failed', reason: 'refresh-rejected' }),
    };

    const mock = createMockFetch(() => ({ body: null }));
    const client = createTestClient({ fetch: mock.fetch, auth: { provider } });

    try {
      await client.get('/users');
      expect.fail('should have thrown');
    } catch (e) {
      const err = e as ApiError;
      expect(err.kind).toBe('abort');
      expect(err.code).toBe('ABORTED');
      expect(err.isCancelled).toBe(true);
    }

    expect(mock.calls).toHaveLength(0);
  });
});

describe('auth - 401 -> refresh -> повтор', () => {
  it('обновляет токен на 401 и повторяет запрос', async () => {
    let attempts = 0;

    const provider: SessionProvider = {
      getAuthHeaders: () => ({ Authorization: 'Bearer old' }),
      refresh: async () => ({
        status: 'success',
        headers: { Authorization: 'Bearer new' },
      }),
    };

    const mock = createMockFetch(() => {
      attempts++;
      if (attempts === 1) {
        return { status: 401, body: { code: 'SESSION_INVALID' } };
      }
      return { body: { id: '1' } };
    });

    const client = createTestClient({ fetch: mock.fetch, auth: { provider } });
    const result = await client.get<{ id: string }>('/users/me');

    expect(result).toEqual({ id: '1' });
    expect(mock.calls).toHaveLength(2);
    expect(mock.calls[0]?.headers.authorization).toBe('Bearer old');
    expect(mock.calls[1]?.headers.authorization).toBe('Bearer new');
  });

  it('вызывает refresh только один раз для параллельных 401 (single-flight)', async () => {
    let refreshCount = 0;
    let token = 'old';

    const provider: SessionProvider = {
      getAuthHeaders: () => ({ Authorization: `Bearer ${token}` }),
      refresh: async () => {
        refreshCount++;
        await new Promise((resolve) => setTimeout(resolve, 20));
        token = 'new';
        return { status: 'success', headers: { Authorization: `Bearer ${token}` } };
      },
    };

    const mock = createMockFetch((_, init) => {
      const headers = init.headers as Record<string, string>;
      if (headers.authorization === 'Bearer old') {
        return { status: 401, body: { code: 'SESSION_INVALID' } };
      }
      return { body: { ok: true } };
    });

    const client = createTestClient({ fetch: mock.fetch, auth: { provider } });

    await Promise.all([
      client.get('/a'),
      client.get('/b'),
      client.get('/c'),
      client.get('/d'),
      client.get('/e'),
    ]);

    expect(refreshCount).toBe(1);
  });

  it('не повторяет больше одного раза после refresh', async () => {
    let attempts = 0;

    const provider: SessionProvider = {
      getAuthHeaders: () => ({ Authorization: 'Bearer token' }),
      refresh: async () => ({
        status: 'success',
        headers: { Authorization: 'Bearer new' },
      }),
    };

    const mock = createMockFetch(() => {
      attempts++;
      return { status: 401, body: { code: 'SESSION_INVALID' } };
    });

    const onSessionExpired = vi.fn();
    const client = createTestClient({
      fetch: mock.fetch,
      auth: { provider, onSessionExpired },
    });

    await expect(client.get('/users')).rejects.toMatchObject({ status: 401 });

    expect(attempts).toBe(2);
    expect(onSessionExpired).toHaveBeenCalledWith('token-rejected');
  });

  it('не вызывает refresh для не-401 ошибок', async () => {
    let refreshCalls = 0;

    const provider: SessionProvider = {
      getAuthHeaders: () => ({ Authorization: 'Bearer token' }),
      refresh: async () => {
        refreshCalls++;
        return { status: 'success' };
      },
    };

    const mock = createMockFetch(() => ({ status: 500, body: { code: 'SERVER_ERROR' } }));
    const client = createTestClient({ fetch: mock.fetch, auth: { provider } });

    await expect(client.get('/users')).rejects.toBeDefined();
    expect(refreshCalls).toBe(0);
  });

  it('берёт новые заголовки из refresh или из getAuthHeaders, если их нет', async () => {
    let attempts1 = 0;
    const provider1: SessionProvider = {
      getAuthHeaders: () => ({ Authorization: 'Bearer stale' }),
      refresh: async () => ({
        status: 'success',
        headers: { Authorization: 'Bearer fresh-from-refresh' },
      }),
    };
    const mock1 = createMockFetch(() => {
      attempts1++;
      if (attempts1 === 1) return { status: 401, body: {} };
      return { body: { ok: true } };
    });
    const client1 = createTestClient({ fetch: mock1.fetch, auth: { provider: provider1 } });
    await client1.get('/users');
    expect(mock1.calls[1]?.headers.authorization).toBe('Bearer fresh-from-refresh');

    let attempts2 = 0;
    let headerCallCount = 0;
    const provider2: SessionProvider = {
      getAuthHeaders: () => {
        headerCallCount++;
        return { Authorization: `Bearer token-${headerCallCount}` };
      },
      refresh: async () => ({ status: 'success' }),
    };
    const mock2 = createMockFetch(() => {
      attempts2++;
      if (attempts2 === 1) return { status: 401, body: {} };
      return { body: {} };
    });
    const client2 = createTestClient({ fetch: mock2.fetch, auth: { provider: provider2 } });
    await client2.get('/users');
    expect(headerCallCount).toBeGreaterThanOrEqual(2);
  });

  it('refresh получает AbortSignal', async () => {
    let receivedSignal: AbortSignal | undefined;

    const provider: SessionProvider = {
      getAuthHeaders: () => ({ Authorization: 'Bearer old' }),
      refresh: async (signal) => {
        receivedSignal = signal;
        return {
          status: 'success',
          headers: { Authorization: 'Bearer new' },
        };
      },
    };

    let attempts = 0;
    const mock = createMockFetch(() => {
      attempts++;
      if (attempts === 1) return { status: 401, body: {} };
      return { body: {} };
    });

    const client = createTestClient({ fetch: mock.fetch, auth: { provider } });
    await client.get('/users');

    expect(receivedSignal).toBeInstanceOf(AbortSignal);
    expect(receivedSignal?.aborted).toBe(false);
  });
});

describe('auth - definitely-failed', () => {
  it('вызывает onSessionExpired с refresh-rejected или refresh-forbidden', async () => {
    for (const reason of ['refresh-rejected', 'refresh-forbidden'] as const) {
      const provider: SessionProvider = {
        getAuthHeaders: () => ({ Authorization: 'Bearer token' }),
        refresh: async () => ({ status: 'definitely-failed', reason }),
      };

      const mock = createMockFetch(() => ({
        status: 401,
        body: { code: 'SESSION_INVALID' },
      }));

      const onSessionExpired = vi.fn();
      const client = createTestClient({
        fetch: mock.fetch,
        auth: { provider, onSessionExpired },
      });

      await expect(client.get('/users')).rejects.toBeDefined();
      expect(onSessionExpired).toHaveBeenCalledWith(reason);
    }
  });

  it('вызывает provider.clear; падение clear не подменяет ошибку', async () => {
    const clear = vi.fn();
    const provider1: SessionProvider = {
      getAuthHeaders: () => ({ Authorization: 'Bearer token' }),
      refresh: async () => ({ status: 'definitely-failed', reason: 'refresh-rejected' }),
      clear,
    };
    const mock1 = createMockFetch(() => ({ status: 401, body: { code: 'SESSION_INVALID' } }));
    const client1 = createTestClient({ fetch: mock1.fetch, auth: { provider: provider1 } });
    await expect(client1.get('/users')).rejects.toBeDefined();
    expect(clear).toHaveBeenCalled();

    const provider2: SessionProvider = {
      getAuthHeaders: () => ({ Authorization: 'Bearer token' }),
      refresh: async () => ({ status: 'definitely-failed', reason: 'refresh-rejected' }),
      clear: () => {
        throw new Error('Clear failed');
      },
    };
    const mock2 = createMockFetch(() => ({ status: 401, body: { code: 'SESSION_INVALID' } }));
    const client2 = createTestClient({ fetch: mock2.fetch, auth: { provider: provider2 } });
    await expect(client2.get('/users')).rejects.toMatchObject({ status: 401 });
  });
});

describe('auth - temporarily-failed', () => {
  it('не разлогинивает: ни onSessionExpired, ни clear', async () => {
    const clear = vi.fn();
    const provider: SessionProvider = {
      getAuthHeaders: () => ({ Authorization: 'Bearer token' }),
      refresh: async () => ({
        status: 'temporarily-failed',
        error: new TypeError('Network down'),
      }),
      clear,
    };

    const mock = createMockFetch(() => ({ status: 401, body: { code: 'SESSION_INVALID' } }));

    const onSessionExpired = vi.fn();
    const client = createTestClient({
      fetch: mock.fetch,
      auth: { provider, onSessionExpired },
    });

    await expect(client.get('/users')).rejects.toBeDefined();
    expect(onSessionExpired).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
  });

  it('отдает нормализованную ошибку из refresh: network и abort', async () => {
    const networkProvider: SessionProvider = {
      getAuthHeaders: () => ({ Authorization: 'Bearer token' }),
      refresh: async () => ({
        status: 'temporarily-failed',
        error: new TypeError('Network down'),
      }),
    };
    const mock1 = createMockFetch(() => ({ status: 401, body: { code: 'SESSION_INVALID' } }));
    const client1 = createTestClient({ fetch: mock1.fetch, auth: { provider: networkProvider } });
    await expect(client1.get('/users')).rejects.toMatchObject({
      kind: 'network',
      code: 'NETWORK_ERROR',
    });

    const abortProvider: SessionProvider = {
      getAuthHeaders: () => ({ Authorization: 'Bearer token' }),
      refresh: async () => {
        throw new DOMException('Aborted', 'AbortError');
      },
    };
    const mock2 = createMockFetch(() => ({ status: 401, body: { code: 'SESSION_INVALID' } }));
    const client2 = createTestClient({
      fetch: mock2.fetch,
      auth: { provider: abortProvider, circuitBreakerMs: 60_000 },
    });

    await expect(client2.get('/a')).rejects.toMatchObject({ kind: 'abort' });
    await expect(client2.get('/b')).rejects.toMatchObject({ kind: 'abort' });
  });
});

describe('auth - ошибки из provider.refresh', () => {
  it('классифицирует ошибку из refresh', async () => {
    const provider401: SessionProvider = {
      getAuthHeaders: () => ({ Authorization: 'Bearer token' }),
      refresh: async () => {
        throw new ApiError({ kind: 'http', status: 401, message: 'Refresh failed' });
      },
    };
    const mock1 = createMockFetch(() => ({ status: 401, body: { code: 'SESSION_INVALID' } }));
    const onSessionExpired1 = vi.fn();
    const client1 = createTestClient({
      fetch: mock1.fetch,
      auth: { provider: provider401, onSessionExpired: onSessionExpired1 },
    });
    await expect(client1.get('/users')).rejects.toBeDefined();
    expect(onSessionExpired1).toHaveBeenCalled();

    const providerNetwork: SessionProvider = {
      getAuthHeaders: () => ({ Authorization: 'Bearer token' }),
      refresh: async () => {
        throw new TypeError('Network down');
      },
    };
    const mock2 = createMockFetch(() => ({ status: 401, body: { code: 'SESSION_INVALID' } }));
    const onSessionExpired2 = vi.fn();
    const client2 = createTestClient({
      fetch: mock2.fetch,
      auth: { provider: providerNetwork, onSessionExpired: onSessionExpired2 },
    });
    await expect(client2.get('/users')).rejects.toBeDefined();
    expect(onSessionExpired2).not.toHaveBeenCalled();
  });
});

describe('auth - refreshTimeoutMs', () => {
  it('refresh с signal отменяется по refreshTimeoutMs с REFRESH_TIMEOUT', async () => {
    const provider: SessionProvider = {
      getAuthHeaders: () => ({ Authorization: 'Bearer token' }),
      refresh: (signal) =>
        new Promise((_, reject) => {
          signal?.addEventListener(
            'abort',
            () => {
              reject(signal.reason ?? new DOMException('Refresh aborted', 'AbortError'));
            },
            { once: true },
          );
        }),
    };

    const mock = createMockFetch(() => ({ status: 401, body: { code: 'SESSION_INVALID' } }));
    const client = createTestClient({
      fetch: mock.fetch,
      auth: { provider, refreshTimeoutMs: 50, circuitBreakerMs: 60_000 },
    });

    await expect(client.get('/users')).rejects.toMatchObject({
      kind: 'timeout',
      code: 'REFRESH_TIMEOUT',
    });
  });

  it('refresh завершается по refreshTimeoutMs, даже если реализация не слушает signal', async () => {
    // Провайдер принимает signal по сигнатуре, но не подписывается
    // на него и возвращает промис, который никогда не завершается.
    // Без гонки с таймаутным промисом вызов завис бы навсегда,
    // а параллельные 401 встали бы в очередь через SingleFlight.
    const provider: SessionProvider = {
      getAuthHeaders: () => ({ Authorization: 'Bearer token' }),
      refresh: () => new Promise<never>(() => {}),
    };

    const mock = createMockFetch(() => ({ status: 401, body: { code: 'SESSION_INVALID' } }));
    const client = createTestClient({
      fetch: mock.fetch,
      auth: { provider, refreshTimeoutMs: 50, circuitBreakerMs: 60_000 },
    });

    await expect(client.get('/users')).rejects.toMatchObject({
      kind: 'timeout',
      code: 'REFRESH_TIMEOUT',
    });
  });
});

describe('auth - валидация конфигурации', () => {
  it('ошибка конфигурации при circuitBreakerMs <= 0 и refreshTimeoutMs <= 0', () => {
    const provider = createTestSessionProvider();

    expect(() =>
      createTestClient({
        fetch: createMockFetch(() => ({ body: {} })).fetch,
        auth: { provider, circuitBreakerMs: 0 },
      }),
    ).toThrow(/circuitBreakerMs/);

    expect(() =>
      createTestClient({
        fetch: createMockFetch(() => ({ body: {} })).fetch,
        auth: { provider, refreshTimeoutMs: 0 },
      }),
    ).toThrow(/refreshTimeoutMs/);

    expect(() =>
      createTestClient({
        fetch: createMockFetch(() => ({ body: {} })).fetch,
        auth: { provider, refreshTimeoutMs: -1 },
      }),
    ).toThrow(/refreshTimeoutMs/);
  });
});

describe('auth - circuit breaker', () => {
  it('открывает circuit после temporarily-failed refresh', async () => {
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

    const mock = createMockFetch(() => ({ status: 401, body: { code: 'SESSION_INVALID' } }));
    const client = createTestClient({
      fetch: mock.fetch,
      auth: { provider, circuitBreakerMs: 60_000 },
    });

    await expect(client.get('/a')).rejects.toBeDefined();
    expect(refreshCalls).toBe(1);

    await expect(client.get('/b')).rejects.toMatchObject({
      kind: 'unknown',
      code: 'REFRESH_CIRCUIT_OPEN',
    });
    expect(refreshCalls).toBe(1);
  });

  it('закрывает circuit через circuitBreakerMs', async () => {
    vi.useFakeTimers();
    try {
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

      const mock = createMockFetch(() => ({ status: 401, body: { code: 'SESSION_INVALID' } }));
      const client = createTestClient({
        fetch: mock.fetch,
        auth: { provider, circuitBreakerMs: 5000 },
      });

      await expect(client.get('/a')).rejects.toBeDefined();
      expect(refreshCalls).toBe(1);

      await vi.advanceTimersByTimeAsync(6000);

      await expect(client.get('/b')).rejects.toBeDefined();
      expect(refreshCalls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('вызывает onCircuitOpen ровно один раз, пока circuit открыт', async () => {
    const provider: SessionProvider = {
      getAuthHeaders: () => ({ Authorization: 'Bearer token' }),
      refresh: async () => ({
        status: 'temporarily-failed',
        error: new TypeError('Network down'),
      }),
    };

    const mock = createMockFetch(() => ({ status: 401, body: { code: 'SESSION_INVALID' } }));

    const onCircuitOpen = vi.fn();
    const onCircuitClose = vi.fn();
    const client = createTestClient({
      fetch: mock.fetch,
      auth: { provider, circuitBreakerMs: 60_000, onCircuitOpen, onCircuitClose },
    });

    await expect(client.get('/a')).rejects.toBeDefined();
    await expect(client.get('/b')).rejects.toBeDefined();
    await expect(client.get('/c')).rejects.toBeDefined();

    expect(onCircuitOpen).toHaveBeenCalledTimes(1);
    expect(onCircuitClose).not.toHaveBeenCalled();
  });
});

describe('auth - cooldown', () => {
  it('в течение cooldown refresh не вызывается, запрос повторяется с текущим токеном', async () => {
    let refreshCalls = 0;
    let token = 'old';
    let serverCalls = 0;

    const provider: SessionProvider = {
      getAuthHeaders: () => ({ Authorization: `Bearer ${token}` }),
      refresh: async () => {
        refreshCalls++;
        token = 'new';
        return { status: 'success', headers: { Authorization: `Bearer ${token}` } };
      },
    };

    const mock = createMockFetch(() => {
      serverCalls++;
      // Запрос 1: старая авторизация -> 401.
      if (serverCalls === 1) {
        return { status: 401, body: { code: 'SESSION_INVALID' } };
      }
      // Запрос 2: с новым токеном -> успех.
      if (serverCalls === 2) {
        return { body: { ok: 'first' } };
      }
      // Запрос 3: снова старая авторизация (симуляция рассинхронизации) -> 401.
      if (serverCalls === 3) {
        return { status: 401, body: { code: 'SESSION_INVALID' } };
      }
      // Запрос 4: cooldown -> повтор с текущим токеном (new) -> успех.
      return { body: { ok: 'second' } };
    });

    const client = createTestClient({
      fetch: mock.fetch,
      auth: { provider, circuitBreakerMs: 60_000 },
    });

    const first = await client.get<{ ok: string }>('/a');
    expect(first.ok).toBe('first');
    expect(refreshCalls).toBe(1);

    // Второй запрос: сервер отвечает 401, но refresh уже был
    // недавно - cooldown, повтор с текущим токеном без refresh.
    const second = await client.get<{ ok: string }>('/b');
    expect(second.ok).toBe('second');
    expect(refreshCalls).toBe(1);
  });

  it('cooldown не вызывает onSessionExpired даже если повтор даёт 401', async () => {
    let refreshCalls = 0;
    let token = 'old';

    const provider: SessionProvider = {
      getAuthHeaders: () => ({ Authorization: `Bearer ${token}` }),
      refresh: async () => {
        refreshCalls++;
        token = 'new';
        return { status: 'success', headers: { Authorization: `Bearer ${token}` } };
      },
    };

    const mock = createMockFetch((_, init) => {
      const headers = init.headers as Record<string, string>;
      // Первый запрос со старым токеном: 401 -> refresh -> повтор с новым.
      if (headers.authorization === 'Bearer old') {
        return { status: 401, body: { code: 'SESSION_INVALID' } };
      }
      // Всё, что с новым токеном: 401 (симуляция: сервер отвергает новый токен).
      return { status: 401, body: { code: 'SESSION_INVALID' } };
    });

    const onSessionExpired = vi.fn();
    const client = createTestClient({
      fetch: mock.fetch,
      auth: { provider, circuitBreakerMs: 60_000, onSessionExpired },
    });

    // Первый запрос: 401 -> refresh -> повтор с новым токеном -> 401.
    // Это ветка token-rejected, onSessionExpired вызывается.
    await expect(client.get('/a')).rejects.toBeDefined();
    expect(onSessionExpired).toHaveBeenCalledWith('token-rejected');
    expect(refreshCalls).toBe(1);

    onSessionExpired.mockClear();

    // Второй запрос: снова 401 на новый токен. Cooldown.
    // Повтор с тем же токеном снова 401. onSessionExpired НЕ вызывается:
    // refresh не запускался, мы не знаем, жива ли сессия.
    await expect(client.get('/b')).rejects.toMatchObject({ status: 401 });
    expect(refreshCalls).toBe(1);
    expect(onSessionExpired).not.toHaveBeenCalled();
  });
});

describe('resetRefreshCircuit', () => {
  it('сбрасывает circuit немедленно и вызывает onCircuitClose', async () => {
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

    const mock = createMockFetch(() => ({ status: 401, body: { code: 'SESSION_INVALID' } }));

    const onCircuitClose = vi.fn();
    const client = createTestClient({
      fetch: mock.fetch,
      auth: { provider, circuitBreakerMs: 60_000, onCircuitClose },
    });

    await expect(client.get('/a')).rejects.toBeDefined();
    expect(refreshCalls).toBe(1);

    expect(resetRefreshCircuit(client)).toBe(true);
    expect(onCircuitClose).toHaveBeenCalledTimes(1);

    await expect(client.get('/b')).rejects.toBeDefined();
    expect(refreshCalls).toBe(2);
  });

  it('возвращает false без auth и true, даже если circuit закрыт', () => {
    const mock1 = createMockFetch(() => ({ body: {} }));
    const client1 = createTestClient({ fetch: mock1.fetch });
    expect(resetRefreshCircuit(client1)).toBe(false);

    const provider = createTestSessionProvider();
    const mock2 = createMockFetch(() => ({ body: {} }));
    const client2 = createTestClient({ fetch: mock2.fetch, auth: { provider } });
    expect(resetRefreshCircuit(client2)).toBe(true);
  });
});
