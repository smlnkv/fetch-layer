// Тесты core/errors.ts: ApiError, toApiError, геттеры.

import { describe, expect, it } from 'vitest';

import { ApiError, toApiError } from '../src/index';

describe('ApiError - конструктор', () => {
  it('устанавливает поля и применяет дефолты', () => {
    const err = new ApiError({
      kind: 'http',
      message: 'Not found',
      status: 404,
      code: 'NOT_FOUND',
    });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('ApiError');
    expect(err.kind).toBe('http');
    expect(err.message).toBe('Not found');
    expect(err.status).toBe(404);
    expect(err.code).toBe('NOT_FOUND');

    const minimal = new ApiError({ kind: 'network', message: 'Network down' });
    expect(minimal.status).toBe(0);
    expect(minimal.code).toBe('UNKNOWN');
    expect(minimal.isUncertain).toBe(false);
    expect(minimal.details).toBeUndefined();

    const uncertain = new ApiError({
      kind: 'http',
      status: 400,
      message: 'Bad request',
      isUncertain: true,
    });
    expect(uncertain.isUncertain).toBe(true);
  });

  it('сохраняет fields, requestId, retryAfterMs, rawBody, details, cause', () => {
    const cause = new Error('Original');
    const err = new ApiError({
      kind: 'http',
      status: 422,
      message: 'Validation error',
      fields: { email: 'Invalid' },
      requestId: 'req-123',
      retryAfterMs: 5000,
      rawBody: { custom: 'body' },
      details: { instance: '/orders/1', status: 422 },
      cause,
    });

    expect(err.fields).toEqual({ email: 'Invalid' });
    expect(err.requestId).toBe('req-123');
    expect(err.retryAfterMs).toBe(5000);
    expect(err.rawBody).toEqual({ custom: 'body' });
    expect(err.details).toEqual({ instance: '/orders/1', status: 422 });
    expect(err.cause).toBe(cause);
  });
});

describe('ApiError - isNetwork и isCancelled', () => {
  it('корректно классифицируют kind', () => {
    expect(new ApiError({ kind: 'network', message: 'x' }).isNetwork).toBe(true);
    expect(new ApiError({ kind: 'timeout', message: 'x' }).isNetwork).toBe(true);
    expect(new ApiError({ kind: 'http', status: 500, message: 'x' }).isNetwork).toBe(false);

    expect(new ApiError({ kind: 'abort', message: 'x' }).isCancelled).toBe(true);
    expect(new ApiError({ kind: 'network', message: 'x' }).isCancelled).toBe(false);
  });
});

describe('ApiError - isAuthError', () => {
  it('true для auth-кодов, 401, 403; пересекается с isClientError', () => {
    for (const code of [
      'AUTH_PROVIDER_ERROR',
      'REFRESH_TIMEOUT',
      'REFRESH_CIRCUIT_OPEN',
      'REFRESH_COOLDOWN',
    ]) {
      expect(new ApiError({ kind: 'unknown', code, message: 'x' }).isAuthError).toBe(true);
    }

    expect(new ApiError({ kind: 'http', status: 401, message: 'x' }).isAuthError).toBe(true);
    expect(new ApiError({ kind: 'http', status: 403, message: 'x' }).isAuthError).toBe(true);

    for (const status of [400, 404, 422, 500, 503]) {
      expect(new ApiError({ kind: 'http', status, message: 'x' }).isAuthError).toBe(false);
    }

    const err401 = new ApiError({ kind: 'http', status: 401, message: 'x' });
    expect(err401.isAuthError).toBe(true);
    expect(err401.isClientError).toBe(true);
  });
});

describe('ApiError - isRetryable', () => {
  it('true для network, timeout, 408, 429 и 5xx', () => {
    expect(new ApiError({ kind: 'network', message: 'x' }).isRetryable).toBe(true);
    expect(new ApiError({ kind: 'timeout', message: 'x' }).isRetryable).toBe(true);

    // kind timeout с кодом TIMEOUT (обычный таймаут транспорта)
    // повторяется.
    expect(new ApiError({ kind: 'timeout', code: 'TIMEOUT', message: 'x' }).isRetryable).toBe(true);

    for (const status of [408, 429, 500, 502, 503, 504, 599]) {
      expect(new ApiError({ kind: 'http', status, message: 'x' }).isRetryable).toBe(true);
    }
  });

  it('false для abort, auth-кодов, остальных 4xx и 2xx/3xx', () => {
    expect(new ApiError({ kind: 'abort', message: 'x' }).isRetryable).toBe(false);
    expect(new ApiError({ kind: 'serialize', message: 'x' }).isRetryable).toBe(false);
    expect(new ApiError({ kind: 'storage', message: 'x' }).isRetryable).toBe(false);

    // Auth-коды не повторяются, даже если kind позволяет.
    for (const code of [
      'AUTH_PROVIDER_ERROR',
      'REFRESH_TIMEOUT',
      'REFRESH_CIRCUIT_OPEN',
      'REFRESH_COOLDOWN',
    ]) {
      expect(new ApiError({ kind: 'unknown', code, message: 'x' }).isRetryable).toBe(false);
    }
    expect(
      new ApiError({ kind: 'timeout', code: 'REFRESH_TIMEOUT', message: 'x' }).isRetryable,
    ).toBe(false);

    for (const status of [400, 401, 403, 404, 409, 422]) {
      expect(new ApiError({ kind: 'http', status, message: 'x' }).isRetryable).toBe(false);
    }

    expect(new ApiError({ kind: 'http', status: 200, message: 'x' }).isRetryable).toBe(false);
    expect(new ApiError({ kind: 'http', status: 304, message: 'x' }).isRetryable).toBe(false);
  });
});

describe('ApiError - isClientError, isServerError, isConflict', () => {
  it('корректно классифицирует статусы', () => {
    expect(new ApiError({ kind: 'http', status: 400, message: 'x' }).isClientError).toBe(true);
    expect(new ApiError({ kind: 'http', status: 499, message: 'x' }).isClientError).toBe(true);
    expect(new ApiError({ kind: 'http', status: 500, message: 'x' }).isClientError).toBe(false);

    expect(new ApiError({ kind: 'http', status: 500, message: 'x' }).isServerError).toBe(true);
    expect(new ApiError({ kind: 'http', status: 599, message: 'x' }).isServerError).toBe(true);
    expect(new ApiError({ kind: 'http', status: 400, message: 'x' }).isServerError).toBe(false);

    expect(new ApiError({ kind: 'http', status: 409, message: 'x' }).isConflict).toBe(true);
    expect(new ApiError({ kind: 'http', status: 400, message: 'x' }).isConflict).toBe(false);
  });
});

describe('toApiError', () => {
  it('возвращает ApiError без изменений и идемпотентен', () => {
    const original = new ApiError({ kind: 'http', status: 404, message: 'Not found' });
    expect(toApiError(original)).toBe(original);
    expect(toApiError(toApiError(original))).toBe(original);
  });

  it('распознаёт AbortError и TimeoutError по имени, включая duck-typed', () => {
    const abort = new DOMException('Aborted', 'AbortError');
    const err1 = toApiError(abort);
    expect(err1.kind).toBe('abort');
    expect(err1.code).toBe('ABORTED');
    expect(err1.isCancelled).toBe(true);

    expect(toApiError({ name: 'AbortError', message: 'Custom abort' }).kind).toBe('abort');

    const timeout = new DOMException('Timeout', 'TimeoutError');
    const err2 = toApiError(timeout);
    expect(err2.kind).toBe('timeout');
    expect(err2.code).toBe('TIMEOUT');
    expect(err2.isUncertain).toBe(true);

    expect(toApiError({ name: 'TimeoutError', message: 'Custom timeout' }).kind).toBe('timeout');
  });

  it('преобразует SyntaxError в parse с isUncertain false', () => {
    const err = toApiError(new SyntaxError('Unexpected token'));
    expect(err.kind).toBe('parse');
    expect(err.code).toBe('PARSE_ERROR');
    // Ответ получен: сервер ответил, состояние операции известно.
    // isUncertain относится к доставке, а не к парсингу.
    expect(err.isUncertain).toBe(false);

    const duck = { name: 'SyntaxError', message: 'cross-realm' };
    expect(toApiError(duck).kind).toBe('parse');
    expect(toApiError(duck).code).toBe('PARSE_ERROR');
    expect(toApiError(duck).isUncertain).toBe(false);
  });

  it('преобразует TypeError и Error с message в unknown', () => {
    const typeErr = toApiError(new TypeError('undefined is not a function'));
    expect(typeErr.kind).toBe('unknown');
    expect(typeErr.message).toBe('undefined is not a function');

    const genericErr = toApiError(new Error('Something went wrong'));
    expect(genericErr.kind).toBe('unknown');
    expect(genericErr.message).toBe('Something went wrong');
    expect(genericErr.cause).toBeInstanceOf(Error);
  });

  it('преобразует неизвестное значение в unknown', () => {
    expect(toApiError('just a string').kind).toBe('unknown');
    expect(toApiError('just a string').message).toBe('Unknown error');
    expect(toApiError(null).kind).toBe('unknown');
  });

  it('не путает обычный Error с полем name = "SomeError"', () => {
    const err = new Error('x');
    err.name = 'SomeError';
    expect(toApiError(err).kind).toBe('unknown');
  });
});
