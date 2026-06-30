/**
 * Доменные модели для фичи CAP-распределения (capacity по бакетам тимлида).
 * Без зависимостей наружу. Слой: core/domain (DDD).
 */

/** Три капасити-бакета + «не размечено». */
export const CAP_BUCKETS = ['Product', 'Tech', 'Support'] as const;
export type CapBucket = (typeof CAP_BUCKETS)[number];
/** Расширенный набор для отображения (бакеты + Unlabeled). */
export type CapSlice = CapBucket | 'Unlabeled';

/**
 * Канонические Jira-лейблы CAP-бакетов — ЕДИНСТВЕННЫЙ источник истины. Регистр как в Jira.
 * Прямую и обратную карты выводим отсюда, чтобы не держать параллельные копии (см. ниже).
 */
export const BUCKET_TO_CAP_LABEL: Record<CapBucket, string> = {
  Product: 'CAP_Product',
  Tech: 'CAP_Tech',
  Support: 'CAP_Support',
};

/** Все CAP-лейблы (в порядке бакетов). */
export const ALL_CAP_LABELS = CAP_BUCKETS.map((b) => BUCKET_TO_CAP_LABEL[b]);

/**
 * Лейбл (в любом регистре) → бакет. Маппер нормализует к нижнему регистру, поэтому ключи lowercase.
 * Выводится из BUCKET_TO_CAP_LABEL — добавление бакета правится в одном месте.
 */
export const CAP_LABEL_TO_BUCKET: Record<string, CapBucket> = Object.fromEntries(
  CAP_BUCKETS.map((b) => [BUCKET_TO_CAP_LABEL[b].toLowerCase(), b]),
);

/** Бакет по Jira-лейблу (любой регистр) или null, если это не CAP-лейбл. */
export function bucketForLabel(label: string): CapBucket | null {
  return CAP_LABEL_TO_BUCKET[label.toLowerCase()] ?? null;
}

/** Задача backlog в доменных терминах (после маппинга из Jira-DTO). */
export interface BacklogIssue {
  id: number;
  key: string;
  /** Story points (0 если не оценено). */
  storyPoints: number;
  /** CAP-лейблы задачи, уже нормализованные к бакетам (может быть несколько). */
  capBuckets: CapBucket[];
  /** Id спринтов, к которым привязана задача (пусто = в общем backlog). */
  sprintIds: number[];
  /** Уровень иерархии: 0 = задача верхнего уровня (Story/Bug/…), >0 = подзадача. */
  hierarchyLevel: number;
}

/** Спринт. */
export interface Sprint {
  id: number;
  name: string;
  state: 'ACTIVE' | 'FUTURE' | 'CLOSED';
  startDate?: string;
  endDate?: string;
}

/** Полный срез доски: спринты + задачи. */
export interface BoardBacklog {
  sprints: Sprint[];
  issues: BacklogIssue[];
}

/** Целевое распределение по бакетам (в процентах, сумма = 100). */
export interface CapTargets {
  Product: number;
  Tech: number;
  Support: number;
}

/** Дефолт: 67% Product, остальное поровну между Tech и Support. */
export const DEFAULT_CAP_TARGETS: CapTargets = {
  Product: 67,
  Tech: 16.5,
  Support: 16.5,
};

/** Статистика одного бакета внутри спринта. */
export interface BucketStat {
  bucket: CapSlice;
  /** Сумма story points. */
  points: number;
  /** Доля от размеченного объёма, %. */
  pct: number;
  /** Дельта от цели в процентных пунктах (только для Product/Tech/Support). null для Unlabeled. */
  deltaPp: number | null;
}

/** Свёрнутое распределение спринта по бакетам — то, что рисует виджет. */
export interface SprintCapStats {
  sprintId: number;
  sprintName: string;
  /** Всего SP в учёте (верхний уровень). */
  totalPoints: number;
  /** Кол-во задач в учёте. */
  issueCount: number;
  /** По одному на Product/Tech/Support/Unlabeled (в этом порядке). */
  buckets: BucketStat[];
  /** Самый сильный перекос: бакет + знак (для подсветки). null если в пределах нормы. */
  topSkew: { bucket: CapBucket; deltaPp: number } | null;
}
