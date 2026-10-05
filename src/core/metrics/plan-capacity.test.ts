import { describe, it, expect } from 'vitest';
import type { SprintReportDetail, SprintReportIssue } from '@/core/domain';
import {
  allowedPlan,
  explainPlan,
  lowerQuantile,
  mannKendallZ,
  planCapacity,
  PLAN_HISTORY,
  sprintFlow,
  targetCompletionFromCarryover,
  theilSen,
} from './plan-capacity';

const issue = (key: string, points: number | null): SprintReportIssue => ({
  key,
  summary: '',
  points,
  initialPoints: points,
  status: '',
  type: '',
  labels: [],
});

function report(p: Partial<SprintReportDetail>): SprintReportDetail {
  return {
    sprintId: 1,
    name: 'S',
    state: 'CLOSED',
    completedPoints: 0,
    completedInitialPoints: 0,
    notCompletedPoints: 0,
    allPoints: 0,
    completedIssues: [],
    notCompletedIssues: [],
    puntedIssues: [],
    completedInAnotherSprintIssues: [],
    addedIssueKeys: new Set(),
    hasPuntedData: true,
    hasAddedData: true,
    ...p,
  };
}

/** Реальные потоки (закрыто, прилёты) с появления CAP-меток (2025-10), живой API 2026-10-01. Старые → свежие. */
const REAL: Record<string, Array<[number, number]>> = {
  ELCAS: [
    [75, 4],
    [74, 4],
    [57, 19],
    [92, 4],
    [91, 27],
    [111, 27],
    [61, 12],
    [74, 8],
    [74, 2],
    [71, 5],
    [83, 1],
    [86, 2],
    [91, 15],
    [60, 14],
    [94, 7],
    [89, 23],
    [67, 1],
    [78, 4],
    [66, 1],
    [79, 5],
    [57, 6],
    [96, 10],
    [66, 3],
    [75, 4],
  ],
  POC: [
    [60, 20],
    [38, 13],
    [56, 9],
    [57, 14],
    [70, 5],
    [70, 32],
    [69, 13],
    [67, 5],
    [94, 8],
    [61, 7],
    [83, 10],
    [64, 14],
    [50, 3],
    [65, 8],
    [42, 2],
    [77, 15],
    [76, 16],
    [42, 5],
    [67, 6],
    [71, 11],
    [88, 12],
    [58, 7],
    [75, 2],
    [62, 13],
  ],
  Web: [
    [86, 14],
    [85, 24],
    [67, 17],
    [67, 14],
    [53, 4],
    [71, 26],
    [55, 11],
    [69, 13],
    [65, 13],
    [53, 17],
    [38, 8],
    [71, 18],
    [23, 9],
    [61, 12],
    [80, 14],
    [64, 15],
    [63, 20],
    [107, 29],
    [73, 17],
    [100, 8],
    [112, 34],
    [75, 25],
    [115, 44],
    [94, 14],
  ],
};
const flowsOf = (team: string) => REAL[team].map(([completed, added]) => ({ completed, added }));

describe('planCapacity', () => {
  it('один спринт: план = закрыто / цель − прилёты, вниз (70, прилёты 10 → 77.5 → 77)', () => {
    const r = planCapacity([{ completed: 70, added: 10 }], 0.8)!;
    expect(r.recommended).toBe(77);
    expect((77.5 + 10) * 0.8).toBe(70);
  });

  it('стабильная команда: 20%-квантиль допустимого плана, тренд не включается', () => {
    // Допустимые 75, 80, …, 120 (10 шт., вперемешку — тренда нет): 20%-квантиль = 2-е по величине.
    const allowed = [100, 80, 115, 90, 75, 120, 85, 105, 95, 110];
    const r = planCapacity(
      allowed.map((a) => ({ completed: a * 0.8, added: 0 })),
      0.8,
    )!;
    expect(r.trend!.active).toBe(false);
    expect(r.recommended).toBe(80);
    expect(r.stretch).toBe(85);
  });

  it('растущая команда: значимый тренд поднимает план выше квантиля прошлого', () => {
    const allowed = Array.from({ length: 12 }, (_, i) => 60 + 4 * i + (i % 2 ? 3 : -3));
    const flows = allowed.map((a) => ({ completed: a * 0.8, added: 0 }));
    const r = planCapacity(flows, 0.8)!;
    expect(r.trend!.active).toBe(true);
    expect(r.trend!.slope).toBeGreaterThan(0);
    expect(r.recommended).toBeGreaterThan(lowerQuantile(allowed, 0.2));
  });

  it('один провальный спринт не обваливает план (в отличие от минимума)', () => {
    const flows = flowsOf('Web').slice(0, 18); // включает 26.4.1 (13-й): закрыли 23 SP
    const r = planCapacity(flows, 0.8)!;
    const min = Math.min(...flows.map((f) => allowedPlan(f, 0.8)));
    expect(min).toBeLessThan(25);
    expect(r.recommended).toBeGreaterThan(40);
  });

  it('реальные данные: Казино 79 и POC 60 стабильны, Web растёт — вес у трендовых моделей', () => {
    const elcas = planCapacity(flowsOf('ELCAS'), 0.8)!;
    const poc = planCapacity(flowsOf('POC'), 0.8)!;
    const web = planCapacity(flowsOf('Web'), 0.8)!;
    expect([elcas.recommended, elcas.stretch, elcas.trend!.active]).toEqual([79, 82, false]);
    expect([poc.recommended, poc.trend!.active]).toEqual([60, false]);
    expect([web.recommended, web.stretch, web.trend!.active]).toEqual([78, 84, true]);
    expect(web.models[0].model).toMatch(/^тренд/);
    expect(web.models.reduce((s, m) => s + m.weight, 0)).toBeCloseTo(1);
  });

  it('появился тренд — смесь сама переносит вес на трендовые модели', () => {
    const stable = Array.from({ length: 30 }, (_, i) => 80 + ((i * 7) % 11) - 5);
    const growing = Array.from({ length: 14 }, (_, i) => 85 + 4 * i + ((i * 7) % 5) - 2);
    const toFlows = (xs: number[]) => xs.map((a) => ({ completed: a * 0.8, added: 0 }));
    const before = planCapacity(toFlows(stable), 0.8)!;
    const after = planCapacity(toFlows([...stable, ...growing]), 0.8)!;
    expect(before.trend!.active).toBe(false);
    expect(after.trend!.active).toBe(true);
    const trendWeight = (p: typeof after) =>
      p.models.filter((m) => m.model.startsWith('тренд')).reduce((s, m) => s + m.weight, 0);
    expect(trendWeight(after)).toBeGreaterThan(trendWeight(before));
    expect(after.recommended).toBeGreaterThan(before.recommended + 20);
  });

  it('вызов не ниже рекомендации', () => {
    for (const t of Object.keys(REAL)) {
      const r = planCapacity(flowsOf(t), 0.8)!;
      expect(r.stretch).toBeGreaterThanOrEqual(r.recommended);
    }
  });

  it('берёт не больше PLAN_HISTORY последних спринтов', () => {
    const old = Array.from({ length: PLAN_HISTORY }, () => ({ completed: 8, added: 0 }));
    const r = planCapacity([...old, ...flowsOf('ELCAS')], 0.8)!;
    expect(r.count).toBe(PLAN_HISTORY);
    expect(planCapacity([...old.slice(0, 5), ...flowsOf('ELCAS')], 0.8)!.count).toBe(29);
  });

  it('короткая история (< 12 спринтов) — без смеси, по базовой модели', () => {
    const r = planCapacity(flowsOf('POC').slice(0, 6), 0.8)!;
    expect(r.models).toEqual([]);
    expect(r.recommended).toBeGreaterThan(0);
  });

  it('прилёты больше потолка → 0, а не отрицательный план', () => {
    expect(planCapacity([{ completed: 10, added: 50 }], 0.8)!.recommended).toBe(0);
  });

  it('нет спринтов или некорректная цель → null', () => {
    expect(planCapacity([], 0.8)).toBeNull();
    expect(planCapacity([{ completed: 70, added: 0 }], 0)).toBeNull();
    expect(planCapacity([{ completed: 70, added: 0 }], 1.2)).toBeNull();
  });
});

describe('mannKendallZ / theilSen', () => {
  it('монотонный рост — большой положительный Z, наклон точный', () => {
    const y = Array.from({ length: 12 }, (_, i) => 50 + 5 * i);
    expect(mannKendallZ(y)).toBeGreaterThan(3);
    expect(theilSen(y)).toEqual({ intercept: 50, slope: 5 });
  });

  it('выброс не сбивает наклон Тейла–Сена', () => {
    const y = [10, 12, 14, 16, -100, 20, 22, 24];
    expect(theilSen(y).slope).toBe(2);
  });

  it('ровный ряд — Z = 0', () => {
    expect(mannKendallZ([5, 5, 5, 5, 5, 5, 5, 5])).toBe(0);
  });
});

describe('sprintFlow', () => {
  it('прилёты — добавленные задачи среди закрытых и переехавших; выброшенные не считаются', () => {
    const s = report({
      completedPoints: 13,
      completedIssues: [issue('A-1', 5), issue('A-2', 8)],
      notCompletedIssues: [issue('A-3', 3)],
      puntedIssues: [issue('A-4', 20)],
      addedIssueKeys: new Set(['A-2', 'A-3', 'A-4']),
    });
    expect(sprintFlow(s)).toEqual({ name: 'S', completed: 13, added: 11 });
  });

  it('задача в двух массивах учитывается один раз, null-оценка → 0', () => {
    const s = report({
      completedIssues: [issue('A-1', 5), issue('A-2', null)],
      notCompletedIssues: [issue('A-1', 5)],
      addedIssueKeys: new Set(['A-1', 'A-2']),
    });
    expect(sprintFlow(s).added).toBe(5);
  });
});

describe('targetCompletionFromCarryover', () => {
  it('перенос 20% ⇔ выполнение 80%', () => {
    expect(targetCompletionFromCarryover(20)).toBeCloseTo(0.8);
  });
});

describe('explainPlan — разбор плана для страницы «как посчитано»', () => {
  const flows = flowsOf('ELCAS');
  const e = explainPlan(flows, 0.8)!;

  it('итог совпадает с planCapacity — страница не считает своё', () => {
    expect(e.plan).toEqual(planCapacity(flows, 0.8));
  });

  it('допустимый план каждого спринта = закрыто / цель − прилёты', () => {
    expect(e.sprints).toHaveLength(flows.length);
    expect(e.sprints[0]).toMatchObject({ completed: 75, added: 4, allowed: 89.8 });
  });

  it('проверка на истории — до 18 последних спринтов, каждый по данным до него', () => {
    // 24 спринта: первые 8 — разгон истории, проверяются 16.
    expect(e.backtest.scored).toBe(16);
    expect(e.backtest.hitsPlan).toBe(e.backtest.rows.filter((r) => r.plan <= r.allowed).length);
    expect(e.backtest.hitsMedian).toBe(e.backtest.rows.filter((r) => r.median <= r.allowed).length);
    // Живые данные ELCAS: рекомендация в цели 11 из 16, медиана закрытого — 12 из 16
    // (POC 12 против 9, Web 12 против 11). Страница показывает это как есть.
    expect([e.backtest.hitsPlan, e.backtest.hitsMedian]).toEqual([11, 12]);
  });

  it('веса моделей в сумме 1, у каждой есть прогноз и ошибка', () => {
    expect(e.models).toHaveLength(11);
    expect(e.models.reduce((s, m) => s + m.weight, 0)).toBeCloseTo(1, 9);
    expect(e.models.every((m) => m.loss >= 0 && m.forecast > 0)).toBe(true);
  });

  it('линия тренда — по последним 12 спринтам; короткая история — без неё', () => {
    expect(e.trendLine?.values).toHaveLength(12);
    expect(explainPlan(flows.slice(0, 5), 0.8)!.trendLine).toBeNull();
    expect(explainPlan([], 0.8)).toBeNull();
  });
});
