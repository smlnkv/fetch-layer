// Тесты базового транспорта.

import { describe, expect, it, vi } from 'vitest';

import { createClient } from '../src/client';
import { ApiError, toApiError, type Layer } from '../src/index';

import { createMockFetch, createTestClient } from './helpers';

describe('client - HTTP-методы', () => {
  it('GET отправляет правильный метод и URL', async () => {
    const mock = createMockFetch(() => ({ body: { id: '1' } }));
    const client = createTestClient({ fetch: mock.fetch });

    await client.get('/users/1');

    expect(mock.calls[0]?.method).toBe('GET');
    expect(mock.calls[0]?.url).toBe('https://api.test/users/1');
  });

  it('POST отправляет body и Content-Type', async () => {
    const mock = createMockFetch(() => ({ body: { id: '1' } }));
    const client = createTestClient({ fetch: mock.fetch });

    await client.post('/orders', { total: 100 });

    expect(mock.calls[0]?.method).toBe('POST');
    expect(mock.calls[0]?.headers['content-type']).toBe('application/json');
    expect(mock.calls[0]?.body).toEqual({ total: 100 });
  });
});

describe('client - Accept по responseType', () => {
  it('соответствует ожидаемому типу ответа', async () => {
    const mock = createMockFetch(() => ({ body: {} }));
    const client = createTestClient({ fetch: mock.fetch });

    await client.get('/users');
    expect(mock.calls[0]?.headers.accept).toBe('application/json');

    await client.get('/users', { responseType: 'text' });
    expect(mock.calls[1]?.headers.accept).toBe('text/plain');

    await client.get('/users', { responseType: 'blob' });
    expect(mock.calls[2]?.headers.accept).toBe('*/*');
  });
});

describe('client - requestWithMeta', () => {
  it('возвращает { data, meta } вместо чистого тела', async () => {
    const mock = createMockFetch(() => ({
      status: 201,
      headers: { 'x-request-id': 'req-123' },
      body: { id: '1' },
    }));
    const client = createTestClient({ fetch: mock.fetch });

    const result = await client.requestWithMeta<{ id: string }>({
      path: '/users',
      method: 'GET',
    });

    expect(result.data).toEqual({ id: '1' });
    expect(result.meta.status).toBe(201);
    expect(result.meta.requestId).toBe('req-123');
  });
});

describe('client - head и options', () => {
  it.each([
    ['HEAD', 'HEAD'],
    ['OPTIONS', 'OPTIONS'],
  ] as const)('%s возвращает { data: undefined, meta } с заголовками', async (_, method) => {
    const mock = createMockFetch(() => ({
      status: 200,
      headers: { 'content-length': '1024' },
    }));
    const client = createTestClient({ fetch: mock.fetch });

    const result =
      method === 'HEAD' ? await client.head('/files/report.pdf') : await client.options('/files');

    expect(result.data).toBeUndefined();
    expect(result.meta.status).toBe(200);
    expect(result.meta.headers.get('content-length')).toBe('1024');
    expect(mock.calls[0]?.method).toBe(method);
  });
});

describe('client - пустые ответы', () => {
  it('204 и 304 возвращают undefined', async () => {
    const mock = createMockFetch(() => ({ status: 204 }));
    const client = createTestClient({ fetch: mock.fetch });

    expect(await client.delete('/users/1')).toBeUndefined();

    const mock2 = createMockFetch(() => ({ status: 304 }));
    const client2 = createTestClient({ fetch: mock2.fetch });

    expect(await client2.get('/users')).toBeUndefined();
  });
});

describe('client - ошибки', () => {
  it('404 с телом: code, message, rawBody, requestId', async () => {
    const mock = createMockFetch(() => ({
      status: 404,
      headers: { 'x-request-id': 'req-404' },
      body: { code: 'NOT_FOUND', message: 'Not found' },
    }));
    const client = createTestClient({ fetch: mock.fetch });

    try {
      await client.get('/users/999');
      expect.fail('should have thrown');
    } catch (e) {
      const err = toApiError(e);
      expect(err).toMatchObject({
        kind: 'http',
        status: 404,
        code: 'NOT_FOUND',
        message: 'Not found',
        requestId: 'req-404',
      });
      expect(err.rawBody).toEqual({ code: 'NOT_FOUND', message: 'Not found' });
    }
  });

  it('HTTP_{status} как fallback code и plain-text ошибки в message', async () => {
    // Пустое тело: code и message формируются из статуса.
    const mock1 = createMockFetch(() => ({ status: 500, body: {} }));
    const client1 = createTestClient({ fetch: mock1.fetch });
    await expect(client1.get('/users')).rejects.toMatchObject({
      code: 'HTTP_500',
      message: 'HTTP 500',
    });

    // Plain-text тело: message от сервера, rawBody сохраняет строку.
    const mock2 = createMockFetch(() => ({
      status: 500,
      bodyAsText: 'database is down',
      headers: { 'content-type': 'text/plain' },
    }));
    const client2 = createTestClient({ fetch: mock2.fetch });

    try {
      await client2.get('/users');
      expect.fail('should have thrown');
    } catch (e) {
      const err = toApiError(e);
      expect(err.status).toBe(500);
      expect(err.message).toBe('database is down');
      expect(err.rawBody).toBe('database is down');
      expect(err.code).toBe('HTTP_500');
    }
  });

  it('isUncertain: true для 5xx и network, false для 4xx', async () => {
    const mock1 = createMockFetch((url) => {
      if (url.endsWith('/server-error')) return { status: 503, body: { code: 'UNAVAILABLE' } };
      return { status: 400, body: { code: 'BAD_REQUEST' } };
    });
    const client1 = createTestClient({ fetch: mock1.fetch });

    try {
      await client1.get('/server-error');
      expect.fail('should have thrown');
    } catch (e) {
      expect(toApiError(e).isUncertain).toBe(true);
    }

    try {
      await client1.get('/client-error');
      expect.fail('should have thrown');
    } catch (e) {
      expect(toApiError(e).isUncertain).toBe(false);
    }

    const mock2 = createMockFetch(() => {
      throw new TypeError('Failed to fetch');
    });
    const client2 = createTestClient({ fetch: mock2.fetch });

    try {
      await client2.get('/users');
      expect.fail('should have thrown');
    } catch (e) {
      const err = toApiError(e);
      expect(err.isNetwork).toBe(true);
      expect(err.isUncertain).toBe(true);
    }
  });

  it('обрабатывает невалидный JSON и указывает content-type в сообщении', async () => {
    const mock = createMockFetch(() => ({
      bodyAsText: 'not json',
      headers: { 'content-type': 'text/html; charset=utf-8' },
    }));
    const client = createTestClient({ fetch: mock.fetch });

    try {
      await client.get('/users');
      expect.fail('should have thrown');
    } catch (e) {
      const err = toApiError(e);
      expect(err.kind).toBe('parse');
      expect(err.code).toBe('PARSE_ERROR');
      expect(err.message).toMatch(/as json/);
      expect(err.message).toMatch(/text\/html/);
    }
  });
});

describe('client - parseErrorBody', () => {
  it('использует кастомный парсер и парсит fields', async () => {
    const mock = createMockFetch(() => ({
      status: 422,
      body: {
        content: { code: 'VALIDATION_ERROR', message: 'Validation failed' },
        fields: { email: 'Invalid' },
      },
    }));

    const client = createTestClient({
      fetch: mock.fetch,
      parseErrorBody: (raw) => {
        const body = raw as {
          content?: { code?: string; message?: string };
          fields?: Record<string, string>;
        };
        return {
          code: body?.content?.code,
          message: body?.content?.message,
          fields: body?.fields,
        };
      },
    });

    try {
      await client.post('/users', {});
      expect.fail('should have thrown');
    } catch (e) {
      const err = toApiError(e);
      expect(err.code).toBe('VALIDATION_ERROR');
      expect(err.message).toBe('Validation failed');
      expect(err.fields).toEqual({ email: 'Invalid' });
    }
  });

  it('использует requestId из заголовка, если парсер его не вернул', async () => {
    const mock = createMockFetch(() => ({
      status: 400,
      headers: { 'x-request-id': 'header-req-id' },
      body: { code: 'BAD_REQUEST' },
    }));
    const client = createTestClient({ fetch: mock.fetch });

    try {
      await client.get('/users');
      expect.fail('should have thrown');
    } catch (e) {
      const err = toApiError(e);
      expect(err.requestId).toBe('header-req-id');
    }
  });
});

describe('client - query-параметры', () => {
  it('сериализует query в URL и использует форматы клиента по умолчанию', async () => {
    const mock1 = createMockFetch(() => ({ body: {} }));
    const client1 = createTestClient({ fetch: mock1.fetch });

    await client1.get('/products', {
      query: { page: 1, limit: 20 },
    });

    expect(mock1.calls[0]?.url).toBe('https://api.test/products?limit=20&page=1');

    const mock2 = createMockFetch(() => ({ body: {} }));
    const client2 = createTestClient({
      fetch: mock2.fetch,
      queryArrayFormat: 'comma',
      queryObjectFormat: 'dots',
    });

    await client2.get('/products', {
      query: { ids: [1, 2], filter: { status: 'active' } },
    });

    expect(mock2.calls[0]?.url).toBe('https://api.test/products?filter.status=active&ids=1,2');
  });

  it('per-request переопределение формата', async () => {
    const mock = createMockFetch(() => ({ body: {} }));
    const client = createTestClient({ fetch: mock.fetch });

    await client.get('/products', {
      query: { ids: [1, 2] },
      queryArrayFormat: 'brackets',
    });

    expect(mock.calls[0]?.url).toBe('https://api.test/products?ids[]=1&ids[]=2');
  });
});

describe('client - заголовки', () => {
  it('передаёт кастомные заголовки и не перезаписывает Content-Type', async () => {
    const mock = createMockFetch(() => ({ body: {} }));
    const client = createTestClient({ fetch: mock.fetch });

    await client.get('/users', {
      headers: { 'X-Custom': 'value' },
    });
    expect(mock.calls[0]?.headers['x-custom']).toBe('value');

    await client.post('/logs', 'plain', {
      headers: { 'Content-Type': 'text/plain' },
    });
    expect(mock.calls[1]?.headers['content-type']).toBe('text/plain');
  });

  it('принимает Headers и массив пар', async () => {
    const mock = createMockFetch(() => ({ body: {} }));
    const client = createTestClient({ fetch: mock.fetch });

    await client.get('/users', {
      headers: new Headers({ 'X-From-Headers': 'h' }),
    });
    expect(mock.calls[0]?.headers['x-from-headers']).toBe('h');

    await client.get('/users', {
      headers: [
        ['X-From-Pairs', 'p'],
        ['X-Second', 's'],
      ],
    });
    expect(mock.calls[1]?.headers['x-from-pairs']).toBe('p');
    expect(mock.calls[1]?.headers['x-second']).toBe('s');
  });

  it('defaultHeaders применяются ко всем запросам', async () => {
    const mock = createMockFetch(() => ({ body: {} }));
    const client = createTestClient({
      fetch: mock.fetch,
      defaultHeaders: { 'X-Client-Version': '1.0.0', 'X-Env': 'test' },
    });

    await client.get('/users');
    expect(mock.calls[0]?.headers['x-client-version']).toBe('1.0.0');
    expect(mock.calls[0]?.headers['x-env']).toBe('test');

    await client.post('/orders', { total: 100 });
    expect(mock.calls[1]?.headers['x-client-version']).toBe('1.0.0');
    expect(mock.calls[1]?.headers['x-env']).toBe('test');
  });

  it('per-request заголовки переопределяют defaultHeaders', async () => {
    const mock = createMockFetch(() => ({ body: {} }));
    const client = createTestClient({
      fetch: mock.fetch,
      defaultHeaders: { 'X-Client-Version': '1.0.0' },
    });

    await client.get('/users', {
      headers: { 'X-Client-Version': '2.0.0' },
    });

    expect(mock.calls[0]?.headers['x-client-version']).toBe('2.0.0');
  });
});

describe('client - credentials', () => {
  it('передаёт credentials из опций и переопределяет per-request', async () => {
    const mock = createMockFetch(() => ({ body: {} }));
    const client = createTestClient({
      fetch: mock.fetch,
      credentials: 'include',
    });

    await client.get('/users');
    expect(mock.calls[0]?.credentials).toBe('include');

    await client.get('/users', { credentials: 'omit' });
    expect(mock.calls[1]?.credentials).toBe('omit');
  });
});

describe('client - timeoutMs', () => {
  it('ошибка TIMEOUT при превышении, не классифицируя как отмену', async () => {
    vi.useFakeTimers();
    try {
      const mock = createMockFetch(
        (_, init) =>
          new Promise((resolve, reject) => {
            init.signal?.addEventListener('abort', () => {
              reject(init.signal?.reason ?? new DOMException('Aborted', 'AbortError'));
            });
            setTimeout(() => resolve({ body: {} }), 5000);
          }),
      );

      const client = createTestClient({ fetch: mock.fetch, timeoutMs: 100 });

      const promise = client.get('/slow');
      promise.catch(() => {});

      await vi.advanceTimersByTimeAsync(200);

      try {
        await promise;
        expect.fail('should have thrown');
      } catch (e) {
        const err = toApiError(e);
        expect(err.kind).toBe('timeout');
        expect(err.code).toBe('TIMEOUT');
        expect(err.isCancelled).toBe(false);
        expect(err.isNetwork).toBe(true);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('per-request timeoutMs переопределяет клиентский', async () => {
    // Больше клиентского: запрос успешен.
    vi.useFakeTimers();
    try {
      const mock1 = createMockFetch(
        (_, init) =>
          new Promise((resolve, reject) => {
            init.signal?.addEventListener('abort', () => {
              reject(init.signal?.reason ?? new DOMException('Aborted', 'AbortError'));
            });
            setTimeout(() => resolve({ body: { ok: true } }), 1000);
          }),
      );
      const client1 = createTestClient({ fetch: mock1.fetch, timeoutMs: 100 });
      const promise1 = client1.get('/slow', { timeoutMs: 2000 });
      await vi.advanceTimersByTimeAsync(1100);
      await expect(promise1).resolves.toEqual({ ok: true });
    } finally {
      vi.useRealTimers();
    }

    // Меньше клиентского: падает.
    vi.useFakeTimers();
    try {
      const mock2 = createMockFetch(
        (_, init) =>
          new Promise((resolve, reject) => {
            init.signal?.addEventListener('abort', () => {
              reject(init.signal?.reason ?? new DOMException('Aborted', 'AbortError'));
            });
            setTimeout(() => resolve({ body: {} }), 5000);
          }),
      );
      const client2 = createTestClient({ fetch: mock2.fetch, timeoutMs: 10_000 });
      const promise2 = client2.get('/slow', { timeoutMs: 100 });
      promise2.catch(() => {});
      await vi.advanceTimersByTimeAsync(200);
      await expect(promise2).rejects.toMatchObject({
        kind: 'timeout',
        code: 'TIMEOUT',
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('client - fetchOptions', () => {
  it('передаёт поля из fetchOptions в fetch', async () => {
    let capturedInit: RequestInit | undefined;

    const mock = createMockFetch((_, init) => {
      capturedInit = init;
      return { body: {} };
    });
    const client = createTestClient({ fetch: mock.fetch });

    await client.post(
      '/analytics',
      { event: 'click' },
      {
        fetchOptions: {
          cache: 'no-store',
          redirect: 'manual',
          keepalive: true,
        },
      },
    );

    expect(capturedInit?.cache).toBe('no-store');
    expect(capturedInit?.redirect).toBe('manual');
    expect(capturedInit?.keepalive).toBe(true);
  });
});

describe('client - signal', () => {
  it('отменяет запрос до отправки и во время выполнения', async () => {
    const mock1 = createMockFetch(() => ({ body: {} }));
    const client1 = createTestClient({ fetch: mock1.fetch });

    const preAborted = new AbortController();
    preAborted.abort();

    try {
      await client1.get('/users', { signal: preAborted.signal });
      expect.fail('should have thrown');
    } catch (e) {
      expect(toApiError(e).isCancelled).toBe(true);
    }
    expect(mock1.calls).toHaveLength(0);

    const controller = new AbortController();
    const mock2 = createMockFetch(
      (_, init) =>
        new Promise((resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(init.signal?.reason ?? new DOMException('Aborted', 'AbortError'));
          });
          setTimeout(() => resolve({ body: {} }), 1000);
        }),
    );
    const client2 = createTestClient({ fetch: mock2.fetch });

    const promise = client2.get('/slow', { signal: controller.signal });
    promise.catch(() => {});
    setTimeout(() => controller.abort(), 10);

    await expect(promise).rejects.toMatchObject({
      kind: 'abort',
      code: 'ABORTED',
    });
  });

  it('внешний signal + timeout: побеждает первый сработавший', async () => {
    // Побеждает таймаут.
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const mock = createMockFetch(
        (_, init) =>
          new Promise((resolve, reject) => {
            init.signal?.addEventListener('abort', () => {
              reject(init.signal?.reason ?? new DOMException('Aborted', 'AbortError'));
            });
            setTimeout(() => resolve({ body: {} }), 10_000);
          }),
      );
      const client = createTestClient({ fetch: mock.fetch, timeoutMs: 100 });
      const promise = client.get('/slow', { signal: controller.signal });
      promise.catch(() => {});
      await vi.advanceTimersByTimeAsync(200);

      try {
        await promise;
        expect.fail('should have thrown');
      } catch (e) {
        const err = toApiError(e);
        expect(err.kind).toBe('timeout');
        expect(err.isCancelled).toBe(false);
      }
    } finally {
      vi.useRealTimers();
    }

    // Побеждает внешний abort.
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const mock = createMockFetch(
        (_, init) =>
          new Promise((resolve, reject) => {
            init.signal?.addEventListener('abort', () => {
              reject(init.signal?.reason ?? new DOMException('Aborted', 'AbortError'));
            });
            setTimeout(() => resolve({ body: {} }), 10_000);
          }),
      );
      const client = createTestClient({ fetch: mock.fetch, timeoutMs: 10_000 });
      const promise = client.get('/slow', { signal: controller.signal });
      promise.catch(() => {});
      await vi.advanceTimersByTimeAsync(50);
      controller.abort();

      try {
        await promise;
        expect.fail('should have thrown');
      } catch (e) {
        expect(toApiError(e).isCancelled).toBe(true);
      }
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('client - request()', () => {
  it('позволяет указать метод явно, по умолчанию GET', async () => {
    const mock = createMockFetch(() => ({ body: {} }));
    const client = createTestClient({ fetch: mock.fetch });

    await client.request({
      path: '/users',
      method: 'POST',
      body: { name: 'Alice' },
    });
    expect(mock.calls[0]?.method).toBe('POST');

    await client.request({ path: '/users' });
    expect(mock.calls[1]?.method).toBe('GET');
  });
});

describe('client - валидация', () => {
  it('ошибка до запроса при пустом или нестроковом path', async () => {
    const mock = createMockFetch(() => ({ body: {} }));
    const client = createTestClient({ fetch: mock.fetch });

    await expect(client.get('')).rejects.toThrow(/client: path/);
    await expect(client.get(null as unknown as string)).rejects.toThrow(/client: path/);

    expect(mock.calls).toHaveLength(0);
  });

  it('ошибка до запроса при невалидном per-request timeoutMs', async () => {
    const mock = createMockFetch(() => ({ body: {} }));
    const client = createTestClient({ fetch: mock.fetch });

    await expect(client.get('/users', { timeoutMs: -1 })).rejects.toThrow(
      /client: timeoutMs must be a number >= 100 ms/,
    );
    await expect(client.get('/users', { timeoutMs: 0 })).rejects.toThrow(
      /client: timeoutMs must be a number >= 100 ms/,
    );
    await expect(client.get('/users', { timeoutMs: NaN })).rejects.toThrow(
      /client: timeoutMs must be a number >= 100 ms/,
    );
    await expect(client.get('/users', { timeoutMs: 50 })).rejects.toThrow(
      /client: timeoutMs must be a number >= 100 ms/,
    );

    expect(mock.calls).toHaveLength(0);
  });

  it('нормализует ошибку из пользовательского слоя', async () => {
    const boom = new Error('boom');
    const withBoom: Layer = {
      name: 'withBoom',
      wrap: () => ({
        fn: () => {
          throw boom;
        },
      }),
    };

    const mock = createMockFetch(() => ({ body: {} }));
    const client = createClient({
      baseUrl: 'https://api.test',
      fetch: mock.fetch,
      layers: [withBoom],
    });

    try {
      await client.get('/users');
      expect.fail('should have thrown');
    } catch (e) {
      const err = toApiError(e);
      expect(err).toBeInstanceOf(ApiError);
      expect(err.kind).toBe('unknown');
      expect(err.message).toBe('boom');
    }

    expect(mock.calls).toHaveLength(0);
  });
});

describe('createClient - валидация', () => {
  it('ошибка конфигурации при пустом baseUrl или невалидном timeoutMs', () => {
    expect(() => createClient({ baseUrl: '' })).toThrow(/baseUrl/);
    expect(() => createClient({ baseUrl: null as unknown as string })).toThrow(/baseUrl/);
    expect(() => createClient({ baseUrl: '/api', timeoutMs: -1 })).toThrow(
      /createClient: timeoutMs must be a number >= 100 ms/,
    );
    expect(() => createClient({ baseUrl: '/api', timeoutMs: 50 })).toThrow(
      /createClient: timeoutMs must be a number >= 100 ms/,
    );
    expect(() => createClient({ baseUrl: '/api', timeoutMs: 5000 })).not.toThrow();
  });
});
