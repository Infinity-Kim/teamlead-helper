import type { SprintReportDetail } from '@/core/domain';

/**
 * Процент закрытия спринта от двух баз — ЧИСТЫЕ функции. Слой: core/metrics.
 *
 * Пример: на старте взяли 75 SP, по ходу докинули — стало 85, закрыли 80, 5 переехало.
 * От взятого на старте закрыто 80/75 = 107%, от итогового объёма — 80/85 = 94%.
 * Первое отвечает «выполнили ли обещанное», второе — «успели ли всё, что в итоге было в спринте».
 *
 *  - взяли (start) = оценки НА СТАРТЕ задач, которые были в спринте к старту (Jira Velocity
 *    Chart «Commitment»): добавленные после старта исключены, выброшенные по ходу — входят,
 *    их обещали. Задача без оценки на старте даёт 0 — базы у неё не было;
 *  - стало (final) = закрытое + переехавшее к концу спринта (та же база, что у правила переноса);
 *  - закрыли = completed SP (green bar Jira).
 */

export interface SprintCompletion {
  startPoints: number;
  finalPoints: number;
  completedPoints: number;
}

/** Совокупное закрытие набора спринтов: суммы SP и доли (null — базы нет, делить нельзя). */
export interface CompletionRates extends SprintCompletion {
  /** Закрыто от взятого на старте, 0..∞ (может быть >1: докинутое тоже закрыли). */
  ofStart: number | null;
  /** Закрыто от итогового объёма, 0..1. */
  ofFinal: number | null;
}

const pts = (p: number | null) => (typeof p === 'number' && p > 0 ? p : 0);
const round1 = (n: number) => +n.toFixed(1);

export function sprintCompletion(s: SprintReportDetail): SprintCompletion {
  const atStart = [
    ...s.completedIssues,
    ...s.notCompletedIssues,
    ...s.puntedIssues,
    ...s.completedInAnotherSprintIssues,
  ].filter((i) => !s.addedIssueKeys.has(i.key));
  // Одна задача может встретиться в двух массивах — считаем её оценку один раз.
  const seen = new Set<string>();
  let start = 0;
  for (const i of atStart) {
    if (seen.has(i.key)) continue;
    seen.add(i.key);
    start += pts(i.initialPoints);
  }
  return {
    startPoints: round1(start),
    finalPoints: round1(s.completedPoints + s.notCompletedPoints),
    completedPoints: round1(s.completedPoints),
  };
}

/**
 * Закрытие за период: отношение СУММ, а не среднее процентов по спринтам — иначе маленький
 * спринт весил бы столько же, сколько большой.
 */
export function completionRates(sprints: readonly SprintReportDetail[]): CompletionRates {
  const sum = { startPoints: 0, finalPoints: 0, completedPoints: 0 };
  for (const s of sprints) {
    const c = sprintCompletion(s);
    sum.startPoints += c.startPoints;
    sum.finalPoints += c.finalPoints;
    sum.completedPoints += c.completedPoints;
  }
  const ratio = (base: number) => (base > 0 ? +(sum.completedPoints / base).toFixed(3) : null);
  return {
    startPoints: round1(sum.startPoints),
    finalPoints: round1(sum.finalPoints),
    completedPoints: round1(sum.completedPoints),
    ofStart: ratio(sum.startPoints),
    ofFinal: ratio(sum.finalPoints),
  };
}
