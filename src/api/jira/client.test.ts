import { describe, it, expect, vi, afterEach } from 'vitest';
import { retryDelayMs, mapWithConcurrency } from './client';
import { JiraRequestError } from './errors';

afterEach(() => vi.restoreAllMocks());

describe('retryDelayMs', () => {
  it('экспоненциальный рост по попыткам (без jitter — фиксируем random=0.5 → множитель 1.0)', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5); // jitter = 0.7 + 0.5*0.6 = 1.0
    expect(retryDelayMs(1, undefined, 300)).toBe(300); // 300 * 2^0
    expect(retryDelayMs(2, undefined, 300)).toBe(600); // 300 * 2^1
    expect(retryDelayMs(3, undefined, 300)).toBe(1200); // 300 * 2^2
  });

  it('уважает Retry-After, если он больше экспоненты', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const err = new JiraRequestError({ kind: 'rate-limited', retryAfterMs: 5000 });
    // экспонента attempt=1 = 300, но Retry-After=5000 больше → берём 5000
    expect(retryDelayMs(1, err, 300)).toBe(5000);
  });

  it('игнорирует Retry-After, если экспонента уже больше', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const err = new JiraRequestError({ kind: 'rate-limited', retryAfterMs: 100 });
    expect(retryDelayMs(4, err, 300)).toBe(2400); // 300*2^3=2400 > 100
  });

  it('jitter в диапазоне [0.7..1.3] от target', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0); // множитель 0.7
    expect(retryDelayMs(1, undefined, 1000)).toBe(700);
    vi.spyOn(Math, 'random').mockReturnValue(1); // множитель ~1.3
    expect(retryDelayMs(1, undefined, 1000)).toBe(1300);
  });
});

describe('mapWithConcurrency', () => {
  it('сохраняет порядок результатов независимо от порядка завершения', async () => {
    const settled = await mapWithConcurrency([30, 10, 20], 3, async (ms) => {
      await new Promise((r) => setTimeout(r, ms));
      return ms;
    });
    expect(settled.map((r) => (r.status === 'fulfilled' ? r.value : null))).toEqual([30, 10, 20]);
  });

  it('ограничивает число одновременных вызовов лимитом', async () => {
    let active = 0;
    let peak = 0;
    await mapWithConcurrency(Array.from({ length: 12 }, (_, i) => i), 4, async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return true;
    });
    expect(peak).toBeLessThanOrEqual(4);
  });

  it('ошибка отдельного элемента не роняет пул — попадает как rejected в свою позицию', async () => {
    const settled = await mapWithConcurrency([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error('boom');
      return n * 10;
    });
    expect(settled[0]).toEqual({ status: 'fulfilled', value: 10 });
    expect(settled[1].status).toBe('rejected');
    expect(settled[2]).toEqual({ status: 'fulfilled', value: 30 });
  });

  it('пустой вход → пустой результат', async () => {
    expect(await mapWithConcurrency([], 5, async () => 1)).toEqual([]);
  });
});
