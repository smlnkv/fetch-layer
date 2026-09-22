// Тесты layers/idempotency/serialize.ts: stableSerialize,
// isSerializableBody.

import { describe, expect, it } from 'vitest';

import { stableSerialize } from '../src/index';
import { isSerializableBody } from '../src/layers/idempotency/serialize';

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
});

describe('stableSerialize - Map и Set', () => {
  it('Map и Set сериализуются как {} на любом уровне вложенности', () => {
    // Ограничение stableSerialize: у Map и Set нет перечисляемых свойств.
    // Разные Map с одинаковым размером дают одинаковый отпечаток.
    const map1 = new Map([
      ['a', 1],
      ['b', 2],
    ]);
    const map2 = new Map([
      ['c', 3],
      ['d', 4],
    ]);
    expect(stableSerialize(map1)).toBe('{}');
    expect(stableSerialize(map2)).toBe('{}');
    expect(stableSerialize(map1)).toBe(stableSerialize(map2));

    // Ограничение действует и внутри объектов.
    const body1 = { tags: new Set(['a', 'b']) };
    const body2 = { tags: new Set(['c', 'd']) };
    expect(stableSerialize(body1)).toBe(stableSerialize(body2));

    // Рекомендованная альтернатива - массив.
    const body3 = { tags: ['a', 'b'] };
    const body4 = { tags: ['c', 'd'] };
    expect(stableSerialize(body3)).not.toBe(stableSerialize(body4));
  });
});

describe('stableSerialize - циклы и общие ссылки', () => {
  it('ошибка ApiError для циклов, включая cause', () => {
    const shallow: { name: string; self?: unknown } = { name: 'loop' };
    shallow.self = shallow;

    expect(() => stableSerialize(shallow)).toThrowError(
      expect.objectContaining({
        name: 'ApiError',
        kind: 'serialize',
        code: 'BODY_SERIALIZATION_ERROR',
      }),
    );

    const a: { b?: unknown } = {};
    const b: { a?: unknown } = { a };
    a.b = b;
    expect(() => stableSerialize(a)).toThrowError(
      expect.objectContaining({ code: 'BODY_SERIALIZATION_ERROR' }),
    );

    try {
      stableSerialize(shallow);
      expect.fail('should have thrown');
    } catch (e) {
      expect((e as { cause?: unknown }).cause).toBeInstanceOf(TypeError);
    }
  });

  it('разрешает общие ссылки без цикла', () => {
    const shared = { value: 1 };
    expect(stableSerialize({ a: shared, b: shared })).toBe('{"a":{"value":1},"b":{"value":1}}');
    expect(stableSerialize([shared, shared, shared])).toBe('[{"value":1},{"value":1},{"value":1}]');
  });
});

describe('stableSerialize - BigInt', () => {
  it('ошибка ApiError на верхнем уровне, в объекте и в массиве', () => {
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

describe('isSerializableBody', () => {
  it('true для примитивов и plain-объектов', () => {
    expect(isSerializableBody('string')).toBe(true);
    expect(isSerializableBody(42)).toBe(true);
    expect(isSerializableBody(null)).toBe(true);
    expect(isSerializableBody(undefined)).toBe(true);
    expect(isSerializableBody({ a: 1 })).toBe(true);
    expect(isSerializableBody([1, 2, 3])).toBe(true);
  });

  it('false для бинарных типов и потоков', () => {
    const fd = new FormData();
    fd.append('key', 'value');
    expect(isSerializableBody(fd)).toBe(false);
    expect(isSerializableBody(new Blob(['x']))).toBe(false);
    expect(isSerializableBody(new ArrayBuffer(8))).toBe(false);
    expect(isSerializableBody(new Uint8Array([1, 2]))).toBe(false);
    expect(isSerializableBody(new Int32Array([1, 2]))).toBe(false);
    expect(isSerializableBody(new ReadableStream())).toBe(false);
    expect(isSerializableBody(new URLSearchParams({ a: '1' }))).toBe(false);
  });
});

describe('stableSerialize - практика', () => {
  it('даёт одинаковый отпечаток для эквивалентных тел', () => {
    const body1 = { items: ['a', 'b'], total: 100, customer: { id: '1', name: 'Alice' } };
    const body2 = { customer: { name: 'Alice', id: '1' }, total: 100, items: ['a', 'b'] };

    expect(stableSerialize(body1)).toBe(stableSerialize(body2));
  });

  it('даёт разный отпечаток для разных тел и типов', () => {
    expect(stableSerialize({ total: 100 })).not.toBe(stableSerialize({ total: 200 }));
    expect(stableSerialize({ a: 1 })).not.toBe(stableSerialize({ a: '1' }));
  });
});
