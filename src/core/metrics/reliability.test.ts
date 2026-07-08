import { describe, it, expect } from 'vitest';
import {
  calcReliabilityTrend,
  calcThroughputTrend,
  calcCarryoverTrend,
  forecastThroughput,
  seededRng,
} from './reliability';
import type { SprintOutcome } from '@/core/domain';

const outcome = (p: Partial<SprintOutcome>): SprintOutcome => ({
  id: p.id ?? 1,
  name: p.name ?? 'S',
  committedPoints: p.committedPoints ?? 0,
  completedPoints: p.completedPoints ?? 0,
  completedCount: p.completedCount ?? 0,
  carryoverPoints: p.carryoverPoints ?? 0,
  carryoverCount: p.carryoverCount ?? 0,
});

describe('calcReliabilityTrend — say/do', () => {
  it('ratio = completed/committed по спринту', () => {
    const t = calcReliabilityTrend([
      outcome({ id: 1, committedPoints: 40, completedPoints: 30 }), // 0.75
      outcome({ id: 2, committedPoints: 50, completedPoints: 50 }), // 1.0
    ]);
    expect(t.perSprint.map((p) => p.ratio)).toEqual([0.75, 1]);
    expect(t.medianRatio).toBe(0.875);
  });

  it('спринт без committed → ratio null и не искажает медиану', () => {
    const t = calcReliabilityTrend([
      outcome({ id: 1, committedPoints: 0, completedPoints: 10 }),
      outcome({ id: 2, committedPoints: 20, completedPoints: 10 }), // 0.5
    ]);
    expect(t.perSprint[0].ratio).toBeNull();
    expect(t.medianRatio).toBe(0.5); // считается только по валидным
  });

  it('пустая история → null-медиана, null-направление', () => {
    const t = calcReliabilityTrend([]);
    expect(t.medianRatio).toBeNull();
    expect(t.direction).toBeNull();
  });

  it('растущий тренд → direction up', () => {
    const t = calcReliabilityTrend([
      outcome({ id: 1, committedPoints: 100, completedPoints: 50 }), // 0.5
      outcome({ id: 2, committedPoints: 100, completedPoints: 60 }), // 0.6
      outcome({ id: 3, committedPoints: 100, completedPoints: 90 }), // 0.9
      outcome({ id: 4, committedPoints: 100, completedPoints: 95 }), // 0.95
    ]);
    expect(t.direction).toBe('up');
  });

  it('ровный тренд → direction flat', () => {
    const t = calcReliabilityTrend([
      outcome({ id: 1, committedPoints: 100, completedPoints: 80 }),
      outcome({ id: 2, committedPoints: 100, completedPoints: 81 }),
      outcome({ id: 3, committedPoints: 100, completedPoints: 79 }),
      outcome({ id: 4, committedPoints: 100, completedPoints: 80 }),
    ]);
    expect(t.direction).toBe('flat');
  });
});

describe('calcThroughputTrend — счёт задач + стабильность', () => {
  it('mean/median/CV по количеству Done-задач', () => {
    const t = calcThroughputTrend([
      outcome({ id: 1, completedCount: 8 }),
      outcome({ id: 2, completedCount: 10 }),
      outcome({ id: 3, completedCount: 12 }),
    ]);
    expect(t.mean).toBe(10);
    expect(t.median).toBe(10);
    // σ = sqrt((4+0+4)/3) ≈ 1.63; CV ≈ 0.16
    expect(t.coefficientOfVariation).toBe(0.16);
  });

  it('идеально ровная команда → CV 0', () => {
    const t = calcThroughputTrend([
      outcome({ completedCount: 5 }),
      outcome({ completedCount: 5 }),
      outcome({ completedCount: 5 }),
    ]);
    expect(t.coefficientOfVariation).toBe(0);
  });

  it('пустая история → все null', () => {
    const t = calcThroughputTrend([]);
    expect(t.mean).toBeNull();
    expect(t.coefficientOfVariation).toBeNull();
  });

  it('μ=0 (ничего не закрывали) → CV null, не делит на ноль', () => {
    const t = calcThroughputTrend([outcome({ completedCount: 0 }), outcome({ completedCount: 0 })]);
    expect(t.mean).toBe(0);
    expect(t.coefficientOfVariation).toBeNull();
  });
});

describe('calcCarryoverTrend — перенос SP', () => {
  it('медиана и направление переноса (SP и задачи)', () => {
    const t = calcCarryoverTrend([
      outcome({ id: 1, carryoverPoints: 20, carryoverCount: 6 }),
      outcome({ id: 2, carryoverPoints: 15, carryoverCount: 4 }),
      outcome({ id: 3, carryoverPoints: 10, carryoverCount: 3 }),
      outcome({ id: 4, carryoverPoints: 5, carryoverCount: 1 }),
    ]);
    expect(t.median).toBe(12.5);
    expect(t.medianCount).toBe(3.5); // медиана count задач
    expect(t.direction).toBe('down'); // хвост уменьшается — хорошо
  });

  it('пустая история → null', () => {
    const t = calcCarryoverTrend([]);
    expect(t.median).toBeNull();
    expect(t.direction).toBeNull();
  });
});

describe('forecastThroughput — Monte Carlo', () => {
  it('null на пустой истории / нулевом горизонте', () => {
    expect(forecastThroughput([], 3)).toBeNull();
    expect(forecastThroughput([10], 0)).toBeNull();
  });

  it('константная история → все перцентили = сумма (детерминированно)', () => {
    // каждый спринт ровно 10 → за 3 спринта всегда 30, разброса нет
    const f = forecastThroughput([10, 10, 10], 3, 1000, seededRng(42));
    expect(f).not.toBeNull();
    expect(f!.p85).toBe(30);
    expect(f!.p50).toBe(30);
    expect(f!.p15).toBe(30);
    expect(f!.horizonSprints).toBe(3);
  });

  it('перцентили упорядочены p85 ≤ p50 ≤ p15 (пессимизм→оптимизм)', () => {
    const f = forecastThroughput([5, 8, 10, 12, 15], 6, 5000, seededRng(7))!;
    expect(f.p85).toBeLessThanOrEqual(f.p50);
    expect(f.p50).toBeLessThanOrEqual(f.p15);
  });

  it('детерминированность: тот же seed → тот же результат', () => {
    const a = forecastThroughput([3, 7, 9, 11], 4, 2000, seededRng(123))!;
    const b = forecastThroughput([3, 7, 9, 11], 4, 2000, seededRng(123))!;
    expect(a).toEqual(b);
  });

  it('прогноз в разумных границах истории (за 2 спринта от 6 до 30 при истории 3..15)', () => {
    const f = forecastThroughput([3, 6, 9, 12, 15], 2, 5000, seededRng(99))!;
    expect(f.p85).toBeGreaterThanOrEqual(6); // 2 худших спринта
    expect(f.p15).toBeLessThanOrEqual(30); // 2 лучших спринта
  });
});

describe('seededRng — детерминированный PRNG', () => {
  it('одинаковый seed → одинаковая последовательность', () => {
    const r1 = seededRng(1);
    const r2 = seededRng(1);
    expect([r1(), r1(), r1()]).toEqual([r2(), r2(), r2()]);
  });

  it('значения в [0, 1)', () => {
    const r = seededRng(555);
    for (let i = 0; i < 100; i++) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});
