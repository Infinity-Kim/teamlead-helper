import type {
  BoardBacklog,
  QuarterId,
  SprintRecord,
  SprintReportDetail,
  SprintReportsResult,
  TeamCalendar,
} from '@/core/domain';
import {
  splitPointsByBucket,
  sprintQuarter,
  teamCalendar,
  quarterOf,
  bigTaskWorkOf,
  BIG_TASK_SP,
  PLAN_HISTORY,
  type BigTaskWork,
  type BucketPoints,
} from '@/core/metrics';
import type {
  AgileSprintDto,
  AgileSprintPageDto,
  GhBacklogDataDto,
  GhChangelogPageDto,
  GhSprintReportDto,
} from './dto';
import { currentConcurrency, jiraGetJson, jiraGetJsonRetry, mapWithConcurrency } from './client';
import { endpoints } from './endpoints';
import {
  mapIssue,
  mapSprint,
  labelsToBuckets,
  normalizeSprintState,
  mapSprintReportDetail,
  statusTransitionsOf,
} from './mappers';

type GhSprint = AgileSprintDto;

/**
 * Спринты доски в состояниях `states` (по умолчанию только закрытые) через ОФИЦИАЛЬНЫЙ Agile API, с датами.
 * Пагинация по `isLast` (НЕ по `total` — Jira Cloud его часто не отдаёт, JSWCLOUD-22101).
 *
 * Фильтр `originBoardId`: доска отдаёт и ЧУЖИЕ спринты — в выдаче board 80 реально приходят
 * спринты Web (originBoardId=16), которые иначе попали бы в отчёт ELCAS (замер 2026-07-27).
 * Спринты без originBoardId пропускаем в выдачу: поле опционально, а терять свои спринты
 * из-за его отсутствия хуже, чем изредка пустить чужой.
 */
export async function fetchBoardSprints(
  rapidViewId: number,
  states = 'closed',
): Promise<AgileSprintDto[]> {
  const out: AgileSprintDto[] = [];
  for (let startAt = 0, guard = 0; guard < MAX_SPRINT_PAGES; guard++) {
    const page = await jiraGetJsonRetry<AgileSprintPageDto>(
      endpoints.boardSprints(rapidViewId, startAt, states),
    );
    const values = page.values ?? [];
    out.push(
      ...values.filter((s) => s.originBoardId === undefined || s.originBoardId === rapidViewId),
    );
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

/** sprintreport каждого спринта через пул конкурентности; упавшие считаются в `failed`. */
async function fetchSprintReports(
  rapidViewId: number,
  recent: readonly GhSprint[],
): Promise<SprintReportsFetch> {
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
 * Спринты ТЕКУЩЕГО квартала для квартального баланса (ЗАКРЫТЫЕ + АКТИВНЫЙ) с распределением
 * completed SP по CAP-бакетам. Deep module (Agile API + sprintreport каждого).
 *
 * Текущий квартал — квартал активного спринта (без него — самого свежего) в календаре команды,
 * построенном по ВСЕЙ истории доски (team-quarter: 6-6-6-остаток). Квартал отдаётся наружу:
 * по одним спринтам квартала его не вычислить — в них нет январского спринта.
 * Отбор по датам из списка спринтов, а не «последние N»: N под одну длину спринта не подходит
 * другой, а лишние отчёты — лишние запросы.
 *
 * Активный нужен обязательно: без него факт квартала не видит закрытое в текущем спринте, «план»
 * не считается, а на стыке кварталов бар показывает прошлый квартал вместо текущего.
 *
 * Бакеты считаются по completedIssues[] отчёта (labels + currentEstimateStatistic = SP на закрытии).
 * У активного спринта completedIssues = уже закрытые в нём задачи (план в работе).
 */
export async function getQuarterSprints(rapidViewId: number): Promise<QuarterSprints | null> {
  const all = await fetchBoardSprints(rapidViewId, 'closed,active');
  const calendar = teamCalendar(all.map((s) => s.startDate));
  const current =
    all.find((s) => s.state?.toLowerCase() === 'active') ??
    all.reduce<GhSprint | undefined>(
      (a, s) => (!a || Date.parse(s.startDate ?? '') > Date.parse(a.startDate ?? '') ? s : a),
      undefined,
    );
  const quarter = current ? sprintQuarter(current.startDate, calendar) : null;
  if (!quarter) return null;
  const { ok } = await fetchSprintReports(
    rapidViewId,
    all.filter((s) => sprintQuarter(s.startDate, calendar) === quarter),
  );

  const sprints = ok
    .map(({ sprint, report }): SprintRecord => {
      // ACL только раскладывает сырьё по бакетам (SP на закрытии = currentEstimate); решение
      // «что из notDone считать планом» принимает core/metrics по state — здесь без интерпретации.
      const done = bucketizeReport(report.contents?.completedIssues);
      const notDone = bucketizeReport(report.contents?.issuesNotCompletedInCurrentSprint);
      return {
        id: sprint.id,
        name: sprint.name,
        startDate: report.sprint?.isoStartDate ?? sprint.startDate ?? '',
        // Agile API отдаёт state строчными ("closed") — нормализатор ждёт заглавные.
        state: normalizeSprintState(sprint.state?.toUpperCase()),
        points: { Product: done.Product, Tech: done.Tech, Support: done.Support },
        unlabeledPoints: done.Unlabeled,
        notDonePoints: { Product: notDone.Product, Tech: notDone.Tech, Support: notDone.Support },
        notDoneUnlabeled: notDone.Unlabeled,
      };
    })
    .filter((r) => r.startDate !== '');
  return { quarter, calendar, sprints };
}

/** Спринты текущего квартала + сам квартал и календарь команды (для «сколько осталось»). */
export interface QuarterSprints {
  quarter: QuarterId;
  calendar: TeamCalendar;
  sprints: SprintRecord[];
}

/** Полная история статусов задачи постранично (или [] при ошибке). */
async function fetchAllStatusTransitions(issueKey: string) {
  const values: NonNullable<GhChangelogPageDto['values']> = [];
  try {
    for (let startAt = 0; ;) {
      const page = await jiraGetJsonRetry<GhChangelogPageDto>(
        endpoints.issueChangelogPage(issueKey, startAt),
      );
      values.push(...(page.values ?? []));
      if (page.isLast !== false || !page.values?.length) break;
      startAt += page.values.length;
    }
  } catch {
    return [];
  }
  return statusTransitionsOf(values);
}

/**
 * Время работы над крупными задачами (≥ BIG_TASK_SP) спринтов, которые видит план
 * (последние PLAN_HISTORY отчётов, `reports` — от свежих к старым) — для разнесения их SP по
 * спринтам (sprintFlows). Крупных задач немного (≈ 1–2 на спринт), запрос на каждую.
 * Задачи без входа в рабочий статус в мапу не попадают — для них sprintFlows делит поровну.
 */
export async function getBigTaskWork(
  reports: readonly SprintReportDetail[],
  workStatuses: readonly string[],
  doneStatuses: readonly string[],
): Promise<Map<string, BigTaskWork>> {
  const keys = new Set<string>();
  for (const r of reports.slice(0, PLAN_HISTORY + 1)) {
    for (const i of [...r.completedIssues, ...r.notCompletedIssues]) {
      if ((i.points ?? 0) >= BIG_TASK_SP) keys.add(i.key);
    }
  }
  const list = [...keys];
  const works = await mapLimit(list, CHANGELOG_CONCURRENCY, async (key) =>
    bigTaskWorkOf(await fetchAllStatusTransitions(key), workStatuses, doneStatuses),
  );
  const out = new Map<string, BigTaskWork>();
  works.forEach((w, i) => w && out.set(list[i], w));
  return out;
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

/** Ограничение параллельных changelog-запросов (чтобы не залить Jira / не словить rate-limit). */
const CHANGELOG_CONCURRENCY = 6;

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
 * ВСЕ закрытые спринты доски с квартала, куда попадает `sinceIso`, ЦЕЛИКОМ (без обрезки до N) —
 * для страницы «Отчёт по спринтам». Порядок: от свежих к старым. Квартал — по календарю
 * команды из всей истории доски (team-quarter): с '2025-10-01' это весь Q4 2025, включая ГГ.9.2
 * со стартом 24.09. Спринт без даты старта отбрасывается.
 *
 * N+1 запросов идут через ПУЛ конкурентности (не Promise.all по всем) + ретрай с Retry-After —
 * чтобы не пробивать burst-лимит Jira и не терять спринты на случайных 429. Число НЕзагруженных
 * возвращается в `failed` (частичные данные), UI показывает это пользователю.
 */
export async function getBoardSprintReportsSince(
  rapidViewId: number,
  sinceIso: string,
  cached: ReadonlyMap<number, SprintReportDetail> = new Map(),
  refetch = false,
): Promise<SprintReportsResult> {
  const sinceQuarter = quarterOf(sinceIso);

  // 1) Список спринтов С ДАТАМИ — 2 запроса вместо 83 (Agile API отдаёт даты в списке).
  //    Календарь — по всем спринтам доски: январские спринты прошлых лет задают начало года.
  const all = await fetchBoardSprints(rapidViewId);
  const calendar = teamCalendar(all.map((s) => s.startDate));
  const wanted = all.filter((s) => {
    const q = sprintQuarter(s.startDate, calendar);
    return q !== null && sinceQuarter !== null && q >= sinceQuarter;
  });

  // 2) Обычно тянем только спринты, которых нет в кеше. refetch — все: метки и оценки задач
  //    правят и после закрытия спринта, а отчёт отдаёт их текущие значения. Кеш при этом
  //    остаётся запасным вариантом — спринт, не догрузившийся из-за лимита, не пропадёт.
  const missing = refetch ? wanted : wanted.filter((s) => !cached.has(s.id));

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

  return { sprints, failed, fetched, calendar };
}

export { setJiraAuth, setJiraTabTransport, hasJiraAccess } from './client';
export type { JiraAuth, JiraTabTransport } from './client';
export { JiraRequestError } from './errors';
export type { JiraError } from './errors';
