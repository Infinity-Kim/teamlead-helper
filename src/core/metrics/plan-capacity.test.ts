import { describe, it, expect } from 'vitest';
import type { SprintReportDetail, SprintReportIssue } from '@/core/domain';
import {
  allowedPlan,
  BIG_TASK_SP,
  bigTaskWorkOf,
  describePlan,
  explainPlan,
  lowerQuantile,
  mannKendallZ,
  normalCdf,
  planCapacity,
  PLAN_HISTORY,
  PLAN_WINDOW,
  silvermanBandwidth,
  sprintFlow,
  sprintFlows,
  summarizeBacktest,
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

  it('смотрит ровно на 6 последних спринтов — старая история на план не влияет', () => {
    const old = Array.from({ length: 30 }, () => ({ completed: 120, added: 0 }));
    const recent = flowsOf('ELCAS').slice(-PLAN_WINDOW);
    const r = planCapacity([...old, ...recent], 0.8)!;
    expect(r.count).toBe(PLAN_WINDOW);
    expect(r).toEqual(planCapacity(recent, 0.8));
  });

  it('симуляция сглаживает: план между 1-м и 2-м снизу допустимым планом окна, не скачет к минимуму', () => {
    // Допустимые 75…120 (шесть, вперемешку): голый 20%-квантиль — второй снизу (80).
    const allowed = [100, 80, 115, 90, 75, 120];
    const r = planCapacity(
      allowed.map((a) => ({ completed: a * 0.8, added: 0 })),
      0.8,
    )!;
    expect(r.recommended).toBeGreaterThan(75);
    expect(r.recommended).toBeLessThanOrEqual(85);
    expect(r.stretch).toBeGreaterThan(r.recommended);
  });

  it('один провальный спринт в окне не обваливает план до минимума', () => {
    const flows = flowsOf('Web').slice(7, 13); // окно с 26.4.1: закрыли 23 SP
    const r = planCapacity(flows, 0.8)!;
    const min = Math.min(...flows.map((f) => allowedPlan(f, 0.8)));
    expect(min).toBeLessThan(25);
    expect(r.recommended).toBeGreaterThan(25);
  });

  it('реальные данные (живой API 2026-10-01): ELCAS 74, POC 67, Web 78', () => {
    const plans = Object.keys(REAL).map((t) => {
      const p = planCapacity(flowsOf(t), 0.8)!;
      return [p.recommended, p.stretch];
    });
    expect(plans).toEqual([
      [74, 79],
      [67, 71],
      [78, 85],
    ]);
  });

  it('смена состава −30%: через 6 спринтов план полностью на новом уровне', () => {
    const stable = Array.from({ length: 12 }, (_, i) => 100 + ((i * 7) % 11) - 5);
    const shrunk = stable.map((a) => a * 0.7);
    const toFlows = (xs: number[]) => xs.map((a) => ({ completed: a * 0.8, added: 0 }));
    const before = planCapacity(toFlows(stable), 0.8)!.recommended;
    const after = planCapacity(toFlows([...stable, ...shrunk.slice(0, PLAN_WINDOW)]), 0.8)!;
    expect(after.recommended).toBeLessThan(before * 0.75);
    expect(after).toEqual(planCapacity(toFlows(shrunk.slice(0, PLAN_WINDOW)), 0.8));
  });

  it('рост внутри окна — тренд виден в подсказке, но в план не входит', () => {
    const flows = [60, 66, 72, 78, 84, 90].map((a) => ({ completed: a * 0.8, added: 0 }));
    const r = planCapacity(flows, 0.8)!;
    expect(r.trend!.active).toBe(true);
    expect(r.trend!.slope).toBe(6);
  });

  it('windowFits — в скольких спринтах окна план уложился бы (для «почему столько»)', () => {
    const r = planCapacity(flowsOf('Web'), 0.8)!;
    const fits = flowsOf('Web')
      .slice(-PLAN_WINDOW)
      .filter((f) => allowedPlan(f, 0.8) >= r.recommended).length;
    expect(r.windowFits).toBe(fits);
    expect(describePlan(r)).toContain(`уложились бы в ${fits} из 6`);
  });

  it('вызов не ниже рекомендации', () => {
    for (const t of Object.keys(REAL)) {
      const r = planCapacity(flowsOf(t), 0.8)!;
      expect(r.stretch).toBeGreaterThanOrEqual(r.recommended);
    }
  });

  it('короткая история — считает по тому, что есть; одинаковые спринты — без шума', () => {
    expect(planCapacity(flowsOf('POC').slice(0, 3), 0.8)!.count).toBe(3);
    const same = Array.from({ length: 6 }, () => ({ completed: 64, added: 0 }));
    expect(planCapacity(same, 0.8)).toMatchObject({ recommended: 80, spread: 0 });
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

describe('Монте-Карло: замкнутая форма совпадает с симуляцией', () => {
  it('20%-квантиль 200 000 симулированных спринтов ≈ план', () => {
    // Сглаженный бутстреп пар (закрыто, прилёты) со сжатием к среднему — как в шапке модуля.
    const flows = flowsOf('Web').slice(-PLAN_WINDOW);
    const hc = silvermanBandwidth(flows.map((f) => f.completed));
    const ha = silvermanBandwidth(flows.map((f) => f.added));
    const allowed = flows.map((f) => allowedPlan(f, 0.8));
    const mean = allowed.reduce((a, b) => a + b, 0) / allowed.length;
    const variance = allowed.reduce((a, v) => a + (v - mean) ** 2, 0) / (allowed.length - 1);
    const shrink = 1 / Math.sqrt(1 + ((hc / 0.8) ** 2 + ha ** 2) / variance);
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
    const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
    const sims: number[] = [];
    for (let k = 0; k < 200_000; k++) {
      const f = flows[Math.floor(rnd() * flows.length)];
      const x = (f.completed + hc * gauss()) / 0.8 - (f.added + ha * gauss());
      sims.push(mean + shrink * (x - mean));
    }
    expect(lowerQuantile(sims, 0.2)).toBeCloseTo(planCapacity(flows, 0.8)!.recommended, -0.3);
  });

  it('Φ: табличные значения', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
    expect(normalCdf(-0.8416)).toBeCloseTo(0.2, 4);
    expect(normalCdf(1.96)).toBeCloseTo(0.975, 4);
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
    expect(sprintFlow(s)).toEqual({ name: 'S', completed: 13, added: 11, start: 5 });
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

describe('sprintFlows — крупные задачи (≥ 3 SP) по времени работы', () => {
  // Два спринта по 14 дней: 01–15.09 и 15–29.09.
  const s1 = (p: Partial<SprintReportDetail>) =>
    report({ isoStartDate: '2026-09-01T08:00:00Z', isoCompleteDate: '2026-09-15T08:00:00Z', ...p });
  const s2 = (p: Partial<SprintReportDetail>) =>
    report({ isoStartDate: '2026-09-15T08:00:00Z', isoCompleteDate: '2026-09-29T08:00:00Z', ...p });

  it('шла два спринта поровну: 13 SP зачёта во втором → по 6.5 в каждом', () => {
    const flows = sprintFlows(
      [
        s1({ completedPoints: 50, notCompletedIssues: [issue('B-1', 13)] }),
        s2({ completedPoints: 63, completedIssues: [issue('B-1', 13)] }),
      ],
      new Map([['B-1', { startedAt: '2026-09-08T08:00:00Z', doneAt: '2026-09-22T08:00:00Z' }]]),
    );
    expect(flows.map((f) => f.work)).toEqual([56.5, 56.5]);
  });

  it('работа до попадания в отчёт спринта (ELCAS-12936) — тоже в прошлый спринт', () => {
    // В отчёте спринта 1 задачи нет: стояла в будущем спринте, а в DEV ушла 10.09.
    const flows = sprintFlows(
      [
        s1({ completedPoints: 60 }),
        s2({ completedPoints: 73, completedIssues: [issue('B-2', 13)] }),
      ],
      new Map([['B-2', { startedAt: '2026-09-10T08:00:00Z', doneAt: '2026-09-20T08:00:00Z' }]]),
    );
    // 5 дней из 10 — в спринте 1.
    expect(flows.map((f) => f.work)).toEqual([66.5, 66.5]);
  });

  it('уложилась в один спринт — без изменений; без истории статусов — поровну по спринтам', () => {
    const inOne = sprintFlows(
      [
        s1({ completedPoints: 60 }),
        s2({ completedPoints: 70, completedIssues: [issue('B-3', 13)] }),
      ],
      new Map([['B-3', { startedAt: '2026-09-16T08:00:00Z', doneAt: '2026-09-25T08:00:00Z' }]]),
    );
    expect(inOne.map((f) => f.work)).toEqual([undefined, undefined]);
    const noHistory = sprintFlows([
      s1({ completedPoints: 50, notCompletedIssues: [issue('B-4', 20)] }),
      s2({ completedPoints: 70, completedIssues: [issue('B-4', 20)] }),
    ]);
    expect(noHistory.map((f) => f.work)).toEqual([60, 60]);
  });

  it('ещё идёт в последнем спринте — доля этого спринта засчитывается заранее', () => {
    const flows = sprintFlows([
      s1({ completedPoints: 50, notCompletedIssues: [issue('B-5', 13)] }),
    ]);
    expect(flows[0].work).toBe(56.5);
  });

  it('задачи меньше 3 SP не трогаем', () => {
    const flows = sprintFlows([
      s1({ completedPoints: 50, notCompletedIssues: [issue('S-1', 2)] }),
      s2({ completedPoints: 52, completedIssues: [issue('S-1', 2)] }),
    ]);
    expect(flows.every((f) => f.work === undefined)).toBe(true);
  });

  it('порог 3 SP: задача на 3 SP и на 8 SP тоже разносится по времени работы', () => {
    expect(BIG_TASK_SP).toBe(3);
    const flows = sprintFlows(
      [
        s1({ completedPoints: 50, notCompletedIssues: [issue('M-1', 3), issue('M-2', 8)] }),
        s2({ completedPoints: 61, completedIssues: [issue('M-1', 3), issue('M-2', 8)] }),
      ],
      new Map([
        ['M-1', { startedAt: '2026-09-08T08:00:00Z', doneAt: '2026-09-22T08:00:00Z' }],
        ['M-2', { startedAt: '2026-09-08T08:00:00Z', doneAt: '2026-09-22T08:00:00Z' }],
      ]),
    );
    expect(flows.map((f) => f.work)).toEqual([55.5, 55.5]);
  });

  it('bigTaskWorkOf: первый вход в рабочий статус → первое «готово» после него', () => {
    const tr = [
      { at: '2026-09-09T11:16:00Z', to: 'DoR/PBR' },
      { at: '2026-09-18T15:19:00Z', to: 'DEV' },
      { at: '2026-09-25T16:14:00Z', to: 'Testing' },
      { at: '2026-10-02T13:04:00Z', to: 'DoD/Release' },
      { at: '2026-10-06T12:31:00Z', to: 'Done' },
    ];
    expect(bigTaskWorkOf(tr, ['DEV'], ['DoD/Release', 'Done'])).toEqual({
      startedAt: '2026-09-18T15:19:00Z',
      doneAt: '2026-10-02T13:04:00Z',
    });
    expect(bigTaskWorkOf(tr.slice(0, 1), ['DEV'], ['Done'])).toBeNull();
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

  it('история — до 18 спринтов, последние 6 помечены окном', () => {
    expect(e.sprints).toHaveLength(PLAN_HISTORY);
    expect(e.sprints.filter((s) => s.inWindow)).toHaveLength(PLAN_WINDOW);
    expect(e.sprints.at(-1)).toMatchObject({
      completed: 75,
      added: 4,
      allowed: 89.8,
      inWindow: true,
    });
  });

  it('проверка на истории — 12 последних спринтов, каждый по 6 спринтам перед ним', () => {
    expect(e.backtest.scored).toBe(12);
    expect(e.backtest.hitsPlan).toBe(e.backtest.rows.filter((r) => r.plan <= r.allowed).length);
    expect(e.backtest.hitsMedian).toBe(e.backtest.rows.filter((r) => r.median <= r.allowed).length);
    const first = e.backtest.rows[0];
    const before = flows.slice(flows.length - 12 - PLAN_WINDOW, flows.length - 12);
    expect(first.plan).toBe(planCapacity(before, 0.8)!.recommended);
  });

  it('плотность симуляции: площадь ≈ 1, план левее медианы', () => {
    const d = e.density;
    const area = d.slice(1).reduce((s, p, i) => s + ((p.y + d[i].y) / 2) * (p.x - d[i].x), 0);
    expect(area).toBeCloseTo(1, 1);
    expect(e.plan.recommended).toBeLessThan(e.medianSim);
    expect(explainPlan([], 0.8)).toBeNull();
  });
});

describe('summarizeBacktest - итог проверки на прошлых спринтах', () => {
  const row = (plan: number, allowed: number) => ({ plan, allowed });

  it('попадания, цель, средний запас и сдвиг до цели', () => {
    const s = summarizeBacktest([row(40, 50), row(40, 44), row(40, 36), row(40, 52), row(40, 48)]);
    // запасы 10, 4, -4, 12, 8: выполнили 4 из 5 = цель, сдвигать не нужно сверх 4-го запаса
    expect(s).toEqual({
      scored: 5,
      hits: 4,
      targetHits: 4,
      meanGap: 6,
      shift: 4,
      verdict: 'ok',
    });
  });

  it('выполняли во всех 12 - план занижен, его можно было поднять', () => {
    const rows = Array.from({ length: 12 }, (_, i) => row(40, 50 + i));
    // запасы 10..21, чтобы выполнить в 10 из 12, план поднимаем на 3-й снизу запас: 12
    expect(summarizeBacktest(rows)).toMatchObject({ hits: 12, shift: 12, verdict: 'under' });
  });

  it('выполняли в половине - план завышен, его нужно было снизить', () => {
    const rows = Array.from({ length: 12 }, (_, i) => row(40, i < 6 ? 45 : 28 + i));
    // запасы 5 x6 и -6..-1: 6 попаданий; чтобы стало 10, план снижаем на 3-й снизу запас -4
    expect(summarizeBacktest(rows)).toMatchObject({ hits: 6, shift: -4, verdict: 'over' });
  });

  it('11 из 12 при цели 10 - в пределах случайности', () => {
    const rows = Array.from({ length: 12 }, (_, i) => row(40, i ? 50 : 30));
    expect(summarizeBacktest(rows)).toMatchObject({ hits: 11, targetHits: 10, verdict: 'ok' });
  });

  it('пусто - нечего проверять', () => {
    expect(summarizeBacktest([])).toMatchObject({ scored: 0, hits: 0, shift: 0, verdict: 'ok' });
  });

  it('в explainPlan: строки знают закрытое и запас, итог совпадает с hitsPlan', () => {
    const flows = flowsOf('ELCAS');
    const e = explainPlan(flows, 0.8)!;
    const last = e.backtest.rows.at(-1)!;
    expect(last.completed).toBe(flows.at(-1)!.completed);
    expect(last.added).toBe(flows.at(-1)!.added);
    expect(last.gap).toBeCloseTo(last.allowed - last.plan, 0);
    expect(e.backtest.summary).toMatchObject({
      scored: 12,
      hits: 9,
      targetHits: 10,
      verdict: 'ok',
    });
    expect(e.backtest.summary.hits).toBe(e.backtest.hitsPlan);
  });

  it('«взяли на старте» только для показа: план с ним и без него один и тот же', () => {
    const flows = flowsOf('ELCAS');
    const bare = explainPlan(flows, 0.8)!;
    expect(bare.backtest.rows.every((r) => r.start === null)).toBe(true);
    const withStart = explainPlan(
      flows.map((f, i) => ({ ...f, start: 50 + i })),
      0.8,
    )!;
    expect(withStart.backtest.rows.at(-1)!.start).toBe(50 + flows.length - 1);
    expect(withStart.plan).toEqual(bare.plan);
    expect(withStart.backtest.rows.map((r) => r.plan)).toEqual(
      bare.backtest.rows.map((r) => r.plan),
    );
  });
});
