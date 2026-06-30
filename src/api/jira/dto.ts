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

/** Ответ /rest/greenhopper/1.0/sprintquery/<board>?includeFutureSprints=false. */
export interface GhSprintQueryDto {
  sprints: Array<{
    id: number;
    name: string;
    state: string; // "CLOSED" | "ACTIVE"
    sequence: number; // монотонный хронологический ключ (НЕ id!)
  }>;
}

/** Сумма-блок отчёта: value может ОТСУТСТВОВАТЬ (не null) при нулевой/неопр. сумме. */
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
}

/** Ответ /rest/greenhopper/1.0/rapid/charts/sprintreport?rapidViewId=&sprintId=. */
export interface GhSprintReportDto {
  contents: {
    completedIssuesEstimateSum: GhEstimateSum; // completed SP (для velocity)
    allIssuesEstimateSum?: GhEstimateSum; // весь объём (committed)
    completedIssues?: GhReportIssue[]; // Done-задачи — для факта по CAP-бакетам
    issuesNotCompletedInCurrentSprint?: GhReportIssue[]; // взятые, но не Done — для плана
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
