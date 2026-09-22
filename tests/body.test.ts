// Тесты transport/body.ts: prepareBody, parseResponse,
// readBodyAsJsonOrText, isNodeReadableBody, isReadableStreamBody.

import { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { type ApiError } from '../src/core/errors';
import {
  isNodeReadableBody,
  isReadableStreamBody,
  parseResponse,
  prepareBody,
  readBodyAsJsonOrText,
} from '../src/transport/body';

describe('prepareBody', () => {
  it('пустое тело: undefined и null', () => {
    expect(prepareBody(undefined)).toEqual({
      body: undefined,
      contentType: undefined,
    });
    expect(prepareBody(null)).toEqual({
      body: undefined,
      contentType: undefined,
    });
  });

  it('JSON: объект, массив, число, boolean, Date', () => {
    expect(prepareBody({ name: 'Alice', age: 30 })).toEqual({
      body: '{"name":"Alice","age":30}',
      contentType: 'application/json',
    });
    expect(prepareBody([1, 2, 3])).toEqual({
      body: '[1,2,3]',
      contentType: 'application/json',
    });
    expect(prepareBody(42)).toEqual({
      body: '42',
      contentType: 'application/json',
    });
    expect(prepareBody(true)).toEqual({
      body: 'true',
      contentType: 'application/json',
    });
    expect(prepareBody({ date: new Date('2026-09-13T12:00:00.000Z') }).body).toBe(
      '{"date":"2026-09-13T12:00:00.000Z"}',
    );

    // Поведение как у JSON.stringify: NaN и Infinity - null,
    // undefined в объекте пропускается, undefined в массиве - null.
    expect(prepareBody({ a: NaN, b: Infinity })).toEqual({
      body: '{"a":null,"b":null}',
      contentType: 'application/json',
    });
    expect(prepareBody({ a: 1, b: undefined })).toEqual({
      body: '{"a":1}',
      contentType: 'application/json',
    });
    expect(prepareBody([1, undefined, 2])).toEqual({
      body: '[1,null,2]',
      contentType: 'application/json',
    });
  });

  it('строка уходит как есть без Content-Type', () => {
    expect(prepareBody('hello')).toEqual({ body: 'hello', contentType: undefined });
    expect(prepareBody('')).toEqual({ body: '', contentType: undefined });
    expect(prepareBody('{"a":1}')).toEqual({ body: '{"a":1}', contentType: undefined });
  });

  it('FormData и Blob', () => {
    const formData = new FormData();
    formData.append('name', 'Alice');
    expect(prepareBody(formData)).toEqual({ body: formData, contentType: undefined });

    const typedBlob = new Blob(['content'], { type: 'text/plain' });
    expect(prepareBody(typedBlob)).toEqual({
      body: typedBlob,
      contentType: 'text/plain',
    });

    const untypedBlob = new Blob(['content']);
    expect(prepareBody(untypedBlob)).toEqual({
      body: untypedBlob,
      contentType: 'application/octet-stream',
    });
  });

  it('ArrayBuffer, TypedArray, DataView', () => {
    const buffer = new ArrayBuffer(8);
    expect(prepareBody(buffer)).toEqual({
      body: buffer,
      contentType: 'application/octet-stream',
    });

    const u8 = new Uint8Array([1, 2, 3]);
    expect(prepareBody(u8)).toEqual({
      body: u8,
      contentType: 'application/octet-stream',
    });

    const view = new DataView(new ArrayBuffer(8));
    expect(prepareBody(view)).toEqual({
      body: view,
      contentType: 'application/octet-stream',
    });
  });

  it('Web ReadableStream: без Content-Type по умолчанию', () => {
    const stream = new ReadableStream();
    expect(prepareBody(stream)).toEqual({
      body: stream,
      contentType: undefined,
    });
  });

  it('Node.js stream.Readable: без Content-Type, body как async iterable', () => {
    const readable = Readable.from(['hello', 'world']);
    const result = prepareBody(readable);
    expect(result.body).toBe(readable);
    expect(result.contentType).toBeUndefined();
  });

  it('URLSearchParams', () => {
    const params = new URLSearchParams({ a: '1', b: '2' });
    expect(prepareBody(params)).toEqual({
      body: params,
      contentType: 'application/x-www-form-urlencoded;charset=UTF-8',
    });
  });

  it('распознаёт FormData и Blob через duck-typing', () => {
    const fakeFormData = {
      [Symbol.toStringTag]: 'FormData',
    };
    Object.setPrototypeOf(fakeFormData, FormData.prototype);
    expect(prepareBody(fakeFormData).contentType).toBeUndefined();

    const blob = new Blob(['x'], { type: 'text/plain' });
    Object.defineProperty(blob, Symbol.toStringTag, { value: 'Blob' });
    expect(prepareBody(blob).contentType).toBe('text/plain');
  });

  it('ошибки сериализации: BigInt и циклы', () => {
    expect(() => prepareBody({ id: 1n })).toThrowError(
      expect.objectContaining({
        name: 'ApiError',
        kind: 'serialize',
        code: 'BODY_SERIALIZATION_ERROR',
      }),
    );

    const obj: Record<string, unknown> = { name: 'loop' };
    obj.self = obj;
    expect(() => prepareBody(obj)).toThrowError(
      expect.objectContaining({
        kind: 'serialize',
        code: 'BODY_SERIALIZATION_ERROR',
      }),
    );

    try {
      prepareBody({ id: 1n });
      expect.fail('should have thrown');
    } catch (e) {
      expect((e as ApiError).cause).toBeInstanceOf(TypeError);
    }
  });
});

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

describe('parseResponse', () => {
  it('json: объект, массив, пустое тело, невалидный JSON', async () => {
    const objResponse = new Response(JSON.stringify({ id: '1' }), {
      headers: { 'content-type': 'application/json' },
    });
    expect(await parseResponse(objResponse, 'json')).toEqual({ id: '1' });

    const arrResponse = new Response(JSON.stringify([1, 2, 3]), {
      headers: { 'content-type': 'application/json' },
    });
    expect(await parseResponse(arrResponse, 'json')).toEqual([1, 2, 3]);

    // Пустое тело - валидное отсутствие данных: DELETE 200 OK
    // с Content-Length: 0 не должен давать PARSE_ERROR.
    const empty = new Response('', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    expect(await parseResponse(empty, 'json')).toBeUndefined();

    const invalid = new Response('not json', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

    try {
      await parseResponse(invalid, 'json');
      expect.fail('should have thrown');
    } catch (e) {
      const err = e as ApiError;
      expect(err).toMatchObject({
        kind: 'parse',
        code: 'PARSE_ERROR',
        status: 200,
      });
      // Ответ 200 OK получен полностью: состояние операции на сервере
      // известно, повтор безопасен.
      expect(err.isUncertain).toBe(false);
    }
  });

  it('text, blob, arrayBuffer, stream', async () => {
    expect(await parseResponse(new Response('hello world'), 'text')).toBe('hello world');

    const blobResult = await parseResponse(new Response('binary content'), 'blob');
    expect(blobResult).toBeInstanceOf(Blob);
    expect(await (blobResult as Blob).text()).toBe('binary content');

    expect(await parseResponse(new Response('content'), 'arrayBuffer')).toBeInstanceOf(ArrayBuffer);

    expect(await parseResponse(new Response('content'), 'stream')).toBeInstanceOf(ReadableStream);
    expect(await parseResponse(new Response(null), 'stream')).toBeNull();
  });
});

describe('readBodyAsJsonOrText', () => {
  it('валидный JSON, не-JSON, пустое тело', async () => {
    expect(await readBodyAsJsonOrText(new Response(JSON.stringify({ code: 'X' })))).toEqual({
      code: 'X',
    });
    expect(await readBodyAsJsonOrText(new Response(JSON.stringify([{ code: 'X' }])))).toEqual([
      { code: 'X' },
    ]);
    expect(await readBodyAsJsonOrText(new Response('<html>Error</html>'))).toBe(
      '<html>Error</html>',
    );
    expect(await readBodyAsJsonOrText(new Response(''))).toBeNull();
  });
});
