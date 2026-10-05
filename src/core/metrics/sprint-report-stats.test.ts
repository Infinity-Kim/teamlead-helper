import { describe, it, expect } from 'vitest';
import {
  sprintCapBreakdown,
  aggregateCapBreakdown,
  groupSprintsByQuarter,
  velocitySummary,
  issueBuckets,
  issueInSlice,
} from './sprint-report-stats';
import { issue, sprint } from './__test-helpers__/sprint-fixtures';

describe('sprintCapBreakdown', () => {
  it('раскладывает SP по бакетам, % от ВСЕГО completed (вкл. Unlabeled), сумма = 100', () => {
    const s = sprint({
      sprintId: 1,
      completedIssues: [
        issue('A', 60, ['CAP_Product']),
        issue('B', 20, ['CAP_Tech']),
        issue('C', 20, []), // без метки → Unlabeled
      ],
    });
    const b = sprintCapBreakdown(s);
    const by = Object.fromEntries(b.shares.map((x) => [x.slice, x]));
    expect(b.totalPoints).toBe(100);
    expect(by.Product.points).toBe(60);
    expect(by.Product.pct).toBe(60);
    expect(by.Tech.pct).toBe(20);
    expect(by.Unlabeled.pct).toBe(20);
    expect(by.Support.pct).toBe(0);
    const sumPct = b.shares.reduce((a, x) => a + x.pct, 0);
    expect(Math.round(sumPct)).toBe(100);
  });

  it('несколько CAP-лейблов на задаче → SP делится поровну', () => {
    const s = sprint({
      sprintId: 2,
      completedIssues: [issue('A', 10, ['CAP_Product', 'CAP_Tech'])],
    });
    const by = Object.fromEntries(sprintCapBreakdown(s).shares.map((x) => [x.slice, x]));
    expect(by.Product.points).toBe(5);
    expect(by.Tech.points).toBe(5);
  });

  it('null-оценка и не-CAP лейблы: задача без SP не искажает, чужой лейбл → Unlabeled', () => {
    const s = sprint({
      sprintId: 3,
      completedIssues: [
        issue('A', null, ['CAP_Product']), // нет оценки → 0 SP
        issue('B', 30, ['template']), // не CAP → Unlabeled
      ],
      completedPoints: 30,
    });
    const b = sprintCapBreakdown(s);
    const by = Object.fromEntries(b.shares.map((x) => [x.slice, x]));
    expect(b.totalPoints).toBe(30);
    expect(by.Unlabeled.points).toBe(30);
    expect(by.Product.points).toBe(0);
  });

  it('пустой спринт → всё по нулям, без деления на ноль', () => {
    const b = sprintCapBreakdown(sprint({ sprintId: 4, completedIssues: [], completedPoints: 0 }));
    expect(b.totalPoints).toBe(0);
    expect(b.shares.every((x) => x.pct === 0 && x.points === 0)).toBe(true);
  });
});

describe('aggregateCapBreakdown', () => {
  it('суммирует задачи нескольких спринтов', () => {
    const a = sprint({ sprintId: 1, completedIssues: [issue('A', 40, ['CAP_Product'])] });
    const b = sprint({ sprintId: 2, completedIssues: [issue('B', 60, ['CAP_Tech'])] });
    const agg = aggregateCapBreakdown([a, b]);
    const by = Object.fromEntries(agg.shares.map((x) => [x.slice, x]));
    expect(agg.totalPoints).toBe(100);
    expect(by.Product.pct).toBe(40);
    expect(by.Tech.pct).toBe(60);
  });
});

describe('groupSprintsByQuarter (календарь команды)', () => {
  it('ГГ.9.2 (старт 24.09) — первый спринт Q4, если год команды начался 15.01', () => {
    const jan = sprint({
      sprintId: 1,
      isoStartDate: '2025-01-15T09:00:00+0000',
      completedIssues: [],
    });
    const s91 = sprint({
      sprintId: 2,
      isoStartDate: '2025-09-10T09:00:00+0000',
      completedIssues: [],
    });
    const s92 = sprint({
      sprintId: 3,
      isoStartDate: '2025-09-24T09:00:00+0000',
      completedIssues: [issue('A', 10, ['CAP_Product'])],
    });
    const groups = groupSprintsByQuarter([s92, s91, jan]);
    expect(groups.map((g) => [g.quarter, g.sprints.map((d) => d.sprintId)])).toEqual([
      ['2025-Q4', [3]],
      ['2025-Q3', [2]],
      ['2025-Q1', [1]],
    ]);
  });

  it('группирует по кварталам и сортирует от новых к старым', () => {
    const q1 = sprint({
      sprintId: 1,
      isoStartDate: '2025-02-01T00:00:00+0000',
      completedIssues: [issue('A', 10, ['CAP_Product'])],
    });
    const q2 = sprint({
      sprintId: 2,
      isoStartDate: '2025-05-01T00:00:00+0000',
      completedIssues: [issue('B', 20, ['CAP_Tech'])],
    });
    const q3 = sprint({
      sprintId: 3,
      isoStartDate: '2025-08-01T00:00:00+0000',
      completedIssues: [issue('C', 30, [])],
    });
    const groups = groupSprintsByQuarter([q1, q2, q3]);
    expect(groups.map((g) => g.quarter)).toEqual(['2025-Q3', '2025-Q2', '2025-Q1']);
    // completedSp квартала = сумма completedPoints его спринтов
    expect(groups.find((g) => g.quarter === '2025-Q2')!.completedSp).toBe(20);
  });

  it('спринт без дат пропускается', () => {
    const s = sprint({ sprintId: 1, completedIssues: [issue('A', 10)] }); // нет isoStartDate
    expect(groupSprintsByQuarter([s])).toHaveLength(0);
  });
});

describe('issueBuckets / issueInSlice (клик-фильтр по бакету)', () => {
  it('issueBuckets возвращает CAP-бакеты задачи, чужие лейблы игнорирует', () => {
    expect(issueBuckets(issue('A', 5, ['CAP_Product', 'template']))).toEqual(['Product']);
    expect(issueBuckets(issue('B', 5, ['CAP_Tech', 'CAP_Support']))).toEqual(['Tech', 'Support']);
    expect(issueBuckets(issue('C', 5, []))).toEqual([]);
  });

  it('issueInSlice: Product/Tech/Support — по наличию бакета', () => {
    const i = issue('A', 5, ['CAP_Product']);
    expect(issueInSlice(i, 'Product')).toBe(true);
    expect(issueInSlice(i, 'Tech')).toBe(false);
  });

  it('issueInSlice: Unlabeled — задача без CAP-меток', () => {
    expect(issueInSlice(issue('A', 5, []), 'Unlabeled')).toBe(true);
    expect(issueInSlice(issue('B', 5, ['template']), 'Unlabeled')).toBe(true);
    expect(issueInSlice(issue('C', 5, ['CAP_Product']), 'Unlabeled')).toBe(false);
  });

  it('задача с несколькими бакетами попадает в каждый (multi-label)', () => {
    const i = issue('A', 5, ['CAP_Product', 'CAP_Tech']);
    expect(issueInSlice(i, 'Product')).toBe(true);
    expect(issueInSlice(i, 'Tech')).toBe(true);
    expect(issueInSlice(i, 'Support')).toBe(false);
  });
});

describe('velocitySummary (median + mean, окно 6)', () => {
  it('берёт последние N (первые в массиве «свежие→старые») и считает медиану и среднее', () => {
    // completedPoints: 10,20,30,40,50,60,70 — окно 6 берёт первые 6 → 10..60
    const sprints = [70, 60, 50, 40, 30, 20, 10].map((p, i) =>
      sprint({ sprintId: i, completedIssues: [issue('A', p)] }),
    );
    const v = velocitySummary(sprints, 6);
    expect(v.count).toBe(6);
    // первые 6: 70,60,50,40,30,20 → mean 45, median (30+40)/2=35... сортировка внутри median
    expect(v.mean).toBe(45);
    expect(v.median).toBe(45); // median([70,60,50,40,30,20]) = (40+50)/2 = 45
  });

  it('меньше окна — берёт что есть', () => {
    const sprints = [30, 10].map((p, i) =>
      sprint({ sprintId: i, completedIssues: [issue('A', p)] }),
    );
    const v = velocitySummary(sprints, 6);
    expect(v.count).toBe(2);
    expect(v.mean).toBe(20);
    expect(v.median).toBe(20);
  });

  it('пусто → null', () => {
    const v = velocitySummary([], 6);
    expect(v).toEqual({ median: null, mean: null, count: 0 });
  });
});
