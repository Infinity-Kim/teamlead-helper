<script lang="ts" setup>
import { ref, onMounted, computed } from 'vue';
import {
  getBoardSprintReportsSince,
  setJiraAuth,
  setJiraTabTransport,
  JiraRequestError,
} from '@/api/jira';
import { sendMessage } from '@/shared/messaging';
import {
  jiraCreds,
  teams,
  divisions,
  quarterTarget,
  sprintReportCache,
  sprintHealthThresholds,
  SPRINT_CACHE_LIMIT,
  type QuarterTargetConfig,
} from '@/shared/storage';
import {
  divisionTeams,
  type CapSlice,
  type Division,
  type SprintReportDetail,
  type SprintReportIssue,
  type TeamBoard,
} from '@/core/domain';
import {
  groupSprintsByQuarter,
  sprintCapBreakdown,
  velocitySummary,
  issueInSlice,
  healthBySprint,
  healthSummary,
  healthVerdict,
  toThresholds,
  divisionQuarters,
  quarterOf,
  CAP_SLICES,
  type QuarterGroup,
  type VelocitySummary,
  type CapBreakdown,
  type DivisionQuarter,
  type HealthThresholds,
  type RuleId,
  type RuleResult,
  type RuleSummary,
} from '@/core/metrics';
import { BUCKET_COLORS } from '@/components/ads-tokens';
import HealthChips from '@/components/HealthChips.vue';

/**
 * Спринты берём со стартом от Q4 2025 — раньше CAP-метки в Jira не проставлялись
 * (ранние спринты дали бы 100% «Без метки», см. проверку на живых данных).
 */
const SINCE_ISO = '2025-10-01';
/** Окно для average velocity. */
const VELOCITY_WINDOW = 6;
/** Псевдо-дивизион для включённых команд, не попавших ни в один дивизион. */
const OTHERS_ID = '__others__';

/** Отчёт одной команды: сырьё + предрасчитанные агрегаты. */
interface TeamReport {
  team: string;
  rapidViewId: number;
  sprints: SprintReportDetail[];
  quarters: QuarterGroup[];
  velocity: VelocitySummary;
  sprintCount: number;
  /** Сколько спринтов не загрузилось (частичные данные) — показываем плашку. */
  failed: number;
  /** Правила здоровья по каждому спринту. */
  health: Map<number, RuleResult[]>;
  /** Сводка правил за последние VELOCITY_WINDOW спринтов — для шапки. */
  healthSummary: RuleSummary[];
}

/** Кеш готовых отчётов по команде В ПАМЯТИ страницы — мгновенное переключение между командами. */
const memCache = new Map<number, TeamReport>();

/** Пороги правил из настроек (читаются один раз при монтировании). */
const thresholds = ref<HealthThresholds | null>(null);

/** Данные идут через вкладку Jira (без токена) — показываем это пользователю. */
const usingTab = ref(false);

/** Ждём, пока вкладка Jira догрузится — объясняем пользователю паузу. */
const waitingTab = ref(false);

/** Хост Jira для ссылок на задачи: из настроек токена, иначе рабочий инстанс по умолчанию. */
const jiraBase = ref('https://tvbet.atlassian.net');

/**
 * Дождаться готовности вкладки Jira, опрашивая background короткими запросами.
 * Ожидание держим НА СТРАНИЦЕ: MV3-воркер выгружается после ~30 с бездействия и порвал бы
 * длинную паузу. Jira SPA поднимается до ~20 с — отсюда запас.
 */
async function waitJiraTabReady(timeoutMs = 30_000): Promise<{ ready: boolean; present: boolean }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await sendMessage('jiraTabReady');
    if (res.ready || Date.now() >= deadline) return res;
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** Собрать TeamReport из сырья спринтов. */
function buildReport(team: TeamBoard, sprints: SprintReportDetail[], failed: number): TeamReport {
  const t = thresholds.value;
  return {
    team: team.name,
    rapidViewId: team.rapidViewId,
    sprints,
    quarters: groupSprintsByQuarter(sprints),
    velocity: velocitySummary(sprints, VELOCITY_WINDOW),
    sprintCount: sprints.length,
    failed,
    health: t ? healthBySprint(sprints, t) : new Map(),
    healthSummary: t ? healthSummary(sprints, t, VELOCITY_WINDOW) : [],
  };
}

const loading = ref(true);
const error = ref<string | null>(null);
/** Что сейчас грузится — для дивизиона показываем, какая команда из скольких. */
const progress = ref<string | null>(null);

/** Команды и дивизионы из настроек. */
const teamList = ref<TeamBoard[]>([]);
const divisionList = ref<Division[]>([]);
const target = ref<QuarterTargetConfig>({ productPct: 67, bandPp: 5 });

/**
 * Дивизионы для выбора. Включённые команды вне всех дивизионов не должны теряться —
 * для них добавляется псевдо-дивизион «Другие команды».
 */
const divisionOptions = computed<Division[]>(() => {
  const inDivision = new Set(divisionList.value.flatMap((d) => d.teamIds));
  const others = teamList.value.filter((t) => t.enabled && !inDivision.has(t.rapidViewId));
  const list = [...divisionList.value];
  if (others.length) {
    list.push({ id: OTHERS_ID, name: 'Другие команды', teamIds: others.map((t) => t.rapidViewId) });
  }
  return list;
});

const selectedDivisionId = ref<string>('');
const selectedDivision = computed(
  () => divisionOptions.value.find((d) => d.id === selectedDivisionId.value) ?? null,
);
/** Включённые команды выбранного дивизиона — это вкладки. */
const currentTeams = computed(() =>
  selectedDivision.value ? divisionTeams(selectedDivision.value, teamList.value) : [],
);

/** Что открыто: сводка дивизиона или конкретная команда (rapidViewId). */
const view = ref<'division' | number>('division');

/** Отчёт по ВЫБРАННОЙ команде (грузим только её — не тянем лишнее). */
const report = ref<TeamReport | null>(null);
/** Сводка выбранного дивизиона по кварталам. */
const division = ref<{ quarters: DivisionQuarter[]; failed: number } | null>(null);

/** Раскрытые кварталы: `${quarterId}`. */
const openQuarters = ref<Set<string>>(new Set());
/** Раскрытые спринты: `${sprintId}`. */
const openSprints = ref<Set<number>>(new Set());

function toggleQuarter(q: string) {
  const next = new Set(openQuarters.value);
  if (next.has(q)) next.delete(q);
  else next.add(q);
  openQuarters.value = next;
}
function toggleSprint(sid: number) {
  const next = new Set(openSprints.value);
  if (next.has(sid)) next.delete(sid);
  else next.add(sid);
  openSprints.value = next;
}

/** Активный фильтр задач по бакету на КАЖДЫЙ спринт: sprintId → слайс (или отсутствует = все). */
const sliceFilter = ref<Map<number, CapSlice>>(new Map());

/**
 * Клик по бакет-чипу спринта: раскрыть спринт и отфильтровать таблицу по этому слайсу.
 * Повторный клик по тому же слайсу — снять фильтр (показать все задачи).
 */
function onSliceClick(sid: number, slice: CapSlice) {
  const next = new Map(sliceFilter.value);
  if (next.get(sid) === slice) next.delete(sid);
  else next.set(sid, slice);
  sliceFilter.value = next;
  // Всегда раскрываем спринт при выборе фильтра.
  if (next.has(sid) && !openSprints.value.has(sid)) toggleSprint(sid);
}

/** Сбросить фильтр бакета у спринта (кнопка «Все»). */
function clearSliceFilter(sid: number) {
  if (!sliceFilter.value.has(sid)) return;
  const next = new Map(sliceFilter.value);
  next.delete(sid);
  sliceFilter.value = next;
}

/** Задачи спринта с учётом активного бакет-фильтра. */
function visibleIssues(s: SprintReportDetail): SprintReportIssue[] {
  const slice = sliceFilter.value.get(s.sprintId);
  if (!slice) return s.completedIssues;
  return s.completedIssues.filter((i) => issueInSlice(i, slice));
}

/** Применить отчёт к UI: выставить report, раскрыть свежий квартал, сбросить фильтры. */
function applyReport(r: TeamReport) {
  report.value = r;
  openQuarters.value = r.quarters[0] ? new Set([r.quarters[0].quarter]) : new Set();
  openSprints.value = new Set();
  sliceFilter.value = new Map();
  ruleFilter.value = new Map();
}

/** Отчёты закрытых спринтов из persist-кеша. Без TTL: закрытый спринт неизменен. */
async function readSprintCache(): Promise<Map<number, SprintReportDetail>> {
  const cache = await sprintReportCache.getValue();
  const out = new Map<number, SprintReportDetail>();
  for (const [id, entry] of Object.entries(cache ?? {})) {
    // addedIssueKeys — Set, а JSON его не переживает: восстанавливаем из массива.
    out.set(Number(id), reviveDetail(entry.detail));
  }
  return out;
}

/**
 * chrome.storage сериализует через JSON, поэтому Set превращается в {} — восстанавливаем.
 * Без этого правило reestimate перестало бы исключать добавленные задачи (двойной счёт).
 */
function reviveDetail(d: SprintReportDetail): SprintReportDetail {
  const keys = d.addedIssueKeys;
  return {
    ...d,
    addedIssueKeys: keys instanceof Set ? keys : new Set(Array.isArray(keys) ? keys : []),
  };
}

/**
 * Дописать свежедобытые отчёты в кеш, вытеснив самые старые при переполнении.
 * Пишем ДАЖЕ при частичной загрузке — иначе упавший спринт пришлось бы тянуть каждый раз заново.
 */
async function writeSprintCache(fetched: ReadonlyMap<number, SprintReportDetail>) {
  if (fetched.size === 0) return;
  const cache = { ...(await sprintReportCache.getValue()) };
  const now = Date.now();
  for (const [id, detail] of fetched) {
    // Set не сериализуется в chrome.storage — кладём массивом, обратно поднимаем в reviveDetail.
    cache[String(id)] = {
      detail: { ...detail, addedIssueKeys: [...detail.addedIssueKeys] as unknown as Set<string> },
      cachedAt: now,
    };
  }
  const entries = Object.entries(cache);
  if (entries.length > SPRINT_CACHE_LIMIT) {
    entries.sort((a, b) => b[1].cachedAt - a[1].cachedAt);
    await sprintReportCache.setValue(Object.fromEntries(entries.slice(0, SPRINT_CACHE_LIMIT)));
    return;
  }
  await sprintReportCache.setValue(cache);
}

/**
 * Настроить доступ к Jira. Два пути: токен — основной (работает всегда). Без токена идём
 * через ОТКРЫТУЮ вкладку Jira: там живут cookie сессии SSO, и запросы делает content-script.
 * false — доступа нет, текст ошибки уже выставлен.
 */
async function ensureAccess(): Promise<boolean> {
  const creds = await jiraCreds.getValue();
  if (creds) {
    setJiraAuth({ baseUrl: creds.baseUrl, email: creds.email, apiToken: creds.apiToken });
    setJiraTabTransport(null);
    usingTab.value = false;
    jiraBase.value = creds.baseUrl;
    return true;
  }
  // Ждём ГОТОВНОСТИ вкладки, а не просто её наличия: Jira SPA поднимает content-script
  // секунды, и без ожидания первый же запрос падал бы — пользователь видел бы ошибку
  // вместо данных. Цикл живёт здесь: страница не выгружается, в отличие от MV3-воркера.
  waitingTab.value = true;
  const { ready, present } = await waitJiraTabReady();
  waitingTab.value = false;
  if (!ready) {
    error.value = present
      ? 'Вкладка Jira ещё не загрузилась. Дождитесь, пока откроется доска, и нажмите «Повторить».'
      : 'Нет доступа к Jira. Либо откройте вкладку Jira в этом браузере (тогда токен не нужен), ' +
        'либо укажите email и API-токен в настройках расширения.';
    return false;
  }
  setJiraAuth(null);
  setJiraTabTransport((path) => sendMessage('jiraFetch', { path }));
  usingTab.value = true;
  return true;
}

/**
 * Отчёт одной команды. Отчёты закрытых спринтов кешируются БЕССРОЧНО по sprintId, поэтому
 * сеть трогается только для новых спринтов: первое открытие ~14 запросов, дальше — 2 + 0–1.
 * fresh: 'list' — перечитать список спринтов (новые закрытые), 'all' — ещё и все отчёты.
 */
async function loadTeam(team: TeamBoard, fresh: 'none' | 'list' | 'all'): Promise<TeamReport> {
  const mem = fresh === 'none' ? memCache.get(team.rapidViewId) : undefined;
  if (mem) return mem;
  // Отдаём загрузчику всё, что уже есть — он дотянет только недостающее.
  const cached = fresh === 'all' ? new Map<number, SprintReportDetail>() : await readSprintCache();
  const { sprints, failed, fetched } = await getBoardSprintReportsSince(
    team.rapidViewId,
    SINCE_ISO,
    cached,
  );
  const built = buildReport(team, sprints, failed);
  memCache.set(team.rapidViewId, built);
  await writeSprintCache(fetched);
  return built;
}

/** Все ли нужные отчёты уже в памяти страницы — тогда показываем без сети и без мигания. */
function inMemory(list: readonly TeamBoard[]): boolean {
  return list.every((t) => memCache.has(t.rapidViewId));
}

/** Загрузить текущий вид: сводку дивизиона или одну команду. force=true минует кеши. */
async function load(force = false) {
  const v = view.value;
  const list =
    v === 'division' ? currentTeams.value : currentTeams.value.filter((t) => t.rapidViewId === v);
  error.value = null;
  if (list.length === 0) {
    report.value = null;
    division.value = null;
    loading.value = false;
    return;
  }

  const fromMemory = !force && inMemory(list);
  if (!fromMemory) loading.value = true;
  try {
    if (!fromMemory && !(await ensureAccess())) return;

    // Команды — ПОСЛЕДОВАТЕЛЬНО: у каждой свой пул запросов, а параллельно три пула
    // пробили бы лимит Jira (rate limit считается на весь тенант). «Обновить» у дивизиона
    // перечитывает только списки спринтов: полная перезагрузка всех команд — это десятки
    // запросов разом, а закрытые спринты не меняются. Полная — на вкладке команды.
    const fresh = !force ? 'none' : v === 'division' ? 'list' : 'all';
    const reports: TeamReport[] = [];
    for (const [i, t] of list.entries()) {
      if (list.length > 1) progress.value = `${t.name} (${i + 1} из ${list.length})`;
      reports.push(await loadTeam(t, fresh));
    }
    if (v !== view.value) return; // пока грузили, пользователь переключил вкладку

    if (v === 'division') {
      division.value = {
        quarters: divisionQuarters(
          reports.map((r) => ({ rapidViewId: r.rapidViewId, team: r.team, sprints: r.sprints })),
        ),
        failed: reports.reduce((s, r) => s + r.failed, 0),
      };
    } else {
      applyReport(reports[0]);
    }
  } catch (e) {
    error.value = errorText(e);
  } finally {
    progress.value = null;
    loading.value = false;
  }
}

/**
 * Текст ошибки под режим доступа: в режиме вкладки совет «проверьте токен» бессмыслен —
 * токена там нет и не должно быть.
 */
function errorText(e: unknown): string {
  if (e instanceof JiraRequestError) {
    if (e.error.kind === 'unauthorized') {
      return usingTab.value
        ? 'Jira отклонила запрос (401/403). Похоже, сессия на вкладке Jira истекла — обновите вкладку и войдите заново.'
        : 'Jira отклонила запрос (401/403). Проверьте email и API-токен в настройках.';
    }
    if (e.error.kind === 'not-configured') {
      return 'Вкладка Jira не отвечает. Откройте её, дождитесь загрузки доски и нажмите «Повторить». Либо укажите API-токен в настройках — тогда вкладка не нужна.';
    }
    if (e.error.kind === 'rate-limited') {
      return 'Jira ограничила частоту запросов. Подождите минуту и нажмите «Повторить» — уже загруженные спринты сохранены.';
    }
  }
  return `Ошибка загрузки: ${String(e)}`;
}

/** Кнопка «Обновить» — форсированная перезагрузка текущего вида из сети. */
function refresh() {
  void load(true);
}

/** Выбор и адрес запоминаем в hash — ссылку на вид дивизиона/команды можно переслать. */
function writeHash() {
  const team = view.value === 'division' ? '' : `&team=${view.value}`;
  history.replaceState(
    null,
    '',
    `#division=${encodeURIComponent(selectedDivisionId.value)}${team}`,
  );
}

function selectView(v: 'division' | number) {
  if (loading.value || v === view.value) return;
  view.value = v;
  writeHash();
  void load();
}

function selectDivision(id: string) {
  if (loading.value || id === selectedDivisionId.value) return;
  selectedDivisionId.value = id;
  view.value = 'division';
  writeHash();
  void load();
}

onMounted(async () => {
  // Пороги нужны ДО первого buildReport — иначе правила не посчитаются.
  thresholds.value = toThresholds(await sprintHealthThresholds.getValue());
  teamList.value = await teams.getValue();
  divisionList.value = await divisions.getValue();
  target.value = await quarterTarget.getValue();

  const hash = new URLSearchParams(location.hash.slice(1));
  const wanted = divisionOptions.value.find((d) => d.id === hash.get('division'));
  selectedDivisionId.value = (wanted ?? divisionOptions.value[0])?.id ?? '';
  const teamId = Number(hash.get('team'));
  if (currentTeams.value.some((t) => t.rapidViewId === teamId)) view.value = teamId;
  await load();
});

/**
 * Настройки команд/дивизионов поменяли в соседней вкладке — перестраиваем вид без перезагрузки
 * страницы. Сеть почти не трогаем: отчёты команд уже в памяти и в кеше спринтов.
 */
async function onTeamsChanged() {
  teamList.value = await teams.getValue();
  divisionList.value = await divisions.getValue();
  if (!divisionOptions.value.some((d) => d.id === selectedDivisionId.value)) {
    selectedDivisionId.value = divisionOptions.value[0]?.id ?? '';
  }
  if (view.value !== 'division' && !currentTeams.value.some((t) => t.rapidViewId === view.value)) {
    view.value = 'division';
  }
  writeHash();
  if (!loading.value) void load();
}
teams.watch(() => void onTeamsChanged());
divisions.watch(() => void onTeamsChanged());
quarterTarget.watch((v) => (target.value = v));

// --- Сводка дивизиона ---

/** Идёт ли квартал сейчас — у текущего в сводке только закрытые спринты, цифры будут расти. */
const currentQuarter = quarterOf(new Date().toISOString());

/** Product-доля квартала против цели из настроек: в коридоре или нет. */
function productStatus(b: CapBreakdown): { pct: number; delta: number; ok: boolean } {
  const pct = b.shares.find((s) => s.slice === 'Product')?.pct ?? 0;
  const delta = +(pct - target.value.productPct).toFixed(1);
  return { pct, delta, ok: Math.abs(delta) <= target.value.bandPp };
}

/** Доля команды в закрытом объёме дивизиона за квартал, %. */
function shareOf(q: DivisionQuarter, sp: number): number {
  return q.completedSp > 0 ? Math.round((sp / q.completedSp) * 100) : 0;
}

/** Активное правило на КАЖДЫЙ спринт: sprintId → правило (или отсутствует = не выбрано). */
const ruleFilter = ref<Map<number, RuleId>>(new Map());

/** Правила здоровья конкретного спринта. */
function healthOf(sprintId: number): RuleResult[] {
  return report.value?.health.get(sprintId) ?? [];
}

/**
 * Клик по чипу правила: раскрыть спринт и показать задачи, на которых основано число.
 * Повторный клик по тому же правилу — свернуть подсветку.
 */
function onRuleClick(sid: number, rule: RuleId) {
  const next = new Map(ruleFilter.value);
  if (next.get(sid) === rule) next.delete(sid);
  else next.set(sid, rule);
  ruleFilter.value = next;
  if (next.has(sid) && !openSprints.value.has(sid)) toggleSprint(sid);
}

/** Подтверждающие данные активного правила спринта (какие задачи дали число). */
function activeEvidence(sid: number) {
  const rule = ruleFilter.value.get(sid);
  if (!rule) return null;
  const res = healthOf(sid).find((r) => r.rule === rule);
  return res?.evidence?.issues.length ? { rule, result: res, ...res.evidence } : null;
}

/**
 * Задачи выбранного правила КАК КАРТОЧКИ: с заголовком, типом, статусом и вкладом в метрику.
 * Ищем во всех массивах спринта — punted/added задачи не лежат в completedIssues.
 */
function evidenceCards(s: SprintReportDetail) {
  const ev = activeEvidence(s.sprintId);
  if (!ev) return [];
  const pool = new Map<string, SprintReportIssue>();
  for (const i of [
    ...s.completedIssues,
    ...s.notCompletedIssues,
    ...s.puntedIssues,
    ...s.completedInAnotherSprintIssues,
  ]) {
    if (!pool.has(i.key)) pool.set(i.key, i);
  }
  return ev.issues.map((e) => ({ ...e, issue: pool.get(e.key) ?? null }));
}

/** Подпись вклада задачи в метрику: для переоценки «3 → 8 SP», иначе просто SP. */
function contribution(e: { points: number; from?: number | null; to?: number }): string {
  if (typeof e.to === 'number' && typeof e.from === 'number') {
    return `${fmtNum(e.from)} → ${fmtNum(e.to)} SP  (+${fmtNum(e.points)})`;
  }
  return `${fmtNum(e.points)} SP`;
}

/** Короткие имена правил для сводки в шапке. */
const SUMMARY_LABEL: Record<RuleId, string> = {
  'velocity-drop': 'Скорость',
  carryover: 'Перенос',
  reestimate: 'Переоценка',
  'scope-added': 'Добавлено',
  punted: 'Выброшено',
};

/** Проценты сводки: до 1 знака при малых значениях, иначе целые (7.3% против «7%»). */
function fmtPct(v: number | null): string {
  if (v === null) return '—';
  const abs = Math.abs(v) * 100;
  return (abs < 10 ? abs.toFixed(1) : abs.toFixed(0)) + '%';
}

/** Значение правила в сводке: перенос/скорость — в %, выброшенные — в задачах. */
function summaryValue(rs: RuleSummary): string {
  if (rs.typical === null) return '—';
  return rs.rule === 'punted' ? `${fmtNum(rs.typical)} зад.` : fmtPct(rs.typical);
}

/** Главный вывод по окну: что чинить, почему и что уже наладилось. */
const verdict = computed(() => (report.value ? healthVerdict(report.value.healthSummary) : null));

/**
 * Формулировка проблемы человеческим языком. Опирается на причинно-следственную модель
 * Cohn: перенос — следствие, а «взяли больше», «вбросы», «рост оценок» — его причины.
 */
const verdictText = computed(() => {
  const v = verdict.value;
  if (!v) return null;
  if (!v.focus) {
    return { headline: 'Спринты идут в пределах ориентиров', detail: '' };
  }
  const f = v.focus;

  const HEAD: Record<RuleId, string> = {
    carryover: `Команда берёт больше, чем закрывает: ${summaryValue(f)} работы уезжает в следующий спринт`,
    'velocity-drop': `Скорость держится ниже привычной: типично на ${summaryValue(f)} меньше медианы предыдущих спринтов`,
    reestimate: `Оценки растут уже в спринте: в среднем на ${summaryValue(f)} от взятого объёма`,
    'scope-added': `В спринт добавляют работу после старта: ${summaryValue(f)} сверх плана`,
    punted: `Из спринтов убирают задачи после старта: ${summaryValue(f)} за спринт`,
  };
  const CAUSE: Partial<Record<RuleId, string>> = {
    'velocity-drop': 'берут больше, чем обычно успевают',
    'scope-added': 'в спринт добавляют работу после старта',
    reestimate: 'задачи оказываются объёмнее, чем оценили',
  };

  // «4 спринта из 6» — склонение по числу, иначе получается «в 4 спринтов из 6 спринтов».
  const plural = (n: number) => {
    const mod10 = n % 10;
    const mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return 'спринте';
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'спринтах';
    return 'спринтах';
  };
  const ref = f.rule === 'punted' ? `${fmtNum(f.threshold)} задач` : fmtPct(f.threshold);
  const parts: string[] = [
    `Так в ${f.warnCount} ${plural(f.warnCount)} из ${f.evaluated}${v.chronic ? ' — это уже привычка, а не случайность' : ''}. Ориентир — ${ref}.`,
  ];
  if (v.cause && CAUSE[v.cause.rule]) {
    parts.push(`Вероятная причина: ${CAUSE[v.cause.rule]} (${summaryValue(v.cause)}).`);
  }
  if (v.worsening) parts.push('В последних спринтах стало заметнее.');
  return { headline: HEAD[f.rule], detail: parts.join(' ') };
});

/** «Что наладилось» — короткие фразы вида «вбросов стало меньше: 14% → 2%». */
const improvedText = computed(() => {
  const IMPROVED: Record<RuleId, string> = {
    carryover: 'переносить стали меньше',
    'velocity-drop': 'скорость выровнялась',
    reestimate: 'оценки стали точнее',
    'scope-added': 'реже добавляют работу после старта',
    punted: 'перестали убирать задачи из спринта',
  };
  // Для «выброшено» единица — задачи, и дробное «0.3 задачи» бессмысленно: округляем.
  const fmtBy = (rule: RuleId, v: number | null) =>
    rule === 'punted' ? String(Math.round(v ?? 0)) : fmtPct(v);
  return (
    (verdict.value?.improved ?? [])
      .map((s) => ({
        rule: s.rule,
        text: IMPROVED[s.rule],
        from: fmtBy(s.rule, s.olderAvg),
        to: fmtBy(s.rule, s.recentAvg),
      }))
      // Если после округления «было» и «стало» совпали, улучшение не читается — не показываем.
      .filter((s) => s.from !== s.to)
  );
});

/** Направление словом + «хорошо ли это» для конкретного правила (рост всех пяти — плохо). */
function directionNote(rs: RuleSummary): { arrow: string; word: string; good: boolean } | null {
  // Значение уже на нуле — «снижается» бессмысленно (снижаться некуда).
  if (rs.typical === 0 && rs.direction === 'down') {
    return { arrow: '', word: 'нет', good: true };
  }
  if (!rs.direction || rs.direction === 'flat') {
    return rs.direction === 'flat' ? { arrow: '→', word: 'ровно', good: true } : null;
  }
  const up = rs.direction === 'up';
  return { arrow: up ? '↑' : '↓', word: up ? 'растёт' : 'снижается', good: !up };
}

/** Пояснение к строке сводки: типичное значение, ориентир, динамика. */
function summaryHint(rs: RuleSummary): string {
  if (rs.evaluated === 0) {
    return `${SUMMARY_LABEL[rs.rule]}: нет спринтов, для которых правило можно посчитать (мало истории или Jira не отдала данные)`;
  }
  const base = `${SUMMARY_LABEL[rs.rule]}: типично ${summaryValue(rs)} при ориентире ${rs.rule === 'punted' ? fmtNum(rs.threshold) + ' зад.' : fmtPct(rs.threshold)}. Вне ориентира ${rs.warnCount} из ${rs.evaluated} спринтов.`;
  if (rs.olderAvg === null || rs.recentAvg === null) return base;
  const fmt = rs.rule === 'punted' ? fmtNum : fmtPct;
  return `${base} Первая половина окна ${fmt(rs.olderAvg)} → вторая ${fmt(rs.recentAvg)}.`;
}

/** Человекочитаемые имена правил — для подписи раскрытого списка. */
const RULE_LABEL: Record<RuleId, string> = {
  'velocity-drop': 'Просадка скорости',
  carryover: 'Перенесено в следующий спринт',
  reestimate: 'Выросли оценки после старта',
  'scope-added': 'Добавлено после старта спринта',
  punted: 'Выброшено из спринта',
};

const totalSprints = computed(() => report.value?.sprintCount ?? 0);

/** Сколько спринтов не догрузилось в текущем виде — для плашки о неполных данных. */
const failedCount = computed(() =>
  view.value === 'division' ? (division.value?.failed ?? 0) : (report.value?.failed ?? 0),
);

/** Человекочитаемое имя квартала: "2025-Q2" → "Q2 2025". */
function quarterLabel(q: string): string {
  const [year, quarter] = q.split('-');
  return `${quarter} ${year}`;
}

/** SP → строка (— если оценки нет). */
const fmtSp = (p: number | null) => (p === null ? '—' : String(p));

/** Число без лишнего .0 (68 вместо 68.0, но 12.5 сохраняем). */
const fmtNum = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

/** Переоценка спринта: сколько SP добавилось после старта (current − initial). */
function reestimate(s: SprintReportDetail): number {
  return s.completedPoints - s.completedInitialPoints;
}

/** Только слайсы с ненулевой долей — для компактного бара/легенды. */
function nonEmpty(b: CapBreakdown) {
  return b.shares.filter((s) => s.points > 0);
}

/** Цвет слайса. */
const sliceColor = (slice: CapSlice) => BUCKET_COLORS[slice];

/** Русское имя слайса для легенды. */
const SLICE_LABEL: Record<CapSlice, string> = {
  Product: 'Product',
  Tech: 'Tech',
  Support: 'Support',
  Unlabeled: 'Без метки',
};

/** Цвет чипа статуса задачи. */
function statusTone(status: string): string {
  const s = status.toLowerCase();
  if (s.includes('готов') || s.includes('done') || s.includes('closed')) {
    return 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300';
  }
  if (s.includes('отмен') || s.includes('cancel') || s.includes('reject')) {
    return 'bg-rose-50 text-rose-700 dark:bg-rose-950 dark:text-rose-300';
  }
  return 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300';
}

/** CAP-метка задачи (первая с cap_) для мелкого бейджа. */
function capLabel(issue: SprintReportIssue): string | null {
  const cap = issue.labels.find((l) => l.toLowerCase().startsWith('cap_'));
  return cap ? cap.replace(/^CAP_/i, '') : null;
}

// экспортируем в шаблон
const CAP_SLICES_ALL = CAP_SLICES;
</script>

<template>
  <div class="min-h-screen bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
    <div class="mx-auto max-w-4xl px-6 py-8">
      <!-- Заголовок -->
      <header class="mb-5 flex items-center gap-3">
        <span
          class="grid size-9 place-items-center rounded-lg bg-indigo-600 text-base font-bold text-white"
        >
          TL
        </span>
        <div class="flex-1">
          <h1 class="text-lg font-semibold">Отчёт по спринтам</h1>
          <p class="text-sm text-slate-500 dark:text-slate-400">
            Спринты с Q4 2025 по кварталам · сводка дивизиона и команд · CAP-микс · velocity.
          </p>
        </div>
        <button
          class="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:hover:bg-slate-800"
          :disabled="loading"
          @click="refresh"
        >
          {{ loading ? 'Загрузка…' : '↻ Обновить' }}
        </button>
      </header>

      <!-- Выбор дивизиона и вкладки: сводка дивизиона + команды (ADS-стиль, как табы Jira) -->
      <div class="mb-6 flex flex-wrap items-center gap-3">
        <label class="flex items-center gap-2">
          <span class="text-xs font-medium uppercase tracking-wide text-slate-400">Дивизион</span>
          <select
            :value="selectedDivisionId"
            :disabled="loading || divisionOptions.length < 2"
            class="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm font-medium outline-none focus:border-indigo-500 disabled:opacity-100 dark:border-slate-700 dark:bg-slate-900"
            @change="selectDivision(($event.target as HTMLSelectElement).value)"
          >
            <option v-for="d in divisionOptions" :key="d.id" :value="d.id">{{ d.name }}</option>
          </select>
        </label>
        <div
          v-if="currentTeams.length"
          role="tablist"
          aria-label="Сводка дивизиона или команда"
          class="inline-flex flex-wrap gap-0.5 rounded-lg bg-slate-100 p-0.5 dark:bg-slate-800/80"
        >
          <button
            v-for="tab in [
              { id: 'division' as const, label: 'Весь дивизион' },
              ...currentTeams.map((t) => ({ id: t.rapidViewId, label: t.name })),
            ]"
            :key="tab.id"
            type="button"
            role="tab"
            :aria-selected="view === tab.id"
            :disabled="loading"
            class="rounded-md px-3.5 py-1.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-60"
            :class="
              view === tab.id
                ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-950 dark:text-white'
                : 'text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200'
            "
            @click="selectView(tab.id)"
          >
            {{ tab.label }}
          </button>
        </div>
        <a
          href="/options.html"
          target="_blank"
          class="ml-auto text-xs text-indigo-600 hover:underline dark:text-indigo-400"
        >
          Настроить команды и дивизионы
        </a>
      </div>

      <!-- Общая легенда бакетов -->
      <div
        v-if="
          !loading && !error && (view === 'division' ? division?.quarters.length : totalSprints)
        "
        class="mb-6 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500 dark:text-slate-400"
      >
        <span v-for="slice in CAP_SLICES_ALL" :key="slice" class="inline-flex items-center gap-1.5">
          <span
            class="inline-block size-2.5 rounded-sm"
            :style="{ background: sliceColor(slice) }"
          />
          {{ SLICE_LABEL[slice] }}
        </span>
      </div>

      <!-- Режим без токена: данные идут через открытую вкладку Jira -->
      <div
        v-if="usingTab && !error"
        class="mb-4 flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-500 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400"
      >
        <span class="inline-block size-1.5 rounded-full bg-emerald-500"></span>
        Работаем через открытую вкладку Jira (сессия браузера) — API-токен не нужен. Если закрыть
        её, добавьте токен в настройках.
      </div>

      <!-- Плашка частичных данных: часть спринтов не догрузилась (rate-limit/сеть) -->
      <div
        v-if="!loading && !error && failedCount > 0"
        class="mb-4 flex items-center gap-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
      >
        <span class="flex-1">
          Загружены не все спринты: {{ failedCount }}
          {{ failedCount === 1 ? 'спринт не удалось' : 'спринтов не удалось' }} получить
          (ограничение частоты запросов Jira). Квартальные цифры могут быть неполными.
        </span>
        <button
          type="button"
          class="shrink-0 rounded-md border border-amber-400 px-2.5 py-1 text-xs font-medium hover:bg-amber-100 dark:border-amber-700 dark:hover:bg-amber-900"
          @click="refresh"
        >
          Повторить
        </button>
      </div>

      <!-- Ошибка -->
      <div
        v-if="error"
        class="flex flex-wrap items-center gap-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
      >
        <span class="flex-1">{{ error }}</span>
        <button
          type="button"
          class="shrink-0 rounded-md border border-amber-400 px-2.5 py-1 text-xs font-medium hover:bg-amber-100 disabled:opacity-50 dark:border-amber-700 dark:hover:bg-amber-900"
          :disabled="loading"
          @click="refresh"
        >
          Повторить
        </button>
      </div>

      <!-- Загрузка -->
      <div v-else-if="loading" class="py-16 text-center text-sm text-slate-400">
        <template v-if="waitingTab">
          Ждём загрузки вкладки Jira — через неё идут запросы, пока не задан API-токен…
        </template>
        <template v-else>
          Загружаем отчёты по спринтам…
          <template v-if="progress">{{ progress }}</template>
          <template v-else>(все закрытые спринты с Q4 2025)</template>
        </template>
      </div>

      <!-- Нет команд: всё выключено или дивизион пуст -->
      <div v-else-if="!currentTeams.length" class="py-16 text-center text-sm text-slate-400">
        В дивизионе нет включённых команд. Добавьте их в
        <a
          href="/options.html"
          target="_blank"
          class="text-indigo-600 hover:underline dark:text-indigo-400"
        >
          настройках</a
        >.
      </div>

      <!-- Сводка дивизиона: кварталы, в каждом итог и строка на команду -->
      <div v-else-if="view === 'division'" class="space-y-4">
        <div v-if="!division?.quarters.length" class="py-16 text-center text-sm text-slate-400">
          Нет закрытых спринтов с Q4 2025 у команд дивизиона.
        </div>
        <section
          v-for="q in division?.quarters ?? []"
          :key="q.quarter"
          class="overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900"
        >
          <div class="px-4 pb-3 pt-3">
            <div class="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <h2 class="text-base font-semibold">{{ quarterLabel(q.quarter) }}</h2>
              <span
                v-if="q.quarter === currentQuarter"
                class="rounded bg-sky-50 px-1.5 py-0.5 text-[11px] font-medium text-sky-700 dark:bg-sky-950 dark:text-sky-300"
                title="Квартал ещё идёт: учтены только закрытые спринты"
              >
                идёт
              </span>
              <span class="text-xs text-slate-500 dark:text-slate-400">
                {{ q.sprintCount }} спр. ·
                <b class="text-slate-700 dark:text-slate-200">{{ fmtNum(q.completedSp) }} SP</b>
                закрыто
              </span>
              <span
                class="ml-auto text-xs font-medium"
                :class="
                  productStatus(q.breakdown).ok
                    ? 'text-emerald-700 dark:text-emerald-400'
                    : 'text-amber-700 dark:text-amber-400'
                "
                :title="`Цель Product ${target.productPct}% ±${target.bandPp} пп (настраивается в «Квартальный баланс»)`"
              >
                Product {{ productStatus(q.breakdown).pct }}%
                <template v-if="productStatus(q.breakdown).ok">· в цели</template>
                <template v-else>
                  · {{ productStatus(q.breakdown).delta > 0 ? '+' : ''
                  }}{{ productStatus(q.breakdown).delta }} пп от цели {{ target.productPct }}%
                </template>
              </span>
            </div>

            <!-- CAP-микс дивизиона + метка цели Product -->
            <div class="relative">
              <div class="flex h-3 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
                <div
                  v-for="sh in nonEmpty(q.breakdown)"
                  :key="sh.slice"
                  class="h-full"
                  :style="{ width: sh.pct + '%', background: sliceColor(sh.slice) }"
                  :title="`${SLICE_LABEL[sh.slice]}: ${fmtNum(sh.points)} SP (${sh.pct}%)`"
                />
              </div>
              <div
                class="absolute -bottom-0.5 -top-0.5 w-0.5 bg-slate-800 dark:bg-slate-100"
                :style="{ left: `calc(${target.productPct}% - 1px)` }"
                :title="`Цель Product: ${target.productPct}%`"
              />
            </div>
            <div
              class="mt-2 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-slate-500 dark:text-slate-400"
            >
              <span
                v-for="sh in nonEmpty(q.breakdown)"
                :key="sh.slice"
                class="inline-flex items-center gap-1"
              >
                <span
                  class="inline-block size-2 rounded-sm"
                  :style="{ background: sliceColor(sh.slice) }"
                />
                {{ SLICE_LABEL[sh.slice] }} {{ sh.pct }}%
                <span class="text-slate-400">({{ fmtNum(sh.points) }})</span>
              </span>
            </div>
          </div>

          <!-- Вклад команд -->
          <table class="w-full text-sm">
            <thead>
              <tr
                class="border-t border-slate-100 text-left font-mono text-[11px] uppercase tracking-wide text-slate-400 dark:border-slate-800"
              >
                <th class="py-2 pl-4 pr-2 font-normal">Команда</th>
                <th class="px-2 py-2 text-right font-normal">Спр.</th>
                <th class="px-2 py-2 text-right font-normal">SP</th>
                <th
                  class="px-2 py-2 text-right font-normal"
                  title="Доля команды в закрытом объёме дивизиона"
                >
                  Доля
                </th>
                <th class="px-2 py-2 text-right font-normal" title="Среднее закрытое за спринт">
                  SP/спр.
                </th>
                <th class="w-2/5 py-2 pl-2 pr-4 font-normal">CAP-микс</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="t in q.teams"
                :key="t.rapidViewId"
                class="border-t border-slate-50 dark:border-slate-800/50"
              >
                <td class="py-2 pl-4 pr-2">
                  <button
                    type="button"
                    class="font-medium text-indigo-600 hover:underline dark:text-indigo-400"
                    :title="`Открыть отчёт команды ${t.team}`"
                    @click="selectView(t.rapidViewId)"
                  >
                    {{ t.team }}
                  </button>
                </td>
                <td class="px-2 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400">
                  {{ t.sprintCount }}
                </td>
                <td class="px-2 py-2 text-right font-medium tabular-nums">
                  {{ fmtNum(t.completedSp) }}
                </td>
                <td class="px-2 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400">
                  {{ shareOf(q, t.completedSp) }}%
                </td>
                <td class="px-2 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400">
                  {{ t.spPerSprint === null ? '—' : fmtNum(t.spPerSprint) }}
                </td>
                <td class="py-2 pl-2 pr-4">
                  <div v-if="t.breakdown.totalPoints > 0" class="flex items-center gap-2">
                    <span
                      class="flex h-2 flex-1 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800"
                    >
                      <span
                        v-for="sh in nonEmpty(t.breakdown)"
                        :key="sh.slice"
                        class="h-full"
                        :style="{ width: sh.pct + '%', background: sliceColor(sh.slice) }"
                        :title="`${SLICE_LABEL[sh.slice]}: ${fmtNum(sh.points)} SP (${sh.pct}%)`"
                      />
                    </span>
                    <span
                      class="w-20 shrink-0 text-right text-[11px] tabular-nums"
                      :class="
                        productStatus(t.breakdown).ok
                          ? 'text-slate-500 dark:text-slate-400'
                          : 'text-amber-700 dark:text-amber-400'
                      "
                      :title="`Доля Product у команды; цель ${target.productPct}% ±${target.bandPp} пп`"
                    >
                      Product {{ productStatus(t.breakdown).pct }}%
                    </span>
                  </div>
                  <span v-else class="text-[11px] text-slate-400">нет закрытых спринтов</span>
                </td>
              </tr>
            </tbody>
          </table>
        </section>
      </div>

      <!-- Пусто -->
      <div
        v-else-if="!report || totalSprints === 0"
        class="py-16 text-center text-sm text-slate-400"
      >
        Нет закрытых спринтов с Q4 2025 у этой команды.
      </div>

      <!-- Отчёт выбранной команды -->
      <div v-else class="space-y-6">
        <section>
          <!-- Шапка команды + velocity -->
          <div class="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h2 class="text-base font-semibold">{{ report.team }}</h2>
            <span class="font-mono text-xs text-slate-400">board {{ report.rapidViewId }}</span>
            <span class="ml-auto text-xs text-slate-500 dark:text-slate-400">
              <template v-if="report.velocity.median !== null">
                <span
                  title="Медиана и среднее completed SP по последним спринтам, ВКЛЮЧАЯ самый свежий. Правило «Скорость» у каждого спринта сравнивает его с медианой ПРЕДЫДУЩИХ — поэтому там другое число."
                >
                  velocity (посл. {{ report.velocity.count }}, вкл. текущий):
                  <b class="text-slate-700 dark:text-slate-200">
                    медиана {{ fmtNum(report.velocity.median) }} SP
                  </b>
                  · среднее {{ fmtNum(report.velocity.mean!) }} SP
                </span>
              </template>
              <template v-else>velocity: нет данных</template>
            </span>
          </div>

          <!--
            Сводка окна. Не счётчик нарушений («4 из 6 вне нормы» не отвечает ни насколько
            плохо, ни куда движется), а вывод + типичное значение + динамика: число без
            истории и сравнения бессмысленно (Tufte), а следствие отделено от причины (Cohn).
          -->
          <section
            v-if="report.healthSummary.length && verdictText"
            class="mb-4 overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900"
          >
            <!-- Главный вывод словами -->
            <div
              class="px-4 py-3"
              :class="
                verdict?.focus
                  ? 'bg-amber-50/70 dark:bg-amber-950/20'
                  : 'bg-emerald-50/60 dark:bg-emerald-950/20'
              "
            >
              <p class="text-sm font-medium text-slate-800 dark:text-slate-100">
                {{ verdictText.headline }}
              </p>
              <p
                v-if="verdictText.detail"
                class="mt-1 text-xs leading-relaxed text-slate-600 dark:text-slate-300"
              >
                {{ verdictText.detail }}
              </p>
              <p
                v-if="improvedText.length"
                class="mt-1.5 text-xs leading-relaxed text-emerald-700 dark:text-emerald-400"
              >
                Наладилось:
                <span v-for="(im, idx) in improvedText" :key="im.rule">
                  {{ im.text }} ({{ im.from }} → {{ im.to }}){{
                    idx < improvedText.length - 1 ? ', ' : ''
                  }}
                </span>
              </p>
            </div>

            <!-- Цифры по каждому правилу: типичное значение, ориентир, направление -->
            <p
              class="border-t border-slate-100 px-4 pt-2 text-[10px] uppercase tracking-wide text-slate-400 dark:border-slate-800"
            >
              типично за 6 спринтов / ориентир · динамика
            </p>
            <div class="grid gap-x-6 gap-y-1.5 px-4 pb-2.5 pt-1.5 sm:grid-cols-2 xl:grid-cols-3">
              <!--
                Сетка внутри строки, а не flex с ml-auto: при узкой колонке значения
                переносились на вторую строку и подписи соседних правил слипались.
              -->
              <div
                v-for="rs in report.healthSummary"
                :key="rs.rule"
                class="grid grid-cols-[minmax(72px,auto)_minmax(0,1fr)_auto] items-baseline gap-x-2 text-xs"
                :title="summaryHint(rs)"
              >
                <span class="truncate text-slate-500 dark:text-slate-400">
                  {{ SUMMARY_LABEL[rs.rule] }}
                </span>
                <template v-if="rs.evaluated > 0">
                  <span class="whitespace-nowrap">
                    <b class="tabular-nums text-slate-800 dark:text-slate-100">
                      {{ summaryValue(rs) }}
                    </b>
                    <span class="text-slate-400">
                      / {{ rs.rule === 'punted' ? fmtNum(rs.threshold) : fmtPct(rs.threshold) }}
                    </span>
                  </span>
                  <span
                    class="whitespace-nowrap text-right"
                    :class="
                      directionNote(rs) && !directionNote(rs)!.good
                        ? 'text-amber-700 dark:text-amber-400'
                        : 'text-slate-400'
                    "
                  >
                    <template v-if="directionNote(rs)">
                      {{ directionNote(rs)!.arrow }} {{ directionNote(rs)!.word }}
                    </template>
                  </span>
                </template>
                <span v-else class="col-span-2 text-slate-400">мало истории</span>
              </div>
            </div>
          </section>

          <!-- Квартальная сводка: ряд кварталов со стек-баром CAP-микса (вариант A) -->
          <div class="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <div
              v-for="q in report.quarters"
              :key="q.quarter"
              class="rounded-lg border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900"
            >
              <div class="mb-2 flex items-baseline justify-between">
                <span class="text-sm font-semibold">{{ quarterLabel(q.quarter) }}</span>
                <span class="text-xs text-slate-400">
                  {{ fmtNum(q.completedSp) }} SP · {{ q.sprints.length }} спр.
                </span>
              </div>
              <!-- Стек-бар -->
              <div
                class="flex h-2.5 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800"
                :title="`${quarterLabel(q.quarter)} — CAP-микс`"
              >
                <div
                  v-for="s in nonEmpty(q.breakdown)"
                  :key="s.slice"
                  class="h-full"
                  :style="{ width: s.pct + '%', background: sliceColor(s.slice) }"
                  :title="`${SLICE_LABEL[s.slice]}: ${fmtNum(s.points)} SP (${s.pct}%)`"
                />
              </div>
              <!-- Числа под баром -->
              <div
                class="mt-2 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-slate-500 dark:text-slate-400"
              >
                <span
                  v-for="s in nonEmpty(q.breakdown)"
                  :key="s.slice"
                  class="inline-flex items-center gap-1"
                >
                  <span
                    class="inline-block size-2 rounded-sm"
                    :style="{ background: sliceColor(s.slice) }"
                  />
                  {{ SLICE_LABEL[s.slice] }} {{ s.pct }}%
                  <span class="text-slate-400">({{ fmtNum(s.points) }})</span>
                </span>
              </div>
            </div>
          </div>

          <!-- Кварталы (раскрываемые) → спринты внутри -->
          <div class="space-y-3">
            <div v-for="q in report.quarters" :key="q.quarter">
              <button
                class="flex w-full items-center gap-2 rounded-md px-1 py-1 text-left hover:bg-slate-100 dark:hover:bg-slate-800/50"
                @click="toggleQuarter(q.quarter)"
              >
                <span class="w-4 text-slate-400">
                  {{ openQuarters.has(q.quarter) ? '▾' : '▸' }}
                </span>
                <span class="text-sm font-medium">{{ quarterLabel(q.quarter) }}</span>
                <span class="text-xs text-slate-400">
                  · {{ q.sprints.length }} спринтов · {{ fmtNum(q.completedSp) }} SP
                </span>
              </button>

              <!-- Спринты квартала -->
              <div v-if="openQuarters.has(q.quarter)" class="mt-2 space-y-2 pl-4">
                <div
                  v-for="s in q.sprints"
                  :key="s.sprintId"
                  class="overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900"
                >
                  <!-- Шапка спринта -->
                  <div class="px-4 py-3">
                    <!-- Верхняя строка (клик раскрывает/сворачивает) -->
                    <button
                      class="flex w-full items-center gap-3 text-left"
                      @click="toggleSprint(s.sprintId)"
                    >
                      <span class="w-4 shrink-0 text-slate-400">
                        {{ openSprints.has(s.sprintId) ? '▾' : '▸' }}
                      </span>
                      <span class="w-28 shrink-0 font-mono text-sm font-medium">{{ s.name }}</span>

                      <!-- Мини CAP-бар спринта -->
                      <span
                        class="flex h-2 flex-1 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800"
                      >
                        <span
                          v-for="cs in nonEmpty(sprintCapBreakdown(s))"
                          :key="cs.slice"
                          class="h-full"
                          :style="{ width: cs.pct + '%', background: sliceColor(cs.slice) }"
                          :title="`${SLICE_LABEL[cs.slice]}: ${fmtNum(cs.points)} SP (${cs.pct}%)`"
                        />
                      </span>

                      <!-- Completed SP -->
                      <span class="flex items-baseline gap-1">
                        <span
                          class="text-lg font-bold tabular-nums text-emerald-600 dark:text-emerald-400"
                        >
                          {{ s.completedPoints }}
                        </span>
                        <span class="text-xs text-slate-400">SP</span>
                      </span>

                      <!-- Переоценка -->
                      <span
                        v-if="reestimate(s) !== 0"
                        class="rounded px-1.5 py-0.5 font-mono text-[11px]"
                        :class="
                          reestimate(s) > 0
                            ? 'bg-sky-50 text-sky-600 dark:bg-sky-950 dark:text-sky-300'
                            : 'bg-slate-100 text-slate-500 dark:bg-slate-800'
                        "
                        :title="`Оценка на старте: ${s.completedInitialPoints} SP`"
                      >
                        {{ reestimate(s) > 0 ? '+' : '' }}{{ reestimate(s) }}
                      </span>

                      <span class="w-14 shrink-0 text-right text-xs text-slate-400">
                        {{ s.completedIssues.length }} зад.
                      </span>
                    </button>

                    <!-- Числа распределения + клик-фильтр по бакету (видно без раскрытия) -->
                    <div class="mt-2 flex flex-wrap items-center gap-1.5 pl-7">
                      <button
                        v-for="cs in nonEmpty(sprintCapBreakdown(s))"
                        :key="cs.slice"
                        type="button"
                        class="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] transition"
                        :class="
                          sliceFilter.get(s.sprintId) === cs.slice
                            ? 'border-transparent text-white'
                            : 'border-slate-200 text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800'
                        "
                        :style="
                          sliceFilter.get(s.sprintId) === cs.slice
                            ? { background: sliceColor(cs.slice) }
                            : {}
                        "
                        :title="`Показать только задачи «${SLICE_LABEL[cs.slice]}»`"
                        @click="onSliceClick(s.sprintId, cs.slice)"
                      >
                        <span
                          class="inline-block size-2 rounded-sm"
                          :style="{ background: sliceColor(cs.slice) }"
                        />
                        {{ SLICE_LABEL[cs.slice] }} {{ cs.pct }}%
                        <span
                          :class="
                            sliceFilter.get(s.sprintId) === cs.slice
                              ? 'text-white/80'
                              : 'text-slate-400'
                          "
                        >
                          ({{ fmtNum(cs.points) }})
                        </span>
                      </button>
                      <button
                        v-if="sliceFilter.get(s.sprintId)"
                        type="button"
                        class="rounded-full px-2 py-0.5 text-[11px] text-indigo-600 hover:underline dark:text-indigo-400"
                        @click="clearSliceFilter(s.sprintId)"
                      >
                        × сбросить
                      </button>
                    </div>

                    <!-- Здоровье спринта: 5 правил (скорость/перенос/переоценка/добавлено/выброшено) -->
                    <div class="mt-2 pl-7">
                      <HealthChips
                        :results="healthOf(s.sprintId)"
                        :active="ruleFilter.get(s.sprintId) ?? null"
                        @pick="(rule) => onRuleClick(s.sprintId, rule)"
                      />
                    </div>
                  </div>

                  <!-- Раскрытый список задач -->
                  <div
                    v-if="openSprints.has(s.sprintId)"
                    class="border-t border-slate-100 dark:border-slate-800"
                  >
                    <!-- Подпись активного фильтра -->
                    <div
                      v-if="sliceFilter.get(s.sprintId)"
                      class="px-4 py-2 text-[11px] text-slate-500 dark:text-slate-400"
                    >
                      Фильтр: {{ SLICE_LABEL[sliceFilter.get(s.sprintId)!] }} —
                      {{ visibleIssues(s).length }} из {{ s.completedIssues.length }} задач
                    </div>

                    <!-- Задачи, на которых основано число выбранного правила — карточками -->
                    <div
                      v-if="activeEvidence(s.sprintId)"
                      class="border-b border-amber-200 bg-amber-50/60 px-4 py-3 dark:border-amber-900/60 dark:bg-amber-950/20"
                    >
                      <div
                        class="mb-2 flex flex-wrap items-baseline gap-x-2 text-xs font-medium text-slate-700 dark:text-slate-200"
                      >
                        <span>{{ RULE_LABEL[activeEvidence(s.sprintId)!.rule] }}</span>
                        <span class="font-normal text-slate-500 dark:text-slate-400">
                          {{ activeEvidence(s.sprintId)!.issues.length }} зад. ·
                          {{ fmtNum(activeEvidence(s.sprintId)!.points) }} SP
                          <template v-if="activeEvidence(s.sprintId)!.result.value !== null">
                            ·
                            {{
                              Math.round(Math.abs(activeEvidence(s.sprintId)!.result.value!) * 100)
                            }}% при пороге
                            {{ Math.round(activeEvidence(s.sprintId)!.result.threshold * 100) }}%
                          </template>
                        </span>
                        <button
                          type="button"
                          class="ml-auto text-[11px] font-normal text-indigo-600 hover:underline dark:text-indigo-400"
                          @click="onRuleClick(s.sprintId, activeEvidence(s.sprintId)!.rule)"
                        >
                          × закрыть
                        </button>
                      </div>

                      <ul class="grid gap-1.5 sm:grid-cols-2">
                        <li
                          v-for="e in evidenceCards(s)"
                          :key="e.key"
                          class="rounded-md border border-amber-200/70 bg-white px-2.5 py-2 dark:border-amber-900/50 dark:bg-slate-900"
                        >
                          <div class="flex items-baseline gap-2">
                            <a
                              :href="`${jiraBase}/browse/${e.key}`"
                              target="_blank"
                              rel="noopener"
                              class="font-mono text-[11px] font-medium text-indigo-600 hover:underline dark:text-indigo-400"
                            >
                              {{ e.key }}
                            </a>
                            <span
                              class="ml-auto whitespace-nowrap font-mono text-[11px] font-semibold tabular-nums text-amber-700 dark:text-amber-300"
                            >
                              {{ contribution(e) }}
                            </span>
                          </div>
                          <div
                            class="mt-0.5 text-xs leading-snug text-slate-600 dark:text-slate-300"
                          >
                            {{ e.issue?.summary || '—' }}
                          </div>
                          <div
                            v-if="e.issue"
                            class="mt-1 flex flex-wrap items-center gap-1.5 text-[10px] text-slate-400"
                          >
                            <span>{{ e.issue.type }}</span>
                            <span
                              class="rounded px-1 py-0.5 font-medium"
                              :class="statusTone(e.issue.status)"
                            >
                              {{ e.issue.status }}
                            </span>
                            <span v-if="capLabel(e.issue)" class="font-mono text-violet-500">
                              {{ capLabel(e.issue) }}
                            </span>
                          </div>
                        </li>
                      </ul>
                    </div>

                    <table class="w-full text-sm">
                      <thead>
                        <tr
                          class="text-left font-mono text-[11px] uppercase tracking-wide text-slate-400"
                        >
                          <th class="py-2 pl-11 pr-2 font-normal">Задача</th>
                          <th class="px-2 py-2 font-normal">Тип</th>
                          <th class="px-2 py-2 font-normal">Статус</th>
                          <th class="px-2 py-2 text-right font-normal">SP</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr
                          v-for="issue in visibleIssues(s)"
                          :key="issue.key"
                          class="border-t border-slate-50 hover:bg-slate-50 dark:border-slate-800/50 dark:hover:bg-slate-800/30"
                        >
                          <td class="py-2 pl-11 pr-2">
                            <div class="flex items-center gap-2">
                              <a
                                :href="`${jiraBase}/browse/${issue.key}`"
                                target="_blank"
                                rel="noopener"
                                class="font-mono text-xs text-indigo-600 hover:underline dark:text-indigo-400"
                              >
                                {{ issue.key }}
                              </a>
                              <span
                                v-if="capLabel(issue)"
                                class="rounded bg-violet-50 px-1.5 py-0.5 font-mono text-[10px] text-violet-600 dark:bg-violet-950 dark:text-violet-300"
                              >
                                {{ capLabel(issue) }}
                              </span>
                            </div>
                            <div
                              class="mt-0.5 max-w-md truncate text-xs text-slate-500 dark:text-slate-400"
                            >
                              {{ issue.summary }}
                            </div>
                          </td>
                          <td class="px-2 py-2 text-xs text-slate-500 dark:text-slate-400">
                            {{ issue.type }}
                          </td>
                          <td class="px-2 py-2">
                            <span
                              class="rounded px-1.5 py-0.5 text-[11px] font-medium"
                              :class="statusTone(issue.status)"
                            >
                              {{ issue.status }}
                            </span>
                          </td>
                          <td
                            class="px-2 py-2 text-right font-mono tabular-nums text-slate-700 dark:text-slate-300"
                          >
                            {{ fmtSp(issue.points) }}
                          </td>
                        </tr>
                      </tbody>
                    </table>

                    <!-- Carryover -->
                    <div
                      v-if="s.notCompletedIssues.length"
                      class="border-t border-slate-100 px-4 py-2 text-xs text-slate-400 dark:border-slate-800"
                    >
                      Перенесено в следующий спринт: {{ s.notCompletedIssues.length }} задач
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  </div>
</template>
