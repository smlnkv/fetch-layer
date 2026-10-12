// Тесты layers/idempotency/serialize.ts: stableSerialize.

import { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { stableSerialize } from '../src/layers/idempotency/index';

describe('stableSerialize - примитивы и структуры', () => {
  it('примитивы: undefined, функция и Symbol как null', () => {
    expect(stableSerialize(null)).toBe('null');
    expect(stableSerialize(42)).toBe('42');
    expect(stableSerialize('hello')).toBe('"hello"');

    expect(stableSerialize(undefined)).toBe('null');
    expect(stableSerialize(() => undefined)).toBe('null');
  });

  it('объекты: сортировка ключей, пропуск undefined, null сохраняется', () => {
    expect(stableSerialize({})).toBe('{}');
    expect(stableSerialize({ c: 3, a: 1, b: 2 })).toBe('{"a":1,"b":2,"c":3}');
    expect(stableSerialize({ z: { c: 1, a: 2 }, a: { y: 3, x: 4 } })).toBe(
      '{"a":{"x":4,"y":3},"z":{"a":2,"c":1}}',
    );
    expect(stableSerialize({ a: 1, b: undefined, c: 3 })).toBe('{"a":1,"c":3}');
    expect(stableSerialize({ a: null })).toBe('{"a":null}');
  });

  it('массивы: порядок, вложенность, undefined как null', () => {
    expect(stableSerialize([])).toBe('[]');
    expect(stableSerialize([3, 1, 2])).toBe('[3,1,2]');
    expect(stableSerialize([{ b: 1, a: 2 }])).toBe('[{"a":2,"b":1}]');
    expect(stableSerialize([1, undefined, 2])).toBe('[1,null,2]');
  });
});

describe('stableSerialize - toJSON', () => {
  it('вызывает toJSON, результат сортируется как обычно', () => {
    expect(stableSerialize(new Date('2026-09-13T12:00:00.000Z'))).toBe(
      '"2026-09-13T12:00:00.000Z"',
    );
    expect(stableSerialize({ toJSON: () => ({ b: 1, a: 2 }) })).toBe('{"a":2,"b":1}');
  });

  it('toJSON, вернувший undefined: свойство опускается, как в JSON.stringify', () => {
    expect(stableSerialize({ a: { toJSON: () => undefined } })).toBe('{}');
    expect(stableSerialize({ a: 1, b: { toJSON: () => undefined }, c: 3 })).toBe('{"a":1,"c":3}');
    expect(stableSerialize([{ toJSON: () => undefined }])).toBe('[null]');
    expect(
      stableSerialize({
        nested: { inner: { toJSON: () => undefined }, keep: 'x' },
      }),
    ).toBe('{"nested":{"keep":"x"}}');
  });

  it('совпадает с JSON.stringify для toJSON, вернувшего undefined или null', () => {
    const cases: unknown[] = [
      { a: { toJSON: () => undefined } },
      [{ toJSON: () => undefined }],
      { x: { toJSON: () => null } },
    ];

    for (const value of cases) {
      const expected = JSON.stringify(value) ?? 'null';
      expect(stableSerialize(value)).toBe(expected);
    }
  });

  it('toJSON, вернувший несериализуемый тип, отклоняется; сообщение называет тип', () => {
    const cases: Array<[string, unknown]> = [
      ['Map', { toJSON: () => new Map([['a', 1]]) }],
      ['Blob', { toJSON: () => new Blob(['x']) }],
      ['ReadableStream', { toJSON: () => new ReadableStream() }],
    ];

    for (const [typeName, value] of cases) {
      try {
        stableSerialize(value);
        expect.fail(`should have thrown for ${typeName}`);
      } catch (e) {
        expect(e).toMatchObject({
          kind: 'serialize',
          code: 'BODY_SERIALIZATION_ERROR',
        });
        const cause = (e as { cause?: unknown }).cause;
        expect(cause).toBeInstanceOf(TypeError);
        expect((cause as TypeError).message).toMatch(/toJSON/);
        expect((cause as TypeError).message).toMatch(new RegExp(typeName));
      }
    }
  });
});

describe('stableSerialize - несериализуемые типы', () => {
  it.each([
    ['Map', new Map()],
    ['Blob', new Blob(['x'])],
    ['URLSearchParams', new URLSearchParams({ a: '1' })],
  ])('%s на верхнем уровне отклоняется', (_name, value) => {
    expect(() => stableSerialize(value)).toThrowError(
      expect.objectContaining({
        kind: 'serialize',
        code: 'BODY_SERIALIZATION_ERROR',
      }),
    );
  });

  it.each([
    ['Map', new Map()],
    ['Blob', new Blob(['x'])],
  ])('%s во вложенном значении отклоняется', (_name, value) => {
    expect(() => stableSerialize({ nested: value })).toThrowError(
      expect.objectContaining({ code: 'BODY_SERIALIZATION_ERROR' }),
    );
    expect(() => stableSerialize([value])).toThrowError(
      expect.objectContaining({ code: 'BODY_SERIALIZATION_ERROR' }),
    );
  });

  it('Node stream отклоняется до обхода _readableState', () => {
    // Без явной проверки stableSerialize обошёл бы перечисляемые
    // свойства _readableState, нашёл бы там циклические ссылки и упал
    // с 'Converting circular structure to JSON'.
    const readable = Readable.from(['hello', 'world']);

    try {
      stableSerialize(readable);
      expect.fail('should have thrown');
    } catch (e) {
      const cause = (e as { cause?: unknown }).cause;
      expect(cause).toBeInstanceOf(TypeError);
      expect((cause as TypeError).message).toMatch(/NodeReadable/);
    }
  });
});

describe('stableSerialize - циклы и общие ссылки', () => {
  it('ошибка для циклов; общие ссылки без цикла разрешены', () => {
    const shallow: { name: string; self?: unknown } = { name: 'loop' };
    shallow.self = shallow;

    try {
      stableSerialize(shallow);
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toMatchObject({
        name: 'ApiError',
        kind: 'serialize',
        code: 'BODY_SERIALIZATION_ERROR',
      });
      expect((e as { cause?: unknown }).cause).toBeInstanceOf(TypeError);
    }

    const shared = { value: 1 };
    expect(stableSerialize({ a: shared, b: shared })).toBe('{"a":{"value":1},"b":{"value":1}}');
  });
});

describe('stableSerialize - BigInt', () => {
  it('ошибка во вложенном значении', () => {
    expect(() => stableSerialize({ id: 1n })).toThrowError(
      expect.objectContaining({
        kind: 'serialize',
        code: 'BODY_SERIALIZATION_ERROR',
      }),
    );
  });
});
