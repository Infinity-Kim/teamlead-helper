import type { SprintReportDetail } from '@/core/domain';
import { median } from './median';

/**
 * Рекомендуемый объём планирования спринта — ЧИСТЫЕ функции. Слой: core/metrics.
 *
 * ПОЧЕМУ НЕ МЕДИАНА VELOCITY. Медиана completed SP отвечает на «сколько мы обычно закрываем»,
 * а тимлид на планировании спрашивает «сколько взять на старте». Это разные числа:
 *  - договорённость команды — закрывать не меньше 80% взятого (порог переноса 20%), то есть
 *    взять можно больше, чем закроешь;
 *  - но часть взятого съедают прилёты — задачи, добавленные ПОСЛЕ старта. На планировании их
 *    ещё нет, поэтому место под них надо оставить.
 *
 * ШАГ 1. Допустимый план прошлого спринта — сколько можно было взять на старте, чтобы ровно
 * уложиться в цель при фактически закрытом и прилётах:
 *
 *   выполнение = закрыто / (план_на_старте + прилёты) ≥ цель
 *   ⇒ допустимый план = закрыто / цель − прилёты
 *
 * Считаем по каждому спринту, а не из агрегатов: закрытое и прилёты связаны (в спринт с большими
 * прилётами команда часто закрывает и больше), раздельные статистики эту связь рвут.
 *
 * ШАГ 2. Прогноз — нижний КВАНТИЛЬ допустимого плана следующего спринта (τ = 0.2: ориентир —
 * в цель 4 спринта из 5). Медиана допустимого плана промахивалась бы в каждом втором спринте,
 * минимум ломается об один провальный спринт.
 *
 * КАЛИБРОВКА (исследование 2026-10-05, живые данные ELCAS/POC/Web, честный бэктест): на деле
 * смесь укладывается в цель в 71–74% спринтов, а не в 80% — она агрессивнее номинала (короткие
 * окна и забывание дают завышенный квантиль), промахи идут сериями (тест Кристофферсена).
 * Проверены альтернативы: Стьюдент по 18 спринтам (80%, план на ~3 SP меньше), Стьюдент с общим
 * для команд разбросом (83–86%, pinball лучше), конформный квантиль, ACI, регрессия на число
 * исполнителей. Решение тимлида: оставить смесь — больший план важнее, это вызов команде.
 * Поэтому в интерфейсе — «план с вызовом» и фактическая частота попаданий, а не «4 из 5».
 *
 * ШАГ 3. Модель НЕ фиксирована — её подбирают данные команды. У команд меняются режимы
 * (ELCAS в 2025 закрывал 100–120 SP, в 2026 ~75; Web падал, потом вырос после найма), поэтому
 * ни одно окно не подходит всем и навсегда. Кандидаты:
 *  - уровень: τ-квантиль за окно 9…36 спринтов (стабильная команда, разная память);
 *  - экспоненциальное забывание: взвешенный τ-квантиль, полураспад 6 / 12 спринтов;
 *  - тренд при значимости: тест Манна–Кендалла по последним 8…18 спринтам; при |Z| ≥ 1.64 —
 *    робастная линия Тейла–Сена на шаг вперёд (наклон гасится вдвое) минус τ-квантиль остатков,
 *    иначе — уровень. Голый тренд без проверки значимости исключён: у стабильной команды он
 *    подгоняется под шум.
 * Каждый кандидат честно прогнозирует последние HEDGE_LOOKBACK спринтов (только по данным
 * до каждого из них); ошибка — pinball-loss (правильная оценка для квантильного прогноза).
 * Итог — смесь прогнозов с весами exp(−η·(ошибка − лучшая)) (Hedge). Начнёт команда расти —
 * трендовые модели станут ошибаться меньше и сами наберут вес; стабилизируется — вес уйдёт
 * к уровню. Никаких ручных переключателей.
 *
 * История — закрытые спринты с появления CAP-меток (CAP_LABELS_SINCE_ISO, как в отчёте), не
 * больше PLAN_HISTORY. Окна кандидатов длиннее истории просто берут всё, что есть; чем дольше
 * копится история, тем больше у смеси выбор.
 *
 * Выбор схемы — бэктест на живом API (ELCAS 63, Web 90, POC 24 спринта; каждый спринт
 * прогнозировался только по прошлым): ансамбль точнее фиксированного гибрида (pinball 7.88
 * против 7.97), план меняется от спринта к спринту на 3.5 SP против 5.4. Отвергнуты: окно «за
 * всё время» (план 45 SP у ELCAS при факте ~75), точка смены режима по Петтитту (хуже
 * гибрида), адаптивная калибровка квантиля ACI (план скачет 65↔79). Ограничение истории
 * датой меток почти не меняет точность: pinball 5.95 против 5.85 на той же проверке.
 *
 * «Вызов» — та же смесь при τ = 0.3: в цель ≈ 7 спринтов из 10, ориентир для амбициозного плана.
 */

/** Поток SP одного спринта, нужный для расчёта. */
export interface SprintFlow {
  /** Имя спринта — для подписей в разборе плана. */
  name?: string;
  /** Закрыто SP (green bar Jira). */
  completed: number;
  /** SP задач, добавленных после старта и оставшихся в спринте к закрытию (закрытых или переехавших). */
  added: number;
}

/** Верхняя граница истории: самое длинное окно (36) + горизонт оценки (18). */
export const PLAN_HISTORY = 54;
/** На скольких последних спринтах кандидаты соревнуются. */
const HEDGE_LOOKBACK = 18;
/** Резкость весов Hedge: разница ошибки в 1 SP → вес в e раз меньше. */
const HEDGE_ETA = 1;
/** Меньше точек под оценку — смесь не строим, берём базовый гибрид. */
const MIN_SCORED = 4;
/** Раньше этого индекса прогноз не оцениваем: истории мало. */
const MIN_HISTORY = 8;
/** Окно для отображаемого тренда — два последних квартала. */
export const TREND_WINDOW = 12;
/** Порог |Z| Манна–Кендалла (≈ p < 0.1, двусторонний). */
const TREND_Z = 1.64;
/** Квантиль рекомендации: план в цели ≈ в 80% спринтов. */
const TAU = 0.2;
/** Квантиль «вызова»: ≈ в 70% спринтов. */
const STRETCH_TAU = 0.3;
/** Меньше точек — тренд не проверяем (статистика Манна–Кендалла на коротком ряду бессмысленна). */
const MIN_TREND_POINTS = 8;

export interface PlanTrend {
  /** Наклон Тейла–Сена, SP допустимого плана за спринт. */
  slope: number;
  /** Z-статистика Манна–Кендалла. */
  z: number;
  /** Тренд значим и участвует в прогнозе. */
  active: boolean;
}

/** Вклад кандидата в смесь — для подсказки «на что сейчас опирается план». */
export interface PlanModelWeight {
  /** Человеческое имя кандидата. */
  model: string;
  /** Доля в смеси, 0..1. */
  weight: number;
  /** Его прогноз (τ = 0.2), SP. */
  forecast: number;
}

export interface PlanCapacity {
  /** Сколько SP брать на старте: план с вызовом (ориентир 4 из 5, на истории ≈ 3 из 4). */
  recommended: number;
  /** Амбициозный ориентир: в цель ≈ 7 спринтов из 10. Не меньше `recommended`. */
  stretch: number;
  /** Тренд допустимого плана за последние TREND_WINDOW. null — истории мало для проверки. */
  trend: PlanTrend | null;
  /** Кандидаты по убыванию веса (пусто — истории мало, смесь не строилась). */
  models: PlanModelWeight[];
  /** Медиана закрытого за последние 18 — прежняя «velocity», для сравнения в подсказке. */
  medianCompleted: number;
  /** Медиана прилётов за последние 18, SP. */
  medianAdded: number;
  /** Целевая доля выполнения, 0..1 (0.8 = 80%). */
  targetCompletion: number;
  /** По скольким спринтам посчитано. */
  count: number;
}

const pts = (p: number | null) => (typeof p === 'number' && p > 0 ? p : 0);
const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Поток SP спринта из отчёта. Прилёты — только среди закрытых и переехавших: именно они входят
 * в знаменатель выполнения (закрыто + перенос, как у правила переноса). Выброшенные по ходу
 * из спринта ушли и места не заняли.
 */
export function sprintFlow(s: SprintReportDetail): SprintFlow {
  const seen = new Set<string>();
  let added = 0;
  for (const i of [...s.completedIssues, ...s.notCompletedIssues]) {
    if (!s.addedIssueKeys.has(i.key) || seen.has(i.key)) continue;
    seen.add(i.key);
    added += pts(i.points);
  }
  return { name: s.name, completed: pts(s.completedPoints), added: round1(added) };
}

/** Наибольший план на старте, при котором этот спринт уложился бы в цель выполнения. */
export function allowedPlan(f: SprintFlow, targetCompletion: number): number {
  return Math.max(0, f.completed / targetCompletion - f.added);
}

/** Нижний квантиль методом ближайшего ранга (значение из выборки, без интерполяции). */
export function lowerQuantile(values: readonly number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)];
}

/** Z-статистика Манна–Кендалла (монотонный тренд), с поправкой на непрерывность. */
export function mannKendallZ(y: readonly number[]): number {
  const n = y.length;
  let s = 0;
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) s += Math.sign(y[j] - y[i]);
  if (s === 0) return 0;
  const variance = (n * (n - 1) * (2 * n + 5)) / 18;
  return (s - Math.sign(s)) / Math.sqrt(variance);
}

/** Линия Тейла–Сена: медиана попарных наклонов, устойчива к выбросам (до ~29% точек). */
export function theilSen(y: readonly number[]): { intercept: number; slope: number } {
  const slopes: number[] = [];
  for (let i = 0; i < y.length; i++) {
    for (let j = i + 1; j < y.length; j++) slopes.push((y[j] - y[i]) / (j - i));
  }
  const slope = median(slopes) ?? 0;
  const intercept = median(y.map((v, i) => v - slope * i)) ?? 0;
  return { intercept, slope };
}

/** Взвешенный нижний квантиль: наименьшее значение, накопленный вес до которого ≥ q. */
function weightedQuantile(
  values: readonly number[],
  weights: readonly number[],
  q: number,
): number {
  const pairs = values.map((v, i) => [v, weights[i]] as const).sort((a, b) => a[0] - b[0]);
  const total = weights.reduce((s, w) => s + w, 0);
  let acc = 0;
  for (const [v, w] of pairs) {
    acc += w;
    if (acc >= q * total - 1e-12) return v;
  }
  return pairs[pairs.length - 1][0];
}

/** Экспоненциальные веса: свежий спринт = 1, вес вдвое меньше каждые `halfLife` спринтов. */
function decayWeights(n: number, halfLife: number): number[] {
  return Array.from({ length: n }, (_, i) => 0.5 ** ((n - 1 - i) / halfLife));
}

/** Прогноз τ-квантиля допустимого плана следующего спринта по истории `h` (старые → свежие). */
type Forecaster = (h: readonly number[], tau: number) => number;

function levelModel(window: number): Forecaster {
  return (h, tau) => lowerQuantile(h.slice(-window), tau);
}

function decayModel(halfLife: number, window = 36): Forecaster {
  return (h, tau) => {
    const x = h.slice(-window);
    return weightedQuantile(x, decayWeights(x.length, halfLife), tau);
  };
}

/** Тренд, если значим (Манн–Кендалл), иначе уровень. */
function gatedTrendModel(window: number, trendWindow: number): Forecaster {
  return (h, tau) => {
    const y = h.slice(-trendWindow);
    if (y.length < MIN_TREND_POINTS || Math.abs(mannKendallZ(y)) < TREND_Z) {
      return lowerQuantile(h.slice(-window), tau);
    }
    const { intercept, slope } = theilSen(y);
    const residuals = y.map((v, i) => v - (intercept + slope * i));
    // Шаг вперёд с наклоном, затухающим вдвое: тренд не длится вечно, а перелёт в плане
    // дороже недолёта (перенос vs недогруз).
    return intercept + slope * (y.length - 1) + 0.5 * slope + lowerQuantile(residuals, tau);
  };
}

/** Кандидаты смеси (состав и параметры — по бэктесту, см. шапку). */
const CANDIDATES: ReadonlyArray<readonly [string, Forecaster]> = [
  ['уровень 9 спр.', levelModel(9)],
  ['уровень 12 спр.', levelModel(12)],
  ['уровень 18 спр.', levelModel(18)],
  ['уровень 24 спр.', levelModel(24)],
  ['уровень 36 спр.', levelModel(36)],
  ['забывание ½ за 6', decayModel(6)],
  ['забывание ½ за 12', decayModel(12)],
  ['тренд 8 / уровень 12', gatedTrendModel(12, 8)],
  ['тренд 12 / уровень 18', gatedTrendModel(18, 12)],
  ['тренд 12 / уровень 24', gatedTrendModel(24, 12)],
  ['тренд 18 / уровень 36', gatedTrendModel(36, 18)],
];
/** Запасной вариант на короткой истории. */
const FALLBACK = gatedTrendModel(18, 12);

/** pinball-loss τ-квантиля: недолёт штрафуется τ, перелёт — (1 − τ). */
function pinball(actual: number, forecast: number, tau: number): number {
  return actual >= forecast ? tau * (actual - forecast) : (1 - tau) * (forecast - actual);
}

/** Средняя ошибка (pinball) каждого кандидата на последних HEDGE_LOOKBACK спринтах `h`. */
function candidateLosses(h: readonly number[]): number[] | null {
  const from = Math.max(MIN_HISTORY, h.length - HEDGE_LOOKBACK);
  if (h.length - from < MIN_SCORED) return null;
  return CANDIDATES.map(([, f]) => {
    let sum = 0;
    for (let t = from; t < h.length; t++) sum += pinball(h[t], f(h.slice(0, t), TAU), TAU);
    return sum / (h.length - from);
  });
}

/** Веса кандидатов по их честным прогнозам последних HEDGE_LOOKBACK спринтов истории `h`. */
function hedgeWeights(h: readonly number[]): number[] | null {
  const losses = candidateLosses(h);
  if (!losses) return null;
  const best = Math.min(...losses);
  const raw = losses.map((l) => Math.exp(-HEDGE_ETA * (l - best)));
  const total = raw.reduce((s, w) => s + w, 0);
  return raw.map((w) => w / total);
}

/** Прогноз τ-квантиля смесью кандидатов (или запасной моделью на короткой истории). */
function mixtureForecast(allowed: readonly number[], tau: number): number {
  const weights = hedgeWeights(allowed);
  return weights
    ? CANDIDATES.reduce((s, [, f], i) => s + weights[i] * f(allowed, tau), 0)
    : FALLBACK(allowed, tau);
}

/**
 * Рекомендуемый план на старте. `flows` — В ХРОНОЛОГИЧЕСКОМ порядке (старые → свежие);
 * берутся последние PLAN_HISTORY. `targetCompletion` — доля (0.8). null — нет спринтов или
 * цель вне (0, 1]: делить на 0 / «закрывать больше 100% взятого» бессмысленно.
 */
export function planCapacity(
  flows: readonly SprintFlow[],
  targetCompletion: number,
): PlanCapacity | null {
  if (flows.length === 0 || !(targetCompletion > 0) || targetCompletion > 1) return null;
  const history = flows.slice(-PLAN_HISTORY);
  const allowed = history.map((f) => allowedPlan(f, targetCompletion));

  const weights = hedgeWeights(allowed);
  const forecast = (tau: number) => mixtureForecast(allowed, tau);

  const trendSeries = allowed.slice(-TREND_WINDOW);
  let trend: PlanTrend | null = null;
  if (trendSeries.length >= MIN_TREND_POINTS) {
    const z = mannKendallZ(trendSeries);
    trend = {
      slope: round1(theilSen(trendSeries).slope),
      z: Math.round(z * 100) / 100,
      active: Math.abs(z) >= TREND_Z,
    };
  }

  const recent = history.slice(-18);
  // Вниз, а не до ближайшего: лишний SP сверху — это уже выход за цель в граничном спринте.
  const recommended = Math.max(0, Math.floor(forecast(TAU) + 1e-9));
  return {
    recommended,
    stretch: Math.max(recommended, Math.floor(forecast(STRETCH_TAU) + 1e-9)),
    trend,
    models: weights
      ? CANDIDATES.map(([model, f], i) => ({
          model,
          weight: weights[i],
          forecast: Math.round(f(allowed, TAU)),
        })).sort((a, b) => b.weight - a.weight)
      : [],
    medianCompleted: round1(median(recent.map((f) => f.completed))!),
    medianAdded: round1(median(recent.map((f) => f.added))!),
    targetCompletion,
    count: history.length,
  };
}

/** Подсказка к плану: что значит число, как получено и насколько можно больше. */
export function describePlan(p: PlanCapacity): string {
  const target = Math.round(p.targetCompletion * 100);
  const trend = p.trend?.active
    ? `\nКоманда ${p.trend.slope > 0 ? 'растёт' : 'снижается'}: ≈ ${p.trend.slope > 0 ? '+' : ''}${p.trend.slope} SP за спринт.`
    : '';
  return (
    `План на старт ≤ ${p.recommended} SP — столько брать, чтобы закрыть ≥ ${target}% взятого ` +
    `с учётом прилётов. План с вызовом: на истории команд в цель ≈ 3 спринта из 4.\n` +
    `Как: по каждому прошлому спринту допустимый план = закрыто ÷ ${p.targetCompletion} − прилёты; ` +
    `берём нижние 20% этого ряда смесью моделей (${p.count} спринтов).${trend}\n` +
    `Можно ещё больше: ${p.stretch} SP — риск переноса выше.`
  );
}

/** Целевое выполнение из порога переноса: перенос ≤ 20% ⇔ выполнение ≥ 80%. */
export function targetCompletionFromCarryover(carryoverPct: number): number {
  return Math.min(1, Math.max(0, 1 - carryoverPct / 100));
}

// --- Разбор плана: те же вычисления, но с промежуточными рядами — для страницы «как посчитано» ---

/** Один прошлый спринт в разборе плана. */
export interface PlanSprintRow {
  name: string;
  completed: number;
  added: number;
  /** Допустимый план: закрыто / цель − прилёты. */
  allowed: number;
}

/** Кандидат смеси в разборе: прогноз, ошибка на истории, вес. */
export interface PlanModelRow {
  model: string;
  /** Прогноз на следующий спринт, SP. */
  forecast: number;
  /** Средняя pinball-ошибка на последних спринтах, SP. */
  loss: number;
  weight: number;
}

/** Честная проверка на истории: каждый спринт прогнозируется только по спринтам до него. */
export interface PlanBacktest {
  /** Сколько спринтов проверено. */
  scored: number;
  /** В скольких из них рекомендованный план уложился бы в цель. */
  hitsPlan: number;
  /** То же для «медианы закрытого за 6 спринтов» — прежней velocity. */
  hitsMedian: number;
  /** По спринтам: имя, рекомендация, медиана velocity, допустимый план. */
  rows: Array<{ name: string; plan: number; median: number; allowed: number }>;
}

export interface PlanExplanation {
  plan: PlanCapacity;
  /** История, по которой посчитан план (старые → свежие). */
  sprints: PlanSprintRow[];
  /** Медиана допустимого плана за всю историю — «типичный» спринт. */
  medianAllowed: number;
  /** Нижние 20% и 30% допустимого плана за всю историю (без смеси моделей) — для наглядности. */
  q20: number;
  q30: number;
  backtest: PlanBacktest;
  /** Ряд тренда (последние TREND_WINDOW) и линия Тейла–Сена по нему. null — истории мало. */
  trendLine: { names: string[]; values: number[]; intercept: number; slope: number } | null;
  /** Кандидаты в исходном порядке. Пусто — истории мало, работает запасная модель. */
  models: PlanModelRow[];
  /** Константы расчёта — чтобы текст страницы не расходился с кодом. */
  constants: {
    tau: number;
    stretchTau: number;
    hedgeLookback: number;
    hedgeEta: number;
    trendWindow: number;
    trendZ: number;
    velocityWindow: number;
  };
}

/** Окно «прежней velocity» в проверке на истории. */
const VELOCITY_WINDOW = 6;

/**
 * Разбор плана для страницы «как посчитано». Те же функции, что в planCapacity, плюс
 * честная проверка на истории: для каждого из последних HEDGE_LOOKBACK спринтов план
 * пересчитывается ТОЛЬКО по спринтам до него и сравнивается с его допустимым планом.
 */
export function explainPlan(
  flows: readonly SprintFlow[],
  targetCompletion: number,
): PlanExplanation | null {
  const plan = planCapacity(flows, targetCompletion);
  if (!plan) return null;
  const history = flows.slice(-PLAN_HISTORY);
  const allowed = history.map((f) => allowedPlan(f, targetCompletion));
  const names = history.map((f, i) => f.name ?? `#${i + 1}`);

  const rows: PlanBacktest['rows'] = [];
  for (let t = Math.max(MIN_HISTORY, history.length - HEDGE_LOOKBACK); t < history.length; t++) {
    const before = allowed.slice(0, t);
    rows.push({
      name: names[t],
      plan: Math.max(0, Math.floor(mixtureForecast(before, TAU) + 1e-9)),
      median: round1(
        median(history.slice(Math.max(0, t - VELOCITY_WINDOW), t).map((f) => f.completed))!,
      ),
      allowed: round1(allowed[t]),
    });
  }

  const trendSeries = allowed.slice(-TREND_WINDOW);
  const fit = trendSeries.length >= MIN_TREND_POINTS ? theilSen(trendSeries) : null;
  const losses = candidateLosses(allowed);
  const weights = hedgeWeights(allowed);

  return {
    plan,
    sprints: history.map((f, i) => ({
      name: names[i],
      completed: f.completed,
      added: f.added,
      allowed: round1(allowed[i]),
    })),
    medianAllowed: round1(median(allowed)!),
    q20: round1(lowerQuantile(allowed, TAU)),
    q30: round1(lowerQuantile(allowed, STRETCH_TAU)),
    backtest: {
      scored: rows.length,
      hitsPlan: rows.filter((r) => r.plan <= r.allowed).length,
      hitsMedian: rows.filter((r) => r.median <= r.allowed).length,
      rows,
    },
    trendLine: fit
      ? {
          names: names.slice(-TREND_WINDOW),
          values: trendSeries.map(round1),
          intercept: fit.intercept,
          slope: fit.slope,
        }
      : null,
    models:
      losses && weights
        ? CANDIDATES.map(([model, f], i) => ({
            model,
            forecast: round1(f(allowed, TAU)),
            loss: round1(losses[i]),
            weight: weights[i],
          }))
        : [],
    constants: {
      tau: TAU,
      stretchTau: STRETCH_TAU,
      hedgeLookback: HEDGE_LOOKBACK,
      hedgeEta: HEDGE_ETA,
      trendWindow: TREND_WINDOW,
      trendZ: TREND_Z,
      velocityWindow: VELOCITY_WINDOW,
    },
  };
}
