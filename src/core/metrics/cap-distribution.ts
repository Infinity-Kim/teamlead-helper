import {
  CAP_BUCKETS,
  DEFAULT_CAP_TARGETS,
  type BacklogIssue,
  type BucketStat,
  type CapBucket,
  type CapSlice,
  type CapTargets,
  type Sprint,
  type SprintCapStats,
} from '@/core/domain';

/**
 * Расчёт распределения story points по CAP-бакетам для спринта — ЧИСТАЯ функция.
 * Без chrome.*, fetch, Vue. Тестируется обычным Vitest. Слой: core/metrics (DDD Domain Service).
 *
 * Правила (согласованы с пользователем):
 *  - учитываем только задачи верхнего уровня (hierarchyLevel === 0) — как Jira в шапке спринта;
 *  - бакет берётся с самой задачи; без CAP-лейбла → Unlabeled;
 *  - несколько CAP-лейблов на задаче → SP делятся поровну между ними;
 *  - проценты считаются от размеченного объёма (Product+Tech+Support+Unlabeled).
 */

/** Порог в процентных пунктах, выше которого перекос считается значимым (для подсветки). */
const SKEW_THRESHOLD_PP = 5;

const SLICES: CapSlice[] = [...CAP_BUCKETS, 'Unlabeled'];

/** Задачи спринта `sprintId` (верхний уровень). Если sprintId null — общий backlog (sprintIds пуст). */
export function issuesOfSprint(issues: BacklogIssue[], sprintId: number | null): BacklogIssue[] {
  return issues.filter((i) => {
    if (i.hierarchyLevel !== 0) return false;
    if (sprintId === null) return i.sprintIds.length === 0;
    return i.sprintIds.includes(sprintId);
  });
}

/**
 * Ключи задач каждого бакета (для фильтрации на доске). Чистая функция.
 * Задача попадает во все свои CAP-бакеты; без CAP-лейбла — в Unlabeled.
 */
export function issueKeysByBucket(issues: BacklogIssue[]): Record<CapSlice, string[]> {
  const map: Record<CapSlice, string[]> = {
    Product: [],
    Tech: [],
    Support: [],
    Unlabeled: [],
  };
  for (const issue of issues) {
    if (issue.capBuckets.length === 0) map.Unlabeled.push(issue.key);
    else for (const b of issue.capBuckets) map[b].push(issue.key);
  }
  return map;
}

/** Story points, разложенные по CAP-бакетам + Unlabeled. */
export type BucketPoints = Record<CapBucket, number> & { Unlabeled: number };

/**
 * Свернуть набор {бакеты, SP} в сумму SP по бакетам — ЕДИНОЕ правило раскладки:
 *  - нет CAP-бакетов → весь SP в Unlabeled;
 *  - несколько бакетов → SP делится поровну между ними;
 *  - нулевой/отрицательный SP пропускается.
 * Используется и расчётом спринта, и квартальным пайплайном (ACL мапит labels→buckets заранее).
 */
export function splitPointsByBucket(
  items: Iterable<{ buckets: CapBucket[]; points: number }>,
): BucketPoints {
  const acc: BucketPoints = { Product: 0, Tech: 0, Support: 0, Unlabeled: 0 };
  for (const { buckets, points } of items) {
    if (points <= 0) continue;
    if (buckets.length === 0) acc.Unlabeled += points;
    else for (const b of buckets) acc[b] += points / buckets.length;
  }
  return acc;
}

/** Свернуть набор задач в распределение по бакетам относительно целей. */
export function calcCapDistribution(
  sprint: Pick<Sprint, 'id' | 'name'>,
  issues: BacklogIssue[],
  targets: CapTargets = DEFAULT_CAP_TARGETS,
): SprintCapStats {
  const points = splitPointsByBucket(
    issues.map((i) => ({ buckets: i.capBuckets, points: i.storyPoints })),
  );
  const totalPoints = issues.reduce((s, i) => s + Math.max(0, i.storyPoints), 0);

  const denom = totalPoints || 1;
  const targetOf = (s: CapSlice): number | null =>
    s === 'Unlabeled' ? null : targets[s as CapBucket];

  const buckets: BucketStat[] = SLICES.map((slice) => {
    const pct = +((points[slice] / denom) * 100).toFixed(1);
    const target = targetOf(slice);
    const deltaPp = target === null ? null : +(pct - target).toFixed(1);
    return { bucket: slice, points: +points[slice].toFixed(2), pct, deltaPp };
  });

  // Самый сильный значимый перекос среди Product/Tech/Support.
  // Гейтим по РАЗМЕЧЕННОМУ объёму, а не по totalPoints: если весь SP в Unlabeled
  // (ничего не размечено), все бакеты по 0% и дают ложный максимальный «недобор» от цели.
  // Это сигнал «нет разметки» (его несёт доля Unlabeled), а не перекос распределения.
  const labeledPoints = points.Product + points.Tech + points.Support;
  let topSkew: SprintCapStats['topSkew'] = null;
  if (labeledPoints > 0) {
    for (const b of buckets) {
      if (b.deltaPp === null) continue;
      if (Math.abs(b.deltaPp) < SKEW_THRESHOLD_PP) continue;
      if (!topSkew || Math.abs(b.deltaPp) > Math.abs(topSkew.deltaPp)) {
        topSkew = { bucket: b.bucket as CapBucket, deltaPp: b.deltaPp };
      }
    }
  }

  return {
    sprintId: sprint.id,
    sprintName: sprint.name,
    totalPoints: +totalPoints.toFixed(2),
    issueCount: issues.length,
    buckets,
    topSkew,
  };
}
