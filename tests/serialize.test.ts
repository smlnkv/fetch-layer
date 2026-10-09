// Тесты layers/idempotency/serialize.ts: stableSerialize.

import { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { stableSerialize } from '../src/layers/idempotency/index';

describe('stableSerialize - примитивы', () => {
  it('сериализует примитивы; NaN, Infinity, undefined, функции и Symbol как null', () => {
    expect(stableSerialize(null)).toBe('null');
    expect(stableSerialize(true)).toBe('true');
    expect(stableSerialize(false)).toBe('false');
    expect(stableSerialize(42)).toBe('42');
    expect(stableSerialize(-1.5)).toBe('-1.5');
    expect(stableSerialize(0)).toBe('0');
    expect(stableSerialize('hello')).toBe('"hello"');
    expect(stableSerialize('')).toBe('""');
    expect(stableSerialize('a"b')).toBe('"a\\"b"');
    expect(stableSerialize('line\nbreak')).toBe('"line\\nbreak"');

    expect(stableSerialize(NaN)).toBe('null');
    expect(stableSerialize(Infinity)).toBe('null');
    expect(stableSerialize(-Infinity)).toBe('null');
    expect(stableSerialize(undefined)).toBe('null');
    expect(stableSerialize(() => undefined)).toBe('null');
    expect(stableSerialize(Symbol('x'))).toBe('null');
  });
});

describe('stableSerialize - объекты', () => {
  it('сортирует ключи, включая вложенные', () => {
    expect(stableSerialize({})).toBe('{}');
    expect(stableSerialize({ c: 3, a: 1, b: 2 })).toBe('{"a":1,"b":2,"c":3}');
    expect(stableSerialize({ b: 1, a: 2 })).toBe(stableSerialize({ a: 2, b: 1 }));
    expect(stableSerialize({ z: { c: 1, a: 2 }, a: { y: 3, x: 4 } })).toBe(
      '{"a":{"x":4,"y":3},"z":{"a":2,"c":1}}',
    );
  });

  it('пропускает undefined, функции и Symbol; сохраняет null; экранирует ключи', () => {
    expect(stableSerialize({ a: 1, b: undefined, c: 3 })).toBe('{"a":1,"c":3}');
    expect(stableSerialize({ a: 1, b: () => undefined, c: 3 })).toBe('{"a":1,"c":3}');
    expect(stableSerialize({ a: 1, b: Symbol('x'), c: 3 })).toBe('{"a":1,"c":3}');
    expect(stableSerialize({ a: null })).toBe('{"a":null}');
    expect(stableSerialize({ 'a"b': 1 })).toBe('{"a\\"b":1}');
  });
});

describe('stableSerialize - массивы', () => {
  it('пустой, вложенный, порядок; undefined, функции и Symbol как null', () => {
    expect(stableSerialize([])).toBe('[]');
    expect(stableSerialize([3, 1, 2])).toBe('[3,1,2]');
    expect(stableSerialize([[1, 2], [3]])).toBe('[[1,2],[3]]');
    expect(stableSerialize([{ b: 1, a: 2 }])).toBe('[{"a":2,"b":1}]');

    expect(stableSerialize([1, undefined, 2])).toBe('[1,null,2]');
    expect(stableSerialize([1, () => undefined, 2])).toBe('[1,null,2]');
    expect(stableSerialize([1, Symbol('x'), 2])).toBe('[1,null,2]');
  });
});

describe('stableSerialize - toJSON', () => {
  it('вызывает toJSON, включая вложенный; возвращаемое значение сериализуется как обычно', () => {
    const date = new Date('2026-09-13T12:00:00.000Z');
    expect(stableSerialize(date)).toBe('"2026-09-13T12:00:00.000Z"');

    expect(stableSerialize({ toJSON: () => ({ b: 1, a: 2 }) })).toBe('{"a":2,"b":1}');
    expect(stableSerialize({ nested: { toJSON: () => [1, 2, 3] } })).toBe('{"nested":[1,2,3]}');

    expect(stableSerialize({ x: { toJSON: () => 42 } })).toBe('{"x":42}');
    expect(stableSerialize({ x: { toJSON: () => 'str' } })).toBe('{"x":"str"}');
    expect(stableSerialize({ x: { toJSON: () => null } })).toBe('{"x":null}');
    expect(stableSerialize({ x: { toJSON: () => [1, 2] } })).toBe('{"x":[1,2]}');
  });

  it('toJSON, вернувший несериализуемый тип, отклоняется; сообщение называет тип', () => {
    // Правило допустимых типов общее с prepareBody в транспорте.
    // Без повторной проверки после toJSON значение прошло бы через
    // рекурсию и превратилось в {}, дав одинаковый отпечаток
    // разным телам.
    const cases: Array<[string, unknown]> = [
      ['Map', { toJSON: () => new Map([['a', 1]]) }],
      ['Set', { toJSON: () => new Set([1]) }],
      ['Blob', { toJSON: () => new Blob(['x']) }],
      ['File', { toJSON: () => new File(['x'], 'x.txt') }],
      ['FormData', { toJSON: () => new FormData() }],
      ['ArrayBuffer', { toJSON: () => new ArrayBuffer(8) }],
      ['Uint8Array', { toJSON: () => new Uint8Array([1]) }],
      ['ReadableStream', { toJSON: () => new ReadableStream() }],
      ['URLSearchParams', { toJSON: () => new URLSearchParams({ a: '1' }) }],
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

    // Во вложенном значении работает так же.
    expect(() => stableSerialize({ nested: { toJSON: () => new Map() } })).toThrowError(
      expect.objectContaining({ code: 'BODY_SERIALIZATION_ERROR' }),
    );
  });
});

describe('stableSerialize - несериализуемые типы', () => {
  it.each([
    ['Map', new Map()],
    ['Set', new Set()],
    ['WeakMap', new WeakMap()],
    ['WeakSet', new WeakSet()],
    ['RegExp', /pattern/],
    ['Error', new Error('boom')],
    ['FormData', new FormData()],
    ['Blob', new Blob(['x'])],
    ['File', new File(['x'], 'x.txt')],
    ['ArrayBuffer', new ArrayBuffer(8)],
    ['TypedArray', new Uint8Array([1])],
    ['ReadableStream', new ReadableStream()],
    ['URLSearchParams', new URLSearchParams({ a: '1' })],
    ['NodeReadable', Readable.from(['x'])],
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
    ['File', new File(['x'], 'x.txt')],
    ['FormData', new FormData()],
    ['URLSearchParams', new URLSearchParams({ a: '1' })],
    ['ArrayBuffer', new ArrayBuffer(8)],
    ['TypedArray', new Uint8Array([1])],
    ['ReadableStream', new ReadableStream()],
    ['NodeReadable', Readable.from(['x'])],
  ])('%s во вложенном значении отклоняется', (_name, value) => {
    expect(() => stableSerialize({ nested: value })).toThrowError(
      expect.objectContaining({ code: 'BODY_SERIALIZATION_ERROR' }),
    );
    expect(() => stableSerialize([value])).toThrowError(
      expect.objectContaining({ code: 'BODY_SERIALIZATION_ERROR' }),
    );
  });

  it('сообщение называет конкретный тип; Node stream отклоняется до обхода _readableState', () => {
    const cases: Array<[unknown, RegExp]> = [
      [new File(['x'], 'x.txt'), /File/],
      [new Blob(['x']), /Blob/],
      [Readable.from(['x']), /NodeReadable/],
      [new Map(), /Map/],
    ];
    for (const [value, pattern] of cases) {
      try {
        stableSerialize(value);
        expect.fail('should have thrown');
      } catch (e) {
        const cause = (e as { cause?: unknown }).cause;
        expect(cause).toBeInstanceOf(TypeError);
        expect((cause as TypeError).message).toMatch(pattern);
      }
    }

    // Без явной проверки stableSerialize обошёл бы enumerable-свойства
    // _readableState, нашёл там циклические ссылки и упал с
    // 'Converting circular structure to JSON'.
    const readable = Readable.from(['hello', 'world']);
    expect(() => stableSerialize(readable)).toThrowError(
      expect.objectContaining({ code: 'BODY_SERIALIZATION_ERROR' }),
    );
  });
});

describe('stableSerialize - циклы и общие ссылки', () => {
  it('ошибка для циклов, включая cause; общие ссылки без цикла разрешены', () => {
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

    const a: { b?: unknown } = {};
    const b: { a?: unknown } = { a };
    a.b = b;
    expect(() => stableSerialize(a)).toThrowError(
      expect.objectContaining({ code: 'BODY_SERIALIZATION_ERROR' }),
    );

    const shared = { value: 1 };
    expect(stableSerialize({ a: shared, b: shared })).toBe('{"a":{"value":1},"b":{"value":1}}');
    expect(stableSerialize([shared, shared, shared])).toBe('[{"value":1},{"value":1},{"value":1}]');
  });
});

describe('stableSerialize - BigInt', () => {
  it('ошибка на верхнем уровне, в объекте и в массиве', () => {
    expect(() => stableSerialize(1n)).toThrowError(
      expect.objectContaining({
        kind: 'serialize',
        code: 'BODY_SERIALIZATION_ERROR',
      }),
    );
    expect(() => stableSerialize({ id: 1n })).toThrowError(
      expect.objectContaining({ code: 'BODY_SERIALIZATION_ERROR' }),
    );
    expect(() => stableSerialize([1n, 2n])).toThrowError(
      expect.objectContaining({ code: 'BODY_SERIALIZATION_ERROR' }),
    );
  });
});
