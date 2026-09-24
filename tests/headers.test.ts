// Тесты transport/headers.ts и transport/retry-after.ts.

import { describe, expect, it, vi } from 'vitest';

import { getHeader, mergeHeaders, setHeader } from '../src/transport/headers';
import { parseRetryAfterMs } from '../src/transport/retry-after';

describe('getHeader', () => {
  it('читает значение, игнорируя регистр имени', () => {
    const headers = { 'Content-Type': 'application/json' };
    expect(getHeader(headers, 'Content-Type')).toBe('application/json');
    expect(getHeader(headers, 'content-type')).toBe('application/json');
    expect(getHeader(headers, 'CONTENT-TYPE')).toBe('application/json');
    expect(getHeader(headers, 'CoNtEnT-TyPe')).toBe('application/json');
  });

  it('undefined при отсутствии заголовка или headers', () => {
    const headers = { 'Content-Type': 'application/json' };
    expect(getHeader(headers, 'X-Missing')).toBeUndefined();
    expect(getHeader(undefined, 'Content-Type')).toBeUndefined();
  });

  it('возвращает пустую строку и не читает унаследованные свойства', () => {
    expect(getHeader({ 'X-Empty': '' }, 'X-Empty')).toBe('');

    const proto = { 'Content-Type': 'application/json' };
    const headers = Object.create(proto) as Record<string, string>;
    expect(getHeader(headers, 'Content-Type')).toBeUndefined();
  });

  it('читает Headers и массив пар', () => {
    const h = new Headers();
    h.set('X-Trace-Id', 'trace-1');
    expect(getHeader(h, 'x-trace-id')).toBe('trace-1');
    expect(getHeader(h, 'X-Trace-Id')).toBe('trace-1');

    expect(
      getHeader(
        [
          ['X-A', '1'],
          ['X-B', '2'],
        ],
        'x-b',
      ),
    ).toBe('2');
  });
});

describe('setHeader', () => {
  it('устанавливает и перезаписывает заголовок, сохраняя регистр вызова', () => {
    const headers: Record<string, string> = {};
    setHeader(headers, 'Content-Type', 'application/json');
    expect(headers).toEqual({ 'Content-Type': 'application/json' });

    setHeader(headers, 'Content-Type', 'text/plain');
    expect(headers).toEqual({ 'Content-Type': 'text/plain' });

    const lowercase: Record<string, string> = {};
    setHeader(lowercase, 'content-type', 'application/json');
    expect(Object.keys(lowercase)).toEqual(['content-type']);
  });

  it('удаляет один или несколько дублей с другим регистром', () => {
    const headers: Record<string, string> = { 'content-type': 'text/plain' };
    setHeader(headers, 'Content-Type', 'application/json');
    expect(Object.keys(headers)).toEqual(['Content-Type']);
    expect(headers['Content-Type']).toBe('application/json');

    const multi = {
      'content-type': 'text/plain',
      'CONTENT-TYPE': 'text/html',
    };
    setHeader(multi, 'Content-Type', 'application/json');
    expect(Object.keys(multi)).toEqual(['Content-Type']);
  });
});

describe('mergeHeaders', () => {
  it('сливает источники, нормализуя регистр и перезаписывая', () => {
    const result = mergeHeaders(
      { Accept: 'application/json' },
      { 'content-type': 'text/plain' },
      { 'Content-Type': 'application/json' },
      { Authorization: 'Bearer x' },
    );

    expect(result).toEqual({
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: 'Bearer x',
    });
  });

  it('игнорирует undefined источники, undefined значения, пустой список', () => {
    expect(
      mergeHeaders({ Accept: 'application/json' }, undefined, {
        'Content-Type': 'application/json',
      }),
    ).toEqual({
      Accept: 'application/json',
      'Content-Type': 'application/json',
    });

    expect(
      mergeHeaders({
        Accept: 'application/json',
        'X-Skipped': undefined as unknown as string,
      }),
    ).toEqual({ Accept: 'application/json' });

    expect(mergeHeaders()).toEqual({});
  });

  it('не мутирует исходные объекты', () => {
    const source = { 'Content-Type': 'text/plain' };
    mergeHeaders(source, { 'Content-Type': 'application/json' });
    expect(source).toEqual({ 'Content-Type': 'text/plain' });
  });

  it('сливает Headers, Record и массив пар в одном вызове', () => {
    const h = new Headers();
    h.set('X-From-Headers', 'h');

    const result = mergeHeaders({ 'X-From-Record': 'r' }, h, [['X-From-Pairs', 'p']]);

    expect(result['X-From-Record']).toBe('r');
    expect(result['x-from-headers']).toBe('h');
    expect(result['X-From-Pairs']).toBe('p');
  });

  it('перезаписывает значение из Headers значением из следующего источника', () => {
    const h = new Headers();
    h.set('content-type', 'text/plain');

    const result = mergeHeaders(h, { 'Content-Type': 'application/json' });

    expect(result).toEqual({ 'Content-Type': 'application/json' });
  });
});

describe('parseRetryAfterMs', () => {
  it('возвращает undefined для null и пустой строки', () => {
    expect(parseRetryAfterMs(null)).toBeUndefined();
    expect(parseRetryAfterMs('')).toBeUndefined();
  });

  it('парсит числовой формат в секундах без изменений', () => {
    expect(parseRetryAfterMs('5')).toBe(5000);
    expect(parseRetryAfterMs('30')).toBe(30_000);
    expect(parseRetryAfterMs('0')).toBe(0);
  });

  it('парсит IMF-fixdate и возвращает 0 для даты в прошлом', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-09-13T12:00:00Z'));

      const future = new Date('2026-09-13T12:00:30Z').toUTCString();
      expect(parseRetryAfterMs(future)).toBe(30_000);

      const past = new Date('2026-09-13T11:00:00Z').toUTCString();
      expect(parseRetryAfterMs(past)).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    'not-a-date',
    'garbage',
    '1e3',
    '0x10',
    '+5',
    '-5',
    '1.5',
    ' 5 ',
    'GMT',
    '-5 GMT',
    '+5 GMT',
    'garbage GMT',
    'Wed, 21 Oct 2026 07:28:00 GMT extra',
    'Wed, 21 Oct 2026 07:28:00 UTC',
    'Xxx, 21 Oct 2026 07:28:00 GMT',
    'Wed, 21 Xxx 2026 07:28:00 GMT',
    'sun, 06 Nov 1994 08:49:37 GMT',
    'Sun, 06 nov 1994 08:49:37 GMT',
    'SUN, 06 NOV 1994 08:49:37 GMT',
  ])('отсекает не-IMF-fixdate значение: %s', (input) => {
    expect(parseRetryAfterMs(input)).toBeUndefined();
  });
});
