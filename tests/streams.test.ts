// Тесты shared/streams.ts: isReadableStreamBody, isNodeReadableBody,
// isStreamingBody.

import { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { isNodeReadableBody, isReadableStreamBody, isStreamingBody } from '../src/shared/streams';

describe('isReadableStreamBody', () => {
  it('true только для Web ReadableStream', () => {
    expect(isReadableStreamBody(new ReadableStream())).toBe(true);
    expect(isReadableStreamBody(Readable.from(['x']))).toBe(false);
    expect(isReadableStreamBody({})).toBe(false);
    expect(isReadableStreamBody(null)).toBe(false);
    expect(isReadableStreamBody(undefined)).toBe(false);
  });
});

describe('isNodeReadableBody', () => {
  it('true для Node.js stream.Readable', () => {
    expect(isNodeReadableBody(Readable.from(['x']))).toBe(true);
    expect(isNodeReadableBody(Readable.from([]))).toBe(true);
  });

  it('false для Web ReadableStream', () => {
    // У Web ReadableStream нет pipe, а есть pipeTo/pipeThrough.
    expect(isNodeReadableBody(new ReadableStream())).toBe(false);
  });

  it('false для обычных объектов и примитивов', () => {
    expect(isNodeReadableBody({})).toBe(false);
    expect(isNodeReadableBody(null)).toBe(false);
    expect(isNodeReadableBody(undefined)).toBe(false);
    expect(isNodeReadableBody('string')).toBe(false);
    expect(isNodeReadableBody(42)).toBe(false);
  });

  it('false для duck-typed объекта без Symbol.asyncIterator', () => {
    expect(
      isNodeReadableBody({
        pipe: () => {},
        on: () => {},
      }),
    ).toBe(false);
  });

  it('true для duck-typed объекта с pipe, on и Symbol.asyncIterator', () => {
    // Cross-realm Node.js stream.Readable: проверка через duck-typing,
    // а не instanceof.
    const fake = {
      pipe: () => {},
      on: () => {},
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.resolve({ done: true, value: undefined }),
      }),
    };
    expect(isNodeReadableBody(fake)).toBe(true);
  });
});

describe('isStreamingBody', () => {
  it('true для Web ReadableStream и Node.js stream.Readable', () => {
    expect(isStreamingBody(new ReadableStream())).toBe(true);
    expect(isStreamingBody(Readable.from(['x']))).toBe(true);
  });

  it('false для не-потоковых тел', () => {
    expect(isStreamingBody('string')).toBe(false);
    expect(isStreamingBody({})).toBe(false);
    expect(isStreamingBody(new Uint8Array([1]))).toBe(false);
    expect(isStreamingBody(new Blob(['x']))).toBe(false);
    expect(isStreamingBody(null)).toBe(false);
    expect(isStreamingBody(undefined)).toBe(false);
  });
});
