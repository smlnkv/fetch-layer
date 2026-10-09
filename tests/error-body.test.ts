// Тесты core/error-body-parsers.ts: встроенные парсеры как
// чистые функции. Без HTTP-моков: вход — значение, выход — ParsedErrorBody.

import { describe, expect, it } from 'vitest';

import { parseFlatErrorBody, parseFields } from '../src/core/error-body';
import { errorBodyParsers } from '../src/core/error-body-parsers';

describe('parseFlatErrorBody', () => {
  it('читает code, message, fields, requestId', () => {
    expect(
      parseFlatErrorBody({
        code: 'NOT_FOUND',
        message: 'Not found',
        fields: { email: 'Invalid' },
        requestId: 'req-1',
      }),
    ).toEqual({
      code: 'NOT_FOUND',
      message: 'Not found',
      fields: { email: 'Invalid' },
      requestId: 'req-1',
    });
  });

  it('plain-text строка становится message; нестроковые поля отбрасываются', () => {
    expect(parseFlatErrorBody('database is down')).toEqual({ message: 'database is down' });

    expect(
      parseFlatErrorBody({
        code: 123,
        message: { nested: true },
        fields: { a: 'ok', b: 42, c: ['x'] },
      }),
    ).toEqual({ fields: { a: 'ok' } });
  });

  it('null, undefined, массив, число возвращают пустой результат', () => {
    expect(parseFlatErrorBody(null)).toEqual({});
    expect(parseFlatErrorBody(undefined)).toEqual({});
    expect(parseFlatErrorBody([1, 2, 3])).toEqual({});
    expect(parseFlatErrorBody(42)).toEqual({});
  });
});

describe('parseFields', () => {
  it('оставляет только строковые значения; не-объект и массив отбрасываются', () => {
    expect(parseFields({ a: 'x', b: 'y' })).toEqual({ a: 'x', b: 'y' });
    expect(parseFields({ a: 'x', b: 1, c: null, d: {} })).toEqual({ a: 'x' });
    expect(parseFields({})).toBeUndefined();
    expect(parseFields({ a: 1 })).toBeUndefined();
    expect(parseFields('string')).toBeUndefined();
    expect(parseFields([['a', 'b']])).toBeUndefined();
    expect(parseFields(null)).toBeUndefined();
  });
});

describe('errorBodyParsers.content', () => {
  it('читает { content: { code, message, fields } }', () => {
    expect(
      errorBodyParsers.content({
        content: { code: 'LIMIT_REACHED', message: 'Too many', fields: { id: 'x' } },
      }),
    ).toEqual({
      code: 'LIMIT_REACHED',
      message: 'Too many',
      fields: { id: 'x' },
    });
  });

  it('без content или с не-объектом возвращает пустой результат', () => {
    expect(errorBodyParsers.content({ message: 'top-level' })).toEqual({});
    expect(errorBodyParsers.content({ content: 'string' })).toEqual({});
    expect(errorBodyParsers.content(null)).toEqual({});
  });
});

describe('errorBodyParsers.error', () => {
  it('читает { error: { code, message } }', () => {
    expect(errorBodyParsers.error({ error: { code: 'INVALID', message: 'Bad input' } })).toEqual({
      code: 'INVALID',
      message: 'Bad input',
    });
  });

  it('без error или с не-объектом возвращает пустой результат', () => {
    expect(errorBodyParsers.error({ code: 'top-level' })).toEqual({});
    expect(errorBodyParsers.error({ error: 42 })).toEqual({});
    expect(errorBodyParsers.error('string')).toEqual({});
  });
});

describe('errorBodyParsers.rfc7807', () => {
  it('type -> code, detail -> message, instance и status -> details', () => {
    expect(
      errorBodyParsers.rfc7807({
        type: 'https://example.com/probs/out-of-credit',
        title: 'Out of credit',
        detail: 'Your balance is 30, but that costs 50.',
        instance: '/account/12345',
        status: 400,
      }),
    ).toEqual({
      code: 'https://example.com/probs/out-of-credit',
      message: 'Your balance is 30, but that costs 50.',
      details: { instance: '/account/12345', status: 400 },
    });
  });

  it('detail отсутствует: message берётся из title', () => {
    expect(errorBodyParsers.rfc7807({ type: 'about:blank', title: 'Bad request' })).toEqual({
      code: 'about:blank',
      message: 'Bad request',
      details: undefined,
    });
  });

  it('только instance или только status: details заполняется частично', () => {
    expect(errorBodyParsers.rfc7807({ instance: '/x' })).toEqual({
      code: undefined,
      message: undefined,
      details: { instance: '/x', status: undefined },
    });
    expect(errorBodyParsers.rfc7807({ status: 500 })).toEqual({
      code: undefined,
      message: undefined,
      details: { instance: undefined, status: 500 },
    });
  });

  it('null и примитивы возвращают пустой результат', () => {
    expect(errorBodyParsers.rfc7807(null)).toEqual({});
    expect(errorBodyParsers.rfc7807('string')).toEqual({});
    expect(errorBodyParsers.rfc7807(42)).toEqual({});
  });
});
