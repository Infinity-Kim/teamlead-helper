import { describe, it, expect, afterEach } from 'vitest';
import { getBigTaskWork, setJiraTabTransport } from './index';
import { setJiraAuth } from './client';
import type { SprintReportDetail, SprintReportIssue } from '@/core/domain';

const issue = (key: string, points: number): SprintReportIssue => ({
  key,
  summary: '',
  points,
  initialPoints: points,
  status: '',
  type: '',
  labels: [],
});

const report = (p: Partial<SprintReportDetail>): SprintReportDetail => ({
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
});

/** Фейковая Jira: changelog любой задачи - вход в DEV 01.09 и «Done» 10.09. */
function fakeJira(fail: ReadonlySet<string> = new Set()) {
  const calls: string[] = [];
  setJiraAuth(null);
  setJiraTabTransport(async (path) => {
    const key = decodeURIComponent(path.split('/issue/')[1].split('/')[0]);
    calls.push(key);
    if (fail.has(key)) return { ok: false, status: 403, body: '' };
    const values = [
      { created: '2026-09-01T08:00:00Z', items: [{ field: 'status', toString: 'DEV' }] },
      { created: '2026-09-10T08:00:00Z', items: [{ field: 'status', toString: 'Done' }] },
    ];
    return { ok: true, status: 200, body: JSON.stringify({ isLast: true, values }) };
  });
  return calls;
}

afterEach(() => setJiraTabTransport(null));

const reports = [
  report({
    completedIssues: [issue('A-1', 3), issue('A-2', 2)],
    notCompletedIssues: [issue('A-3', 5)],
  }),
];

describe('getBigTaskWork - порог 3 SP и кэш истории закрытых задач', () => {
  it('без кэша качает задачи от 3 SP; в fetchedClosed - только закрытые', async () => {
    const calls = fakeJira();
    const r = await getBigTaskWork(reports, ['DEV'], ['Done']);
    expect(calls.sort()).toEqual(['A-1', 'A-3']);
    expect([...r.work.keys()].sort()).toEqual(['A-1', 'A-3']);
    expect([...r.fetchedClosed.keys()]).toEqual(['A-1']);
    expect(r.work.get('A-1')).toEqual({
      startedAt: '2026-09-01T08:00:00Z',
      doneAt: '2026-09-10T08:00:00Z',
    });
  });

  it('закрытая задача из кэша не запрашивается, незакрытая - всегда', async () => {
    const calls = fakeJira();
    const cached = new Map([
      ['A-1', [{ at: '2026-08-20T08:00:00Z', to: 'DEV' }]],
      ['A-3', [{ at: '2026-08-20T08:00:00Z', to: 'DEV' }]],
    ]);
    const r = await getBigTaskWork(reports, ['DEV'], ['Done'], cached);
    expect(calls).toEqual(['A-3']);
    expect(r.work.get('A-1')?.startedAt).toBe('2026-08-20T08:00:00Z');
    expect(r.work.get('A-3')?.startedAt).toBe('2026-09-01T08:00:00Z');
    expect(r.fetchedClosed.size).toBe(0);
  });

  it('упавший запрос не попадает в кэш: задачу скачаем в следующий раз', async () => {
    fakeJira(new Set(['A-1']));
    const r = await getBigTaskWork(reports, ['DEV'], ['Done']);
    expect(r.fetchedClosed.size).toBe(0);
    expect(r.work.has('A-1')).toBe(false);
  });
});
