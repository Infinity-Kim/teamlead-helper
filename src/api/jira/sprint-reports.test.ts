import { describe, it, expect, afterEach } from 'vitest';
import { getBoardSprintReportsSince, getQuarterSprints, setJiraTabTransport } from './index';
import { setJiraAuth } from './client';
import type { SprintReportDetail } from '@/core/domain';

/** Фейковая Jira через транспорт вкладки: один закрытый спринт, метку задаче уже поставили. */
function fakeJira(opts: { reportFails?: boolean } = {}) {
  const calls: string[] = [];
  setJiraAuth(null);
  setJiraTabTransport(async (path) => {
    calls.push(path);
    if (path.includes('/rest/agile/1.0/board/80/sprint')) {
      const values = [{ id: 1, name: 'S1', state: 'closed', startDate: '2026-07-02T10:00:00Z' }];
      return { ok: true, status: 200, body: JSON.stringify({ isLast: true, values }) };
    }
    if (opts.reportFails) return { ok: false, status: 401, body: '' };
    const issue = {
      key: 'ELCAS-1',
      labels: ['CAP_Product'],
      currentEstimateStatistic: { statFieldValue: { value: 1 } },
    };
    const body = {
      sprint: { id: 1, name: 'S1', state: 'CLOSED', isoStartDate: '2026-07-02T10:00:00Z' },
      contents: { completedIssues: [issue], completedIssuesEstimateSum: { value: 1 } },
    };
    return { ok: true, status: 200, body: JSON.stringify(body) };
  });
  return calls;
}

/** Закешированный отчёт того же спринта — снимок ДО того, как задаче поставили метку. */
const stale = new Map<number, SprintReportDetail>([
  [
    1,
    {
      sprintId: 1,
      name: 'S1',
      state: 'CLOSED',
      isoStartDate: '2026-07-02T10:00:00Z',
      completedPoints: 1,
      completedInitialPoints: 1,
      notCompletedPoints: 0,
      allPoints: 1,
      completedIssues: [
        {
          key: 'ELCAS-1',
          summary: '',
          points: 1,
          initialPoints: 1,
          status: '',
          type: '',
          labels: [],
        },
      ],
      notCompletedIssues: [],
      puntedIssues: [],
      completedInAnotherSprintIssues: [],
      addedIssueKeys: new Set(),
      hasPuntedData: true,
      hasAddedData: true,
    },
  ],
]);

afterEach(() => setJiraTabTransport(null));

describe('getBoardSprintReportsSince — кеш и «Обновить»', () => {
  it('без refetch берёт закешированный отчёт и не ходит за ним в сеть', async () => {
    const calls = fakeJira();
    const r = await getBoardSprintReportsSince(80, '2025-10-01', stale);
    expect(r.sprints[0].completedIssues[0].labels).toEqual([]);
    expect(calls.some((c) => c.includes('sprintreport'))).toBe(false);
  });

  it('refetch перезапрашивает закешированный спринт — поправленная метка подтягивается', async () => {
    fakeJira();
    const r = await getBoardSprintReportsSince(80, '2025-10-01', stale, true);
    expect(r.sprints[0].completedIssues[0].labels).toEqual(['CAP_Product']);
    expect(r.fetched.has(1)).toBe(true);
  });

  it('refetch при сбое запроса оставляет спринт из кеша, а не теряет его', async () => {
    fakeJira({ reportFails: true });
    const r = await getBoardSprintReportsSince(80, '2025-10-01', stale, true);
    expect(r.sprints).toHaveLength(1);
    expect(r.failed).toBe(1);
  });
});

describe('getBoardSprintReportsSince — граница импорта: Q4 2025 целиком', () => {
  it('ELCAS-25.9.2 (старт 24.09) входит в Q4 и в отчёт, 25.9.1 — нет', async () => {
    const reported: string[] = [];
    setJiraAuth(null);
    setJiraTabTransport(async (path) => {
      if (path.includes('/rest/agile/1.0/board/80/sprint')) {
        // Январский спринт задаёт начало года команды: Q4 начинается через 36 недель, 24.09.
        const values = [
          { id: 1, name: 'ELCAS-25.1.1', state: 'closed', startDate: '2025-01-15T08:49:00Z' },
          { id: 2, name: 'ELCAS-25.9.1', state: 'closed', startDate: '2025-09-11T08:00:00Z' },
          { id: 3, name: 'ELCAS-25.9.2', state: 'closed', startDate: '2025-09-24T08:28:00Z' },
        ];
        return { ok: true, status: 200, body: JSON.stringify({ isLast: true, values }) };
      }
      reported.push(path);
      const body = {
        sprint: {
          id: 3,
          name: 'ELCAS-25.9.2',
          state: 'CLOSED',
          isoStartDate: '2025-09-24T08:28:00Z',
        },
        contents: {},
      };
      return { ok: true, status: 200, body: JSON.stringify(body) };
    });
    const r = await getBoardSprintReportsSince(80, '2025-10-01');
    expect(r.sprints.map((s) => s.name)).toEqual(['ELCAS-25.9.2']);
    expect(reported).toHaveLength(1);
    expect(new Date(r.calendar.yearStarts[2025]).toISOString().slice(0, 10)).toBe('2025-01-15');
  });
});

describe('getQuarterSprints — активный спринт в квартальном балансе', () => {
  it('запрашивает closed+active и отдаёт активный спринт с его закрытыми и взятыми SP', async () => {
    const calls: string[] = [];
    setJiraAuth(null);
    setJiraTabTransport(async (path) => {
      calls.push(path);
      if (path.includes('/rest/agile/1.0/board/80/sprint')) {
        const values = [
          // Январский спринт задаёт год команды: Q4 2026 начинается 23.09.
          { id: 9, name: 'S0', state: 'closed', startDate: '2026-01-14T08:22:00Z' },
          { id: 1, name: 'S1', state: 'closed', startDate: '2026-09-09T10:00:00Z' },
          { id: 2, name: 'S2', state: 'active', startDate: '2026-09-23T10:00:00Z' },
        ];
        return { ok: true, status: 200, body: JSON.stringify({ isLast: true, values }) };
      }
      const id = path.includes('sprintId=2') ? 2 : 1;
      const est = (value: number) => ({ statFieldValue: { value } });
      const body = {
        sprint: {
          id,
          name: `S${id}`,
          isoStartDate: id === 2 ? '2026-09-23T10:00:00Z' : '2026-09-09T10:00:00Z',
        },
        contents: {
          completedIssues: [
            { key: `K-${id}`, labels: ['CAP_Product'], currentEstimateStatistic: est(3) },
          ],
          issuesNotCompletedInCurrentSprint: [
            { key: `N-${id}`, labels: ['CAP_Tech'], currentEstimateStatistic: est(5) },
          ],
        },
      };
      return { ok: true, status: 200, body: JSON.stringify(body) };
    });

    const res = await getQuarterSprints(80);
    const records = res!.sprints;

    expect(calls.find((c) => c.includes('/board/80/sprint'))).toContain('state=closed,active');
    // S1 — последний спринт Q3, январский S0 — Q1: в баланс Q4 их отчёты не нужны.
    expect(res!.quarter).toBe('2026-Q4');
    expect(calls.some((c) => c.includes('sprintId=1') || c.includes('sprintId=9'))).toBe(false);
    const active = records.find((r) => r.state === 'ACTIVE');
    expect(active?.id).toBe(2);
    expect(active?.points.Product).toBe(3);
    expect(active?.notDonePoints.Tech).toBe(5);
  });
});
