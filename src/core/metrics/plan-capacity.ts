import type { SprintReportDetail } from '@/core/domain';
import { median } from './median';
import { sprintCompletion } from './sprint-completion';
import { firstWorkStart, type StatusTransition } from './status-transitions';

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
 * ШАГ 2. Окно — ровно PLAN_WINDOW = 6 последних закрытых спринтов (≈ квартал). Длинная история
 * размывала оценку старыми режимами команды: ELCAS 2025 закрывал 100–120 SP, в 2026 ~75; после
 * найма/ухода смесь по 18…36 спринтам перестраивалась месяцами. Шесть спринтов — команда в её
 * нынешнем составе, полная перестройка за 6 спринтов после смены режима.
 *
 * ШАГ 3. Монте-Карло следующего спринта. Шесть точек — мало для голого квантиля: 20%-квантиль
 * из шести — это второй снизу спринт, в цель он попадает в 5/7 ≈ 71% случаев, и один спринт
 * двигает план скачком. Поэтому симулируем следующий спринт:
 *  - берём случайный спринт окна целиком — пару (закрыто, прилёты), связь между ними сохраняется;
 *  - добавляем шум: закрыто ± N(0, h_закр), прилёты ± N(0, h_прил). Ширина h — правило
 *    Сильвермана h = 0.9 · min(σ, IQR / 1.34) · n^(−1/5) по каждому ряду окна (сглаженный
 *    бутстреп: следующий спринт не обязан в точности повторить один из шести);
 *  - допустимый план симулированного спринта = закрыто / цель − прилёты.
 * Распределение такой симуляции — смесь нормальных с центрами в допустимых планах окна и общей
 * шириной h = √((h_закр / цель)² + h_прил²). Шум добавляет свою дисперсию к разбросу окна,
 * поэтому центры и шум сжимаем к среднему так, чтобы дисперсия симуляции равнялась дисперсии
 * окна (shrinkToSampleVariance). τ-квантиль смеси считаем ТОЧНО (бисекция по функции
 * распределения) — бесконечная симуляция без случайности: план не дрожит от перезагрузки.
 *
 * ШАГ 4. План — 20%-квантиль симуляции (в цель ≈ 4 спринта из 5), «вызов» — 30% (≈ 7 из 10).
 *
 * КРУПНЫЕ ЗАДАЧИ (≥ BIG_TASK_SP = 3 SP) часто идут дольше спринта, а Jira засчитывает их целиком
 * в спринте закрытия. В истории это пила (спринт старта — «провал», закрытия — «рекорд»), поэтому
 * sprintFlows раздаёт SP такой задачи спринтам по ВРЕМЕНИ РАБОТЫ над ней — от первого входа
 * в рабочий статус до закрытия, включая работу до того, как задача попала в отчёт спринта.
 * Модель видит темп работы, а не календарь зачёта. Поправку плана будущего спринта на его
 * крупные задачи (−B/(2·цель) за начатую, +B/(2·цель) за доезжающую) проверили и НЕ взяли:
 * на истории она хуже (в цель 78% против 85%) — решение тимлида 2026-10-12.
 *
 * ВЫБОР СХЕМЫ (исследование 2026-10-12, живой API: ELCAS / POC / Web, 59 спринтов с 25.12.2 по
 * 26.9.2; каждый спринт прогнозировался только по спринтам перед ним):
 *   схема                                     в цель   pinball   средний план
 *   смесь 11 моделей, вся история               73%      5.76       65.0   ← было
 *   Монте-Карло пар по 6                        81%      5.81       61.0
 *   + крупные задачи поровну по спринтам        80%      5.69       62.6
 *   + крупные задачи по времени работы          85%      5.75       61.8
 *   + сжатие до дисперсии окна                  78%      5.63       64     ← выбрано
 * Без сжатия план занижен: у Web (прилёты 8–44 SP) выходило 75 при допустимых 69…125.
 * Монте-Карло не требует нормальности (Стьюдент, лог-шкала, сжатие разброса к априорному CV —
 * не лучше), сохраняет связь закрытого и прилётов. Вес свежих спринтов внутри окна и наклон
 * тренда почти ничего не дают и делают план дёрганым — не берём. Синтетика «состав −30% / +30%»:
 * план доходит до нового уровня ровно за 6 спринтов и дальше не завышен/не занижен.
 */

/** Поток SP одного спринта, нужный для расчёта. */
export interface SprintFlow {
  /** Имя спринта — для подписей в разборе плана. */
  name?: string;
  /** Закрыто SP (green bar Jira). */
  completed: number;
  /** SP задач, добавленных после старта и оставшихся в спринте к закрытию (закрытых или переехавших). */
  added: number;
  /**
   * Сделано по работе: закрыто, но крупные задачи (≥ BIG_TASK_SP), шедшие несколько спринтов,
   * разнесены поровну по этим спринтам. Нет — совпадает с `completed`.
   */
  work?: number;
  /**
   * Взяли на старте, SP (как «взяли» на странице спринтов, см. sprintCompletion). Только для
   * показа в разборе плана, в расчёт плана не входит. Нет - данных о старте нет.
   */
  start?: number;
}

/** Окно прогноза: столько последних закрытых спринтов видит модель. */
export const PLAN_WINDOW = 6;
/** Сколько последних спринтов проверяем на истории в разборе плана (каждый — по 6 до него). */
export const PLAN_BACKTEST = 12;
/** История для разбора плана: окно + проверка. Сам план по-прежнему видит только PLAN_WINDOW. */
export const PLAN_HISTORY = PLAN_WINDOW + PLAN_BACKTEST;
/** Квантиль рекомендации: план в цели ≈ в 80% спринтов. */
const TAU = 0.2;
/** Квантиль «вызова»: ≈ в 70% спринтов. */
const STRETCH_TAU = 0.3;
/**
 * Задача от стольких SP разносится по спринтам по времени работы: в спринте старта она перенос,
 * в спринте закрытия Jira засчитывает её целиком. Было 13 SP. Бэктест 2026-11-09 (ELCAS / POC /
 * Web, 160 спринтов, changelog всех задач от 3 SP): порог 3 снижает pinball@0.2 на 0.46 SP за
 * спринт, ДИ95 от -0.85 до -0.09; порог 5 - на 0.29, ДИ95 включает 0; порог 8 не отличается от 13.
 * Changelog закрытых задач кэшируется навсегда (shared/storage/changelog-cache), поэтому из Jira
 * при следующих открытиях идут только задачи новых и незакрытых.
 */
export const BIG_TASK_SP = 3;
/** Порог |Z| Манна–Кендалла (≈ p < 0.1, двусторонний). */
const TREND_Z = 1.64;
/** Меньше точек — тренд не проверяем. */
const MIN_TREND_POINTS = 5;

export interface PlanTrend {
  /** Наклон Тейла–Сена, SP допустимого плана за спринт. */
  slope: number;
  /** Z-статистика Манна–Кендалла. */
  z: number;
  /** Тренд значим — команда в окне заметно растёт или снижается. В план не входит. */
  active: boolean;
}

export interface PlanCapacity {
  /** Сколько SP брать на старте: в цель ≈ 4 спринта из 5. */
  recommended: number;
  /** Амбициозный ориентир: в цель ≈ 7 спринтов из 10. Не меньше `recommended`. */
  stretch: number;
  /** Тренд допустимого плана внутри окна (подсказка «команда растёт»). null — спринтов мало. */
  trend: PlanTrend | null;
  /** Ширина шума симуляции h, SP допустимого плана. */
  spread: number;
  /** Медиана закрытого за окно — прежняя «velocity», для сравнения в подсказке. */
  medianCompleted: number;
  /** Медиана прилётов за окно, SP. */
  medianAdded: number;
  /** Целевая доля выполнения, 0..1 (0.8 = 80%). */
  targetCompletion: number;
  /** По скольким спринтам посчитано (≤ PLAN_WINDOW). */
  count: number;
  /** В скольких спринтах окна такой план уложился бы в цель (допустимый план ≥ рекомендации). */
  windowFits: number;
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
  return {
    name: s.name,
    completed: pts(s.completedPoints),
    added: round1(added),
    start: sprintCompletion(s).startPoints,
  };
}

/** Сделано по работе (см. SprintFlow.work). */
const workOf = (f: SprintFlow) => f.work ?? f.completed;

/** Когда крупная задача была в работе (из истории статусов, см. firstWorkStart). */
export interface BigTaskWork {
  /** Первый вход в рабочий статус (DEV / В работе / In Progress). */
  startedAt: string;
  /** Вход в статус «готово». null — ещё не закрыта. */
  doneAt: string | null;
}

/** Время работы над задачей из истории статусов. null — в работу не входила. */
export function bigTaskWorkOf(
  transitions: readonly StatusTransition[],
  workStatuses: readonly string[],
  doneStatuses: readonly string[],
): BigTaskWork | null {
  const startedAt = firstWorkStart(transitions, workStatuses);
  if (startedAt === null) return null;
  const done = new Set(doneStatuses.map((s) => s.toLowerCase()));
  const start = Date.parse(startedAt);
  const doneAt =
    transitions
      .filter((t) => done.has(t.to.toLowerCase()) && Date.parse(t.at) >= start)
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))[0]?.at ?? null;
  return { startedAt, doneAt };
}

/** Длина пересечения отрезков [a1, a2] и [b1, b2]. */
const overlap = (a1: number, a2: number, b1: number, b2: number) =>
  Math.max(0, Math.min(a2, b2) - Math.max(a1, b1));

/**
 * Потоки спринтов (старые → свежие) с разнесением крупных задач. Jira засчитывает задачу целиком
 * в спринте закрытия, хотя крупная (≥ `bigSp`) делается дольше спринта. Без поправки история —
 * пила: спринт старта выглядит провалом, спринт закрытия — рекордом, и симуляция принимает это за
 * шум. Поэтому SP крупной задачи раздаём спринтам ПО ВРЕМЕНИ РАБОТЫ над ней (`work`: от первого
 * входа в рабочий статус до закрытия) — в том числе работа до того, как задача попала в отчёт
 * спринта (ELCAS-12936: стояла в будущем спринте 26.9.2, а в DEV ушла ещё в 26.9.1).
 * Нет истории статусов — делим поровну между спринтами, где задача стояла.
 * Не закрытая к концу истории, но идущая в последнем спринте, — считаем, что закроется в конце
 * следующего. Брошенную (не закрыта и дальше не встречается) не трогаем: работа неизвестна.
 */
export function sprintFlows(
  reports: readonly SprintReportDetail[],
  work: ReadonlyMap<string, BigTaskWork> = new Map(),
  bigSp = BIG_TASK_SP,
): SprintFlow[] {
  const flows = reports.map(sprintFlow);
  const shift = flows.map(() => 0);
  const bounds = reports.map((r) => [
    Date.parse(r.isoStartDate ?? ''),
    Date.parse(r.isoCompleteDate ?? ''),
  ]);
  const big = new Map<string, { points: number; at: number[]; doneAt: number | null }>();
  reports.forEach((r, i) => {
    const lists = [
      [r.completedIssues, true],
      [r.notCompletedIssues, false],
    ] as const;
    for (const [issues, done] of lists) {
      for (const issue of issues) {
        const p = pts(issue.points);
        if (p < bigSp) continue;
        const e = big.get(issue.key) ?? { points: p, at: [], doneAt: null };
        if (!e.at.includes(i)) e.at.push(i);
        if (done && e.doneAt === null) {
          e.doneAt = i;
          e.points = p;
        }
        big.set(issue.key, e);
      }
    }
  });
  const last = reports.length - 1;
  for (const [key, e] of big) {
    const open = e.doneAt === null;
    if (open && !e.at.includes(last)) continue;
    const end = open ? last : e.doneAt!;
    const shares = workShares(work.get(key), bounds, end, open) ?? equalShares(e.at, end, open);
    if (!open) {
      if (shares[end] >= 1 - 1e-9) continue; // уложилась в один спринт
      shift[end] -= e.points;
    }
    shares.forEach((sh, i) => (shift[i] += e.points * sh));
  }
  return flows.map((f, i) =>
    Math.abs(shift[i]) > 1e-9 ? { ...f, work: round1(Math.max(0, f.completed + shift[i])) } : f,
  );
}

/**
 * Доли работы над задачей по спринтам 0…end — по времени. Открытая закроется в конце следующего
 * спринта (его длина = длине последнего). null — нет истории статусов или дат спринтов.
 */
function workShares(
  w: BigTaskWork | undefined,
  bounds: readonly number[][],
  end: number,
  open: boolean,
): number[] | null {
  if (!w) return null;
  const [lastStart, lastEnd] = bounds[end];
  const from = Date.parse(w.startedAt);
  let to = open ? lastEnd + (lastEnd - lastStart) : Date.parse(w.doneAt ?? '');
  if (!open && !(to <= lastEnd)) to = lastEnd; // «готово» проставили уже после закрытия спринта
  if (!(to > from) || bounds.slice(0, end + 1).some(([a, b]) => !(b > a))) return null;
  const shares = bounds.map(([a, b], i) => (i <= end ? overlap(from, to, a, b) / (to - from) : 0));
  return shares.some((x) => x > 0) ? shares : null;
}

/** Доли поровну между спринтами, где задача стояла (открытой — ещё один спринт впереди). */
function equalShares(at: readonly number[], end: number, open: boolean): number[] {
  const span = at.filter((i) => i <= end);
  const k = span.length + (open ? 1 : 0);
  const shares = Array.from({ length: end + 1 }, () => 0);
  for (const i of span) shares[i] = 1 / k;
  return shares;
}

/** Наибольший план на старте, при котором этот спринт уложился бы в цель выполнения. */
export function allowedPlan(f: SprintFlow, targetCompletion: number): number {
  return Math.max(0, workOf(f) / targetCompletion - f.added);
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

// --- Монте-Карло следующего спринта (в замкнутой форме) ---

/** Функция распределения стандартного нормального (Абрамовиц–Стиган 7.1.26, ошибка < 1.5e−7). */
export function normalCdf(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const poly =
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t;
  const erf = 1 - poly * Math.exp(-x * x);
  return z >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

/** Квантиль по линейной интерполяции (тип 7) — для межквартильного размаха. */
function interpQuantile(sorted: readonly number[], q: number): number {
  const h = (sorted.length - 1) * q;
  const lo = Math.floor(h);
  return sorted[lo] + (h - lo) * ((sorted[lo + 1] ?? sorted[lo]) - sorted[lo]);
}

/** Ширина ядра по правилу Сильвермана: 0.9 · min(σ, IQR / 1.34) · n^(−1/5). 0 — разброса нет. */
export function silvermanBandwidth(values: readonly number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  const mean = values.reduce((s, v) => s + v, 0) / n;
  const sd = Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1));
  const sorted = [...values].sort((a, b) => a - b);
  const iqr = (interpQuantile(sorted, 0.75) - interpQuantile(sorted, 0.25)) / 1.34;
  const scale = iqr > 0 ? Math.min(sd, iqr) : sd;
  return 0.9 * scale * n ** -0.2;
}

/** Ширина шума симуляции в единицах допустимого плана: √((h_закр / цель)² + h_прил²). */
export function simulationSpread(flows: readonly SprintFlow[], targetCompletion: number): number {
  const hc = silvermanBandwidth(flows.map(workOf)) / targetCompletion;
  const ha = silvermanBandwidth(flows.map((f) => f.added));
  return Math.hypot(hc, ha);
}

/** Доля симулированных спринтов с допустимым планом ≤ v: среднее Φ((v − центр) / h). */
function simulationCdf(centers: readonly number[], h: number, v: number): number {
  return centers.reduce((s, c) => s + normalCdf((v - c) / h), 0) / centers.length;
}

/** τ-квантиль симуляции: бисекция по функции распределения смеси нормальных. */
function simulationQuantile(centers: readonly number[], h: number, tau: number): number {
  if (!(h > 0)) return lowerQuantile(centers, tau);
  let lo = Math.min(...centers) - 6 * h;
  let hi = Math.max(...centers) + 6 * h;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (simulationCdf(centers, h, mid) < tau) lo = mid;
    else hi = mid;
  }
  return Math.max(0, (lo + hi) / 2);
}

/** Окно и его симуляция — общая часть плана и разбора. */
function simulate(flows: readonly SprintFlow[], targetCompletion: number) {
  const window = flows.slice(-PLAN_WINDOW);
  const allowed = window.map((f) => allowedPlan(f, targetCompletion));
  const { centers, h } = shrinkToSampleVariance(
    allowed,
    simulationSpread(window, targetCompletion),
  );
  // Вниз, а не до ближайшего: лишний SP сверху — это уже выход за цель в граничном спринте.
  const plan = (tau: number) => Math.floor(simulationQuantile(centers, h, tau) + 1e-9);
  return { window, allowed, centers, h, plan };
}

/**
 * Сглаженный бутстреп со сжатием (Silverman 1986, §6.4.1): шум h добавляет к разбросу окна
 * свою дисперсию — у симуляции σ² + h² вместо σ², хвост уходит ниже реальных спринтов и план
 * занижен (на живых данных в цель 85% при цели 80%). Центры подтягиваем к среднему, а шум
 * сужаем в k = 1 / √(1 + h² / σ²) раз — дисперсия симуляции снова равна дисперсии окна.
 */
function shrinkToSampleVariance(
  allowed: readonly number[],
  h: number,
): { centers: number[]; h: number } {
  const n = allowed.length;
  if (n < 2 || !(h > 0)) return { centers: [...allowed], h };
  const mean = allowed.reduce((s, v) => s + v, 0) / n;
  const variance = allowed.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1);
  if (!(variance > 0)) return { centers: [...allowed], h: 0 };
  const k = 1 / Math.sqrt(1 + (h * h) / variance);
  return { centers: allowed.map((v) => mean + k * (v - mean)), h: k * h };
}

/**
 * Рекомендуемый план на старте. `flows` — В ХРОНОЛОГИЧЕСКОМ порядке (старые → свежие);
 * модель видит только последние PLAN_WINDOW (крупные задачи разнесены — см. sprintFlows).
 * `targetCompletion` — доля (0.8). null — нет спринтов или цель вне (0, 1]: делить на 0 /
 * «закрывать больше 100% взятого» бессмысленно.
 */
export function planCapacity(
  flows: readonly SprintFlow[],
  targetCompletion: number,
): PlanCapacity | null {
  if (flows.length === 0 || !(targetCompletion > 0) || targetCompletion > 1) return null;
  const { window, allowed, h, plan } = simulate(flows, targetCompletion);
  const centers = allowed;

  let trend: PlanTrend | null = null;
  if (centers.length >= MIN_TREND_POINTS) {
    const z = mannKendallZ(centers);
    trend = {
      slope: round1(theilSen(centers).slope),
      z: Math.round(z * 100) / 100,
      active: Math.abs(z) >= TREND_Z,
    };
  }

  const recommended = plan(TAU);
  return {
    recommended,
    stretch: Math.max(recommended, plan(STRETCH_TAU)),
    trend,
    spread: round1(h),
    medianCompleted: round1(median(window.map((f) => f.completed))!),
    medianAdded: round1(median(window.map((f) => f.added))!),
    targetCompletion,
    count: window.length,
    windowFits: allowed.filter((a) => a >= recommended).length,
  };
}

/** Подсказка к плану: что значит число, как получено и насколько можно больше. */
export function describePlan(p: PlanCapacity): string {
  const target = Math.round(p.targetCompletion * 100);
  const trend = p.trend?.active
    ? `\nЗа ${p.count} спринтов это число ${p.trend.slope > 0 ? 'растёт' : 'падает'} на ${Math.abs(p.trend.slope)} SP за спринт. В план это не добавлено: план дойдёт до нового уровня за ${p.count} спринтов.`
    : '';
  return (
    `Берите в следующий спринт до ${p.recommended} SP. Тогда команда закроет не меньше ${target}% ` +
    `взятого в 4 спринтах из 5, даже с задачами, которые добавят по ходу спринта.\n` +
    `Почему не больше: обычно закрываете ${p.medianCompleted} SP, но по ходу спринта добавляют ещё ` +
    `${p.medianAdded} SP, и под них оставлено место. С таким планом уложились бы в ` +
    `${p.windowFits} из ${p.count} последних спринтов.\n` +
    `Как посчитано: по ${p.count} последним спринтам, сколько в каждом можно было взять на старте, ` +
    `и по множеству похожих исходов следующего спринта. План - граница 20% худших исходов.${trend}\n` +
    `С риском: до ${p.stretch} SP, тогда уложитесь в 7 спринтах из 10.`
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
  /** Сделано по работе (крупные задачи разнесены); равно completed, если их не было. */
  work: number;
  /** Допустимый план: работа / цель − прилёты. */
  allowed: number;
  /** Входит в окно прогноза (последние PLAN_WINDOW). */
  inWindow: boolean;
}

/** Честная проверка на истории: каждый спринт прогнозируется только по PLAN_WINDOW до него. */
export interface PlanBacktest {
  /** Сколько спринтов проверено. */
  scored: number;
  /** В скольких из них рекомендованный план уложился бы в цель. */
  hitsPlan: number;
  /** То же для «медианы закрытого за 6 спринтов» — прежней velocity. */
  hitsMedian: number;
  /** По спринтам: имя, рекомендация, медиана velocity, допустимый план. */
  rows: PlanBacktestRow[];
  /** Итог проверки для одной фразы над таблицей: занижает модель план или завышает. */
  summary: PlanBacktestSummary;
}

/** Один проверенный спринт. */
export interface PlanBacktestRow {
  name: string;
  /** План, который модель дала бы на старте этого спринта (по PLAN_WINDOW спринтам до него). */
  plan: number;
  /** Медиана закрытого за PLAN_WINDOW спринтов до него — прежняя velocity. */
  median: number;
  /** Сколько на самом деле можно было взять на старте (допустимый план этого спринта). */
  allowed: number;
  /** Сколько команда на самом деле закрыла в этом спринте, SP (green bar Jira). */
  completed: number;
  /** Сколько SP добавили по ходу этого спринта. */
  added: number;
  /** Сколько взяли на старте, SP. null - данных о старте нет. Только для графика проверки. */
  start: number | null;
  /** allowed − plan: > 0 — план был ниже возможного (запас), < 0 — выше (не хватило). */
  gap: number;
}

/**
 * Итог проверки: только для отображения, план не меняет. Модель по построению берёт план ниже
 * «в среднем» (квантиль τ), поэтому судим не по среднему запасу, а по частоте попаданий против
 * цели (1 − τ) с допуском на случайность 1.5·√(n·τ·(1 − τ)) (1.5 стандартного отклонения
 * биномиального: на 12 спринтах 8-11 попаданий при цели 10 - ещё случайность).
 */
export interface PlanBacktestSummary {
  scored: number;
  /** В скольких спринтах план выполнили бы (plan ≤ allowed). */
  hits: number;
  /** Сколько попаданий нужно по цели: round((1 − τ) · scored). */
  targetHits: number;
  /** Средний запас allowed − plan, SP, до 0.1. Положителен по построению - это запас модели. */
  meanGap: number;
  /**
   * На сколько SP сдвинуть все планы, чтобы попаданий стало ровно targetHits: > 0 - план можно
   * было поднять, < 0 - нужно было снизить. До 0.1.
   */
  shift: number;
  /** under - выполняли заметно чаще цели (план занижен), over - реже (завышен), ok - в допуске. */
  verdict: 'under' | 'over' | 'ok';
}

/** Итог проверки на прошлых спринтах. Пустой список - scored 0, verdict ok. */
export function summarizeBacktest(
  rows: readonly Pick<PlanBacktestRow, 'plan' | 'allowed'>[],
  tau: number = TAU,
): PlanBacktestSummary {
  const n = rows.length;
  if (!n) return { scored: 0, hits: 0, targetHits: 0, meanGap: 0, shift: 0, verdict: 'ok' };
  const gaps = rows.map((r) => r.allowed - r.plan).sort((a, b) => a - b);
  const hits = gaps.filter((g) => g >= 0).length;
  const expected = (1 - tau) * n;
  const targetHits = Math.round(expected);
  const tol = 1.5 * Math.sqrt(n * tau * (1 - tau));
  const verdict = hits > expected + tol ? 'under' : hits < expected - tol ? 'over' : 'ok';
  return {
    scored: n,
    hits,
    targetHits,
    meanGap: round1(gaps.reduce((s, g) => s + g, 0) / n),
    // Сдвиг δ, при котором ровно targetHits спринтов с gap ≥ δ: (n − targetHits)-й снизу запас.
    shift: round1(gaps[Math.min(n - 1, n - targetHits)]),
    verdict,
  };
}

export interface PlanExplanation {
  plan: PlanCapacity;
  /** История для графика (старые → свежие), до PLAN_HISTORY; окно прогноза помечено. */
  sprints: PlanSprintRow[];
  /** Ширины шума: по закрытому и по прилётам (до пересчёта в допустимый план), SP. */
  bandwidth: { completed: number; added: number };
  /** Плотность симуляции — кривая для графика: x — допустимый план, y — плотность. */
  density: Array<{ x: number; y: number }>;
  /** Медиана симуляции — «типичный» следующий спринт. */
  medianSim: number;
  backtest: PlanBacktest;
  /** Константы расчёта — чтобы текст страницы не расходился с кодом. */
  constants: {
    tau: number;
    stretchTau: number;
    window: number;
    trendZ: number;
    bigTaskSp: number;
  };
}

/** Плотность смеси нормальных в точке v. */
function simulationDensity(centers: readonly number[], h: number, v: number): number {
  const k = 1 / (h * Math.sqrt(2 * Math.PI) * centers.length);
  return centers.reduce((s, c) => s + k * Math.exp(-0.5 * ((v - c) / h) ** 2), 0);
}

/**
 * Разбор плана для страницы «как посчитано». Те же функции, что в planCapacity, плюс
 * честная проверка на истории: для каждого из последних PLAN_BACKTEST спринтов план
 * пересчитывается ТОЛЬКО по PLAN_WINDOW спринтам перед ним и сравнивается с его допустимым планом.
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

  const rows: PlanBacktestRow[] = [];
  for (let t = Math.max(PLAN_WINDOW, history.length - PLAN_BACKTEST); t < history.length; t++) {
    const before = history.slice(t - PLAN_WINDOW, t);
    const planT = simulate(before, targetCompletion).plan(TAU);
    rows.push({
      name: names[t],
      plan: planT,
      median: round1(median(before.map((f) => f.completed))!),
      allowed: round1(allowed[t]),
      completed: history[t].completed,
      added: history[t].added,
      start: history[t].start ?? null,
      gap: round1(allowed[t] - planT),
    });
  }

  const { window, centers, h } = simulate(flows, targetCompletion);
  const quantile = (q: number) => simulationQuantile(centers, h, q);
  const density: PlanExplanation['density'] = [];
  if (h > 0) {
    const lo = Math.max(0, quantile(0.005));
    const hi = quantile(0.995);
    for (let i = 0; i <= 80; i++) {
      const x = lo + ((hi - lo) * i) / 80;
      density.push({ x: round1(x), y: simulationDensity(centers, h, x) });
    }
  }

  const firstInWindow = history.length - window.length;
  return {
    plan,
    sprints: history.map((f, i) => ({
      name: names[i],
      completed: f.completed,
      added: f.added,
      work: workOf(f),
      allowed: round1(allowed[i]),
      inWindow: i >= firstInWindow,
    })),
    bandwidth: {
      completed: round1(silvermanBandwidth(window.map(workOf))),
      added: round1(silvermanBandwidth(window.map((f) => f.added))),
    },
    density,
    medianSim: round1(quantile(0.5)),
    backtest: {
      scored: rows.length,
      hitsPlan: rows.filter((r) => r.plan <= r.allowed).length,
      hitsMedian: rows.filter((r) => r.median <= r.allowed).length,
      rows,
      summary: summarizeBacktest(rows),
    },
    constants: {
      tau: TAU,
      stretchTau: STRETCH_TAU,
      window: PLAN_WINDOW,
      trendZ: TREND_Z,
      bigTaskSp: BIG_TASK_SP,
    },
  };
}
