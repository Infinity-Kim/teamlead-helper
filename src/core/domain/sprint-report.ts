import type { TeamCalendar } from './quarter';

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
  /**
   * SP на момент СТАРТА спринта (estimateStatistic = BOS, beginning of sprint).
   * null — оценки на старте не было (типично для задач, добавленных по ходу спринта).
   * Разница с `points` = переоценка задачи внутри спринта.
   */
  initialPoints: number | null;
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
  /** SP взятых, но не завершённых (carryover) — из issuesNotCompletedEstimateSum. */
  notCompletedPoints: number;
  /** Весь объём спринта в SP (allIssuesEstimateSum) — знаменатель для scope-метрик. */
  allPoints: number;
  completedIssues: SprintReportIssue[];
  notCompletedIssues: SprintReportIssue[];
  /** Задачи, выброшенные из спринта после старта. Пусто ≠ отсутствие данных (см. hasPuntedData). */
  puntedIssues: SprintReportIssue[];
  /** Взяты в этот спринт, но закрыты в другом (справочно, в carryover НЕ входят). */
  completedInAnotherSprintIssues: SprintReportIssue[];
  /**
   * Ключи задач, добавленных в спринт ПОСЛЕ старта. Множество, а не массив — нужен
   * O(1) lookup при расчёте переоценки (задачу, добавленную по ходу, нельзя считать
   * переоценённой: у неё нет оценки «на старте»).
   */
  addedIssueKeys: ReadonlySet<string>;
  /**
   * Пришло ли поле puntedIssues в ответе. Отличает «выбросов не было» (ok) от
   * «Jira не отдала данные» (no-data) — без этого метрика молча деградирует в «всё хорошо».
   */
  hasPuntedData: boolean;
  /** Аналогично для issueKeysAddedDuringSprint. */
  hasAddedData: boolean;
}

/** Отчёты одной команды/доски. */
export interface BoardSprintReports {
  rapidViewId: number;
  /** Имя команды для UI, напр. "El Casino". */
  team: string;
  /** Спринты от новых к старым. */
  sprints: SprintReportDetail[];
}

/**
 * Результат загрузки спринт-отчётов доски: успешно загруженные спринты + сколько НЕ загрузилось
 * (частичные данные из-за rate-limit/сетевых сбоев). `failed>0` → показать пользователю плашку,
 * чтобы он не принял неполные квартальные цифры за полные.
 */
export interface SprintReportsResult {
  sprints: SprintReportDetail[];
  /** Сколько закрытых спринтов не удалось загрузить даже после ретраев. */
  failed: number;
  /**
   * Только те отчёты, что реально пришли из сети в этот раз (без взятых из кеша) —
   * вызывающий дописывает их в кеш. Отдаём даже при `failed>0`: частично добытое не должно
   * пропадать, иначе следующее открытие снова начнёт с нуля.
   */
  fetched: ReadonlyMap<number, SprintReportDetail>;
  /** Календарь команды по ВСЕЙ истории спринтов доски, а не только по загруженным отчётам. */
  calendar: TeamCalendar;
}
