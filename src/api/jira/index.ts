import type {
  BoardBacklog,
  SprintOutcome,
  SprintRecord,
  SprintReportDetail,
} from '@/core/domain';
import {
  splitPointsByBucket,
  firstWorkStart,
  cycleTimeDays,
  type AgingIssue,
  type BucketPoints,
} from '@/core/metrics';
import type {
  GhBacklogDataDto,
  GhIssueChangelogDto,
  GhSprintQueryDto,
  GhSprintReportDto,
} from './dto';
import { jiraGetJson, jiraGetJsonRetry } from './client';
import { endpoints } from './endpoints';
import {
  mapIssue,
  mapSprint,
  labelsToBuckets,
  normalizeSprintState,
  extractStatusTransitions,
  mapSprintReportDetail,
} from './mappers';

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

/**
 * Итоги последних `lastN` ЗАКРЫТЫХ спринтов — для reliability (say/do), throughput и forecast.
 * Хронологический порядок: СВЕЖИЕ В КОНЦЕ (тренды/спарклайны читаются слева направо по времени).
 *
 * committed = allIssuesEstimateSum (baseline на планировании — заморожен; поздние добавления
 * в него не входят, это семантика Jira Velocity Chart). completed = completedIssuesEstimateSum.
 * completedCount = число Done-задач (throughput — счёт, не SP; устойчив к инфляции оценок).
 */
export async function getSprintOutcomes(
  rapidViewId: number,
  lastN: number,
): Promise<SprintOutcome[]> {
  const reports = await fetchRecentSprintReports(rapidViewId, lastN, (s) => s.state === 'CLOSED');
  return reports
    .map(({ sprint, report }): SprintOutcome => {
      const c = report.contents;
      // carryover = взятые, но не завершённые задачи (переносятся дальше): в SP И в задачах.
      const notDone = c?.issuesNotCompletedInCurrentSprint ?? [];
      const carryoverPoints = notDone.reduce(
        (sum, i) => sum + (i.currentEstimateStatistic?.statFieldValue?.value ?? 0),
        0,
      );
      return {
        id: sprint.id,
        name: sprint.name,
        committedPoints: c?.allIssuesEstimateSum?.value ?? 0,
        completedPoints: c?.completedIssuesEstimateSum?.value ?? 0,
        completedCount: c?.completedIssues?.length ?? 0,
        carryoverPoints: +carryoverPoints.toFixed(1),
        carryoverCount: notDone.length,
      };
    })
    .reverse(); // fetchRecentSprintReports отдаёт от свежих к старым — разворачиваем в хронологию
}

/** Переходы статусов одной задачи через changelog (или [] при ошибке — не роняем весь расчёт). */
async function fetchStatusTransitions(issueKey: string) {
  const dto = await jiraGetJsonRetry<GhIssueChangelogDto>(endpoints.issueChangelog(issueKey)).catch(
    () => null,
  );
  return dto ? extractStatusTransitions(dto) : [];
}

/**
 * Прогнать `items` через async `fn` с ОГРАНИЧЕННОЙ конкурентностью (пул воркеров).
 * Changelog — это N запросов; Promise.all над сотней задач залил бы Jira и словил rate-limit.
 * Сохраняет порядок результатов. Упавший элемент — вызов fn сам решает (у нас: [] / null).
 */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** Равномерная выборка ≤`max` элементов (каждый k-й) — для дешёвого сэмпла истории. */
function sample<T>(items: readonly T[], max: number): T[] {
  if (items.length <= max) return [...items];
  const step = items.length / max;
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(items[Math.floor(i * step)]);
  return out;
}

/**
 * Задачи активного спринта, которые СЕЙЧАС в работе, с моментом входа в первый рабочий статус —
 * для Work Item Age. `workStatuses` = имена статусов «реальной работы» (ELCAS: DEV/В работе; НЕ
 * Ready for DEV — это очередь, решение пользователя). Возраст считает core/metrics по `startedAt`.
 *
 * N+1 запросов (changelog на каждую in-progress задачу) — вызывать фоном. Задачи без найденного
 * старта работы (ещё не начинались) отсеиваются.
 */
export async function getAgingIssues(
  rapidViewId: number,
  activeSprintId: number,
  workStatuses: readonly string[],
): Promise<AgingIssue[]> {
  const backlog = await getBoardBacklog(rapidViewId);
  const inProgress = backlog.issues.filter(
    (i) =>
      i.hierarchyLevel === 0 &&
      i.sprintIds.includes(activeSprintId) &&
      i.statusCategory === 'indeterminate',
  );

  const results = await mapLimit(inProgress, CHANGELOG_CONCURRENCY, async (issue) => {
    const transitions = await fetchStatusTransitions(issue.key);
    const startedAt = firstWorkStart(transitions, workStatuses);
    return startedAt ? { key: issue.key, startedAt } : null;
  });
  return results.filter((r): r is AgingIssue => r !== null);
}

/**
 * История cycle time (дни, start=вход в рабочий статус → done) по завершённым задачам последних
 * `lastN` закрытых спринтов — для порогов возраста (медиана=aging, p85=stuck). N+1 запросов.
 * Берём completedIssues отчётов и тянем changelog каждой. Незавершённые по данным changelog — null, отсев.
 */
/** Макс. задач для расчёта порогов cycle time (сэмпл: медиана/p85 стабильны и на ~50). */
const CYCLE_HISTORY_SAMPLE = 48;
/** Ограничение параллельных changelog-запросов (чтобы не залить Jira / не словить rate-limit). */
const CHANGELOG_CONCURRENCY = 6;

export async function getCycleTimeHistory(
  rapidViewId: number,
  lastN: number,
  workStatuses: readonly string[],
  doneStatuses: readonly string[],
): Promise<number[]> {
  const reports = await fetchRecentSprintReports(rapidViewId, lastN, (s) => s.state === 'CLOSED');
  const allKeys = reports.flatMap(({ report }) =>
    (report.contents?.completedIssues ?? []).map((i) => i.key),
  );
  // Не тянем changelog для ВСЕХ завершённых (их сотни) — равномерный сэмпл + пул воркеров.
  const keys = sample(allKeys, CYCLE_HISTORY_SAMPLE);
  const cycleTimes = await mapLimit(keys, CHANGELOG_CONCURRENCY, async (key) => {
    const transitions = await fetchStatusTransitions(key);
    return cycleTimeDays(transitions, workStatuses, doneStatuses);
  });
  return cycleTimes.filter((d): d is number => d !== null);
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

/**
 * Детальные отчёты последних `lastN` ЗАКРЫТЫХ спринтов доски — для страницы sprint-отчёта.
 * Каждый спринт: completed SP (current = green bar) + список completed/carryover задач
 * с summary/status/type. Источник — Jira Sprint Report (данные точные, как в retrospective).
 * Deep module: наружу domain SprintReportDetail[], внутри спрятан greenhopper.
 */
export async function getBoardSprintReports(
  rapidViewId: number,
  lastN: number,
): Promise<SprintReportDetail[]> {
  const reports = await fetchRecentSprintReports(rapidViewId, lastN, (s) => s.state === 'CLOSED');
  return reports.map(({ report }) => mapSprintReportDetail(report));
}

/**
 * ВСЕ закрытые спринты доски со стартом ≥ `sinceIso` (без обрезки до N) — для страницы
 * «Отчёт по спринтам» с квартальной группировкой. Порядок: от свежих к старым (по sequence).
 * Фильтр по дате — на domain-объекте (isoStartDate), т.к. sprintquery дат не отдаёт, они
 * приходят в sprintreport. Спринт без валидной isoStartDate отбрасывается (нельзя отнести к кварталу).
 *
 * N+1 запросов (по sprintreport на каждый закрытый спринт) — на реальной доске это десятки
 * параллельных запросов; jiraGetJsonRetry страхует от спорадических отказов Jira.
 */
export async function getBoardSprintReportsSince(
  rapidViewId: number,
  sinceIso: string,
): Promise<SprintReportDetail[]> {
  const since = Date.parse(sinceIso);
  const reports = await fetchRecentSprintReports(
    rapidViewId,
    Number.MAX_SAFE_INTEGER,
    (s) => s.state === 'CLOSED',
  );
  return reports
    .map(({ report }) => mapSprintReportDetail(report))
    .filter((d) => {
      if (!d.isoStartDate) return false;
      const t = Date.parse(d.isoStartDate);
      return !Number.isNaN(t) && t >= since;
    });
}

export { setJiraAuth } from './client';
export type { JiraAuth } from './client';
export { JiraRequestError } from './errors';
export type { JiraError } from './errors';
