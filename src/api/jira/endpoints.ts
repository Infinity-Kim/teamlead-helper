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

  /**
   * История изменений задачи (переходы статусов) — для Work Item Age и cycle time.
   * Platform REST v3. fields=status обязателен (иначе тянет всё). Старый /search задепрекейчен (410),
   * поэтому changelog берём per-issue (проверено на живом API 2026-07-08).
   */
  issueChangelog: (issueKey: string) =>
    `/rest/api/3/issue/${encodeURIComponent(issueKey)}?expand=changelog&fields=status,created`,
};
