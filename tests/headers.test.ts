// Тесты transport/headers.ts и transport/retry-after.ts.

import { describe, expect, it, vi } from 'vitest';

import { getHeader, mergeHeaders, setHeader } from '../src/transport/headers';
import { parseRetryAfterMs } from '../src/transport/retry-after';

describe('getHeader', () => {
  it('читает значение, игнорируя регистр; пустая строка - не undefined; унаследованные не читает', () => {
    const headers = { 'Content-Type': 'application/json' };
    expect(getHeader(headers, 'content-type')).toBe('application/json');
    expect(getHeader(headers, 'X-Missing')).toBeUndefined();
    expect(getHeader(undefined, 'Content-Type')).toBeUndefined();
    expect(getHeader({ 'X-Empty': '' }, 'X-Empty')).toBe('');

    const proto = { 'Content-Type': 'application/json' };
    const inherited = Object.create(proto) as Record<string, string>;
    expect(getHeader(inherited, 'Content-Type')).toBeUndefined();
  });

  it('читает Headers и массив пар', () => {
    const h = new Headers();
    h.set('X-Trace-Id', 'trace-1');
    expect(getHeader(h, 'x-trace-id')).toBe('trace-1');

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
  it('устанавливает и перезаписывает', () => {
    const headers: Record<string, string> = {};
    setHeader(headers, 'Content-Type', 'application/json');
    expect(headers).toEqual({ 'Content-Type': 'application/json' });

    setHeader(headers, 'Content-Type', 'text/plain');
    expect(headers).toEqual({ 'Content-Type': 'text/plain' });
  });

  it('удаляет дубли с другим регистром', () => {
    const multi: Record<string, string> = {
      'content-type': 'text/plain',
      'CONTENT-TYPE': 'text/html',
    };
    setHeader(multi, 'Content-Type', 'application/json');
    expect(Object.keys(multi)).toEqual(['Content-Type']);
    expect(multi['Content-Type']).toBe('application/json');
  });
});

describe('mergeHeaders', () => {
  it('сливает источники, нормализуя регистр и перезаписывая; не мутирует исходные', () => {
    const source = { 'Content-Type': 'text/plain' };
    const result = mergeHeaders(
      source,
      { 'content-type': 'text/html' },
      { 'Content-Type': 'application/json' },
      { Authorization: 'Bearer x' },
    );

    expect(result).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer x',
    });
    expect(source).toEqual({ 'Content-Type': 'text/plain' });
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

  it('сливает Headers, Record и массив пар в одном вызове', () => {
    const h = new Headers();
    h.set('content-type', 'text/plain');

    const result = mergeHeaders({ 'X-From-Record': 'r' }, h, [['X-From-Pairs', 'p']]);

    expect(result['X-From-Record']).toBe('r');
    expect(result['content-type']).toBe('text/plain');
    expect(result['X-From-Pairs']).toBe('p');
  });
});

describe('parseRetryAfterMs', () => {
  it('возвращает undefined для null и пустой строки; парсит число; срезает OWS', () => {
    expect(parseRetryAfterMs(null)).toBeUndefined();
    expect(parseRetryAfterMs('')).toBeUndefined();

    expect(parseRetryAfterMs('5')).toBe(5000);
    expect(parseRetryAfterMs(' 5 ')).toBe(5000);
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
    '1e3',
    '+5',
    'garbage GMT',
    'Wed, 21 Oct 2026 07:28:00 UTC',
    'sun, 06 Nov 1994 08:49:37 GMT',
  ])('отсекает не-IMF-fixdate значение: %s', (input) => {
    expect(parseRetryAfterMs(input)).toBeUndefined();
  });
});
