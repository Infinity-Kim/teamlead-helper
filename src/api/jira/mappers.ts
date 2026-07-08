import { CAP_LABEL_TO_BUCKET, type BacklogIssue, type Sprint } from '@/core/domain';
import type { StatusTransition } from '@/core/metrics';
import type { GhBacklogIssueDto, GhIssueChangelogDto, GhSprintDto } from './dto';

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
