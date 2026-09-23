import type { SprintReportDetail, SprintReportIssue } from '@/core/domain';
import { median } from './median';

/**
 * Правила «здоровья спринта» — ЧИСТЫЕ функции (тестируются без браузера). Слой: core/metrics.
 *
 * Отвечают на планировочные вопросы тимлида: держим ли скорость, сколько переносим,
 * растут ли оценки уже взятых задач, много ли влетает по ходу, выкидываем ли из спринта.
 *
 * Все данные берутся из уже загруженного Jira Sprint Report — дополнительных запросов НЕТ
 * (важно: страница и так упирается в rate-limit, см. sprintReportCache).
 *
 * Направление — ПЛАНИРОВАНИЕ, а не KPI-отчётность: статусы только ok/warn (без «критично»),
 * а пороги настраиваемые, потому что это командная договорённость, а не константа.
 */

/** Идентификаторы правил. */
export type RuleId =
  | 'velocity-drop'
  | 'carryover'
  | 'reestimate'
  | 'scope-added'
  | 'punted';

/**
 * Статус правила.
 * `no-data` и `insufficient-history` НАМЕРЕННО отделены от `ok`: молчаливая деградация
 * «данных нет → значит всё хорошо» — худший вид вранья в метриках.
 */
export type RuleStatus = 'ok' | 'warn' | 'no-data' | 'insufficient-history';

/** Задача, попавшая в подтверждение правила, с её вкладом в число. */
export interface EvidenceIssue {
  key: string;
  /** SP, которыми задача вошла в метрику (для reestimate — прирост, иначе — её оценка). */
  points: number;
  /** Оценка на старте спринта. null — задачи не было на старте. Только для reestimate. */
  from?: number | null;
  /** Оценка на закрытии. Только для reestimate. */
  to?: number;
}

/** Подтверждающие данные для раскрытия в UI (какие именно задачи дали это число). */
export interface RuleEvidence {
  issueKeys: string[];
  points: number;
  /** Детализация по задачам — чтобы UI показал «было → стало», а не только ключи. */
  issues: EvidenceIssue[];
}

export interface RuleResult {
  rule: RuleId;
  status: RuleStatus;
  /**
   * Измеренное значение: доля (0.12 = 12%) для процентных правил, счётчик для `punted`.
   * null — статус no-data / insufficient-history.
   */
  value: number | null;
  /** Порог, с которым сравнивали (в тех же единицах, что value). */
  threshold: number;
  /** База сравнения для velocity-drop (медиана предыдущих спринтов), SP. */
  baseline?: number;
  evidence?: RuleEvidence;
}

/** Пороги в ДОЛЯХ (0.1 = 10%), чтобы правила не пересчитывали проценты каждый раз. */
export interface HealthThresholds {
  velocityDrop: number;
  carryover: number;
  reestimate: number;
  scopeAdded: number;
  punted: number;
  velocityWindow: number;
}

/** Пороги из настроек (проценты) → доли. */
export function toThresholds(pct: {
  velocityDropPct: number;
  carryoverPct: number;
  reestimatePct: number;
  scopeAddedPct: number;
  puntedCount: number;
  velocityWindow: number;
}): HealthThresholds {
  return {
    velocityDrop: pct.velocityDropPct / 100,
    carryover: pct.carryoverPct / 100,
    reestimate: pct.reestimatePct / 100,
    scopeAdded: pct.scopeAddedPct / 100,
    punted: pct.puntedCount,
    velocityWindow: pct.velocityWindow,
  };
}

/** SP задачи для расчётов: null/отрицательные → 0. */
function points(p: number | null): number {
  return typeof p === 'number' && p > 0 ? p : 0;
}

/** Округление доли до 3 знаков — чтобы 0.30000000000000004 не текло в UI и тесты. */
function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/**
 * Сравнение с порогом «не больше». Граница НЕ нарушает правило: ровно 10% при пороге 10% — ok.
 * Порог формулируется как «не более 20%», значит 20% допустимо.
 */
function overThreshold(value: number, threshold: number): boolean {
  // eps гасит двоичную погрешность (0.1+0.2 !== 0.3), иначе метрика ложно срабатывает на границе.
  return value > threshold + 1e-9;
}

/**
 * 1. Просадка скорости. База — медиана completedPoints ПРЕДЫДУЩИХ `velocityWindow` спринтов.
 *
 * Оцениваемый спринт в базу НЕ входит: иначе он влияет на собственный порог и правило
 * теряет смысл (аномально низкий спринт занижает базу и сам себя оправдывает).
 * Медиана, а не среднее — один релизный/праздничный спринт не должен сдвигать базу.
 *
 * `previous` — спринты СТАРШЕ оцениваемого, в порядке от свежих к старым.
 */
export function ruleVelocityDrop(
  sprint: SprintReportDetail,
  previous: readonly SprintReportDetail[],
  t: HealthThresholds,
): RuleResult {
  const window = previous.slice(0, Math.max(0, t.velocityWindow));
  if (window.length < t.velocityWindow) {
    return {
      rule: 'velocity-drop',
      status: 'insufficient-history',
      value: null,
      threshold: t.velocityDrop,
    };
  }
  const base = median(window.map((s) => s.completedPoints));
  if (base === null || base <= 0) {
    return { rule: 'velocity-drop', status: 'no-data', value: null, threshold: t.velocityDrop };
  }
  // Доля просадки: 0.12 = «ниже базы на 12%». Рост (отрицательная просадка) — всегда ok.
  const drop = round3((base - sprint.completedPoints) / base);
  return {
    rule: 'velocity-drop',
    status: overThreshold(drop, t.velocityDrop) ? 'warn' : 'ok',
    value: drop,
    threshold: t.velocityDrop,
    baseline: base,
  };
}

/**
 * 2. Перенос по SP: carryover / (completed + carryover).
 *
 * Знаменатель — весь объём, за который команда взялась. Деление только на completed даёт
 * взрыв метрики в плохом спринте (сделали 5, перенесли 20 → 400%) — то есть число становится
 * нечитаемым именно тогда, когда оно важнее всего.
 *
 * `issuesCompletedInAnotherSprint` в знаменатель НЕ входит: Jira не считает их ни в completed,
 * ни в notCompleted, и включение разошлось бы с числами родного Sprint Report.
 */
export function ruleCarryover(sprint: SprintReportDetail, t: HealthThresholds): RuleResult {
  const taken = sprint.completedPoints + sprint.notCompletedPoints;
  if (taken <= 0) {
    return { rule: 'carryover', status: 'no-data', value: null, threshold: t.carryover };
  }
  const share = round3(sprint.notCompletedPoints / taken);
  return {
    rule: 'carryover',
    status: overThreshold(share, t.carryover) ? 'warn' : 'ok',
    value: share,
    threshold: t.carryover,
    evidence: {
      issueKeys: sprint.notCompletedIssues.map((i) => i.key),
      points: sprint.notCompletedPoints,
      issues: sprint.notCompletedIssues.map((i) => ({ key: i.key, points: points(i.points) })),
    },
  };
}

/** Задачи спринта во всех четырёх массивах — добавленная задача может оказаться в любом. */
function allIssues(sprint: SprintReportDetail): SprintReportIssue[] {
  return [
    ...sprint.completedIssues,
    ...sprint.notCompletedIssues,
    ...sprint.puntedIssues,
    ...sprint.completedInAnotherSprintIssues,
  ];
}

/**
 * 3. Переоценка УЖЕ ВЗЯТЫХ задач: сумма (current − initial) по задачам, добавленные исключены.
 *
 * ПОЧЕМУ ПОШТУЧНО, А НЕ ВЫЧИТАНИЕМ АГРЕГАТОВ. Разница сумм
 * completedIssuesEstimateSum − completedIssuesInitialEstimateSum включает задачи, добавленные
 * ПОСЛЕ старта: у них нет оценки «на старте», поэтому вся их оценка выглядит как переоценка.
 * Замер на живом API (спринт 9465): разница 66−64=2 SP, из которых 1 SP — задача ELCAS-12646,
 * добавленная по ходу. Без исключения таких задач правила 3 и 4 считают одно событие дважды.
 *
 * Задачи с initial=null (не оценённые на старте) отсеиваются автоматически — считать их
 * переоценкой нельзя, базы для сравнения нет.
 */
export function ruleReestimate(sprint: SprintReportDetail, t: HealthThresholds): RuleResult {
  let growth = 0;
  let base = 0;
  const grown: EvidenceIssue[] = [];

  for (const issue of allIssues(sprint)) {
    if (sprint.addedIssueKeys.has(issue.key)) continue; // добавлена после старта → правило 4
    if (issue.initialPoints === null) continue; // не было оценки на старте → база отсутствует
    const from = points(issue.initialPoints);
    const to = points(issue.points);
    base += from;
    if (to > from) {
      growth += to - from;
      // from/to нужны UI: «было 3 → стало 8» читается, а «+5» требует догадки.
      grown.push({ key: issue.key, points: +(to - from).toFixed(1), from, to });
    }
  }

  if (base <= 0) {
    return { rule: 'reestimate', status: 'no-data', value: null, threshold: t.reestimate };
  }
  const share = round3(growth / base);
  return {
    rule: 'reestimate',
    status: overThreshold(share, t.reestimate) ? 'warn' : 'ok',
    value: share,
    threshold: t.reestimate,
    evidence: { issueKeys: grown.map((g) => g.key), points: +growth.toFixed(1), issues: grown },
  };
}

/**
 * 4. Добавление задач ПОСЛЕ старта: SP добавленных / объём на старте.
 *
 * Отдельно от правила 3 намеренно: рост оценки взятой задачи и вброс новой — разные причины,
 * требующие разных действий (плохая декомпозиция vs слабая защита спринта от внешних запросов).
 * Слитая метрика скрывает, какой именно разговор нужно вести с командой.
 *
 * Знаменатель = весь объём минус добавленное, то есть то, с чем спринт стартовал.
 */
export function ruleScopeAdded(sprint: SprintReportDetail, t: HealthThresholds): RuleResult {
  if (!sprint.hasAddedData) {
    return { rule: 'scope-added', status: 'no-data', value: null, threshold: t.scopeAdded };
  }

  const added = allIssues(sprint).filter((i) => sprint.addedIssueKeys.has(i.key));
  const addedPoints = added.reduce((s, i) => s + points(i.points), 0);
  const atStart = sprint.allPoints - addedPoints;

  if (atStart <= 0) {
    return { rule: 'scope-added', status: 'no-data', value: null, threshold: t.scopeAdded };
  }
  const share = round3(addedPoints / atStart);
  return {
    rule: 'scope-added',
    status: overThreshold(share, t.scopeAdded) ? 'warn' : 'ok',
    value: share,
    threshold: t.scopeAdded,
    evidence: {
      issueKeys: added.map((i) => i.key),
      points: +addedPoints.toFixed(1),
      issues: added.map((i) => ({ key: i.key, points: points(i.points) })),
    },
  };
}

/**
 * 5. Выброс задач из спринта после старта. Порог по УМОЛЧАНИЮ 0 — правило бинарное
 * («из спринта ничего не выкидывали»), но настраиваемое на случай договорённости о допуске.
 *
 * Пустой массив (выбросов не было) и отсутствие поля в ответе Jira — РАЗНЫЕ ситуации:
 * первое ok, второе no-data.
 */
export function rulePunted(sprint: SprintReportDetail, t: HealthThresholds): RuleResult {
  if (!sprint.hasPuntedData) {
    return { rule: 'punted', status: 'no-data', value: null, threshold: t.punted };
  }
  const count = sprint.puntedIssues.length;
  return {
    rule: 'punted',
    status: overThreshold(count, t.punted) ? 'warn' : 'ok',
    value: count,
    threshold: t.punted,
    evidence: {
      issueKeys: sprint.puntedIssues.map((i) => i.key),
      points: +sprint.puntedIssues.reduce((s, i) => s + points(i.points), 0).toFixed(1),
      issues: sprint.puntedIssues.map((i) => ({ key: i.key, points: points(i.points) })),
    },
  };
}

/** Все правила одного спринта, в порядке отображения. */
export function sprintHealth(
  sprint: SprintReportDetail,
  previous: readonly SprintReportDetail[],
  t: HealthThresholds,
): RuleResult[] {
  return [
    ruleVelocityDrop(sprint, previous, t),
    ruleCarryover(sprint, t),
    ruleReestimate(sprint, t),
    ruleScopeAdded(sprint, t),
    rulePunted(sprint, t),
  ];
}

/**
 * Здоровье по ВСЕМ спринтам списка. `sprints` ожидается от СВЕЖИХ к старым (как отдаёт API):
 * предыдущими для спринта i считаются элементы i+1.. — то есть более старые.
 */
export function healthBySprint(
  sprints: readonly SprintReportDetail[],
  t: HealthThresholds,
): Map<number, RuleResult[]> {
  const out = new Map<number, RuleResult[]>();
  sprints.forEach((s, i) => {
    out.set(s.sprintId, sprintHealth(s, sprints.slice(i + 1), t));
  });
  return out;
}

/**
 * Сводка по одному правилу за последние N спринтов — для шапки страницы.
 *
 * Принцип подачи (methodology проекта, research 2026-07-08):
 * метрика показывается как ТРЕНД против собственной истории команды, а не как счётчик
 * нарушений фикс-порога. Счётчик «4 из 6 вне нормы» не говорит ни насколько всё плохо,
 * ни куда движется — поэтому здесь есть и типичное значение, и направление.
 */
export interface RuleSummary {
  rule: RuleId;
  /** Сколько спринтов окна нарушили правило (порог — ориентир, не вердикт). */
  warnCount: number;
  /** Сколько спринтов реально оценивались (без no-data / insufficient-history). */
  evaluated: number;
  /** Значения по спринтам от СТАРЫХ к свежим — для спарклайна (null там, где не считалось). */
  trend: Array<number | null>;
  /** Типичное значение окна — МЕДИАНА (устойчива к одиночному выбросу). null — нечего считать. */
  typical: number | null;
  /** Порог правила — чтобы UI показал «22% при ориентире 20%». */
  threshold: number;
  /**
   * Куда движется: сравнение свежей половины окна со старой (та же логика, что в reliability).
   * 'up' — значение растёт, 'down' — падает. Что из этого хорошо, решает UI по смыслу правила.
   */
  direction: 'up' | 'down' | 'flat' | null;
  /** Средние половин окна — для подписи «было 14% → стало 2%». null, если данных мало. */
  olderAvg: number | null;
  recentAvg: number | null;
}

/**
 * Причинно-следственная модель метрик (Cohn, Mountain Goat Software, «Spillover in Agile»):
 * перенос (spillover) — СЛЕДСТВИЕ, у которого три названные причины:
 *   «ambitious sprint goal»        → берут больше обычного (видно как просадка скорости);
 *   «too much unplanned work»      → добавлено после старта;
 *   «underestimating the effort»   → рост оценок уже взятых задач.
 * Поэтому сводка не показывает пять равных счётчиков, а связывает следствие с вероятной причиной.
 * https://www.mountaingoatsoftware.com/blog/unfinished-work-every-sprint-three-ways-to-break-the-habit
 */
export const CARRYOVER_CAUSES: readonly RuleId[] = ['scope-added', 'reestimate', 'velocity-drop'];

/**
 * Направление тренда: свежая половина против старой, с порогом 5% чтобы шум не читался как тренд.
 */
function halves(values: number[]): {
  older: number | null;
  recent: number | null;
  direction: 'up' | 'down' | 'flat' | null;
} {
  if (values.length < 3) return { older: null, recent: null, direction: null };
  const half = Math.floor(values.length / 2);
  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const older = avg(values.slice(0, half));
  const recent = avg(values.slice(values.length - half));
  const eps = Math.abs(older) * 0.05;
  const diff = recent - older;
  return {
    older: round3(older),
    recent: round3(recent),
    direction: diff > eps ? 'up' : diff < -eps ? 'down' : 'flat',
  };
}

/**
 * Сводка правил по последним `window` спринтам. `sprints` — от свежих к старым.
 * Тренд разворачивается в хронологию (слева направо по времени), как принято в спарклайнах.
 */
export function healthSummary(
  sprints: readonly SprintReportDetail[],
  t: HealthThresholds,
  window = 6,
): RuleSummary[] {
  const health = healthBySprint(sprints, t);
  const recent = sprints.slice(0, Math.max(0, window));
  const rules: RuleId[] = ['velocity-drop', 'carryover', 'reestimate', 'scope-added', 'punted'];

  return rules.map((rule) => {
    const results = recent.map((s) => health.get(s.sprintId)?.find((r) => r.rule === rule));
    const counted = (r: RuleResult | undefined) => r?.status === 'warn' || r?.status === 'ok';
    // Хронология: старые слева — так читаются спарклайны и так же считаются половины тренда.
    const trend = results.map((r) => (counted(r) ? r!.value : null)).reverse();
    const values = trend.filter((v): v is number => v !== null);
    const { older, recent: recentAvg, direction } = halves(values);

    return {
      rule,
      warnCount: results.filter((r) => r?.status === 'warn').length,
      evaluated: results.filter(counted).length,
      trend,
      // Медиана, а не среднее: один аномальный спринт не должен задавать «типичное» значение.
      typical: median(values),
      threshold: results.find(counted)?.threshold ?? 0,
      direction,
      olderAvg: older,
      recentAvg,
    };
  });
}

/**
 * Главный вывод по окну спринтов — то, ради чего тимлид смотрит на сводку.
 *
 * Почему не «4 из 6 вне нормы»: счётчик нарушений не проходит тест на пригодность
 * («если число изменится, кто-то завтра сделает иначе?») и показывает значение без истории —
 * то, что Tufte называет «nuggets of information devoid of meaningful context».
 * Поэтому здесь: что происходит (следствие), почему (причина по Cohn), что уже улучшилось.
 */
export interface HealthVerdict {
  /** Правило-проблема №1 или null, если всё в пределах ориентиров. */
  focus: RuleSummary | null;
  /** Вероятная причина проблемы (для переноса — по модели Cohn). null — причина не выделяется. */
  cause: RuleSummary | null;
  /** Что заметно улучшилось за окно — это тоже сигнал (не только плохое). */
  improved: RuleSummary[];
  /** Стало ли хуже по правилу-фокусу. */
  worsening: boolean;
  /** Хроническая ли проблема: нарушена в большинстве спринтов окна. */
  chronic: boolean;
}

/** Насколько правило превышает свой ориентир (в долях порога). Для сравнения разных метрик. */
function severity(s: RuleSummary): number {
  if (s.typical === null || s.evaluated === 0) return -1;
  // punted с порогом 0 нельзя делить — берём само число задач как меру.
  if (s.threshold === 0) return s.typical;
  return s.typical / s.threshold;
}

/**
 * Выбрать главное из сводки. `summaries` — результат healthSummary.
 *
 * Фокус — правило с наибольшим относительным превышением ориентира. Если это перенос,
 * причина ищется среди трёх причин Cohn (та, что сама вышла за ориентир сильнее прочих).
 */
export function healthVerdict(summaries: readonly RuleSummary[]): HealthVerdict {
  const evaluated = summaries.filter((s) => s.evaluated > 0 && s.typical !== null);
  const over = evaluated.filter((s) => overThreshold(s.typical!, s.threshold));

  // Приоритет следствию над причиной: если перенос вышел за ориентир, он и есть проблема,
  // а просадка скорости / вбросы / рост оценок — то, ЧЕМ она объясняется (Cohn). Иначе тимлид
  // получил бы «почини скорость», хотя скорость проседает именно из-за хвостов прошлых спринтов.
  const carryover = over.find((s) => s.rule === 'carryover');
  const focus =
    carryover ?? (over.length ? over.reduce((a, b) => (severity(b) > severity(a) ? b : a)) : null);

  let cause: RuleSummary | null = null;
  if (focus?.rule === 'carryover') {
    const candidates = evaluated.filter(
      (s) => CARRYOVER_CAUSES.includes(s.rule) && overThreshold(s.typical!, s.threshold),
    );
    cause = candidates.length
      ? candidates.reduce((a, b) => (severity(b) > severity(a) ? b : a))
      : null;
  }

  // Улучшение засчитываем только при реальном движении вниз — не по шуму (direction уже с eps 5%).
  const improved = evaluated.filter(
    (s) => s.direction === 'down' && s.olderAvg !== null && s.recentAvg !== null,
  );

  return {
    focus,
    cause,
    improved,
    worsening: focus?.direction === 'up',
    chronic: focus !== null && focus.warnCount > focus.evaluated / 2,
  };
}
