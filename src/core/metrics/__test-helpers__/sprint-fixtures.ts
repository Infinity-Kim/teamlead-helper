import type { SprintReportDetail, SprintReportIssue } from '@/core/domain';

/**
 * Конструкторы доменных объектов для тестов метрик. Держим в одном месте, чтобы добавление
 * поля в SprintReportDetail не требовало правок в каждом тест-файле.
 * Слой: core/metrics (только для тестов).
 */

/** Задача отчёта. `initial` по умолчанию = points (оценка не менялась внутри спринта). */
export function issue(
  key: string,
  points: number | null,
  labels: string[] = [],
  initial?: number | null,
): SprintReportIssue {
  return {
    key,
    summary: key,
    points,
    initialPoints: initial === undefined ? points : initial,
    status: 'Готово',
    type: 'Story',
    labels,
  };
}

/**
 * Спринт-отчёт с разумными умолчаниями: completedPoints = сумма SP completed-задач,
 * carryover пуст, данные punted/added присутствуют (пустые) — то есть «здоровый» спринт.
 */
export function sprint(
  over: Partial<SprintReportDetail> & { sprintId: number; completedIssues: SprintReportIssue[] },
): SprintReportDetail {
  const completedPoints =
    over.completedPoints ?? over.completedIssues.reduce((s, i) => s + (i.points ?? 0), 0);
  const notCompletedIssues = over.notCompletedIssues ?? [];
  const notCompletedPoints =
    over.notCompletedPoints ?? notCompletedIssues.reduce((s, i) => s + (i.points ?? 0), 0);
  return {
    name: over.name ?? `S-${over.sprintId}`,
    state: 'CLOSED',
    completedInitialPoints: over.completedInitialPoints ?? completedPoints,
    allPoints: over.allPoints ?? completedPoints + notCompletedPoints,
    puntedIssues: [],
    completedInAnotherSprintIssues: [],
    addedIssueKeys: new Set<string>(),
    hasPuntedData: true,
    hasAddedData: true,
    ...over,
    completedPoints,
    notCompletedPoints,
    notCompletedIssues,
  };
}
