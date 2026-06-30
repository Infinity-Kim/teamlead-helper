import { describe, it, expect } from 'vitest';
import {
  quarterOf,
  groupByQuarter,
  calcQuarterBalance,
  requiredProductPctForRemainder,
  sprintsRemaining,
} from './quarter-balance';
import type { SprintRecord } from '@/core/domain';

const sprint = (p: Partial<SprintRecord>): SprintRecord => ({
  id: p.id ?? 1,
  name: p.name ?? 'S',
  startDate: p.startDate ?? '2026-04-08T11:00:00+0300',
  state: p.state ?? 'CLOSED',
  points: p.points ?? { Product: 0, Tech: 0, Support: 0 },
  unlabeledPoints: p.unlabeledPoints ?? 0,
  // По умолчанию ничего не «в работе» (для closed план=факт). Активный задаёт notDonePoints явно.
  notDonePoints: p.notDonePoints ?? { Product: 0, Tech: 0, Support: 0 },
  notDoneUnlabeled: p.notDoneUnlabeled ?? 0,
});

describe('quarterOf — отнесение по дате старта', () => {
  it('апрель → Q2', () => {
    expect(quarterOf('2026-04-08T11:00:00+0300')).toBe('2026-Q2');
  });
  it('1 июля → Q3 (новый квартал)', () => {
    expect(quarterOf('2026-07-01T10:00:00Z')).toBe('2026-Q3');
  });
  it('спринт, стартовавший 25 марта, → Q1 даже если закрылся в апреле', () => {
    // методология: относим по СТАРТУ, целиком
    expect(quarterOf('2026-03-25T10:00:00Z')).toBe('2026-Q1');
  });
  it('невалидная дата → null', () => {
    expect(quarterOf('nonsense')).toBeNull();
  });
});

describe('groupByQuarter', () => {
  it('группирует спринты по кварталу старта', () => {
    const m = groupByQuarter([
      sprint({ id: 1, startDate: '2026-04-08T00:00:00Z' }),
      sprint({ id: 2, startDate: '2026-06-17T00:00:00Z' }),
      sprint({ id: 3, startDate: '2026-03-25T00:00:00Z' }),
    ]);
    expect(m.get('2026-Q2')?.map((s) => s.id)).toEqual([1, 2]);
    expect(m.get('2026-Q1')?.map((s) => s.id)).toEqual([3]);
  });
});

describe('calcQuarterBalance', () => {
  it('считает QTD % и отклонение от цели', () => {
    // 2 спринта: Product 130, остальное 70 → total 200, Product 65%
    const b = calcQuarterBalance('2026-Q2', [
      sprint({ points: { Product: 70, Tech: 20, Support: 10 } }),
      sprint({ points: { Product: 60, Tech: 30, Support: 10 } }),
    ]);
    expect(b.totalPoints).toBe(200);
    expect(b.productPoints).toBe(130);
    expect(b.productPct).toBe(65);
    expect(b.deltaPp).toBe(-2); // 65 − 67
    expect(b.outOfBand).toBe(false); // |−2| ≤ 5
  });

  it('перебор Product → outOfBand + положительный долг', () => {
    // Product 80%, цель 67, band 5 → вне коридора
    const b = calcQuarterBalance('2026-Q2', [
      sprint({ points: { Product: 80, Tech: 10, Support: 10 } }),
    ]);
    expect(b.productPct).toBe(80);
    expect(b.deltaPp).toBe(13);
    expect(b.outOfBand).toBe(true);
    // долг = 13% от 100 SP = 13 SP «остального» недодано
    expect(b.productDebtSp).toBe(13);
  });

  it('активный спринт: факт (Done) и план (взято) считаются раздельно', () => {
    const b = calcQuarterBalance('2026-Q2', [
      // закрытый: факт=план
      sprint({ points: { Product: 60, Tech: 20, Support: 20 } }),
      // активный: Done только Product 10, ещё взято (не Done) Tech 40
      sprint({
        state: 'ACTIVE',
        points: { Product: 10, Tech: 0, Support: 0 },
        notDonePoints: { Product: 0, Tech: 40, Support: 0 },
      }),
    ]);
    expect(b.hasActive).toBe(true);
    // ФАКТ: Product 70 из 110 = 63.6%
    expect(b.totalPoints).toBe(110);
    expect(b.productPct).toBe(63.6);
    // ПЛАН: Product 70 из 150 = 46.7% (взяли много Tech в активный)
    expect(b.plannedTotal).toBe(150);
    expect(b.plannedProductPct).toBe(46.7);
  });

  it('закрытый спринт: notDone (перенос) НЕ попадает в план (план = факт)', () => {
    const b = calcQuarterBalance('2026-Q2', [
      // closed: Done Product 60, а notDone Tech 40 — это перенос, не план
      sprint({
        state: 'CLOSED',
        points: { Product: 60, Tech: 0, Support: 0 },
        notDonePoints: { Product: 0, Tech: 40, Support: 0 },
      }),
    ]);
    // факт = план: notDone закрытого игнорируется
    expect(b.totalPoints).toBe(60);
    expect(b.plannedTotal).toBe(60);
    expect(b.productPct).toBe(b.plannedProductPct);
  });

  it('пустой квартал не делит на ноль', () => {
    const b = calcQuarterBalance('2026-Q2', []);
    expect(b.totalPoints).toBe(0);
    expect(b.productPct).toBe(0);
  });
});

describe('requiredProductPctForRemainder', () => {
  it('перебрали Product → на остаток нужно меньше Product', () => {
    // QTD: Product 80 из 100 (80%). Осталось 100 SP прогноза. Цель 67%.
    // нужно всего Product = 67% от 200 = 134; уже 80 → на остаток 54 из 100 = 54%
    const b = calcQuarterBalance('2026-Q2', [
      sprint({ points: { Product: 80, Tech: 10, Support: 10 } }),
    ]);
    expect(requiredProductPctForRemainder(b, 100)).toBe(54);
  });
  it('нет остатка → null', () => {
    const b = calcQuarterBalance('2026-Q2', [
      sprint({ points: { Product: 67, Tech: 33, Support: 0 } }),
    ]);
    expect(requiredProductPctForRemainder(b, 0)).toBeNull();
  });
});

describe('sprintsRemaining', () => {
  it('из 6 спринтов квартала', () => {
    expect(sprintsRemaining(2)).toBe(4);
    expect(sprintsRemaining(6)).toBe(0);
    expect(sprintsRemaining(7)).toBe(0);
  });
});
