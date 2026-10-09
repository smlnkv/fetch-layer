/**
 * createTestClient собирает клиент из опций, раскладывая auth,
 * retry и idempotency в layers в правильном порядке публичного API.
 */

import { vi } from 'vitest';

import { createClient, type Client, type ClientOptions, type StorageLike } from '../src/index';
import {
  withAuth,
  withIdempotency,
  withRetry,
  type AuthOptions,
  type RetryOptions,
} from '../src/layers/index';

import type { RefreshResult, SessionProvider } from '../src/layers/auth/index';
import type { IdempotencySource } from '../src/layers/idempotency/index';

export interface MockResponse {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
  bodyAsText?: string;
}

/**
 * @param url - URL запроса.
 * @param init - нормализованный RequestInit (headers в lowercase).
 * @param headers - нормализованные заголовки в lowercase.
 */
export type MockHandler = (
  url: string,
  init: RequestInit,
  headers: Record<string, string>,
) => MockResponse | Promise<MockResponse>;

export interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  credentials?: RequestCredentials;
  signal?: AbortSignal;
}

export interface MockFetch {
  fetch: typeof fetch;
  calls: FetchCall[];
}

export function createMockFetch(handler: MockHandler): MockFetch {
  const calls: FetchCall[] = [];

  const fetchImpl = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = (init?.method ?? 'GET').toUpperCase();
      const headers = normalizeHeaders(init?.headers);
      const body = parseBody(init?.body);

      calls.push({
        url,
        method,
        headers,
        body,
        credentials: init?.credentials,
        signal: init?.signal ?? undefined,
      });

      const normalizedInit: RequestInit = {
        ...init,
        headers,
      };

      const result = await handler(url, normalizedInit, headers);
      const status = result.status ?? 200;
      const responseHeaders = new Headers(result.headers ?? {});

      const hasBody = result.body !== undefined || result.bodyAsText !== undefined;
      if (hasBody && !responseHeaders.has('content-type')) {
        responseHeaders.set('content-type', 'application/json');
      }

      let responseBody: BodyInit | null = null;
      if (result.bodyAsText !== undefined) {
        responseBody = result.bodyAsText;
      } else if (result.body !== undefined) {
        responseBody = JSON.stringify(result.body);
      }

      return new Response(responseBody, {
        status,
        headers: responseHeaders,
      });
    },
  );

  return {
    fetch: fetchImpl as unknown as typeof fetch,
    calls,
  };
}

export interface TestStorage extends StorageLike {
  failNextSet(): void;
  failNextGet(): void;
  snapshot(): Record<string, string>;
}

export function createTestStorage(): TestStorage {
  const map = new Map<string, string>();
  let failSet = false;
  let failGet = false;

  return {
    getItem: (key) => {
      if (failGet) {
        failGet = false;
        return null;
      }
      return map.get(key) ?? null;
    },
    setItem: (key, value) => {
      if (failSet) {
        failSet = false;
        throw new DOMException('Test failure', 'QuotaExceededError');
      }
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
    failNextSet: () => {
      failSet = true;
    },
    failNextGet: () => {
      failGet = true;
    },
    snapshot: () => Object.fromEntries(map),
  };
}

export interface TestSessionProviderOptions {
  headers?: Record<string, string>;
  refresh?: () => Promise<RefreshResult>;
  clear?: () => void;
}

export function createTestSessionProvider(
  options: TestSessionProviderOptions = {},
): SessionProvider {
  return {
    getAuthHeaders: () => options.headers ?? {},
    refresh:
      options.refresh ??
      (async () => ({ status: 'definitely-failed', reason: 'refresh-rejected' })),
    clear: options.clear,
  };
}

export interface TestClientOptions extends Omit<ClientOptions, 'baseUrl' | 'layers'> {
  auth?: AuthOptions;
  retry?: RetryOptions;
  idempotency?: {
    source: IdempotencySource;
    headerName?: string;
  };
}

export function createTestClient(options: TestClientOptions): Client {
  const { auth, retry, idempotency, ...rest } = options;
  const layers = [];

  if (idempotency) {
    layers.push(withIdempotency(idempotency.source, { headerName: idempotency.headerName }));
  }
  if (retry) {
    layers.push(withRetry(retry));
  }
  if (auth) {
    layers.push(withAuth(auth));
  }

  return createClient({
    baseUrl: 'https://api.test',
    ...rest,
    layers,
  });
}

function normalizeHeaders(input: HeadersInit | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!input) return result;

  if (input instanceof Headers) {
    input.forEach((value, key) => {
      result[key.toLowerCase()] = value;
    });
    return result;
  }

  if (Array.isArray(input)) {
    for (const [key, value] of input) {
      result[key.toLowerCase()] = value;
    }
    return result;
  }

  for (const [key, value] of Object.entries(input)) {
    result[key.toLowerCase()] = String(value);
  }
  return result;
}

function parseBody(body: BodyInit | null | undefined): unknown {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') {
    try {
      return JSON.parse(body);
    } catch {
      return body;
    }
  }
  return body;
}
