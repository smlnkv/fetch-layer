// Тесты layers/idempotency/serialize.ts: stableSerialize.

import { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { stableSerialize } from '../src/index';

describe('stableSerialize - примитивы', () => {
  it('сериализует примитивы', () => {
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
  });

  it('NaN, Infinity, undefined, функции и Symbol сериализуются как null', () => {
    expect(stableSerialize(NaN)).toBe('null');
    expect(stableSerialize(Infinity)).toBe('null');
    expect(stableSerialize(-Infinity)).toBe('null');
    expect(stableSerialize(undefined)).toBe('null');
    expect(stableSerialize(() => undefined)).toBe('null');
    expect(stableSerialize(Symbol('x'))).toBe('null');
  });
});

describe('stableSerialize - объекты', () => {
  it('сортирует ключи в алфавитном порядке, включая вложенные', () => {
    expect(stableSerialize({})).toBe('{}');
    expect(stableSerialize({ c: 3, a: 1, b: 2 })).toBe('{"a":1,"b":2,"c":3}');
    expect(stableSerialize({ b: 1, a: 2 })).toBe(stableSerialize({ a: 2, b: 1 }));
    expect(stableSerialize({ z: { c: 1, a: 2 }, a: { y: 3, x: 4 } })).toBe(
      '{"a":{"x":4,"y":3},"z":{"a":2,"c":1}}',
    );
  });

  it('пропускает undefined, функции и Symbol', () => {
    expect(stableSerialize({ a: 1, b: undefined, c: 3 })).toBe('{"a":1,"c":3}');
    expect(stableSerialize({ a: 1, b: () => undefined, c: 3 })).toBe('{"a":1,"c":3}');
    expect(stableSerialize({ a: 1, b: Symbol('x'), c: 3 })).toBe('{"a":1,"c":3}');
  });

  it('сохраняет null как значение и экранирует ключи', () => {
    expect(stableSerialize({ a: null })).toBe('{"a":null}');
    expect(stableSerialize({ 'a"b': 1 })).toBe('{"a\\"b":1}');
  });
});

describe('stableSerialize - массивы', () => {
  it('сериализует пустой, вложенный массив и сохраняет порядок', () => {
    expect(stableSerialize([])).toBe('[]');
    expect(stableSerialize([3, 1, 2])).toBe('[3,1,2]');
    expect(stableSerialize([[1, 2], [3]])).toBe('[[1,2],[3]]');
    expect(stableSerialize([{ b: 1, a: 2 }])).toBe('[{"a":2,"b":1}]');
  });

  it('преобразует undefined, функции и Symbol в null', () => {
    expect(stableSerialize([1, undefined, 2])).toBe('[1,null,2]');
    expect(stableSerialize([1, () => undefined, 2])).toBe('[1,null,2]');
    expect(stableSerialize([1, Symbol('x'), 2])).toBe('[1,null,2]');
  });
});

describe('stableSerialize - toJSON', () => {
  it('вызывает toJSON, в том числе вложенный', () => {
    const date = new Date('2026-09-13T12:00:00.000Z');
    expect(stableSerialize(date)).toBe('"2026-09-13T12:00:00.000Z"');

    expect(stableSerialize({ toJSON: () => ({ b: 1, a: 2 }) })).toBe('{"a":2,"b":1}');

    expect(stableSerialize({ nested: { toJSON: () => [1, 2, 3] } })).toBe('{"nested":[1,2,3]}');
  });

  it('toJSON может вернуть примитив, массив или объект', () => {
    expect(stableSerialize({ x: { toJSON: () => 42 } })).toBe('{"x":42}');
    expect(stableSerialize({ x: { toJSON: () => 'str' } })).toBe('{"x":"str"}');
    expect(stableSerialize({ x: { toJSON: () => null } })).toBe('{"x":null}');
    expect(stableSerialize({ x: { toJSON: () => [1, 2] } })).toBe('{"x":[1,2]}');
    expect(stableSerialize({ x: { toJSON: () => ({ b: 1, a: 2 }) } })).toBe('{"x":{"a":2,"b":1}}');
  });

  it.each([
    ['Map', { toJSON: () => new Map([['a', 1]]) }],
    ['Set', { toJSON: () => new Set([1]) }],
    ['Blob', { toJSON: () => new Blob(['x']) }],
    ['File', { toJSON: () => new File(['x'], 'x.txt') }],
    ['FormData', { toJSON: () => new FormData() }],
    ['ArrayBuffer', { toJSON: () => new ArrayBuffer(8) }],
    ['TypedArray', { toJSON: () => new Uint8Array([1]) }],
    ['ReadableStream', { toJSON: () => new ReadableStream() }],
    ['URLSearchParams', { toJSON: () => new URLSearchParams({ a: '1' }) }],
  ])('toJSON, вернувший %s, отклоняется', (_name, value) => {
    // Правило допустимых типов общее с prepareBody в транспорте.
    // Без повторной проверки после toJSON значение прошло бы через
    // рекурсию и превратилось в {}, дав одинаковый отпечаток
    // разным телам.
    expect(() => stableSerialize(value)).toThrowError(
      expect.objectContaining({
        kind: 'serialize',
        code: 'BODY_SERIALIZATION_ERROR',
      }),
    );
    expect(() => stableSerialize({ nested: value })).toThrowError(
      expect.objectContaining({ code: 'BODY_SERIALIZATION_ERROR' }),
    );
  });

  it('сообщение об ошибке называет тип, возвращённый toJSON', () => {
    try {
      stableSerialize({ toJSON: () => new Map() });
      expect.fail('should have thrown');
    } catch (e) {
      expect((e as { cause?: unknown }).cause).toBeInstanceOf(TypeError);
      expect((e as { cause: TypeError }).cause.message).toMatch(/Map/);
      expect((e as { cause: TypeError }).cause.message).toMatch(/toJSON/);
    }
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
  ])('%s отклоняется на верхнем уровне', (_name, value) => {
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
  ])('%s отклоняется во вложенном значении', (_name, value) => {
    expect(() => stableSerialize({ nested: value })).toThrowError(
      expect.objectContaining({ code: 'BODY_SERIALIZATION_ERROR' }),
    );
    expect(() => stableSerialize([value])).toThrowError(
      expect.objectContaining({ code: 'BODY_SERIALIZATION_ERROR' }),
    );
  });

  it('сообщение об ошибке называет конкретный тип', () => {
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
        expect((e as { cause?: unknown }).cause).toBeInstanceOf(TypeError);
        expect((e as { cause: TypeError }).cause.message).toMatch(pattern);
      }
    }
  });

  it('Node.js stream отклоняется до обхода _readableState', () => {
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
  it('ошибка для циклов, включая cause', () => {
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
  });

  it('разрешает общие ссылки без цикла', () => {
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
