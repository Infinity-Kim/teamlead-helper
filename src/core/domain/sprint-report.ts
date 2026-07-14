/**
 * Доменная модель детального отчёта по спринту — для страницы «задачи спринта».
 * Источник — Jira Sprint Report (greenhopper): completed SP = green bar (current estimate),
 * initial = оценка на старте. Задачи с их SP/статусом/типом — как в Jira retrospective.
 * Слой: core/domain.
 */

/** Одна задача в отчёте спринта (completed или carryover). */
export interface SprintReportIssue {
  key: string;
  summary: string;
  /** SP на момент закрытия (currentEstimate). null — оценка не проставлена. */
  points: number | null;
  status: string;
  type: string;
  /** CAP_*-метка (капаситет-бакет), если проставлена. */
  labels: string[];
}

/** Детальный отчёт по одному спринту. */
export interface SprintReportDetail {
  sprintId: number;
  /** Имя спринта, напр. "ELCAS-26.6.1". */
  name: string;
  state: string; // CLOSED | ACTIVE | FUTURE
  isoStartDate?: string;
  isoCompleteDate?: string;
  /** Completed SP на закрытии (current, = green bar Jira). Главное число. */
  completedPoints: number;
  /** Completed SP на старте (initial). Разница с completedPoints = переоценка. */
  completedInitialPoints: number;
  /** SP взятых, но не завершённых (carryover). */
  notCompletedPoints: number;
  completedIssues: SprintReportIssue[];
  notCompletedIssues: SprintReportIssue[];
}

/** Отчёты одной команды/доски. */
export interface BoardSprintReports {
  rapidViewId: number;
  /** Имя команды для UI, напр. "El Casino". */
  team: string;
  /** Спринты от новых к старым. */
  sprints: SprintReportDetail[];
}
