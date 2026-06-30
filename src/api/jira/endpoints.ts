/**
 * Пути Jira REST. Изолирует знание об URL-структуре API.
 * Слой: api/jira.
 */
export const endpoints = {
  /** Полный срез backlog доски (спринты + задачи) — то, чем Jira рисует backlog. */
  backlogData: (rapidViewId: number) =>
    `/rest/greenhopper/1.0/xboard/plan/v2/backlog/data` +
    `?operation=fetchBacklogData&rapidViewId=${rapidViewId}`,

  /** Список спринтов доски (без будущих) — для истории velocity. */
  sprintQuery: (rapidViewId: number) =>
    `/rest/greenhopper/1.0/sprintquery/${rapidViewId}?includeFutureSprints=false`,

  /** Отчёт по закрытому спринту (содержит completed SP). */
  sprintReport: (rapidViewId: number, sprintId: number) =>
    `/rest/greenhopper/1.0/rapid/charts/sprintreport` +
    `?rapidViewId=${rapidViewId}&sprintId=${sprintId}`,
};
