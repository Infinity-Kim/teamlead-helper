import {
  DEFAULT_QUARTER_TARGET,
  SPRINTS_PER_QUARTER,
  type CapBucket,
  type QuarterBalance,
  type QuarterId,
  type QuarterTarget,
  type SprintRecord,
} from '@/core/domain';

/**
 * Квартальный capacity-баланс — ЧИСТЫЕ функции (тестируются без браузера).
 * Методология (см. память project_quarterly_capacity_methodology):
 *  - спринт относится к кварталу ПО ДАТЕ СТАРТА, целиком;
 *  - знаменатель цели — КУМУЛЯТИВНЫЙ по кварталу;
 *  - цель 67/33 — коридор (target band ±bandPp), а не жёсткая квота;
 *  - квартал = 6 спринтов (для прогресса/прогноза остатка).
 * Слой: core/metrics (DDD Domain Service).
 */

/** Квартал даты по СТАРТУ (календарный, UTC). "2026-Q2". */
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

/**
 * Отнести спринты ОДНОЙ команды к кварталам: по дате старта, но не больше SPRINTS_PER_QUARTER
 * спринтов в квартале — седьмой и дальше уходят в следующий квартал.
 *
 * Почему не чистый календарь: квартал команды = 6 двухнедельных спринтов, а 13 недель
 * календарного квартала вмещают 6.5. Спринт, стартующий в последнюю неделю квартала,
 * по календарю стал бы седьмым спринтом уходящего квартала, хотя это первый спринт нового
 * (живые данные: ELCAS-26.9.1 закрыт 23.09 — шестой в Q3, спринт со старта 23.09 — первый в Q4).
 * На всей истории с Q4 2025 правило даёт те же кварталы, что календарь: переносов не было.
 *
 * Спринт без валидной даты старта в результат не попадает.
 */
export function assignQuarters<T>(
  items: readonly T[],
  startOf: (t: T) => string | undefined,
): Map<T, QuarterId> {
  const dated = items
    .map((item) => ({ item, t: Date.parse(startOf(item) ?? '') }))
    .filter((x) => !Number.isNaN(x.t))
    .sort((a, b) => a.t - b.t);

  const out = new Map<T, QuarterId>();
  const count = new Map<QuarterId, number>();
  let prev: QuarterId | null = null;
  for (const { item, t } of dated) {
    let q = quarterOf(new Date(t).toISOString())!;
    // Квартал не может идти раньше квартала предыдущего спринта: если туда уже переносили,
    // следующий спринт продолжает тот же квартал, а не возвращается в календарный.
    if (prev && q < prev) q = prev;
    while ((count.get(q) ?? 0) >= SPRINTS_PER_QUARTER) q = nextQuarter(q);
    count.set(q, (count.get(q) ?? 0) + 1);
    out.set(item, q);
    prev = q;
  }
  return out;
}

/** Сгруппировать спринты одной доски по кварталу (см. assignQuarters). */
export function groupByQuarter(sprints: SprintRecord[]): Map<QuarterId, SprintRecord[]> {
  const map = new Map<QuarterId, SprintRecord[]>();
  const quarterBy = assignQuarters(sprints, (x) => x.startDate);
  for (const s of sprints) {
    const q = quarterBy.get(s);
    if (!q) continue;
    (map.get(q) ?? map.set(q, []).get(q)!).push(s);
  }
  return map;
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
): QuarterBalance {
  const sum = (f: (s: SprintRecord) => number) => sprints.reduce((a, s) => a + f(s), 0);
  const fact = deriveSlice(sum(factProduct), sum(factTotal), target);
  const plan = deriveSlice(sum(planProduct), sum(planTotal), target);

  return {
    quarter,
    sprintsCounted: sprints.length,
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

/** Сколько спринтов квартала осталось (из 6). */
export function sprintsRemaining(sprintsCounted: number): number {
  return Math.max(0, SPRINTS_PER_QUARTER - sprintsCounted);
}

/** Бакеты «остального» (всё кроме Product) — для пояснений в UI. */
export const OTHER_BUCKETS: CapBucket[] = ['Tech', 'Support'];
