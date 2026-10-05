import type { CapBucket } from './cap';

/**
 * Доменные модели квартального capacity-баланса. Методология — см. память
 * project_quarterly_capacity_methodology (SAFe/Cagan/Cohn). Без зависимостей наружу.
 * Слой: core/domain (DDD).
 */

/** Идентификатор квартала, напр. "2026-Q2". */
export type QuarterId = string;

/**
 * Спринт для квартального учёта — СЫРЬЁ из Jira-отчёта без интерпретации (ACL не решает,
 * что считать «планом»). Done = завершённые, notDone = взятые, но не завершённые. Правило
 * «как из этого получить план» (для closed notDone не план, а перенос) живёт в core/metrics.
 */
export interface SprintRecord {
  id: number;
  name: string;
  /** ISO дата старта — по ней спринт относится к кварталу команды (team-quarter). */
  startDate: string;
  /** ACTIVE — текущий (в работе), CLOSED — факт. */
  state: 'ACTIVE' | 'CLOSED' | 'FUTURE';
  /** ФАКТ: SP завершённых (Done) задач по бакетам. У closed = весь спринт; у active = только Done. */
  points: Record<CapBucket, number>;
  unlabeledPoints: number;
  /** SP взятых, но НЕ завершённых задач по бакетам (сырьё; план выводит metrics по state). */
  notDonePoints: Record<CapBucket, number>;
  notDoneUnlabeled: number;
}

/**
 * Календарь команды (см. core/metrics/team-quarter): год начинается с первого январского
 * спринта, Q1–Q3 по 12 недель, Q4 — остаток с новогодним спринтом. Плоские данные.
 */
export interface TeamCalendar {
  /** Старт первого январского спринта по годам: год → epoch ms. */
  yearStarts: Record<number, number>;
  /** Ритм спринтов в днях: медиана шага между стартами, округлённая до недели. */
  cadenceDays: number;
}

/** Цель квартала: % Product (остальное = 100−product). Коридор ±band. */
export interface QuarterTarget {
  /** Целевой % Product (напр. 67). Остальное (Tech+Support) = 100−product. */
  productPct: number;
  /** Полуширина коридора в процентных пунктах (напр. 5 → 62–72%). */
  bandPp: number;
}

export const DEFAULT_QUARTER_TARGET: QuarterTarget = { productPct: 67, bandPp: 5 };

/** Накопительный баланс квартала (quarter-to-date). ФАКТ (только Done) + ПЛАН (с учётом взятого). */
export interface QuarterBalance {
  quarter: QuarterId;
  /** Сколько спринтов квартала уже учтено (closed + active). */
  sprintsCounted: number;
  /** Сколько спринтов квартала ещё впереди (по календарю и ритму команды). */
  sprintsLeft: number;
  /** Есть ли среди них активный спринт (тогда факт ≠ план). */
  hasActive: boolean;

  // --- ФАКТ (только завершённые/Done задачи) ---
  /** Всего SP в учёте по факту (знаменатель — кумулятивный). */
  totalPoints: number;
  /** SP Product (факт). */
  productPoints: number;
  /** SP остального (факт). */
  otherPoints: number;
  /** % Product по факту (QTD). */
  productPct: number;
  /** Отклонение факта от цели, пп. */
  deltaPp: number;
  /** Факт вне коридора. */
  outOfBand: boolean;
  /** «Долг» по факту в SP: >0 перебор Product (долг по «остальному»), <0 недобор Product. */
  productDebtSp: number;

  // --- ПЛАН (Done + взятое в активный спринт) ---
  /** Всего SP с учётом плана активного спринта. */
  plannedTotal: number;
  /** % Product по плану (как сложится квартал, если всё взятое закроют). */
  plannedProductPct: number;
  /** Отклонение плана от цели, пп. */
  plannedDeltaPp: number;
  /** План вне коридора. */
  plannedOutOfBand: boolean;
}

/**
 * С какого квартала спринты участвуют в отчёте и в модели плана: с Q4 2025 в Jira
 * проставляются CAP-метки (ранние спринты дали бы 100% «Без метки», см. проверку на живых данных).
 * Берётся квартал ЦЕЛИКОМ по календарю команды: ГГ.9.2 (старт 24.09.2025) — первый спринт
 * Q4 2025 и в отчёт попадает, 25.9.1 — нет.
 */
export const CAP_LABELS_SINCE_ISO = '2025-10-01';
