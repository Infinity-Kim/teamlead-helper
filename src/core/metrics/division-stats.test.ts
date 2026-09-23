import { describe, it, expect } from 'vitest';
import { divisionQuarters } from './division-stats';
import { issue, sprint } from './__test-helpers__/sprint-fixtures';

const s = (id: number, start: string, issues: ReturnType<typeof issue>[]) =>
  sprint({ sprintId: id, isoStartDate: start, completedIssues: issues });

describe('divisionQuarters', () => {
  it('складывает команды внутри квартала и сортирует кварталы от новых к старым', () => {
    const q = divisionQuarters([
      {
        rapidViewId: 1,
        team: 'A',
        sprints: [
          s(11, '2026-04-06', [issue('A-1', 8, ['CAP_Product'])]),
          s(10, '2026-01-12', [issue('A-2', 5, ['CAP_Tech'])]),
        ],
      },
      {
        rapidViewId: 2,
        team: 'B',
        sprints: [s(21, '2026-04-13', [issue('B-1', 2, ['CAP_Support'])])],
      },
    ]);

    expect(q.map((x) => x.quarter)).toEqual(['2026-Q2', '2026-Q1']);
    const q2 = q[0];
    expect(q2.sprintCount).toBe(2);
    expect(q2.completedSp).toBe(10);
    const pct = Object.fromEntries(q2.breakdown.shares.map((sh) => [sh.slice, sh.pct]));
    expect(pct).toEqual({ Product: 80, Tech: 0, Support: 20, Unlabeled: 0 });
  });

  it('оставляет команду без спринтов в квартале строкой с нулями', () => {
    const [q1] = divisionQuarters([
      { rapidViewId: 1, team: 'A', sprints: [s(10, '2026-01-12', [issue('A-1', 3)])] },
      { rapidViewId: 2, team: 'B', sprints: [] },
    ]);
    expect(q1.teams.map((t) => [t.team, t.sprintCount, t.completedSp, t.spPerSprint])).toEqual([
      ['A', 1, 3, 3],
      ['B', 0, 0, null],
    ]);
  });

  it('считает SP за спринт как среднее по спринтам команды в квартале', () => {
    const [q] = divisionQuarters([
      {
        rapidViewId: 1,
        team: 'A',
        sprints: [s(12, '2026-02-09', [issue('A-1', 10)]), s(11, '2026-01-26', [issue('A-2', 5)])],
      },
    ]);
    expect(q.teams[0].spPerSprint).toBe(7.5);
  });

  it('пустой вход — пустой результат', () => {
    expect(divisionQuarters([])).toEqual([]);
  });
});

describe('divisionQuarters — закрытие', () => {
  it('процент закрытия дивизиона — от сумм по всем командам', () => {
    const [q] = divisionQuarters([
      { rapidViewId: 1, team: 'A', sprints: [s(10, '2026-01-12', [issue('A-1', 6, [], 5)])] },
      { rapidViewId: 2, team: 'B', sprints: [s(20, '2026-01-12', [issue('B-1', 4, [], 5)])] },
    ]);
    expect(q.teams.map((t) => t.completion.ofStart)).toEqual([1.2, 0.8]);
    expect(q.completion).toMatchObject({ startPoints: 10, completedPoints: 10, ofStart: 1 });
  });
});
