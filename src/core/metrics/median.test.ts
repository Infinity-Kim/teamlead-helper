import { describe, it, expect } from 'vitest';
import { median } from './median';

describe('median', () => {
  it('нечётное количество', () => {
    expect(median([5, 1, 3])).toBe(3);
  });
  it('чётное количество — среднее двух центральных', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });
  it('один элемент', () => {
    expect(median([42])).toBe(42);
  });
  it('пустой — null', () => {
    expect(median([])).toBeNull();
  });
  it('не мутирует вход', () => {
    const arr = [3, 1, 2];
    median(arr);
    expect(arr).toEqual([3, 1, 2]);
  });
});
