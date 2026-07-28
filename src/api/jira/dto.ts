/**
 * Типы СЫРОГО ответа /rest/greenhopper/1.0/xboard/plan/v2/backlog/data (board 80).
 * Знание о форме Jira (estimateStatistic, customfield_*, sprintIds) живёт ТОЛЬКО здесь и в mappers.
 * Слой: api/jira (Anti-Corruption Layer — Evans).
 */

export interface GhEstimateStatistic {
  statFieldId: string; // напр. "customfield_10033"
  statFieldValue: { value?: number; text?: string };
}

export interface GhBacklogIssueDto {
  id: number;
  key: string;
  typeHierarchyLevel: number; // 0 = верхний уровень
  labels?: string[];
  sprintIds?: number[];
  estimateStatistic?: GhEstimateStatistic;
  summary?: string;
  done?: boolean;
  statusName?: string; // напр. "DEV", "Тестирование"
  status?: { statusCategory?: { key?: string } }; // key: new|indeterminate|done
}

export interface GhSprintDto {
  id: number;
  name: string;
  state: string; // "ACTIVE" | "FUTURE" | "CLOSED"
  startDate?: string;
  endDate?: string;
}

export interface GhBacklogDataDto {
  issues: GhBacklogIssueDto[];
  sprints: GhSprintDto[];
}

// --- История спринтов (для медианы velocity) ---

/**
 * Ответ ОФИЦИАЛЬНОГО /rest/agile/1.0/board/<id>/sprint?state=closed.
 * Форма проверена на живом API (board 80, 2026-07-27).
 *
 * ВАЖНО: `total` помечен опциональным намеренно — Jira Cloud его часто НЕ отдаёт
 * (JSWCLOUD-22101), поэтому пагинация строится на `isLast`, а не на `total`.
 */
export interface AgileSprintPageDto {
  isLast: boolean;
  maxResults: number;
  startAt: number;
  total?: number;
  values: AgileSprintDto[];
}

/** Спринт из Agile API. Даты — ISO 8601, приходят прямо в списке (в отличие от sprintquery). */
export interface AgileSprintDto {
  id: number;
  name: string;
  state: string; // "closed" | "active" | "future" (строчными, в отличие от greenhopper!)
  startDate?: string; // ISO. У future-спринтов может отсутствовать.
  endDate?: string;
  completeDate?: string;
  /**
   * Доска, на которой спринт СОЗДАН. Доска отдаёт и ЧУЖИЕ спринты: в выдаче board 80
   * реально приходят спринты Web с originBoardId=16 (замер 2026-07-27) — фильтровать
   * обязательно, иначе в отчёт команды попадут чужие данные.
   */
  originBoardId?: number;
  goal?: string;
}

/**
 * Сумма-блок отчёта: `value` может ОТСУТСТВОВАТЬ (не null) при нулевой/неопр. сумме.
 *
 * ЛОВУШКА (замер 2026-07-27): при пустом наборе задач приходит `{"text": "null"}` —
 * ключа `value` нет вообще, а `text` содержит СТРОКУ "null". Поэтому читать только через
 * `sum?.value ?? 0`; `Number(sum.text)` даст NaN, а проверка `value === null` не сработает.
 */
export interface GhEstimateSum {
  value?: number;
  text?: string;
}

/** Задача из completedIssues[] отчёта: labels + SP (на момент закрытия = currentEstimateStatistic). */
export interface GhReportIssue {
  key: string;
  labels?: string[];
  currentEstimateStatistic?: GhEstimateStatistic;
  estimateStatistic?: GhEstimateStatistic;
  // Поля ниже Jira отдаёт в sprintreport — нужны для страницы «задачи спринта».
  summary?: string;
  statusName?: string; // текущий статус, напр. "Готово", "Отменено"
  typeName?: string; // тип задачи, напр. "История", "Spike"
}

// --- Changelog задачи (переходы статусов) для Work Item Age / cycle time ---

/** Ответ /rest/api/3/issue/<KEY>?expand=changelog&fields=status,created. */
export interface GhIssueChangelogDto {
  fields?: {
    created?: string;
    status?: { name?: string; statusCategory?: { key?: string } };
  };
  changelog?: {
    total?: number;
    histories?: Array<{
      created: string; // момент изменения
      items?: Array<{ field: string; fromString?: string; toString?: string }>;
    }>;
  };
}

/**
 * Ответ /rest/greenhopper/1.0/rapid/charts/sprintreport?rapidViewId=&sprintId=.
 * Полный список полей contents проверен на живом API (board 80, sprint 9465, 2026-07-27).
 */
export interface GhSprintReportDto {
  contents: {
    completedIssuesEstimateSum: GhEstimateSum; // completed SP на закрытии (current) — green bar Jira
    completedIssuesInitialEstimateSum?: GhEstimateSum; // completed SP на старте (initial) — оценка при коммите
    allIssuesEstimateSum?: GhEstimateSum; // весь объём (committed)
    completedIssues?: GhReportIssue[]; // Done-задачи — для факта по CAP-бакетам
    issuesNotCompletedInCurrentSprint?: GhReportIssue[]; // взятые, но не Done — для плана
    /** Carryover в SP одним числом — Jira считает сам (раньше суммировали по задачам вручную). */
    issuesNotCompletedEstimateSum?: GhEstimateSum;
    issuesNotCompletedInitialEstimateSum?: GhEstimateSum;
    /** Задачи, ВЫБРОШЕННЫЕ из спринта после старта (блок "Issues Removed From Sprint"). */
    puntedIssues?: GhReportIssue[];
    puntedIssuesEstimateSum?: GhEstimateSum;
    puntedIssuesInitialEstimateSum?: GhEstimateSum;
    /** Взяты в этот спринт, но закрыты в другом. Jira не считает их ни в completed, ни в notCompleted. */
    issuesCompletedInAnotherSprint?: GhReportIssue[];
    issuesCompletedInAnotherSprintEstimateSum?: GhEstimateSum;
    /**
     * Ключи задач, добавленных в спринт ПОСЛЕ старта (звёздочка в родном Sprint Report).
     *
     * ЭТО СЛОВАРЬ, НЕ МАССИВ: реальное значение `{"ELCAS-12646": true}` (замер 2026-07-27).
     * Часть библиотек в интернете типизирует его как string[] — это их баг.
     * Разбирать только через Object.keys(... ?? {}).
     */
    issueKeysAddedDuringSprint?: Record<string, boolean>;
  };
  sprint: {
    id: number;
    name: string;
    state: string;
    isoStartDate?: string; // дата старта — для отнесения к кварталу
    isoEndDate?: string;
    isoCompleteDate?: string;
  };
}
