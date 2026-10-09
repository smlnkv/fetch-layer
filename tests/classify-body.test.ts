// Тесты shared/classify-body.ts.

import { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import {
  classifyBody,
  getTypeName,
  isSerializableKind,
  isUnsupportedKind,
  type BodyKind,
} from '../src/shared/classify-body';

describe('classifyBody', () => {
  it.each([
    [undefined, 'undefined'],
    [null, 'undefined'],
    ['hello', 'string'],
    ['', 'string'],
    [{ a: 1 }, 'json'],
    [[1, 2, 3], 'json'],
    [42, 'json'],
    [true, 'json'],
    [new FormData(), 'form-data'],
    [new Blob(['x']), 'blob'],
    [new File(['x'], 'x.txt'), 'blob'],
    [new ArrayBuffer(8), 'binary'],
    [new Uint8Array([1]), 'binary'],
    [new DataView(new ArrayBuffer(8)), 'binary'],
    [new ReadableStream(), 'stream'],
    [Readable.from(['x']), 'stream'],
    [new URLSearchParams({ a: '1' }), 'url-search-params'],
    [new Map(), 'unsupported'],
    [new Set(), 'unsupported'],
    [new WeakMap(), 'unsupported'],
    [new WeakSet(), 'unsupported'],
    [/x/, 'unsupported'],
    [new Error('x'), 'unsupported'],
  ])('%o -> %s', (value, expected) => {
    expect(classifyBody(value)).toBe(expected);
  });

  it('File и Blob попадают в одну категорию', () => {
    expect(classifyBody(new File(['x'], 'x.txt'))).toBe('blob');
    expect(classifyBody(new Blob(['x']))).toBe('blob');
  });

  it('Node.js stream.Readable распознаётся через duck-typing', () => {
    expect(classifyBody(Readable.from(['x']))).toBe('stream');
    expect(classifyBody(new ReadableStream())).toBe('stream');
  });
});

describe('getTypeName', () => {
  it.each([
    [new Blob(['x']), 'Blob'],
    [new File(['x'], 'x.txt'), 'File'],
    [new Map(), 'Map'],
    [new Set(), 'Set'],
    [new WeakMap(), 'WeakMap'],
    [new WeakSet(), 'WeakSet'],
    [/x/, 'RegExp'],
    [new Error('x'), 'Error'],
    [new Uint8Array([1]), 'Uint8Array'],
    [new ArrayBuffer(8), 'ArrayBuffer'],
    [new FormData(), 'FormData'],
    [new URLSearchParams({ a: '1' }), 'URLSearchParams'],
    [new ReadableStream(), 'ReadableStream'],
  ])('возвращает человекочитаемое имя для %o', (value, expected) => {
    expect(getTypeName(value)).toBe(expected);
  });

  it('Node.js stream.Readable даёт NodeReadable', () => {
    expect(getTypeName(Readable.from(['x']))).toBe('NodeReadable');
  });
});

describe('isSerializableKind', () => {
  it.each(['undefined', 'json', 'string'] as BodyKind[])('true для %s', (kind) => {
    expect(isSerializableKind(kind)).toBe(true);
  });

  it.each([
    'form-data',
    'blob',
    'binary',
    'stream',
    'url-search-params',
    'unsupported',
  ] as BodyKind[])('false для %s', (kind) => {
    expect(isSerializableKind(kind)).toBe(false);
  });
});

describe('isUnsupportedKind', () => {
  it('true только для unsupported', () => {
    expect(isUnsupportedKind('unsupported')).toBe(true);
  });

  it.each([
    'undefined',
    'json',
    'string',
    'form-data',
    'blob',
    'binary',
    'stream',
    'url-search-params',
  ] as BodyKind[])('false для %s', (kind) => {
    expect(isUnsupportedKind(kind)).toBe(false);
  });
});
