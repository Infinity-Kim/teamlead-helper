import {
  bucketForLabel,
  CAP_BUCKETS,
  type CapBucket,
  type CapSlice,
  type QuarterId,
  type SprintReportDetail,
  type SprintReportIssue,
} from '@/core/domain';
import { splitPointsByBucket, type BucketPoints } from './cap-distribution';
import { median } from './median';
import { assignQuarters } from './quarter-balance';

/**
 * Агрегаты для страницы «Отчёт по спринтам» — ЧИСТЫЕ функции (тестируются без браузера).
 * Работают поверх domain SprintReportDetail (ACL уже смапил Jira → domain). Слой: core/metrics.
 *
 * Правила (согласованы с пользователем):
 *  - CAP-раскладка спринта считается по completedIssues[] (labels + SP на закрытии);
 *  - несколько CAP-лейблов на задаче → SP делятся поровну (splitPointsByBucket);
 *  - проценты — от ВСЕГО completed, ВКЛЮЧАЯ Unlabeled (4 слайса = 100%);
 *  - спринт относится к кварталу по дате старта, целиком, не больше 6 спринтов (assignQuarters);
 *  - average velocity = медиана И среднее последних N (по умолчанию 6) completedPoints.
 */

/** Порядок слайсов на стек-полосе. */
export const CAP_SLICES: readonly CapSlice[] = [...CAP_BUCKETS, 'Unlabeled'];

/** Доля одного слайса: SP + % от общего. */
export interface SliceShare {
  slice: CapSlice;
  points: number;
  /** Доля от общего completed (вкл. Unlabeled), %. 0, если общий объём = 0. */
  pct: number;
}

/** CAP-раскладка одного спринта (или квартала) по 4 слайсам + итог. */
export interface CapBreakdown {
  /** По одному на Product/Tech/Support/Unlabeled (в этом порядке). */
  shares: SliceShare[];
  /** Всего SP в учёте (сумма всех слайсов). */
  totalPoints: number;
}

/** SP задачи для CAP-учёта: null-оценка и отрицательные → 0. */
function issuePoints(points: number | null): number {
  return typeof points === 'number' && points > 0 ? points : 0;
}

/** CAP-бакеты задачи (по её CAP-меткам). Пусто = у задачи нет CAP-метки. */
export function issueBuckets(issue: SprintReportIssue): CapBucket[] {
  return issue.labels.map(bucketForLabel).filter((b): b is CapBucket => b !== null);
}

/**
 * Относится ли задача к выбранному слайсу — для клик-фильтра таблицы.
 * Product/Tech/Support: у задачи есть соответствующий CAP-бакет.
 * Unlabeled: у задачи НЕТ ни одного CAP-бакета.
 */
export function issueInSlice(issue: SprintReportIssue, slice: CapSlice): boolean {
  const buckets = issueBuckets(issue);
  return slice === 'Unlabeled' ? buckets.length === 0 : buckets.includes(slice);
}

/** Разложить сырые SP по бакетам в проценты от их суммы (вкл. Unlabeled = 100%). */
function toBreakdown(points: BucketPoints): CapBreakdown {
  const total = points.Product + points.Tech + points.Support + points.Unlabeled;
  const denom = total || 1;
  const shares: SliceShare[] = CAP_SLICES.map((slice) => ({
    slice,
    points: +points[slice].toFixed(2),
    pct: +((points[slice] / denom) * 100).toFixed(1),
  }));
  return { shares, totalPoints: +total.toFixed(2) };
}

/** CAP-раскладка ОДНОГО спринта по его completedIssues (labels → buckets → доли). */
export function sprintCapBreakdown(detail: SprintReportDetail): CapBreakdown {
  const points = splitPointsByBucket(
    detail.completedIssues.map((i) => ({
      buckets: issueBuckets(i),
      points: issuePoints(i.points),
    })),
  );
  return toBreakdown(points);
}

/** CAP-раскладка НАБОРА спринтов (для агрегата квартала): суммируем задачи всех спринтов. */
export function aggregateCapBreakdown(details: SprintReportDetail[]): CapBreakdown {
  const points = splitPointsByBucket(
    details.flatMap((d) =>
      d.completedIssues.map((i) => ({ buckets: issueBuckets(i), points: issuePoints(i.points) })),
    ),
  );
  return toBreakdown(points);
}

/** Один квартал: id, его спринты (от свежих к старым), агрегат CAP-микса и сумма SP. */
export interface QuarterGroup {
  quarter: QuarterId;
  sprints: SprintReportDetail[];
  breakdown: CapBreakdown;
  /** Сумма completedPoints спринтов квартала (green-bar SP, а не доля-раскладка). */
  completedSp: number;
}

/**
 * Сгруппировать спринты одной команды по кварталу (assignQuarters). Спринт без валидной
 * даты старта пропускается. Кварталы возвращаются в хронологии от НОВЫХ к старым
 * (свежий квартал сверху). Внутри квартала спринты — как пришли (ожидается «свежие→старые»).
 */
export function groupSprintsByQuarter(details: SprintReportDetail[]): QuarterGroup[] {
  const map = new Map<QuarterId, SprintReportDetail[]>();
  const quarterBy = assignQuarters(details, (d) => d.isoStartDate);
  for (const d of details) {
    const q = quarterBy.get(d);
    if (!q) continue;
    const list = map.get(q);
    if (list) list.push(d);
    else map.set(q, [d]);
  }
  return [...map.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0)) // "2025-Q4" > "2025-Q1" лексикографически
    .map(([quarter, sprints]) => ({
      quarter,
      sprints,
      breakdown: aggregateCapBreakdown(sprints),
      completedSp: +sprints.reduce((s, d) => s + d.completedPoints, 0).toFixed(2),
    }));
}

/** Медиана и среднее velocity по последним `window` спринтам (completedPoints). */
export interface VelocitySummary {
  /** Медиана completedPoints последних `window` спринтов (null, если спринтов нет). */
  median: number | null;
  /** Среднее арифметическое тех же спринтов (null, если спринтов нет). */
  mean: number | null;
  /** Сколько спринтов реально попало в окно (≤ window). */
  count: number;
}

/**
 * Average velocity: берём последние `window` спринтов по СВЕЖЕСТИ. Ожидается, что `details`
 * упорядочены от свежих к старым (как отдаёт API) → берём первые `window`. Если порядок иной,
 * это не ломает медиану/среднее по последним N лишь при уже отсортированном входе — вызывающий
 * гарантирует порядок. Считаем и медиану (устойчива к выбросам), и среднее (буквальный «average»).
 */
export function velocitySummary(details: SprintReportDetail[], window = 6): VelocitySummary {
  const vs = details.slice(0, Math.max(0, window)).map((d) => d.completedPoints);
  if (vs.length === 0) return { median: null, mean: null, count: 0 };
  const mean = +(vs.reduce((a, b) => a + b, 0) / vs.length).toFixed(1);
  return { median: median(vs), mean, count: vs.length };
}
