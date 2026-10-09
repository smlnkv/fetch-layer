import { describe, expect, it, vi } from 'vitest';

import { createMemoryStorage, toApiError } from '../src/index';
import { createSessionSource } from '../src/layers/idempotency/index';

import { createMockFetch, createTestClient, createTestStorage } from './helpers';

describe('integration - полный pipeline', () => {
  it('401 -> refresh -> успех с сохранением Idempotency-Key', async () => {
    const calls: Array<{ auth?: string; idempotency?: string; status: number }> = [];

    const mock = createMockFetch((_, __, headers) => {
      const auth = headers.authorization;
      const idempotency = headers['idempotency-key'];

      if (auth === 'Bearer old') {
        calls.push({ auth, idempotency, status: 401 });
        return { status: 401, body: { code: 'SESSION_INVALID' } };
      }

      calls.push({ auth, idempotency, status: 200 });
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
      idempotency: { source },
    });

    const result = await client.post('/orders', { total: 100 });

    expect(result).toEqual({ ok: true });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.idempotency).toBeDefined();
    expect(calls[1]?.idempotency).toBe(calls[0]?.idempotency);
  });

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
  it('параллельные 401 + параллельные POST - single-flight и ключи не конфликтуют', async () => {
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

    const source = createSessionSource({ storage: createMemoryStorage() });

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
      idempotency: { source },
    });

    await Promise.all([
      client.post('/orders', { n: 1 }),
      client.post('/orders', { n: 2 }),
      client.post('/orders', { n: 3 }),
    ]);

    expect(refreshCount).toBe(1);
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(3);
  });

  it('idempotency + retry + auth - одинаковые тела, один ключ, один refresh', async () => {
    let refreshCount = 0;
    let token = 'old';

    const allKeys: string[] = [];

    const mock = createMockFetch((_, __, headers) => {
      if (headers.authorization === 'Bearer old') {
        return { status: 401, body: { code: 'SESSION_INVALID' } };
      }

      allKeys.push(headers['idempotency-key'] ?? '');
      return { body: { ok: true } };
    });

    const source = createSessionSource({ storage: createMemoryStorage() });

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
      idempotency: { source },
    });

    await Promise.all([
      client.post('/orders', { total: 100 }),
      client.post('/orders', { total: 100 }),
      client.post('/orders', { total: 100 }),
    ]);

    expect(refreshCount).toBe(1);
    expect(allKeys).toHaveLength(3);
    expect(new Set(allKeys).size).toBe(1);
  });
});

describe('integration - circuit breaker + retry', () => {
  it('после исчерпания retry при 401 auth открывает circuit', async () => {
    let refreshCalls = 0;

    const mock = createMockFetch(() => ({
      status: 401,
      body: { code: 'SESSION_INVALID' },
    }));

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
      retry: { maxAttempts: 1, sleep: () => Promise.resolve() },
    });

    await expect(client.get('/users')).rejects.toBeDefined();
    expect(refreshCalls).toBe(1);

    await expect(client.get('/other')).rejects.toMatchObject({
      code: 'REFRESH_CIRCUIT_OPEN',
    });
    expect(refreshCalls).toBe(1);
  });

  it('retry не повторяет REFRESH_CIRCUIT_OPEN', async () => {
    let attempts = 0;

    const mock = createMockFetch(() => {
      attempts++;
      return { status: 401, body: { code: 'SESSION_INVALID' } };
    });

    const client = createTestClient({
      fetch: mock.fetch,
      auth: {
        provider: {
          getAuthHeaders: () => ({ Authorization: 'Bearer token' }),
          refresh: async () => ({
            status: 'temporarily-failed',
            error: new TypeError('Network down'),
          }),
        },
        circuitBreakerMs: 60_000,
      },
      retry: { maxAttempts: 3, sleep: () => Promise.resolve() },
    });

    await expect(client.get('/a')).rejects.toBeDefined();
    const attemptsAfterFirst = attempts;

    await expect(client.get('/b')).rejects.toMatchObject({
      code: 'REFRESH_CIRCUIT_OPEN',
    });

    expect(attempts).toBe(attemptsAfterFirst + 1);
  });
});

describe('integration - восстановление операций', () => {
  it('реализация PendingOrders с восстановлением', async () => {
    interface PendingCommand {
      id: string;
      key: string;
      path: string;
      body: unknown;
    }

    const storage = createTestStorage();
    const commands: PendingCommand[] = [];

    const saveCommand = (command: Omit<PendingCommand, 'id'>) => {
      const id = crypto.randomUUID();
      const full = { ...command, id };
      commands.push(full);
      storage.setItem(`pending:${id}`, JSON.stringify(full));
      return full;
    };

    const clearCommand = (id: string) => {
      const idx = commands.findIndex((c) => c.id === id);
      if (idx !== -1) commands.splice(idx, 1);
      storage.removeItem(`pending:${id}`);
    };

    let attempt = 0;
    const mock = createMockFetch((_, __, headers) => {
      attempt++;
      if (attempt === 1) {
        throw new TypeError('Network down');
      }
      return {
        body: { ok: true, idempotencyKey: headers['idempotency-key'] },
      };
    });

    const source = createSessionSource({ storage: createMemoryStorage() });
    const client = createTestClient({
      fetch: mock.fetch,
      idempotency: { source },
    });

    const cmd = saveCommand({
      key: crypto.randomUUID(),
      path: '/orders',
      body: { total: 100 },
    });

    await expect(
      client.post(cmd.path, cmd.body, {
        headers: { 'Idempotency-Key': cmd.key },
      }),
    ).rejects.toBeDefined();

    expect(commands).toHaveLength(1);

    const cmd2 = commands[0]!;
    const result = await client.post<{ ok: boolean; idempotencyKey: string }>(
      cmd2.path,
      cmd2.body,
      { headers: { 'Idempotency-Key': cmd2.key } },
    );

    clearCommand(cmd2.id);

    expect(result.idempotencyKey).toBe(cmd.key);
    expect(commands).toHaveLength(0);
  });
});

describe('integration - envelope + parseErrorBody', () => {
  it('работает с envelope и кастомным парсером ошибок', async () => {
    const mock = createMockFetch((url) => {
      if (url.endsWith('/users/1')) {
        return {
          body: { data: { id: '1', name: 'Alice' }, meta: { total: 1 } },
        };
      }
      return {
        status: 404,
        body: { content: { code: 'NOT_FOUND', message: 'User not found' } },
      };
    });

    const client = createTestClient({
      fetch: mock.fetch,
      parseErrorBody: (raw) => {
        const body = raw as { content?: { code?: string; message?: string } };
        return {
          code: body?.content?.code,
          message: body?.content?.message,
        };
      },
    });

    const envelope = await client.get<{ data: { id: string; name: string } }>('/users/1');
    expect(envelope.data.name).toBe('Alice');

    try {
      await client.get('/users/999');
      expect.fail('should have thrown');
    } catch (e) {
      const err = toApiError(e);
      expect(err.code).toBe('NOT_FOUND');
      expect(err.message).toBe('User not found');
      expect(err.rawBody).toEqual({
        content: { code: 'NOT_FOUND', message: 'User not found' },
      });
    }
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
