// Тесты transport/url.ts: buildUrl, serializeQueryValue.

import { describe, expect, it } from 'vitest';

import { buildUrl, serializeQueryValue } from '../src/transport/url';

describe('serializeQueryValue - примитивы', () => {
  it('строка, число, boolean', () => {
    expect(serializeQueryValue('key', 'value', 'repeat', 'brackets')).toEqual(['key=value']);
    expect(serializeQueryValue('page', 1, 'repeat', 'brackets')).toEqual(['page=1']);
    expect(serializeQueryValue('active', true, 'repeat', 'brackets')).toEqual(['active=true']);
  });

  it('пропускает undefined и null', () => {
    expect(serializeQueryValue('key', undefined, 'repeat', 'brackets')).toEqual([]);
    expect(serializeQueryValue('key', null, 'repeat', 'brackets')).toEqual([]);
  });

  it('экранирует спецсимволы', () => {
    expect(serializeQueryValue('q', 'hello world', 'repeat', 'brackets')).toEqual([
      'q=hello%20world',
    ]);
    expect(serializeQueryValue('path', 'a/b', 'repeat', 'brackets')).toEqual(['path=a%2Fb']);
  });
});

describe('serializeQueryValue - массивы', () => {
  it('формат repeat', () => {
    expect(serializeQueryValue('ids', [1, 2, 3], 'repeat', 'brackets')).toEqual([
      'ids=1',
      'ids=2',
      'ids=3',
    ]);
    expect(serializeQueryValue('tags', ['a b', 'c/d'], 'repeat', 'brackets')).toEqual([
      'tags=a%20b',
      'tags=c%2Fd',
    ]);
  });

  it('формат brackets', () => {
    expect(serializeQueryValue('ids', [1, 2], 'brackets', 'brackets')).toEqual([
      'ids[]=1',
      'ids[]=2',
    ]);
  });

  it('формат comma', () => {
    expect(serializeQueryValue('ids', [1, 2, 3], 'comma', 'brackets')).toEqual(['ids=1,2,3']);
  });

  it('пропускает undefined и null, пустой результат для пустого массива', () => {
    expect(serializeQueryValue('ids', [1, undefined, 2, null, 3], 'repeat', 'brackets')).toEqual([
      'ids=1',
      'ids=2',
      'ids=3',
    ]);
    expect(serializeQueryValue('ids', [], 'repeat', 'brackets')).toEqual([]);
    expect(serializeQueryValue('ids', [undefined, null], 'repeat', 'brackets')).toEqual([]);
  });
});

describe('serializeQueryValue - объекты', () => {
  it('формат brackets', () => {
    expect(serializeQueryValue('filter', { status: 'active' }, 'repeat', 'brackets')).toEqual([
      'filter[status]=active',
    ]);
    expect(
      serializeQueryValue('filter', { user: { role: 'admin' } }, 'repeat', 'brackets'),
    ).toEqual(['filter[user][role]=admin']);
  });

  it('формат dots', () => {
    expect(serializeQueryValue('filter', { status: 'active' }, 'repeat', 'dots')).toEqual([
      'filter.status=active',
    ]);
    expect(serializeQueryValue('filter', { user: { role: 'admin' } }, 'repeat', 'dots')).toEqual([
      'filter.user.role=admin',
    ]);
  });

  it('сортирует ключи на всех уровнях вложенности', () => {
    const brackets = serializeQueryValue(
      'filter',
      { type: 'post', status: 'active' },
      'repeat',
      'brackets',
    );
    expect(brackets).toEqual(['filter[status]=active', 'filter[type]=post']);

    const nested = serializeQueryValue(
      'filter',
      { z: { b: '1', a: '2' }, a: '3' },
      'repeat',
      'brackets',
    );
    expect(nested).toEqual(['filter[a]=3', 'filter[z][a]=2', 'filter[z][b]=1']);
  });

  it('сохраняет читаемый вид скобок', () => {
    const result = serializeQueryValue('filter', { status: 'active' }, 'repeat', 'brackets');
    expect(result[0]).toBe('filter[status]=active');
    expect(result[0]).not.toContain('%5B');
    expect(result[0]).not.toContain('%5D');
  });

  it('пропускает undefined, для пустого объекта возвращает пустой результат', () => {
    expect(
      serializeQueryValue('filter', { a: 1, b: undefined, c: 3 }, 'repeat', 'brackets'),
    ).toEqual(['filter[a]=1', 'filter[c]=3']);
    expect(serializeQueryValue('filter', {}, 'repeat', 'brackets')).toEqual([]);
  });
});

describe('buildUrl - склейка URL', () => {
  it('склеивает baseUrl и path, включая абсолютный URL', () => {
    expect(buildUrl('/api', '/users')).toBe('/api/users');
    expect(buildUrl('https://api.example.com', '/users')).toBe('https://api.example.com/users');
  });

  it('нормализует trailing и leading слэши', () => {
    expect(buildUrl('/api/', '/users')).toBe('/api/users');
    expect(buildUrl('/api', 'users')).toBe('/api/users');
    expect(buildUrl('/api/', 'users')).toBe('/api/users');
  });

  it('снимает все завершающие слэши у baseUrl', () => {
    expect(buildUrl('/api//', '/users')).toBe('/api/users');
    expect(buildUrl('/api///', '/users')).toBe('/api/users');
    expect(buildUrl('https://api.example.com//', '/users')).toBe('https://api.example.com/users');
  });

  it('возвращает URL без query, если query пустой', () => {
    expect(buildUrl('/api', '/users', {})).toBe('/api/users');
    expect(buildUrl('/api', '/users')).toBe('/api/users');
  });
});

describe('buildUrl - кодирование path', () => {
  it('кодирует пробелы и спецсимволы в сегментах', () => {
    expect(buildUrl('/api', '/users/John Doe')).toBe('/api/users/John%20Doe');
    expect(buildUrl('/api', '/search/a b/c')).toBe('/api/search/a%20b/c');
  });

  it('сохраняет разделители /', () => {
    expect(buildUrl('/api', '/users/1/posts/2')).toBe('/api/users/1/posts/2');
    expect(buildUrl('/api', '/a/b/c/d')).toBe('/api/a/b/c/d');
  });

  it('не кодирует уже закодированные сегменты повторно', () => {
    expect(buildUrl('/api', '/users/John%20Doe')).toBe('/api/users/John%20Doe');
    expect(buildUrl('/api', '/a%2Fb/c')).toBe('/api/a%2Fb/c');
  });

  it('кодирует невалидные escape-последовательности как есть', () => {
    // %ZZ не является валидной escape-последовательностью.
    // decodeURIComponent упадёт, encodeURIComponent закодирует
    // символ % как %25.
    expect(buildUrl('/api', '/a%ZZb')).toBe('/api/a%25ZZb');
  });

  it('кодирует query-разделители внутри сегмента path', () => {
    // ? и # внутри сегмента должны кодироваться, чтобы не путаться
    // с началом query-строки или fragment.
    expect(buildUrl('/api', '/items/a?b')).toBe('/api/items/a%3Fb');
    expect(buildUrl('/api', '/items/a#b')).toBe('/api/items/a%23b');
  });
});

describe('buildUrl - работа с query', () => {
  it('сортирует ключи в алфавитном порядке', () => {
    expect(buildUrl('/api', '/products', { b: 2, a: 1, c: 3 })).toBe('/api/products?a=1&b=2&c=3');
  });

  it('склеивает разные форматы в одном URL', () => {
    const url = buildUrl('/api', '/products', {
      page: 1,
      tags: ['a', 'b'],
      filter: { status: 'active' },
    });
    expect(url).toBe('/api/products?filter[status]=active&page=1&tags=a&tags=b');
  });

  it('не зависит от порядка ключей в query', () => {
    const url1 = buildUrl('/api', '/products', { b: 2, a: 1, c: [3, 1] });
    const url2 = buildUrl('/api', '/products', { c: [3, 1], a: 1, b: 2 });
    expect(url1).toBe(url2);
  });

  it('кодирует path и query вместе', () => {
    expect(buildUrl('/api', '/users/John Doe', { q: 'test' })).toBe('/api/users/John%20Doe?q=test');
  });
});
