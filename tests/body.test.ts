// Тесты transport/body.ts: prepareBody, parseResponse,
// readBodyAsJsonOrText.

import { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { type ApiError } from '../src/core/errors';
import { parseResponse, prepareBody, readBodyAsJsonOrText } from '../src/transport/body';

describe('prepareBody', () => {
  it.each([
    [undefined, { body: undefined, contentType: undefined }],
    [null, { body: undefined, contentType: undefined }],
    ['hello', { body: 'hello', contentType: undefined }],
    ['', { body: '', contentType: undefined }],
    [
      { name: 'Alice', age: 30 },
      { body: '{"name":"Alice","age":30}', contentType: 'application/json' },
    ],
    [[1, 2, 3], { body: '[1,2,3]', contentType: 'application/json' }],
    [42, { body: '42', contentType: 'application/json' }],
    [true, { body: 'true', contentType: 'application/json' }],
  ])('%o -> тело и Content-Type', (value, expected) => {
    expect(prepareBody(value)).toEqual(expected);
  });

  it('JSON: Date через toJSON, NaN и Infinity как null, undefined пропускается', () => {
    expect(prepareBody({ date: new Date('2026-09-13T12:00:00.000Z') }).body).toBe(
      '{"date":"2026-09-13T12:00:00.000Z"}',
    );
    expect(prepareBody({ a: NaN, b: Infinity }).body).toBe('{"a":null,"b":null}');
    expect(prepareBody({ a: 1, b: undefined }).body).toBe('{"a":1}');
    expect(prepareBody([1, undefined, 2]).body).toBe('[1,null,2]');
  });

  it('FormData, Blob и File уходят как есть', () => {
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

    // File распознаётся отдельной категорией, но обрабатывается
    // как Blob: тело уходит как есть, Content-Type берётся из type.
    const typedFile = new File(['content'], 'avatar.png', { type: 'image/png' });
    expect(prepareBody(typedFile)).toEqual({
      body: typedFile,
      contentType: 'image/png',
    });

    const untypedFile = new File(['content'], 'unknown.bin');
    expect(prepareBody(untypedFile)).toEqual({
      body: untypedFile,
      contentType: 'application/octet-stream',
    });
  });

  it('ArrayBuffer, TypedArray, DataView: application/octet-stream', () => {
    expect(prepareBody(new ArrayBuffer(8))).toEqual({
      body: expect.any(ArrayBuffer),
      contentType: 'application/octet-stream',
    });
    expect(prepareBody(new Uint8Array([1, 2, 3]))).toEqual({
      body: expect.any(Uint8Array),
      contentType: 'application/octet-stream',
    });
    expect(prepareBody(new DataView(new ArrayBuffer(8)))).toEqual({
      body: expect.any(DataView),
      contentType: 'application/octet-stream',
    });
  });

  it('Web ReadableStream и Node.js stream.Readable: без Content-Type', () => {
    const webStream = new ReadableStream();
    expect(prepareBody(webStream)).toEqual({ body: webStream, contentType: undefined });

    const nodeStream = Readable.from(['hello', 'world']);
    const result = prepareBody(nodeStream);
    expect(result.body).toBe(nodeStream);
    expect(result.contentType).toBeUndefined();
  });

  it('URLSearchParams: application/x-www-form-urlencoded', () => {
    const params = new URLSearchParams({ a: '1', b: '2' });
    expect(prepareBody(params)).toEqual({
      body: params,
      contentType: 'application/x-www-form-urlencoded;charset=UTF-8',
    });
  });

  it('BigInt и циклы: BODY_SERIALIZATION_ERROR с TypeError в cause', () => {
    for (const value of [
      { id: 1n },
      (() => {
        const o: Record<string, unknown> = {};
        o.self = o;
        return o;
      })(),
    ]) {
      try {
        prepareBody(value);
        expect.fail('should have thrown');
      } catch (e) {
        const err = e as ApiError;
        expect(err).toMatchObject({
          kind: 'serialize',
          code: 'BODY_SERIALIZATION_ERROR',
        });
        expect(err.cause).toBeInstanceOf(TypeError);
      }
    }
  });

  it.each([
    ['Map', new Map([['a', 1]])],
    ['Set', new Set([1, 2])],
    ['WeakMap', new WeakMap()],
    ['WeakSet', new WeakSet()],
    ['RegExp', /pattern/],
    ['Error', new Error('boom')],
  ])('%s на верхнем уровне: BODY_SERIALIZATION_ERROR с именем типа', (_name, value) => {
    try {
      prepareBody(value);
      expect.fail('should have thrown');
    } catch (e) {
      const err = e as ApiError;
      expect(err.kind).toBe('serialize');
      expect(err.code).toBe('BODY_SERIALIZATION_ERROR');
      expect(err.message).toMatch(new RegExp(_name));
      expect(err.message).toMatch(/plain object/);
    }
  });

  it('несериализуемый тип во вложенном значении отклоняется', () => {
    // Map/Set/RegExp/Error не проходят на верхнем уровне,
    // но и внутри JSON они дали бы {} вместо данных.
    expect(() => prepareBody({ nested: new Map() })).toThrowError(
      expect.objectContaining({ code: 'BODY_SERIALIZATION_ERROR' }),
    );
    expect(() => prepareBody([new Set()])).toThrowError(
      expect.objectContaining({ code: 'BODY_SERIALIZATION_ERROR' }),
    );
  });

  it.each([
    ['Blob', new Blob(['x'])],
    ['File', new File(['x'], 'x.txt')],
    ['FormData', new FormData()],
    ['URLSearchParams', new URLSearchParams({ a: '1' })],
    ['ArrayBuffer', new ArrayBuffer(8)],
    ['TypedArray', new Uint8Array([1])],
    ['ReadableStream', new ReadableStream()],
  ])('%s во вложенном значении отклоняется до отправки', (_name, value) => {
    // Без этой проверки JSON.stringify превратил бы вложенный Blob
    // в {}, и сервер получил бы пустой объект вместо данных.
    expect(() => prepareBody({ payload: value })).toThrowError(
      expect.objectContaining({ code: 'BODY_SERIALIZATION_ERROR' }),
    );
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
