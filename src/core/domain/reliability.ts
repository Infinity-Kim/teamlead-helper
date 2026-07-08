/**
 * Доменные модели предсказуемости/надёжности команды по истории спринтов.
 * Метрики flow и forecast (Vacanti «Actionable Agile», Cohn, DORA, Monte Carlo).
 * Принцип (подтверждён research 2026-07-08): показывать как ТРЕНД против собственной истории,
 * НЕ как фикс-таргет и НЕ как лигу между командами (Goodhart). Без зависимостей наружу.
 * Слой: core/domain (DDD).
 */

/**
 * Итог одного ЗАКРЫТОГО спринта — сырьё истории для reliability/throughput/forecast.
 * Хронологический порядок задаёт вызывающий (свежие в конце). SP — на момент закрытия.
 */
export interface SprintOutcome {
  id: number;
  name: string;
  /** SP, взятых на планировании (baseline committed, заморожен). Jira allIssuesEstimateSum. */
  committedPoints: number;
  /** SP, доведённых до Done к концу спринта. Jira completedIssuesEstimateSum. */
  completedPoints: number;
  /** Кол-во задач, доведённых до Done (throughput; НЕ SP — устойчив к инфляции оценок). */
  completedCount: number;
  /** SP взятых, но НЕ завершённых (переносятся дальше). Jira issuesNotCompletedInCurrentSprint. */
  carryoverPoints: number;
  /** Кол-во незавершённых задач (перенос в задачах — консистентно с throughput). */
  carryoverCount: number;
}

/**
 * Say/do (commitment reliability) по истории — доля выполненного от взятого.
 * ВНИМАНИЕ (research): самая Goodhart-уязвимая метрика. Только self-referential тренд,
 * без «здоровых» порогов (банды 80-110% и т.п. провалили верификацию), не KPI, не по людям.
 */
export interface ReliabilityTrend {
  /** По спринту: доля completed/committed, 0..1 (null — спринт без committed, делить нельзя). */
  perSprint: Array<{ id: number; name: string; ratio: number | null }>;
  /** Медиана долей (устойчивее среднего). null — нет валидных спринтов. */
  medianRatio: number | null;
  /** Направление последних спринтов: 'up' | 'down' | 'flat' | null (мало данных). */
  direction: 'up' | 'down' | 'flat' | null;
}

/**
 * Throughput-тренд: кол-во завершённых задач за спринт + стабильность.
 * Коэффициент вариации (CV = σ/μ) — мера предсказуемости: чем ниже, тем ровнее команда.
 */
export interface ThroughputTrend {
  /** По спринту: id, name, completedCount. */
  perSprint: Array<{ id: number; name: string; count: number }>;
  /** Среднее число задач за спринт. null — нет спринтов. */
  mean: number | null;
  /** Медиана. null — нет спринтов. */
  median: number | null;
  /** Коэффициент вариации σ/μ (0 = идеально ровно). null — недостаточно данных/μ=0. */
  coefficientOfVariation: number | null;
}

/**
 * Carryover-тренд: сколько SP переносится из спринта в спринт (взято, но не Done).
 * Растущий хвост = команда берёт больше, чем закрывает. Показываем как тренд, не как таргет.
 */
export interface CarryoverTrend {
  /** По спринту: id, name, carryover SP + count задач. */
  perSprint: Array<{ id: number; name: string; points: number; count: number }>;
  /** Медиана переноса, SP. null — нет спринтов. */
  median: number | null;
  /** Медиана переноса в задачах (консистентно с throughput). null — нет спринтов. */
  medianCount: number | null;
  /** Направление тренда (по SP). null — мало данных. */
  direction: 'up' | 'down' | 'flat' | null;
}

/**
 * Прогноз Monte Carlo: «сколько задач реально закроем за N спринтов».
 * Диапазон, а не точка (Cohn: prediction interval, не оценка-точка). Перцентили — от
 * ПЕССИМИСТИЧНОГО к оптимистичному: p95 задач закроем почти наверняка, p50 — в половине исходов.
 */
export interface ThroughputForecast {
  /** Горизонт прогноза в спринтах. */
  horizonSprints: number;
  /** Консервативная оценка (85% исходов дают НЕ МЕНЬШЕ) — рекоменд. для commitment. */
  p85: number;
  /** Медианный исход (50%). */
  p50: number;
  /** Оптимистичная граница (15% исходов дают не меньше — «если всё сложится»). */
  p15: number;
  /** Сколько симуляций прогнали (для прозрачности). */
  runs: number;
  /**
   * Параллельный прогноз в SP (та же симуляция по истории completed SP) — для привязки к
   * capacity-балансу. null, если истории SP нет. Основа прогноза — задачи (канон), SP — справочно.
   */
  sp?: { p85: number; p50: number; p15: number } | null;
}

/** Агрегат квартальных трендов для панели (собирается в content script, рисуется в QuarterBar). */
export interface QuarterTrends {
  throughput: ThroughputTrend;
  reliability: ReliabilityTrend;
  carryover: CarryoverTrend;
}
