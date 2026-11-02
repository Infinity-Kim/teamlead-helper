/**
 * Переходы статусов задачи и момент начала работы — ЧИСТЫЕ функции. Слой: core/metrics.
 * Нужны плану: крупные задачи разносятся по спринтам по времени работы (bigTaskWorkOf).
 */

/** Один переход статуса из changelog: когда и в какой статус. */
export interface StatusTransition {
  at: string;
  to: string;
}

/**
 * Момент, когда задача РЕАЛЬНО начала выполняться = первый вход в один из «рабочих» статусов.
 * Для ELCAS доски 80 рабочие = DEV/В работе (Ready for DEV — ещё очередь, не считается — решение
 * пользователя 2026-07-08). Имена сравниваем регистронезависимо. null — задача ещё не в работе.
 */
export function firstWorkStart(
  transitions: readonly StatusTransition[],
  workStatuses: readonly string[],
): string | null {
  const work = new Set(workStatuses.map((s) => s.toLowerCase()));
  const entries = transitions
    .filter((t) => work.has(t.to.toLowerCase()))
    .map((t) => ({ at: t.at, ms: new Date(t.at).getTime() }))
    .filter((t) => !Number.isNaN(t.ms))
    .sort((a, b) => a.ms - b.ms);
  return entries.length ? entries[0].at : null;
}
