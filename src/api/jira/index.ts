import type { BoardBacklog, SprintRecord } from '@/core/domain';
import { splitPointsByBucket, type BucketPoints } from '@/core/metrics';
import type { GhBacklogDataDto, GhSprintQueryDto, GhSprintReportDto } from './dto';
import { jiraGetJson, jiraGetJsonRetry } from './client';
import { endpoints } from './endpoints';
import { mapIssue, mapSprint, labelsToBuckets, normalizeSprintState } from './mappers';

type GhSprint = GhSprintQueryDto['sprints'][number];

/**
 * Общий orchestration N+1-запросов истории: sprintquery (список) → последние `limit` спринтов
 * по хронологии (`sequence`, НЕ id) → sprintreport каждого ПАРАЛЛЕЛЬНО (с ретраем; упавший — null).
 * Используют и velocity-медиана, и квартальный баланс — поэтому helper, а не копипаст.
 */
async function fetchRecentSprintReports(
  rapidViewId: number,
  limit: number,
  filter: (s: GhSprint) => boolean = () => true,
): Promise<Array<{ sprint: GhSprint; report: GhSprintReportDto }>> {
  const query = await jiraGetJson<GhSprintQueryDto>(endpoints.sprintQuery(rapidViewId));
  const recent = (query.sprints ?? [])
    .filter(filter)
    .sort((a, b) => b.sequence - a.sequence)
    .slice(0, Math.max(0, limit));

  const reports = await Promise.all(
    recent.map(async (sprint) => {
      const report = await jiraGetJsonRetry<GhSprintReportDto>(
        endpoints.sprintReport(rapidViewId, sprint.id),
      ).catch(() => null);
      return report ? { sprint, report } : null;
    }),
  );
  return reports.filter((r): r is { sprint: GhSprint; report: GhSprintReportDto } => r !== null);
}

/**
 * Шлюз к Jira backlog — DEEP MODULE: наружу один узкий метод, внутри спрятаны
 * endpoint, форма ответа и маппинг в domain (Ousterhout). Вызывается из content script.
 * Слой: api/jira (Adapter).
 */
export async function getBoardBacklog(rapidViewId: number): Promise<BoardBacklog> {
  const dto = await jiraGetJson<GhBacklogDataDto>(endpoints.backlogData(rapidViewId));
  return {
    sprints: (dto.sprints ?? []).map(mapSprint),
    issues: (dto.issues ?? []).map(mapIssue),
  };
}

/**
 * Completed story points за последние `lastN` ЗАКРЫТЫХ спринтов доски (для медианы velocity).
 * Источник: sprintquery (список) → sprintreport каждого (completed SP). Deep module.
 *
 * Нюансы (изучены на реальном API): закрытые = state==="CLOSED"; хронология по `sequence` (НЕ id);
 * completed SP = contents.completedIssuesEstimateSum.value, где `value` может ОТСУТСТВОВАТЬ → 0.
 */
export async function getSprintVelocities(rapidViewId: number, lastN: number): Promise<number[]> {
  const reports = await fetchRecentSprintReports(
    rapidViewId,
    lastN,
    (s) => s.state === 'CLOSED',
  );
  return reports.map(({ report }) => report.contents?.completedIssuesEstimateSum?.value ?? 0);
}

/**
 * Спринты для квартального баланса: последние `limit` спринтов (closed + active) с датой старта
 * и распределением completed SP по CAP-бакетам. Deep module (sprintquery + sprintreport каждого).
 *
 * Бакеты считаются по completedIssues[] отчёта (labels + currentEstimateStatistic = SP на закрытии).
 * У активного спринта completedIssues = уже закрытые в нём задачи (план в работе).
 */
export async function getQuarterSprints(
  rapidViewId: number,
  limit: number,
): Promise<SprintRecord[]> {
  const reports = await fetchRecentSprintReports(rapidViewId, limit);

  return reports
    .map(({ sprint, report }): SprintRecord => {
      // ACL только раскладывает сырьё по бакетам (SP на закрытии = currentEstimate); решение
      // «что из notDone считать планом» принимает core/metrics по state — здесь без интерпретации.
      const done = bucketizeReport(report.contents?.completedIssues);
      const notDone = bucketizeReport(report.contents?.issuesNotCompletedInCurrentSprint);
      return {
        id: sprint.id,
        name: sprint.name,
        startDate: report.sprint?.isoStartDate ?? '',
        state: normalizeSprintState(sprint.state),
        points: { Product: done.Product, Tech: done.Tech, Support: done.Support },
        unlabeledPoints: done.Unlabeled,
        notDonePoints: { Product: notDone.Product, Tech: notDone.Tech, Support: notDone.Support },
        notDoneUnlabeled: notDone.Unlabeled,
      };
    })
    .filter((r) => r.startDate !== '');
}

/** Свернуть задачи отчёта в SP по бакетам + unlabeled (SP на закрытии = currentEstimate). */
function bucketizeReport(issues: GhSprintReportDto['contents']['completedIssues']): BucketPoints {
  return splitPointsByBucket(
    (issues ?? []).map((i) => ({
      buckets: labelsToBuckets(i.labels),
      points: i.currentEstimateStatistic?.statFieldValue?.value ?? 0,
    })),
  );
}

export { JiraRequestError } from './errors';
export type { JiraError } from './errors';
