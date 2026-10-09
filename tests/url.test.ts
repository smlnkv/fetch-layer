// Тесты transport/url.ts: buildUrl, serializeQueryValue.

import { describe, expect, it } from 'vitest';

import { buildUrl, serializeQueryValue } from '../src/transport/url';

describe('serializeQueryValue - примитивы', () => {
  it('строка, число, boolean; undefined/null пропускаются; экранирование', () => {
    expect(serializeQueryValue('key', 'value', 'repeat', 'brackets')).toEqual(['key=value']);
    expect(serializeQueryValue('page', 1, 'repeat', 'brackets')).toEqual(['page=1']);
    expect(serializeQueryValue('active', true, 'repeat', 'brackets')).toEqual(['active=true']);

    expect(serializeQueryValue('key', undefined, 'repeat', 'brackets')).toEqual([]);
    expect(serializeQueryValue('key', null, 'repeat', 'brackets')).toEqual([]);

    expect(serializeQueryValue('q', 'hello world', 'repeat', 'brackets')).toEqual([
      'q=hello%20world',
    ]);
    expect(serializeQueryValue('path', 'a/b', 'repeat', 'brackets')).toEqual(['path=a%2Fb']);
  });
});

describe('serializeQueryValue - массивы', () => {
  it('форматы repeat, brackets, comma', () => {
    expect(serializeQueryValue('ids', [1, 2, 3], 'repeat', 'brackets')).toEqual([
      'ids=1',
      'ids=2',
      'ids=3',
    ]);
    expect(serializeQueryValue('ids', [1, 2], 'brackets', 'brackets')).toEqual([
      'ids[]=1',
      'ids[]=2',
    ]);
    expect(serializeQueryValue('ids', [1, 2, 3], 'comma', 'brackets')).toEqual(['ids=1,2,3']);
  });

  it('пропускает undefined и null; пустой массив даёт пустой результат', () => {
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
  it('форматы brackets и dots, включая вложенные', () => {
    expect(serializeQueryValue('filter', { status: 'active' }, 'repeat', 'brackets')).toEqual([
      'filter[status]=active',
    ]);
    expect(
      serializeQueryValue('filter', { user: { role: 'admin' } }, 'repeat', 'brackets'),
    ).toEqual(['filter[user][role]=admin']);
    expect(serializeQueryValue('filter', { status: 'active' }, 'repeat', 'dots')).toEqual([
      'filter.status=active',
    ]);
    expect(serializeQueryValue('filter', { user: { role: 'admin' } }, 'repeat', 'dots')).toEqual([
      'filter.user.role=admin',
    ]);
  });

  it('сортирует ключи на всех уровнях вложенности, сохраняет читаемый вид скобок', () => {
    expect(
      serializeQueryValue('filter', { type: 'post', status: 'active' }, 'repeat', 'brackets'),
    ).toEqual(['filter[status]=active', 'filter[type]=post']);

    expect(
      serializeQueryValue('filter', { z: { b: '1', a: '2' }, a: '3' }, 'repeat', 'brackets'),
    ).toEqual(['filter[a]=3', 'filter[z][a]=2', 'filter[z][b]=1']);

    const result = serializeQueryValue('filter', { status: 'active' }, 'repeat', 'brackets');
    expect(result[0]).toBe('filter[status]=active');
    expect(result[0]).not.toContain('%5B');
    expect(result[0]).not.toContain('%5D');
  });

  it('пропускает undefined; пустой объект даёт пустой результат', () => {
    expect(
      serializeQueryValue('filter', { a: 1, b: undefined, c: 3 }, 'repeat', 'brackets'),
    ).toEqual(['filter[a]=1', 'filter[c]=3']);
    expect(serializeQueryValue('filter', {}, 'repeat', 'brackets')).toEqual([]);
  });
});

describe('buildUrl - склейка и нормализация', () => {
  it('склеивает baseUrl и path, включая абсолютный URL', () => {
    expect(buildUrl('/api', '/users')).toBe('/api/users');
    expect(buildUrl('https://api.example.com', '/users')).toBe('https://api.example.com/users');
  });

  it('нормализует trailing и leading слэши', () => {
    expect(buildUrl('/api/', '/users')).toBe('/api/users');
    expect(buildUrl('/api', 'users')).toBe('/api/users');
    expect(buildUrl('/api//', 'users')).toBe('/api/users');
    expect(buildUrl('https://api.example.com//', '/users')).toBe('https://api.example.com/users');
  });

  it('возвращает URL без query, если query пустой', () => {
    expect(buildUrl('/api', '/users', {})).toBe('/api/users');
    expect(buildUrl('/api', '/users')).toBe('/api/users');
  });
});

describe('buildUrl - кодирование path', () => {
  it('кодирует пробелы, спецсимволы и query-разделители в сегментах', () => {
    expect(buildUrl('/api', '/users/John Doe')).toBe('/api/users/John%20Doe');
    expect(buildUrl('/api', '/search/a b/c')).toBe('/api/search/a%20b/c');
    expect(buildUrl('/api', '/items/a?b')).toBe('/api/items/a%3Fb');
    expect(buildUrl('/api', '/items/a#b')).toBe('/api/items/a%23b');
  });

  it('сохраняет разделители /; не кодирует уже закодированные сегменты; кодирует невалидные escape', () => {
    expect(buildUrl('/api', '/a/b/c/d')).toBe('/api/a/b/c/d');
    expect(buildUrl('/api', '/users/John%20Doe')).toBe('/api/users/John%20Doe');
    expect(buildUrl('/api', '/a%2Fb/c')).toBe('/api/a%2Fb/c');
    expect(buildUrl('/api', '/a%ZZb')).toBe('/api/a%25ZZb');
  });
});

describe('buildUrl - работа с query', () => {
  it('сортирует ключи в алфавитном порядке; не зависит от порядка ключей', () => {
    expect(buildUrl('/api', '/products', { b: 2, a: 1, c: 3 })).toBe('/api/products?a=1&b=2&c=3');

    const url1 = buildUrl('/api', '/products', { b: 2, a: 1, c: [3, 1] });
    const url2 = buildUrl('/api', '/products', { c: [3, 1], a: 1, b: 2 });
    expect(url1).toBe(url2);
  });

  it('склеивает разные форматы; кодирует path и query вместе', () => {
    expect(
      buildUrl('/api', '/products', {
        page: 1,
        tags: ['a', 'b'],
        filter: { status: 'active' },
      }),
    ).toBe('/api/products?filter[status]=active&page=1&tags=a&tags=b');

    expect(buildUrl('/api', '/users/John Doe', { q: 'test' })).toBe('/api/users/John%20Doe?q=test');
  });
});
