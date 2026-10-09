import { Readable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { createMemoryStorage, type Client } from '../src/index';
import {
  createSessionSource,
  type IdempotencyContext,
  type IdempotencyOutcome,
  type IdempotencySource,
} from '../src/layers/idempotency/index';
import { memoryStorageSource } from '../src/layers/idempotency/sources';

import { createMockFetch, createTestClient, createTestStorage } from './helpers';

function createIdempotentClient(options: {
  fetch: typeof fetch;
  source: IdempotencySource;
  headerName?: string;
}): Client {
  return createTestClient({
    fetch: options.fetch,
    idempotency: {
      source: options.source,
      headerName: options.headerName,
    },
  });
}

function keyOf(call: { headers: Record<string, string> } | undefined): string | undefined {
  return call?.headers['idempotency-key'];
}

describe('idempotency - добавление ключа', () => {
  it('добавляет ключ к мутирующим методам, не добавляет к GET; метод нормализуется в верхний регистр', async () => {
    const mock = createMockFetch(() => ({ body: null }));
    const source = createSessionSource({ storage: createMemoryStorage() });
    const client = createIdempotentClient({ fetch: mock.fetch, source });

    await client.post('/orders', { total: 100 });
    await client.delete('/orders/1');
    await client.put('/users/1', { name: 'Alice' });
    await client.patch('/users/2', { name: 'Bob' });

    for (let i = 0; i < 4; i++) {
      expect(keyOf(mock.calls[i])).toBeDefined();
    }

    await client.get('/orders');
    expect(keyOf(mock.calls[4])).toBeUndefined();

    await client.post('/orders', { total: 100 }, { skipIdempotency: true });
    expect(keyOf(mock.calls[5])).toBeUndefined();

    // Метод в нижнем регистре нормализуется в client.ts до входа
    // в pipeline; withIdempotency распознаёт 'post' как мутирующий.
    await client.request({
      path: '/orders',
      method: 'post' as unknown as 'POST',
      body: { total: 100 },
    });
    expect(mock.calls[6]?.method).toBe('POST');
    expect(keyOf(mock.calls[6])).toBeDefined();
  });

  it('memoryStorageSource работает как источник ключей', async () => {
    const mock = createMockFetch(() => ({ body: { id: '1' } }));
    const client = createTestClient({
      fetch: mock.fetch,
      idempotency: { source: memoryStorageSource() },
    });

    await client.post('/orders', { total: 100 });
    await client.get('/orders');

    expect(mock.calls[0]?.headers['idempotency-key']).toBeDefined();
    expect(mock.calls[1]?.headers['idempotency-key']).toBeUndefined();
  });
});

describe('idempotency - отпечаток: body, scope, query', () => {
  it('различает body по содержимому, не по порядку ключей', async () => {
    const mock = createMockFetch(() => {
      throw new TypeError('Network down');
    });
    const source = createSessionSource({ storage: createMemoryStorage() });
    const client = createIdempotentClient({ fetch: mock.fetch, source });

    await expect(client.post('/orders', { total: 100 })).rejects.toBeDefined();
    await expect(client.post('/orders', { total: 200 })).rejects.toBeDefined();
    expect(keyOf(mock.calls[0])).not.toBe(keyOf(mock.calls[1]));

    await expect(client.post('/orders', { a: 1, b: 2 })).rejects.toBeDefined();
    await expect(client.post('/orders', { b: 2, a: 1 })).rejects.toBeDefined();
    expect(keyOf(mock.calls[2])).toBe(keyOf(mock.calls[3]));
  });

  it('различает scope, включая символ | в имени', async () => {
    const mock = createMockFetch(() => ({
      status: 500,
      body: { code: 'SERVER_ERROR' },
    }));
    const source = createSessionSource({ storage: createMemoryStorage() });
    const client = createIdempotentClient({ fetch: mock.fetch, source });

    const body = { action: 'create' };

    await expect(
      client.post('/actions', body, { idempotencyScope: 'action-create' }),
    ).rejects.toBeDefined();
    await expect(
      client.post('/actions', body, { idempotencyScope: 'action-delete' }),
    ).rejects.toBeDefined();
    expect(keyOf(mock.calls[0])).not.toBe(keyOf(mock.calls[1]));

    await expect(client.post('/x', { n: 1 }, { idempotencyScope: 'a|b' })).rejects.toBeDefined();
    await expect(client.post('/x', { n: 2 }, { idempotencyScope: 'a' })).rejects.toBeDefined();
    expect(keyOf(mock.calls[2])).not.toBe(keyOf(mock.calls[3]));
  });

  it('query участвует в отпечатке: значение, порядок, undefined/null, пустой query', async () => {
    const mock = createMockFetch(() => {
      throw new TypeError('Network down');
    });
    const source = createSessionSource({ storage: createMemoryStorage() });
    const client = createIdempotentClient({ fetch: mock.fetch, source });

    const body = { amount: 100 };

    // Разные значения query дают разные ключи.
    await expect(
      client.post('/transfer', body, { query: { type: 'internal' } }),
    ).rejects.toBeDefined();
    await expect(
      client.post('/transfer', body, { query: { type: 'external' } }),
    ).rejects.toBeDefined();
    expect(keyOf(mock.calls[0])).not.toBe(keyOf(mock.calls[1]));

    // Одинаковые параметры в разном порядке дают один ключ.
    await expect(client.post('/transfer', body, { query: { a: 1, b: 2 } })).rejects.toBeDefined();
    await expect(client.post('/transfer', body, { query: { b: 2, a: 1 } })).rejects.toBeDefined();
    expect(keyOf(mock.calls[2])).toBe(keyOf(mock.calls[3]));

    // Отсутствие query и пустой query эквивалентны.
    await expect(client.post('/transfer', body)).rejects.toBeDefined();
    await expect(client.post('/transfer', body, { query: {} })).rejects.toBeDefined();
    expect(keyOf(mock.calls[4])).toBe(keyOf(mock.calls[5]));

    // undefined и null в query не влияют на отпечаток.
    await expect(client.post('/transfer', body)).rejects.toBeDefined();
    await expect(
      client.post('/transfer', body, { query: { a: undefined, b: null } }),
    ).rejects.toBeDefined();
    expect(keyOf(mock.calls[6])).toBe(keyOf(mock.calls[7]));

    // Разные body при одинаковом query дают разные ключи.
    await expect(
      client.post('/transfer', { amount: 100 }, { query: { type: 'internal' } }),
    ).rejects.toBeDefined();
    await expect(
      client.post('/transfer', { amount: 200 }, { query: { type: 'internal' } }),
    ).rejects.toBeDefined();
    expect(keyOf(mock.calls[8])).not.toBe(keyOf(mock.calls[9]));
  });
});

describe('idempotency - ручной ключ', () => {
  it('не перезаписывает установленный ключ, включая пустой и whitespace-only', async () => {
    const nextKey = vi.fn(() => 'auto');
    const source: IdempotencySource = { nextKey };

    const mock = createMockFetch(() => ({ body: { id: '1' } }));
    const client = createIdempotentClient({ fetch: mock.fetch, source });

    await client.post(
      '/orders',
      { total: 100 },
      { headers: { 'Idempotency-Key': 'my-custom-key' } },
    );
    expect(keyOf(mock.calls[0])).toBe('my-custom-key');
    expect(nextKey).not.toHaveBeenCalled();

    const sourceWithKeys = createSessionSource({ storage: createMemoryStorage() });
    const client2 = createIdempotentClient({ fetch: mock.fetch, source: sourceWithKeys });
    await client2.post('/orders', { total: 100 }, { headers: { 'Idempotency-Key': '' } });
    await client2.post('/orders', { total: 100 }, { headers: { 'Idempotency-Key': '   ' } });
    expect(keyOf(mock.calls[1])?.trim()).toBeTruthy();
    expect(keyOf(mock.calls[2])?.trim()).toBeTruthy();
  });

  it('распознаёт ключ в любом регистре; поддерживает кастомное имя заголовка', async () => {
    const mock1 = createMockFetch(() => ({ body: { id: '1' } }));
    const source1 = createSessionSource({ storage: createMemoryStorage() });
    const client1 = createIdempotentClient({ fetch: mock1.fetch, source: source1 });

    await client1.post(
      '/orders',
      { total: 100 },
      { headers: { 'idempotency-key': 'lowercase-key' } },
    );
    expect(Object.values(mock1.calls[0]?.headers ?? {})).toContain('lowercase-key');

    const mock2 = createMockFetch(() => ({ body: { id: '1' } }));
    const source2 = createSessionSource({ storage: createMemoryStorage() });
    const client2 = createIdempotentClient({
      fetch: mock2.fetch,
      source: source2,
      headerName: 'X-Idempotency-Key',
    });

    await client2.post('/orders', { total: 100 });

    expect(mock2.calls[0]?.headers['x-idempotency-key']).toBeDefined();
    expect(mock2.calls[0]?.headers['idempotency-key']).toBeUndefined();
  });
});

describe('idempotency - исходы', () => {
  it('удаляет ключ после success и 4xx (definite-failure)', async () => {
    const body = { total: 100 };

    const mock1 = createMockFetch(() => ({ body: { id: '1' } }));
    const source1 = createSessionSource({ storage: createMemoryStorage() });
    const client1 = createIdempotentClient({ fetch: mock1.fetch, source: source1 });

    await client1.post('/orders', body);
    await client1.post('/orders', body);
    expect(keyOf(mock1.calls[0])).not.toBe(keyOf(mock1.calls[1]));

    const mock2 = createMockFetch(() => ({ status: 400, body: { code: 'BAD_REQUEST' } }));
    const source2 = createSessionSource({ storage: createMemoryStorage() });
    const client2 = createIdempotentClient({ fetch: mock2.fetch, source: source2 });

    await expect(client2.post('/orders', body)).rejects.toBeDefined();
    await expect(client2.post('/orders', body)).rejects.toBeDefined();
    expect(keyOf(mock2.calls[0])).not.toBe(keyOf(mock2.calls[1]));
  });

  it('сохраняет ключ после indefinite-failure: 5xx, 408, 429 и сеть', async () => {
    for (const status of [500, 502, 408, 429]) {
      const mock = createMockFetch(() => ({ status, body: { code: 'TEMPORARY' } }));
      const source = createSessionSource({ storage: createMemoryStorage() });
      const client = createIdempotentClient({ fetch: mock.fetch, source });

      const body = { total: 100 };
      await expect(client.post('/orders', body)).rejects.toBeDefined();
      await expect(client.post('/orders', body)).rejects.toBeDefined();

      expect(keyOf(mock.calls[0])).toBe(keyOf(mock.calls[1]));
    }

    const networkMock = createMockFetch(() => {
      throw new TypeError('Network down');
    });
    const networkSource = createSessionSource({ storage: createMemoryStorage() });
    const networkClient = createIdempotentClient({
      fetch: networkMock.fetch,
      source: networkSource,
    });

    await expect(networkClient.post('/orders', { total: 100 })).rejects.toBeDefined();
    await expect(networkClient.post('/orders', { total: 100 })).rejects.toBeDefined();
    expect(keyOf(networkMock.calls[0])).toBe(keyOf(networkMock.calls[1]));
  });
});

describe('idempotency - параллельные POST', () => {
  it('выдаёт разные ключи для разных body, успех одного не удаляет ключ другого', async () => {
    const seenKeys: string[] = [];

    const mock = createMockFetch((_, init) => {
      const headers = init.headers as Record<string, string>;
      const key = headers['idempotency-key'] ?? '';
      seenKeys.push(key);

      if (seenKeys.length === 2) {
        throw new TypeError('Network down');
      }
      return { body: { ok: true } };
    });

    const storage = createMemoryStorage();
    const source = createSessionSource({ storage });
    const client = createIdempotentClient({ fetch: mock.fetch, source });

    await Promise.allSettled([
      client.post('/orders', { n: 1 }, { idempotencyScope: 'shared' }),
      client.post('/orders', { n: 2 }, { idempotencyScope: 'shared' }),
    ]);

    const body1Key = seenKeys[0];
    const body2Key = seenKeys[1];
    expect(body1Key).not.toBe(body2Key);

    // Ключ второго (неуспешного) body сохранился.
    await client.post('/orders', { n: 2 }, { idempotencyScope: 'shared' });
    expect(seenKeys[2]).toBe(body2Key);
  });
});

describe('idempotency - несериализуемые тела', () => {
  it('FormData, Blob, ArrayBuffer, URLSearchParams: новый ключ каждый раз, в хранилище не пишется', async () => {
    const bodies: unknown[] = [
      (() => {
        const fd = new FormData();
        fd.append('file', 'x');
        return fd;
      })(),
      new Blob(['x']),
      new TextEncoder().encode('x').buffer,
      new URLSearchParams({ a: '1' }),
    ];

    for (const body of bodies) {
      const storage = createMemoryStorage();
      const source = createSessionSource({ storage });
      const mock = createMockFetch(() => ({ body: { ok: true } }));
      const client = createIdempotentClient({ fetch: mock.fetch, source });

      await client.post('/upload', body);
      await client.post('/upload', body);

      expect(keyOf(mock.calls[0])).toBeDefined();
      expect(keyOf(mock.calls[1])).not.toBe(keyOf(mock.calls[0]));

      const raw = storage.getItem('idempotency:session');
      const store = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      expect(Object.keys(store)).toHaveLength(0);
    }
  });

  it('File: два разных File дают разные ключи, в хранилище не пишется', async () => {
    const seenKeys: string[] = [];

    const mock = createMockFetch((_, init) => {
      const headers = init.headers as Record<string, string>;
      seenKeys.push(headers['idempotency-key'] ?? '');
      return { body: { ok: true } };
    });

    const storage = createMemoryStorage();
    const source = createSessionSource({ storage });
    const client = createIdempotentClient({ fetch: mock.fetch, source });

    const fileA = new File(['aaa'], 'avatar.png', { type: 'image/png' });
    const fileB = new File(['bbb'], 'avatar.png', { type: 'image/png' });

    await client.post('/upload', fileA, { idempotencyScope: 'avatar' });
    await client.post('/upload', fileB, { idempotencyScope: 'avatar' });

    expect(seenKeys).toHaveLength(2);
    expect(seenKeys[0]).not.toBe(seenKeys[1]);

    const raw = storage.getItem('idempotency:session');
    const store = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    expect(Object.keys(store)).toHaveLength(0);
  });

  it('Node stream.Readable: два разных стрима дают разные ключи, в хранилище не пишется', async () => {
    const seenKeys: string[] = [];

    const mock = createMockFetch((_, init) => {
      const headers = init.headers as Record<string, string>;
      seenKeys.push(headers['idempotency-key'] ?? '');
      return { body: { ok: true } };
    });

    const storage = createMemoryStorage();
    const source = createSessionSource({ storage });
    const client = createIdempotentClient({ fetch: mock.fetch, source });

    await client.post('/upload', Readable.from(['aaa']), { idempotencyScope: 'upload' });
    await client.post('/upload', Readable.from(['bbb']), { idempotencyScope: 'upload' });

    expect(seenKeys).toHaveLength(2);
    expect(seenKeys[0]).not.toBe(seenKeys[1]);

    const raw = storage.getItem('idempotency:session');
    const store = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    expect(Object.keys(store)).toHaveLength(0);
  });
});

describe('idempotency - ошибки', () => {
  it('ошибка IDEMPOTENCY_STORAGE_ERROR при сбое setItem', async () => {
    const storage = createTestStorage();
    storage.failNextSet();

    const source = createSessionSource({ storage });
    const mock = createMockFetch(() => ({ body: { id: '1' } }));
    const client = createIdempotentClient({ fetch: mock.fetch, source });

    await expect(client.post('/orders', { total: 100 })).rejects.toMatchObject({
      kind: 'storage',
      code: 'IDEMPOTENCY_STORAGE_ERROR',
    });

    expect(mock.calls).toHaveLength(0);
  });

  it('ошибка IDEMPOTENCY_KEY_INVALID при пустом или whitespace-only ключе', async () => {
    for (const badKey of ['', '   ']) {
      const source = createSessionSource({
        storage: createMemoryStorage(),
        generateKey: () => badKey,
      });

      const mock = createMockFetch(() => ({ body: { id: '1' } }));
      const client = createIdempotentClient({ fetch: mock.fetch, source });

      await expect(client.post('/orders', { total: 100 })).rejects.toMatchObject({
        kind: 'serialize',
        code: 'IDEMPOTENCY_KEY_INVALID',
      });

      expect(mock.calls).toHaveLength(0);
    }
  });

  it('ошибка BODY_SERIALIZATION_ERROR при циклических ссылках', async () => {
    const source = createSessionSource({ storage: createMemoryStorage() });
    const mock = createMockFetch(() => ({ body: { ok: true } }));
    const client = createIdempotentClient({ fetch: mock.fetch, source });

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    await expect(client.post('/orders', cyclic)).rejects.toMatchObject({
      kind: 'serialize',
      code: 'BODY_SERIALIZATION_ERROR',
    });

    expect(mock.calls).toHaveLength(0);
  });
});

describe('idempotency - maxEntries и lastUsedAt', () => {
  it('удаляет старейшие записи при переполнении', async () => {
    const mock = createMockFetch(() => {
      throw new TypeError('Network down');
    });
    const storage = createTestStorage();
    const source = createSessionSource({ storage, maxEntries: 2 });
    const client = createIdempotentClient({ fetch: mock.fetch, source });

    await expect(
      client.post('/orders', { n: 1 }, { idempotencyScope: 'order-1' }),
    ).rejects.toBeDefined();
    await expect(
      client.post('/orders', { n: 2 }, { idempotencyScope: 'order-2' }),
    ).rejects.toBeDefined();
    await expect(
      client.post('/orders', { n: 3 }, { idempotencyScope: 'order-3' }),
    ).rejects.toBeDefined();

    const raw = storage.snapshot()['idempotency:session'];
    const parsed = JSON.parse(raw!) as Record<string, { key: string }>;
    const keys = Object.keys(parsed);

    expect(keys).toHaveLength(2);
    expect(keys.some((k) => k.includes('"order-1"'))).toBe(false);
  });

  it('не удаляет активный ключ при переполнении', async () => {
    vi.useFakeTimers();
    try {
      const mock = createMockFetch(() => {
        throw new TypeError('Network down');
      });
      const storage = createTestStorage();
      const source = createSessionSource({ storage, maxEntries: 2 });
      const client = createIdempotentClient({ fetch: mock.fetch, source });

      vi.setSystemTime(1000);
      await expect(
        client.post('/orders', { n: 1 }, { idempotencyScope: 'a' }),
      ).rejects.toBeDefined();

      vi.setSystemTime(2000);
      await expect(
        client.post('/orders', { n: 2 }, { idempotencyScope: 'b' }),
      ).rejects.toBeDefined();

      vi.setSystemTime(3000);
      await expect(
        client.post('/orders', { n: 1 }, { idempotencyScope: 'a' }),
      ).rejects.toBeDefined();

      vi.setSystemTime(4000);
      await expect(
        client.post('/orders', { n: 3 }, { idempotencyScope: 'c' }),
      ).rejects.toBeDefined();

      const raw = storage.snapshot()['idempotency:session']!;
      const store = JSON.parse(raw) as Record<string, unknown>;

      expect(Object.keys(store)).toHaveLength(2);
      expect(Object.keys(store).some((k) => k.startsWith('"a"|'))).toBe(true);
      expect(Object.keys(store).some((k) => k.startsWith('"c"|'))).toBe(true);
      expect(Object.keys(store).some((k) => k.startsWith('"b"|'))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('idempotency - кастомный источник', () => {
  it('передаёт в nextKey корректный контекст', async () => {
    const nextKey = vi.fn(() => 'custom-key-1');
    const source: IdempotencySource = { nextKey };

    const mock = createMockFetch(() => ({ body: { id: '1' } }));
    const client = createIdempotentClient({ fetch: mock.fetch, source });

    const body = { total: 100 };
    const query = { type: 'internal', priority: 1 };
    await client.post('/orders', body, { query });

    expect(nextKey).toHaveBeenCalledTimes(1);
    expect(nextKey).toHaveBeenCalledWith({
      method: 'POST',
      path: '/orders',
      body,
      query,
      scope: undefined,
    });
    expect(keyOf(mock.calls[0])).toBe('custom-key-1');
  });

  it('вызывает resolve с success, definite-failure, indefinite-failure', async () => {
    const resolve = vi.fn<(ctx: IdempotencyContext, outcome: IdempotencyOutcome) => void>();
    const source: IdempotencySource = { nextKey: () => 'key-1', resolve };

    const mock1 = createMockFetch(() => ({ body: { id: '1' } }));
    const client1 = createIdempotentClient({ fetch: mock1.fetch, source });
    await client1.post('/orders', { total: 100 });
    expect(resolve).toHaveBeenLastCalledWith(expect.anything(), 'success');

    const mock2 = createMockFetch(() => ({ status: 400, body: {} }));
    const client2 = createIdempotentClient({ fetch: mock2.fetch, source });
    await expect(client2.post('/orders', { total: 100 })).rejects.toBeDefined();
    expect(resolve).toHaveBeenLastCalledWith(expect.anything(), 'definite-failure');

    const mock3 = createMockFetch(() => ({ status: 500, body: {} }));
    const client3 = createIdempotentClient({ fetch: mock3.fetch, source });
    await expect(client3.post('/orders', { total: 100 })).rejects.toBeDefined();
    expect(resolve).toHaveBeenLastCalledWith(expect.anything(), 'indefinite-failure');
  });

  it('падение resolve не ломает запрос', async () => {
    const source: IdempotencySource = {
      nextKey: () => 'key-1',
      resolve: () => {
        throw new Error('Storage failure');
      },
    };

    const mock = createMockFetch(() => ({ body: { id: '1' } }));
    const client = createIdempotentClient({ fetch: mock.fetch, source });

    await expect(client.post('/orders', { total: 100 })).resolves.toEqual({ id: '1' });
  });
});
