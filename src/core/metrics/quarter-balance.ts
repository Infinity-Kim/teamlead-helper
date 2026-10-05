import {
  DEFAULT_QUARTER_TARGET,
  type CapBucket,
  type QuarterBalance,
  type QuarterId,
  type QuarterTarget,
  type SprintRecord,
  type TeamCalendar,
} from '@/core/domain';
import { sprintsLeftInQuarter } from './team-quarter';

/**
 * Квартальный capacity-баланс — ЧИСТЫЕ функции (тестируются без браузера).
 * Методология (см. память project_quarterly_capacity_methodology):
 *  - спринт относится к кварталу команды по дате старта, целиком (team-quarter: 6-6-6-остаток);
 *  - знаменатель цели — КУМУЛЯТИВНЫЙ по кварталу;
 *  - цель 67/33 — коридор (target band ±bandPp), а не жёсткая квота;
 *  - сколько спринтов в квартале осталось — из календаря команды и её ритма.
 * Слой: core/metrics (DDD Domain Service).
 */

/** Календарный квартал даты (UTC). "2026-Q2". Граница импорта отчёта задаётся так. */
export function quarterOf(isoDate: string): QuarterId | null {
  const d = new Date(isoDate);
  if (Number.isNaN(d.getTime())) return null;
  const q = Math.floor(d.getUTCMonth() / 3) + 1;
  return `${d.getUTCFullYear()}-Q${q}`;
}

/** Следующий квартал: "2026-Q4" → "2027-Q1". */
export function nextQuarter(q: QuarterId): QuarterId {
  const [y, n] = q.split('-Q').map(Number);
  return n === 4 ? `${y + 1}-Q1` : `${y}-Q${n + 1}`;
}

const factProduct = (s: SprintRecord) => s.points.Product;
const factTotal = (s: SprintRecord) =>
  s.points.Product + s.points.Tech + s.points.Support + s.unlabeledPoints;

/**
 * ПЛАН спринта = факт + взятое-но-не-Done, но ТОЛЬКО для активного спринта: у него notDone — это
 * прогноз («если закроют»). У закрытого notDone — перенесённые задачи (история), не план, поэтому
 * план = факт. Это доменное правило методологии, а не форма Jira — потому живёт здесь, под тестом.
 */
const planProduct = (s: SprintRecord) =>
  s.points.Product + (s.state === 'ACTIVE' ? s.notDonePoints.Product : 0);
const planTotal = (s: SprintRecord) => {
  if (s.state !== 'ACTIVE') return factTotal(s);
  const nd = s.notDonePoints;
  return factTotal(s) + nd.Product + nd.Tech + nd.Support + s.notDoneUnlabeled;
};

/** Сколько спринтов квартала ещё впереди — после самого свежего спринта, по ритму команды. */
function lastSprintsLeft(sprints: readonly SprintRecord[], cal: TeamCalendar | undefined): number {
  if (!cal || sprints.length === 0) return 0;
  const last = sprints.reduce((a, s) =>
    Date.parse(s.startDate) > Date.parse(a.startDate) ? s : a,
  );
  return sprintsLeftInQuarter(last.startDate, cal);
}

/** Один срез баланса (факт ИЛИ план): % Product, отклонение от цели, вне коридора, долг. */
function deriveSlice(product: number, total: number, target: QuarterTarget) {
  const pct = +((product / (total || 1)) * 100).toFixed(1);
  const deltaPp = +(pct - target.productPct).toFixed(1);
  return {
    total: +total.toFixed(1),
    productPct: pct,
    deltaPp,
    outOfBand: Math.abs(deltaPp) > target.bandPp,
    // Долг: >0 Product перебран (добрать «остального»), <0 недобран.
    productDebtSp: +((deltaPp / 100) * total).toFixed(1),
  };
}

/**
 * Накопительный баланс одного квартала. Считаем ДВА среза одним кодом (deriveSlice):
 *  - ФАКТ: только завершённые (Done) задачи — у активного спринта это лишь закрытое в нём;
 *  - ПЛАН: с учётом всего взятого в активный спринт (как сложится квартал, если всё закроют).
 */
export function calcQuarterBalance(
  quarter: QuarterId,
  sprints: SprintRecord[],
  target: QuarterTarget = DEFAULT_QUARTER_TARGET,
  /** Календарь команды — для «сколько спринтов квартала впереди». Без него 0. */
  calendar?: TeamCalendar,
): QuarterBalance {
  const sum = (f: (s: SprintRecord) => number) => sprints.reduce((a, s) => a + f(s), 0);
  const fact = deriveSlice(sum(factProduct), sum(factTotal), target);
  const plan = deriveSlice(sum(planProduct), sum(planTotal), target);

  return {
    quarter,
    sprintsCounted: sprints.length,
    sprintsLeft: lastSprintsLeft(sprints, calendar),
    hasActive: sprints.some((s) => s.state === 'ACTIVE'),
    totalPoints: fact.total,
    productPoints: +sum(factProduct).toFixed(1),
    otherPoints: +(fact.total - sum(factProduct)).toFixed(1),
    productPct: fact.productPct,
    deltaPp: fact.deltaPp,
    outOfBand: fact.outOfBand,
    productDebtSp: fact.productDebtSp,
    plannedTotal: plan.total,
    plannedProductPct: plan.productPct,
    plannedDeltaPp: plan.deltaPp,
    plannedOutOfBand: plan.outOfBand,
  };
}

/**
 * Какой % Product нужен в ОСТАВШИХСЯ спринтах квартала, чтобы кумулятив сошёлся в цель.
 * forecastRemainingSp — прогноз объёма оставшихся спринтов (напр. медиана × число оставшихся).
 * Возвращает null, если оставшихся спринтов/объёма нет.
 */
export function requiredProductPctForRemainder(
  balance: QuarterBalance,
  forecastRemainingSp: number,
  target: QuarterTarget = DEFAULT_QUARTER_TARGET,
): number | null {
  if (forecastRemainingSp <= 0) return null;
  const quarterTotal = balance.totalPoints + forecastRemainingSp;
  // Сколько Product нужно за весь квартал, минус уже набранное → на остаток.
  const neededProductTotal = (target.productPct / 100) * quarterTotal;
  const neededInRemainder = neededProductTotal - balance.productPoints;
  const pct = (neededInRemainder / forecastRemainingSp) * 100;
  return +Math.max(0, Math.min(100, pct)).toFixed(1);
}

/** Бакеты «остального» (всё кроме Product) — для пояснений в UI. */
export const OTHER_BUCKETS: CapBucket[] = ['Tech', 'Support'];
