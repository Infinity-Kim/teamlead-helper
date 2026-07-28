import {
  CAP_LABEL_TO_BUCKET,
  type BacklogIssue,
  type Sprint,
  type SprintReportIssue,
  type SprintReportDetail,
} from '@/core/domain';
import type { StatusTransition } from '@/core/metrics';
import type {
  AgileSprintDto,
  GhBacklogIssueDto,
  GhEstimateSum,
  GhIssueChangelogDto,
  GhSprintDto,
  GhReportIssue,
  GhSprintReportDto,
} from './dto';

/**
 * Маппинг сырых greenhopper-DTO → domain. ЧИСТЫЕ функции (тестируются без браузера).
 * Здесь — и только здесь — знание, что SP лежит в estimateStatistic.statFieldValue.value,
 * а CAP-бакеты кодируются лейблами cap_*. Меняется Jira → меняется только этот файл.
 * Слой: api/jira (Anti-Corruption Layer).
 */

/** Нормализовать Jira-лейблы задачи в набор CAP-бакетов (без дублей, регистронезависимо). */
export function labelsToBuckets(labels: readonly string[] = []): BacklogIssue['capBuckets'] {
  const out = new Set<BacklogIssue['capBuckets'][number]>();
  for (const l of labels) {
    const bucket = CAP_LABEL_TO_BUCKET[l.toLowerCase()];
    if (bucket) out.add(bucket);
  }
  return [...out];
}

/** Story points из estimateStatistic (0, если нет численной оценки). */
export function extractStoryPoints(dto: GhBacklogIssueDto): number {
  const v = dto.estimateStatistic?.statFieldValue?.value;
  return typeof v === 'number' ? v : 0;
}

/** Категория статуса Jira → доменный union (неизвестное → 'unknown'). */
function normalizeStatusCategory(key: string | undefined): BacklogIssue['statusCategory'] {
  return key === 'new' || key === 'indeterminate' || key === 'done' ? key : 'unknown';
}

export function mapIssue(dto: GhBacklogIssueDto): BacklogIssue {
  return {
    id: dto.id,
    key: dto.key,
    storyPoints: extractStoryPoints(dto),
    capBuckets: labelsToBuckets(dto.labels),
    sprintIds: dto.sprintIds ?? [],
    hierarchyLevel: dto.typeHierarchyLevel,
    statusName: dto.statusName ?? '',
    statusCategory: normalizeStatusCategory(dto.status?.statusCategory?.key),
  };
}

/** Извлечь переходы статусов из changelog (только field==="status"), для age/cycle time. */
export function extractStatusTransitions(dto: GhIssueChangelogDto): StatusTransition[] {
  const histories = dto.changelog?.histories ?? [];
  return histories.flatMap((h) =>
    (h.items ?? [])
      .filter((it) => it.field === 'status' && typeof it.toString === 'string')
      .map((it) => ({ at: h.created, to: it.toString as string })),
  );
}

/** Сырой Jira-state спринта → доменный union. Неизвестное → FUTURE (консервативно: не активен). */
export function normalizeSprintState(raw: string | undefined): Sprint['state'] {
  return raw === 'ACTIVE' || raw === 'FUTURE' || raw === 'CLOSED' ? raw : 'FUTURE';
}

export function mapSprint(dto: GhSprintDto): Sprint {
  return {
    id: dto.id,
    name: dto.name,
    state: normalizeSprintState(dto.state),
    startDate: dto.startDate,
    endDate: dto.endDate,
  };
}

/**
 * Задача отчёта спринта → доменная SprintReportIssue.
 * SP берём с currentEstimateStatistic (на закрытии) — совпадает с green bar Jira;
 * fallback на estimateStatistic. null, если оценка не проставлена (не 0 — важно отличать).
 */
export function mapReportIssue(dto: GhReportIssue): SprintReportIssue {
  const raw =
    dto.currentEstimateStatistic?.statFieldValue?.value ??
    dto.estimateStatistic?.statFieldValue?.value;
  // estimateStatistic = BOS (оценка на старте спринта), currentEstimateStatistic = EOS (на закрытии).
  // Здесь БЕЗ fallback на current: подмена «нет оценки на старте» текущей оценкой превратила бы
  // задачу, добавленную по ходу спринта, в «не переоценённую» и сломала бы правило reestimate.
  const initial = dto.estimateStatistic?.statFieldValue?.value;
  return {
    key: dto.key,
    summary: dto.summary ?? '',
    points: typeof raw === 'number' ? raw : null,
    initialPoints: typeof initial === 'number' ? initial : null,
    status: dto.statusName ?? '',
    type: dto.typeName ?? '',
    labels: dto.labels ?? [],
  };
}

/**
 * SP из суммы-блока отчёта. Пустая сумма приходит как `{"text":"null"}` БЕЗ ключа `value`
 * (замер на живом API) — поэтому только `?? 0`, никакого Number(text).
 */
function sumPoints(sum: GhEstimateSum | undefined): number {
  return typeof sum?.value === 'number' ? sum.value : 0;
}

/** Отчёт спринта (contents + sprint) → доменный SprintReportDetail. */
export function mapSprintReportDetail(dto: GhSprintReportDto): SprintReportDetail {
  const c = dto.contents;
  return {
    sprintId: dto.sprint.id,
    name: dto.sprint.name,
    state: dto.sprint.state,
    isoStartDate: dto.sprint.isoStartDate,
    isoCompleteDate: dto.sprint.isoCompleteDate,
    completedPoints: sumPoints(c.completedIssuesEstimateSum),
    completedInitialPoints: sumPoints(c.completedIssuesInitialEstimateSum),
    notCompletedPoints: sumPoints(c.issuesNotCompletedEstimateSum),
    allPoints: sumPoints(c.allIssuesEstimateSum),
    completedIssues: (c.completedIssues ?? []).map(mapReportIssue),
    notCompletedIssues: (c.issuesNotCompletedInCurrentSprint ?? []).map(mapReportIssue),
    puntedIssues: (c.puntedIssues ?? []).map(mapReportIssue),
    completedInAnotherSprintIssues: (c.issuesCompletedInAnotherSprint ?? []).map(mapReportIssue),
    // Словарь {"KEY": true}, НЕ массив — см. комментарий в dto.ts.
    addedIssueKeys: new Set(Object.keys(c.issueKeysAddedDuringSprint ?? {})),
    // Отсутствие поля ≠ пустой набор: первое = нет данных, второе = выбросов не было.
    hasPuntedData: c.puntedIssues !== undefined,
    hasAddedData: c.issueKeysAddedDuringSprint !== undefined,
  };
}

/** Спринт Agile API → доменный Sprint. Состояния приходят СТРОЧНЫМИ (closed), в отличие от greenhopper. */
export function mapAgileSprint(dto: AgileSprintDto): Sprint {
  return {
    id: dto.id,
    name: dto.name,
    state: normalizeSprintState(dto.state?.toUpperCase()),
    startDate: dto.startDate,
    endDate: dto.endDate,
  };
}
