// Тесты shared/classify-body.ts.

import { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import {
  classifyBody,
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
    [new File(['x'], 'x.txt'), 'file'],
    [new ArrayBuffer(8), 'array-buffer'],
    [new Uint8Array([1]), 'typed-array'],
    [new DataView(new ArrayBuffer(8)), 'typed-array'],
    [new ReadableStream(), 'readable-stream'],
    [Readable.from(['x']), 'node-readable'],
    [new URLSearchParams({ a: '1' }), 'url-search-params'],
    [new Map(), 'map'],
    [new Set(), 'set'],
    [new WeakMap(), 'weak-map'],
    [new WeakSet(), 'weak-set'],
    [/x/, 'regexp'],
    [new Error('x'), 'error'],
  ])('%o -> %s', (value, expected) => {
    expect(classifyBody(value)).toBe(expected);
  });

  it('File отдельная категория, не blob', () => {
    // File наследуется от Blob и имеет собственный Symbol.toStringTag.
    // Обе категории обрабатываются одинаково, но сообщение об ошибке
    // должно называть File, а не Blob.
    expect(classifyBody(new File(['x'], 'x.txt'))).toBe('file');
    expect(classifyBody(new Blob(['x']))).toBe('blob');
  });

  it('Node.js stream.Readable распознаётся через duck-typing', () => {
    expect(classifyBody(Readable.from(['x']))).toBe('node-readable');
    expect(classifyBody(new ReadableStream())).toBe('readable-stream');
  });
});

describe('isSerializableKind', () => {
  const serializable: BodyKind[] = ['undefined', 'json', 'string'];

  it.each(serializable)('true для %s', (kind) => {
    expect(isSerializableKind(kind)).toBe(true);
  });

  it.each([
    'form-data',
    'blob',
    'file',
    'array-buffer',
    'typed-array',
    'readable-stream',
    'node-readable',
    'url-search-params',
    'map',
    'set',
    'weak-map',
    'weak-set',
    'regexp',
    'error',
  ] as BodyKind[])('false для %s', (kind) => {
    expect(isSerializableKind(kind)).toBe(false);
  });
});

describe('isUnsupportedKind', () => {
  it.each(['map', 'set', 'weak-map', 'weak-set', 'regexp', 'error'] as BodyKind[])(
    'true для %s',
    (kind) => {
      expect(isUnsupportedKind(kind)).toBe(true);
    },
  );

  it.each([
    'undefined',
    'json',
    'string',
    'form-data',
    'blob',
    'file',
    'array-buffer',
    'typed-array',
    'readable-stream',
    'node-readable',
    'url-search-params',
  ] as BodyKind[])('false для %s', (kind) => {
    expect(isUnsupportedKind(kind)).toBe(false);
  });
});
