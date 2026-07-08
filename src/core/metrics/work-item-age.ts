import { median } from './median';

/**
 * Work Item Age — сколько времени задача уже «в работе» (от входа в in-progress до сейчас).
 * ЛИДИРУЮЩИЙ индикатор риска (Vacanti «Actionable Agile»): показывает застревающие задачи ДО
 * того, как они попадут в carryover. Порог = типичный cycle time команды (перцентиль истории).
 * ЧИСТЫЕ функции (тестируются без браузера). Слой: core/metrics (DDD Domain Service).
 *
 * Возраст меряется в WALL-CLOCK времени, включая ожидание/блок (research 2026-07-08: именно там
 * живёт непредсказуемость; из worklog/active-часов мерить НЕЛЬЗЯ).
 */

const MS_PER_DAY = 86_400_000;

/** In-progress задача с моментом старта (входа в первый рабочий статус). */
export interface AgingIssue {
  key: string;
  /** ISO-момент входа в in-progress (первый переход из To-Do в рабочий статус). */
  startedAt: string;
}

/** Один переход статуса из changelog: когда и в какой статус. */
export interface StatusTransition {
  at: string;
  to: string;
}

/**
 * Момент, когда задача РЕАЛЬНО начала выполняться = первый вход в один из «рабочих» статусов.
 * Для ELCAS доски 80 рабочие = DEV/В работе (Ready for DEV — ещё очередь, не считается — решение
 * пользователя 2026-07-08). Имена сравниваем регистронезависимо. null — задача ещё не в работе.
 *
 * ЧИСТАЯ функция: и для возраста активных задач, и для cycle time закрытых (start→done).
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

/**
 * Cycle time закрытой задачи в днях: от первого входа в рабочий статус до входа в «done»-статус.
 * Нужен для порогов возраста (медиана/p85 истории). null — не нашли начала или завершения.
 */
export function cycleTimeDays(
  transitions: readonly StatusTransition[],
  workStatuses: readonly string[],
  doneStatuses: readonly string[],
): number | null {
  const start = firstWorkStart(transitions, workStatuses);
  if (start === null) return null;
  const done = new Set(doneStatuses.map((s) => s.toLowerCase()));
  const startMs = new Date(start).getTime();
  const doneEntry = transitions
    .filter((t) => done.has(t.to.toLowerCase()))
    .map((t) => new Date(t.at).getTime())
    .filter((ms) => !Number.isNaN(ms) && ms >= startMs)
    .sort((a, b) => a - b)[0];
  if (doneEntry === undefined) return null;
  return +Math.max(0, (doneEntry - startMs) / MS_PER_DAY).toFixed(1);
}

/** Категория «здоровья» возраста задачи относительно порогов cycle time. */
export type AgeSeverity = 'normal' | 'aging' | 'stuck';

export interface IssueAge {
  key: string;
  /** Возраст в днях (wall-clock, округл. до 0.1). */
  ageDays: number;
  severity: AgeSeverity;
}

/**
 * Пороги возраста, выведенные из истории cycle time команды (перцентили — self-referential, не фикс).
 * aging = дольше типичного (p50/median); stuck = дольше «долгого хвоста» (p85).
 */
export interface AgeThresholds {
  /** Медиана cycle time команды, дни (граница normal→aging). */
  agingDays: number;
  /** p85 cycle time команды, дни (граница aging→stuck). */
  stuckDays: number;
}

/** Перцентиль отсортированного массива (0..1), nearest-rank. null — пусто. */
function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx];
}

/**
 * Пороги возраста из истории cycle time (в днях) закрытых задач.
 * agingDays = медиана, stuckDays = p85. Требует ≥1 наблюдения; иначе null (порогов нет → не красим).
 */
export function ageThresholdsFromHistory(cycleTimesDays: readonly number[]): AgeThresholds | null {
  if (cycleTimesDays.length === 0) return null;
  const m = median(cycleTimesDays);
  const p85 = percentile(cycleTimesDays, 0.85);
  if (m === null || p85 === null) return null;
  return {
    agingDays: +m.toFixed(1),
    // stuck не может быть ниже aging (при малой истории p85≈median) — держим ≥ aging.
    stuckDays: +Math.max(p85, m).toFixed(1),
  };
}

/** Возраст одной задачи в днях на момент `now` (wall-clock). Отрицательный (старт в будущем) → 0. */
export function ageDaysOf(startedAt: string, now: number): number | null {
  const t = new Date(startedAt).getTime();
  if (Number.isNaN(t)) return null;
  return +Math.max(0, (now - t) / MS_PER_DAY).toFixed(1);
}

/** Классифицировать возраст относительно порогов. Без порогов → всегда normal. */
export function severityOf(ageDays: number, thresholds: AgeThresholds | null): AgeSeverity {
  if (!thresholds) return 'normal';
  if (ageDays >= thresholds.stuckDays) return 'stuck';
  if (ageDays >= thresholds.agingDays) return 'aging';
  return 'normal';
}

/**
 * Возраст всех in-progress задач + классификация относительно порогов из истории.
 * `now` инъектируется (не из Date.now внутри) — чистая функция, детерминируемый тест.
 * Возвращает только aging/stuck (normal не подсвечиваем), отсортированные по убыванию возраста.
 */
export function calcAgingIssues(
  issues: readonly AgingIssue[],
  thresholds: AgeThresholds | null,
  now: number,
): IssueAge[] {
  const out: IssueAge[] = [];
  for (const i of issues) {
    const ageDays = ageDaysOf(i.startedAt, now);
    if (ageDays === null) continue;
    const severity = severityOf(ageDays, thresholds);
    if (severity === 'normal') continue;
    out.push({ key: i.key, ageDays, severity });
  }
  return out.sort((a, b) => b.ageDays - a.ageDays);
}
