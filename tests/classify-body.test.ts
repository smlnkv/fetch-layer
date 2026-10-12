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
    [null, 'undefined'],
    ['hello', 'string'],
    [{ a: 1 }, 'json'],
    [new FormData(), 'form-data'],
    [new Blob(['x']), 'blob'],
    [new File(['x'], 'x.txt'), 'blob'],
    [new Uint8Array([1]), 'binary'],
    [new ReadableStream(), 'stream'],
    [Readable.from(['x']), 'stream'],
    [new URLSearchParams({ a: '1' }), 'url-search-params'],
    [new Map(), 'unsupported'],
  ])('%o -> %s', (value, expected) => {
    expect(classifyBody(value)).toBe(expected);
  });
});

describe('getTypeName', () => {
  it.each([
    [new Blob(['x']), 'Blob'],
    [new Map(), 'Map'],
    [new ArrayBuffer(8), 'ArrayBuffer'],
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

  it.each(['form-data', 'blob', 'unsupported'] as BodyKind[])('false для %s', (kind) => {
    expect(isSerializableKind(kind)).toBe(false);
  });
});

describe('isUnsupportedKind', () => {
  it('true только для unsupported', () => {
    expect(isUnsupportedKind('unsupported')).toBe(true);
  });

  it.each(['undefined', 'json', 'binary'] as BodyKind[])('false для %s', (kind) => {
    expect(isUnsupportedKind(kind)).toBe(false);
  });
});
