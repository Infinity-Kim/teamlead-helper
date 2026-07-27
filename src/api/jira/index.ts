import type {
  BoardBacklog,
  SprintOutcome,
  SprintRecord,
  SprintReportDetail,
  SprintReportsResult,
} from '@/core/domain';
import {
  splitPointsByBucket,
  firstWorkStart,
  cycleTimeDays,
  type AgingIssue,
  type BucketPoints,
} from '@/core/metrics';
import type {
  AgileSprintDto,
  AgileSprintPageDto,
  GhBacklogDataDto,
  GhIssueChangelogDto,
  GhSprintReportDto,
} from './dto';
import {
  currentConcurrency,
  jiraGetJson,
  jiraGetJsonRetry,
  mapWithConcurrency,
} from './client';
import { endpoints } from './endpoints';
import {
  mapIssue,
  mapSprint,
  labelsToBuckets,
  normalizeSprintState,
  extractStatusTransitions,
  mapSprintReportDetail,
} from './mappers';

type GhSprint = AgileSprintDto;

/**
 * Все ЗАКРЫТЫЕ спринты доски через ОФИЦИАЛЬНЫЙ Agile API, с датами.
 * Пагинация по `isLast` (НЕ по `total` — Jira Cloud его часто не отдаёт, JSWCLOUD-22101).
 *
 * Фильтр `originBoardId`: доска отдаёт и ЧУЖИЕ спринты — в выдаче board 80 реально приходят
 * спринты Web (originBoardId=16), которые иначе попали бы в отчёт ELCAS (замер 2026-07-27).
 * Спринты без originBoardId пропускаем в выдачу: поле опционально, а терять свои спринты
 * из-за его отсутствия хуже, чем изредка пустить чужой.
 */
export async function fetchClosedSprints(rapidViewId: number): Promise<AgileSprintDto[]> {
  const out: AgileSprintDto[] = [];
  for (let startAt = 0, guard = 0; guard < MAX_SPRINT_PAGES; guard++) {
    const page = await jiraGetJsonRetry<AgileSprintPageDto>(
      endpoints.boardSprints(rapidViewId, startAt),
    );
    const values = page.values ?? [];
    out.push(...values.filter((s) => s.originBoardId === undefined || s.originBoardId === rapidViewId));
    if (page.isLast || values.length === 0) break;
    startAt += values.length;
  }
  return out;
}

/** Предохранитель от бесконечной пагинации при неожиданном ответе (50×40 = 2000 спринтов). */
const MAX_SPRINT_PAGES = 40;

/** Результат orchestration истории спринтов: успешно загруженные + сколько НЕ загрузилось. */
interface SprintReportsFetch {
  ok: Array<{ sprint: GhSprint; report: GhSprintReportDto }>;
  /** Сколько отчётов не удалось получить даже после ретраев (частичные данные). */
  failed: number;
}

/**
 * Общий orchestration N+1-запросов истории: список спринтов (Agile API, с датами) → отбор →
 * sprintreport каждого через ПУЛ конкурентности (не Promise.all по всем — иначе десятки
 * одновременных запросов пробивают burst-лимит Jira → 429 → спринты пропадают).
 * Каждый запрос с ретраем (Retry-After + backoff). Упавшие НЕ теряются молча — считаются в `failed`.
 *
 * `limit` отсекает последние N спринтов ПО ДАТЕ СТАРТА (свежие первыми). Agile API отдаёт
 * закрытые спринты от старых к новым и параметра сортировки не имеет — поэтому сортируем сами.
 */
async function fetchRecentSprintReports(
  rapidViewId: number,
  limit: number,
  filter: (s: GhSprint) => boolean = () => true,
): Promise<SprintReportsFetch> {
  const all = await fetchClosedSprints(rapidViewId);
  const recent = all
    .filter(filter)
    .sort((a, b) => Date.parse(b.startDate ?? '') - Date.parse(a.startDate ?? ''))
    .slice(0, Math.max(0, limit));

  const settled = await mapWithConcurrency(recent, currentConcurrency(), (sprint) =>
    jiraGetJsonRetry<GhSprintReportDto>(endpoints.sprintReport(rapidViewId, sprint.id)),
  );

  const ok: SprintReportsFetch['ok'] = [];
  let failed = 0;
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') ok.push({ sprint: recent[i], report: r.value });
    else failed++;
  });
  return { ok, failed };
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
 * Источник: Agile API (список закрытых, с датами) → sprintreport каждого. Deep module.
 *
 * Нюанс (изучен на реальном API): completed SP = contents.completedIssuesEstimateSum.value,
 * где `value` может ОТСУТСТВОВАТЬ → 0. Хронология — по startDate из Agile API.
 */
export async function getSprintVelocities(rapidViewId: number, lastN: number): Promise<number[]> {
  const { ok } = await fetchRecentSprintReports(rapidViewId, lastN);
  return ok.map(({ report }) => report.contents?.completedIssuesEstimateSum?.value ?? 0);
}

/**
 * Спринты для квартального баланса: последние `limit` ЗАКРЫТЫХ спринтов с датой старта
 * и распределением completed SP по CAP-бакетам. Deep module (Agile API + sprintreport каждого).
 *
 * Бакеты считаются по completedIssues[] отчёта (labels + currentEstimateStatistic = SP на закрытии).
 * У активного спринта completedIssues = уже закрытые в нём задачи (план в работе).
 */
export async function getQuarterSprints(
  rapidViewId: number,
  limit: number,
): Promise<SprintRecord[]> {
  const { ok } = await fetchRecentSprintReports(rapidViewId, limit);

  return ok
    .map(({ sprint, report }): SprintRecord => {
      // ACL только раскладывает сырьё по бакетам (SP на закрытии = currentEstimate); решение
      // «что из notDone считать планом» принимает core/metrics по state — здесь без интерпретации.
      const done = bucketizeReport(report.contents?.completedIssues);
      const notDone = bucketizeReport(report.contents?.issuesNotCompletedInCurrentSprint);
      return {
        id: sprint.id,
        name: sprint.name,
        startDate: report.sprint?.isoStartDate ?? '',
        // Agile API отдаёт state строчными ("closed") — нормализатор ждёт заглавные.
        state: normalizeSprintState(sprint.state?.toUpperCase()),
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
  const { ok } = await fetchRecentSprintReports(rapidViewId, lastN);
  return ok
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
 * mapWithConcurrency, но fn НЕ должна кидать (у changelog-вызовов fn сама возвращает []/null при
 * ошибке) — поэтому разворачиваем settled в простой R[]. Единый пул воркеров — в client.ts.
 */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const settled = await mapWithConcurrency(items, limit, fn);
  return settled.map((r, i) => {
    if (r.status === 'fulfilled') return r.value;
    throw r.reason ?? new Error(`mapLimit item ${i} rejected`);
  });
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
  const { ok } = await fetchRecentSprintReports(rapidViewId, lastN);
  const allKeys = ok.flatMap(({ report }) =>
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
  const { ok } = await fetchRecentSprintReports(rapidViewId, lastN);
  return ok.map(({ report }) => mapSprintReportDetail(report));
}

/**
 * ВСЕ закрытые спринты доски со стартом ≥ `sinceIso` (без обрезки до N) — для страницы
 * «Отчёт по спринтам» с квартальной группировкой. Порядок: от свежих к старым (по sequence).
 * Фильтр по дате — на domain-объекте (isoStartDate), т.к. sprintquery дат не отдаёт, они
 * приходят в sprintreport. Спринт без валидной isoStartDate отбрасывается (нельзя отнести к кварталу).
 *
 * N+1 запросов идут через ПУЛ конкурентности (не Promise.all по всем) + ретрай с Retry-After —
 * чтобы не пробивать burst-лимит Jira и не терять спринты на случайных 429. Число НЕзагруженных
 * возвращается в `failed` (частичные данные), UI показывает это пользователю.
 */
export async function getBoardSprintReportsSince(
  rapidViewId: number,
  sinceIso: string,
  cached: ReadonlyMap<number, SprintReportDetail> = new Map(),
): Promise<SprintReportsResult> {
  const since = Date.parse(sinceIso);

  // 1) Список спринтов С ДАТАМИ — 2 запроса вместо 83 (Agile API отдаёт startDate в списке).
  const wanted = (await fetchClosedSprints(rapidViewId)).filter((s) => {
    const t = Date.parse(s.startDate ?? '');
    return !Number.isNaN(t) && t >= since;
  });

  // 2) Отчёты закрытых спринтов неизменны → тянем только те, которых нет в кеше.
  const missing = wanted.filter((s) => !cached.has(s.id));

  const settled = await mapWithConcurrency(missing, currentConcurrency(), (sprint) =>
    jiraGetJsonRetry<GhSprintReportDto>(endpoints.sprintReport(rapidViewId, sprint.id)),
  );

  const fetched = new Map<number, SprintReportDetail>();
  let failed = 0;
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      const detail = mapSprintReportDetail(r.value);
      fetched.set(missing[i].id, detail);
    } else {
      failed++;
    }
  });

  // 3) Кеш + свежедобытые, от НОВЫХ к старым (порядок, который ожидает UI и velocitySummary).
  const sprints = wanted
    .map((s) => fetched.get(s.id) ?? cached.get(s.id))
    .filter((d): d is SprintReportDetail => d !== undefined)
    .sort((a, b) => Date.parse(b.isoStartDate ?? '') - Date.parse(a.isoStartDate ?? ''));

  return { sprints, failed, fetched };
}

export { setJiraAuth, setJiraTabTransport, hasJiraAccess } from './client';
export type { JiraAuth, JiraTabTransport } from './client';
export { JiraRequestError } from './errors';
export type { JiraError } from './errors';
