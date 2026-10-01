/**
 * Размер страницы Agile API. Значения >50 Jira игнорирует (JSWSERVER-15503),
 * поэтому 50 — и максимум, и оптимум.
 */
export const AGILE_PAGE_SIZE = 50;

/**
 * Пути Jira REST. Изолирует знание об URL-структуре API.
 * Слой: api/jira.
 */
export const endpoints = {
  /** Полный срез backlog доски (спринты + задачи) — то, чем Jira рисует backlog. */
  backlogData: (rapidViewId: number) =>
    `/rest/greenhopper/1.0/xboard/plan/v2/backlog/data` +
    `?operation=fetchBacklogData&rapidViewId=${rapidViewId}`,

  /**
   * Список спринтов доски — ОФИЦИАЛЬНЫЙ Agile API (в отличие от остальных путей здесь).
   * Отдаёт startDate/endDate/completeDate ПРЯМО В СПИСКЕ, поэтому фильтр по дате делается
   * до запросов за отчётами (раньше даты знал только sprintreport → грузили все 83 спринта
   * доски ради 12 нужных, проверено на живом API 2026-07-27).
   *
   * Нюансы (замерены на board 80): maxResults>50 игнорируется (JSWSERVER-15503) — всегда 50;
   * `total` может отсутствовать (JSWCLOUD-22101) → пагинация ТОЛЬКО по `isLast`;
   * порядок фиксирован (state, затем позиция в backlog), параметра сортировки нет.
   */
  boardSprints: (boardId: number, startAt: number, states = 'closed') =>
    `/rest/agile/1.0/board/${boardId}/sprint` +
    `?state=${states}&maxResults=${AGILE_PAGE_SIZE}&startAt=${startAt}`,

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
