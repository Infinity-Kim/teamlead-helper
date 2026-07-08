import type {
  CarryoverTrend,
  ReliabilityTrend,
  SprintOutcome,
  ThroughputForecast,
  ThroughputTrend,
} from '@/core/domain';
import { median } from './median';

/**
 * Метрики предсказуемости команды по истории спринтов — ЧИСТЫЕ функции (тестируются без браузера).
 * Слой: core/metrics (DDD Domain Service). Источники методологии (research 2026-07-08):
 *  - say/do = completed/committed при ЗАМОРОЖЕННОМ baseline (Jira Velocity Chart semantics);
 *  - throughput = СЧЁТ задач (не SP) — устойчив к инфляции оценок (Vacanti «Bye velocity, hello throughput»);
 *  - forecast — Monte Carlo по историческому throughput: диапазон, не точка (Cohn prediction interval).
 * Всё — self-referential тренд, не таргет (Goodhart).
 */

/** Направление тренда по последним точкам: сравниваем среднее свежей половины со старой. */
function trendDirection(values: number[]): 'up' | 'down' | 'flat' | null {
  if (values.length < 3) return null;
  const half = Math.floor(values.length / 2);
  const older = values.slice(0, half);
  const recent = values.slice(values.length - half);
  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const diff = avg(recent) - avg(older);
  // Порог 5% от старого среднего — чтобы шум не читался как тренд.
  const eps = Math.abs(avg(older)) * 0.05;
  if (diff > eps) return 'up';
  if (diff < -eps) return 'down';
  return 'flat';
}

/**
 * Say/do (commitment reliability) по истории спринтов.
 * ratio = completed/committed (0..1); спринт без committed → null (делить нельзя, не искажаем медиану).
 * Возвращаем тренд для спарклайна — БЕЗ «здоровых» порогов (их нет по evidence).
 */
export function calcReliabilityTrend(outcomes: readonly SprintOutcome[]): ReliabilityTrend {
  const perSprint = outcomes.map((o) => ({
    id: o.id,
    name: o.name,
    ratio: o.committedPoints > 0 ? +(o.completedPoints / o.committedPoints).toFixed(3) : null,
  }));
  const valid = perSprint.map((p) => p.ratio).filter((r): r is number => r !== null);
  return {
    perSprint,
    medianRatio: median(valid),
    direction: trendDirection(valid),
  };
}

/**
 * Throughput-тренд: кол-во завершённых задач за спринт + стабильность (коэф. вариации).
 * CV = σ/μ (population stddev). Низкий CV = ровная, предсказуемая команда — база для Monte Carlo.
 */
export function calcThroughputTrend(outcomes: readonly SprintOutcome[]): ThroughputTrend {
  const perSprint = outcomes.map((o) => ({ id: o.id, name: o.name, count: o.completedCount }));
  const counts = perSprint.map((p) => p.count);
  if (counts.length === 0) {
    return { perSprint, mean: null, median: null, coefficientOfVariation: null };
  }
  const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
  const variance = counts.reduce((a, c) => a + (c - mean) ** 2, 0) / counts.length;
  const stddev = Math.sqrt(variance);
  return {
    perSprint,
    mean: +mean.toFixed(2),
    median: median(counts),
    // μ=0 (команда ничего не закрывала) → CV не определён.
    coefficientOfVariation: mean > 0 ? +(stddev / mean).toFixed(2) : null,
  };
}

/**
 * Carryover-тренд: сколько SP переносится (взято, но не Done) по спринтам + медиана и направление.
 * Растущий тренд — сигнал «берём больше, чем закрываем» (обсудить на планировании).
 */
export function calcCarryoverTrend(outcomes: readonly SprintOutcome[]): CarryoverTrend {
  const perSprint = outcomes.map((o) => ({
    id: o.id,
    name: o.name,
    points: o.carryoverPoints,
    count: o.carryoverCount,
  }));
  const points = perSprint.map((p) => p.points);
  return {
    perSprint,
    median: median(points),
    medianCount: median(perSprint.map((p) => p.count)),
    direction: trendDirection(points),
  };
}

/**
 * Monte Carlo прогноз: сколько задач закроем за `horizonSprints`, семплируя исторический throughput.
 * КАЖДАЯ симуляция = сумма `horizonSprints` случайно выбранных исторических спринтов (с возвращением).
 * Возвращаем перцентили: p85 (консервативно — для commitment), p50, p15 (оптимистично).
 *
 * rng инъектируется (по умолчанию Math.random) — для детерминированных тестов передаётся seeded PRNG.
 * Это ЧИСТАЯ функция при фиксированном rng.
 */
export function forecastThroughput(
  history: readonly number[],
  horizonSprints: number,
  runs = 10_000,
  rng: () => number = Math.random,
): ThroughputForecast | null {
  if (history.length === 0 || horizonSprints <= 0) return null;

  const outcomes: number[] = [];
  for (let i = 0; i < runs; i++) {
    let sum = 0;
    for (let s = 0; s < horizonSprints; s++) {
      const idx = Math.floor(rng() * history.length);
      sum += history[Math.min(idx, history.length - 1)];
    }
    outcomes.push(sum);
  }
  outcomes.sort((a, b) => a - b);

  // Перцентиль p: доля исходов, дающих НЕ МЕНЬШЕ. p85 → 15-й перцентиль отсортированного (низкий хвост).
  const at = (fromBottom: number) =>
    outcomes[Math.min(outcomes.length - 1, Math.max(0, Math.floor(fromBottom * outcomes.length)))];

  return {
    horizonSprints,
    p85: at(0.15), // 85% исходов ≥ этого
    p50: at(0.5),
    p15: at(0.85), // лишь 15% исходов ≥ этого
    runs,
  };
}

/**
 * Детерминированный PRNG (mulberry32) — для прогноза, воспроизводимого между рендерами и в тестах.
 * Не криптостойкий; нужен только для стабильности семплинга. seed из данных истории (не из времени).
 */
export function seededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
