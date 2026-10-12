// Тесты core/error-body.ts: parseFlatErrorBody и parseFields
// как чистые функции.

import { describe, expect, it } from 'vitest';

import { parseFlatErrorBody, parseFields } from '../src/core/error-body';

describe('parseFlatErrorBody', () => {
  it('читает code, message, fields', () => {
    expect(
      parseFlatErrorBody({
        code: 'NOT_FOUND',
        message: 'Not found',
        fields: { email: 'Invalid' },
      }),
    ).toEqual({
      code: 'NOT_FOUND',
      message: 'Not found',
      fields: { email: 'Invalid' },
    });
  });

  it('requestId из тела не извлекается: это структурное поле', () => {
    expect(parseFlatErrorBody({ code: 'X', requestId: 'req-1' })).toEqual({
      code: 'X',
      message: undefined,
      fields: undefined,
    });
  });

  it('plain-text строка становится message; нестроковые поля отбрасываются', () => {
    expect(parseFlatErrorBody('database is down')).toEqual({ message: 'database is down' });

    expect(
      parseFlatErrorBody({
        code: 123,
        message: { nested: true },
        fields: { a: 'ok', b: 42 },
      }),
    ).toEqual({ code: undefined, message: undefined, fields: { a: 'ok' } });
  });

  it('null и число возвращают пустой результат', () => {
    expect(parseFlatErrorBody(null)).toEqual({});
    expect(parseFlatErrorBody(42)).toEqual({});
  });
});

describe('parseFields', () => {
  it('оставляет только строковые значения; не-объект и массив отбрасываются', () => {
    expect(parseFields({ a: 'x', b: 'y' })).toEqual({ a: 'x', b: 'y' });
    expect(parseFields({ a: 'x', b: 1, c: null })).toEqual({ a: 'x' });
    expect(parseFields({})).toBeUndefined();
    expect(parseFields('string')).toBeUndefined();
    expect(parseFields([['a', 'b']])).toBeUndefined();
  });
});
