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

describe('getQuarterSprints — активный спринт в квартальном балансе', () => {
  it('запрашивает closed+active и отдаёт активный спринт с его закрытыми и взятыми SP', async () => {
    const calls: string[] = [];
    setJiraAuth(null);
    setJiraTabTransport(async (path) => {
      calls.push(path);
      if (path.includes('/rest/agile/1.0/board/80/sprint')) {
        const values = [
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

    const records = await getQuarterSprints(80, 10);

    expect(calls.find((c) => c.includes('/board/80/sprint'))).toContain('state=closed,active');
    const active = records.find((r) => r.state === 'ACTIVE');
    expect(active?.id).toBe(2);
    expect(active?.points.Product).toBe(3);
    expect(active?.notDonePoints.Tech).toBe(5);
  });
});
