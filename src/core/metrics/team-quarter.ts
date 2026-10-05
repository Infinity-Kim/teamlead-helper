import type { QuarterId, TeamCalendar } from '@/core/domain';

/**
 * Год команды и кварталы спринтов — ЧИСТЫЕ функции. Слой: core/metrics.
 *
 * Правило «6-6-6-остаток» (согласовано с пользователем 2026-10-05, проверено на живых
 * данных ELCAS/POC/Web/CRASH за 2025–2026):
 *  - год команды начинается со старта её первого январского спринта (ELCAS: 15.01.2025,
 *    14.01.2026 — после новогоднего спринта);
 *  - Q1, Q2, Q3 — ровно по 12 недель (6 двухнедельных спринтов), спринт относится к кварталу
 *    по дате СТАРТА, целиком;
 *  - Q4 — всё остальное до следующего январского спринта, вместе с новогодним спринтом
 *    (12.2, 26–27 дней). Поэтому в Q4 обычно 7 спринтов, в остальных — 6.
 *
 * Почему так, а не календарь. В году 52 недели = 26 двухнедельных слотов, а 13 недель
 * календарного квартала вмещают 6.5 спринта — по любому календарному правилу (по старту,
 * по окончанию, по закрытию) какой-то квартал получает 7, и ГДЕ — зависит от сдвига дат на
 * 1–2 дня: ГГ.9.2 (старт 23–24.09) уходил в Q3, ГГ.6.2 (конец 30.06) — то в Q2, то в Q3.
 * У команды договорённость другая: 9.2 — первый спринт Q4, а лишний спринт года — всегда
 * новогодний, в Q4. Ровно так устроены финансовые календари 52/53 недели (4-4-5): лишняя
 * неделя года всегда уходит в последний квартал.
 *
 * Границы — по ВРЕМЕНИ, а не по счёту спринтов: недельные спринты (CRASH, осень 2025) и
 * пропуски не сдвигают кварталы каскадом, как это делал прежний лимит «не больше 6».
 *
 * Поля Jira, которые проверялись и НЕ годятся источником: «Quarter by Sprint»
 * (customfield_14199) — автоматизация по дате старта (25.9.2 → Q3), с июля 2026 не ведётся,
 * и это объединение кварталов всех спринтов задачи; «Quarter» (Q3Y26) — кварталы эпиков,
 * не спринтов. В объекте спринта квартала нет.
 */

const DAY_MS = 86_400_000;

/** Длина Q1–Q3: 12 недель = 6 двухнедельных спринтов. */
const QUARTER_MS = 84 * DAY_MS;

/** Год ритма: 52 недели. Им выводится старт года, если январского спринта в истории нет. */
const YEAR_MS = 364 * DAY_MS;

/**
 * Допуск на границе: спринт стартует в тот же день недели, но в разное время и иногда на
 * день-два раньше/позже (26.4.1 стартовал 08.04 в 08:18, граница — 08.04 в 08:00).
 */
const TOLERANCE_MS = 3 * DAY_MS;

/** Ритм по умолчанию, если по датам его не вывести. */
const DEFAULT_CADENCE_DAYS = 14;

/** Календарь по датам старта ВСЕХ известных спринтов доски (чем полнее история, тем лучше). */
export function teamCalendar(starts: readonly (string | undefined)[]): TeamCalendar {
  const times = starts
    .map((s) => Date.parse(s ?? ''))
    .filter((t) => !Number.isNaN(t))
    .sort((a, b) => a - b);

  const yearStarts: Record<number, number> = {};
  for (const t of times) {
    const d = new Date(t);
    if (d.getUTCMonth() === 0 && yearStarts[d.getUTCFullYear()] === undefined) {
      yearStarts[d.getUTCFullYear()] = t;
    }
  }

  // Ритм — по последним шагам: у команды он менялся (CRASH: неделя → две).
  const steps = times
    .slice(1)
    .map((t, i) => (t - times[i]) / DAY_MS)
    .slice(-6)
    .sort((a, b) => a - b);
  const mid = steps.length ? steps[Math.floor(steps.length / 2)] : DEFAULT_CADENCE_DAYS;
  const cadenceDays = Math.max(7, Math.round(mid / 7) * 7);

  return { yearStarts, cadenceDays };
}

/**
 * Старт года команды. Нет январского спринта этого года в истории — выводим от ближайшего
 * известного года шагом 52 недели (ритм привязан к дню недели: 14.01.2026 − 364 дня =
 * 15.01.2025, ровно как у ELCAS). null — у доски нет ни одного январского спринта.
 */
function yearStart(year: number, cal: TeamCalendar): number | null {
  const own = cal.yearStarts[year];
  if (own !== undefined) return own;
  const known = Object.keys(cal.yearStarts).map(Number);
  if (known.length === 0) return null;
  const nearest = known.reduce((a, b) => (Math.abs(b - year) < Math.abs(a - year) ? b : a));
  return cal.yearStarts[nearest] + (year - nearest) * YEAR_MS;
}

/** Календарный квартал даты (UTC) — запасной вариант для доски без январских спринтов. */
function calendarQuarter(t: number): QuarterId {
  const d = new Date(t);
  return `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
}

/** Год команды и номер квартала (0..3) для момента старта спринта. */
function locate(
  t: number,
  cal: TeamCalendar,
): { year: number; index: number; base: number } | null {
  let year = new Date(t).getUTCFullYear();
  let base = yearStart(year, cal);
  if (base === null) return null;
  // Старт до первого январского спринта (новогодний/начало января) — Q4 прошлого года.
  if (t < base - TOLERANCE_MS) {
    year -= 1;
    base = yearStart(year, cal)!;
  }
  const index = Math.min(3, Math.floor((t - base + TOLERANCE_MS) / QUARTER_MS));
  return { year, index, base };
}

/** Квартал спринта по дате его СТАРТА в календаре команды. null — даты нет. */
export function sprintQuarter(start: string | undefined, cal: TeamCalendar): QuarterId | null {
  const t = Date.parse(start ?? '');
  if (Number.isNaN(t)) return null;
  const at = locate(t, cal);
  return at ? `${at.year}-Q${at.index + 1}` : calendarQuarter(t);
}

/**
 * Сколько ещё спринтов команды СТАРТУЕТ в квартале после спринта со стартом `lastStart`
 * (по ритму команды). 0 — это последний спринт квартала.
 *
 * В Q4 спринты стартуют только до ~20 декабря: последний из них — новогодний, двойной
 * длины, следующий стартует уже в январе (новый год команды).
 */
export function sprintsLeftInQuarter(lastStart: string | undefined, cal: TeamCalendar): number {
  const t = Date.parse(lastStart ?? '');
  if (Number.isNaN(t)) return 0;
  const at = locate(t, cal);
  if (!at) return 0;
  const end =
    at.index < 3 ? at.base + (at.index + 1) * QUARTER_MS - TOLERANCE_MS : Date.UTC(at.year, 11, 24); // старты после 24.12 не бывает — новогодний уже идёт
  const step = cal.cadenceDays * DAY_MS;
  return Math.max(0, Math.ceil((end - t) / step) - 1);
}

/** Отнести спринты к кварталам календаря команды. Спринт без даты старта пропускается. */
export function assignQuarters<T>(
  items: readonly T[],
  startOf: (t: T) => string | undefined,
  cal: TeamCalendar = teamCalendar(items.map(startOf)),
): Map<T, QuarterId> {
  const out = new Map<T, QuarterId>();
  for (const item of items) {
    const q = sprintQuarter(startOf(item), cal);
    if (q) out.set(item, q);
  }
  return out;
}
