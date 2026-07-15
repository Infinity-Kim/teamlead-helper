<script lang="ts" setup>
import { ref, onMounted, computed } from 'vue';
import { getBoardSprintReportsSince, setJiraAuth, JiraRequestError } from '@/api/jira';
import {
  jiraCreds,
  TEAM_BOARDS,
  boardConfig,
  sprintReportsCache,
  type SprintReportsCache,
} from '@/shared/storage';
import type { SprintReportDetail, SprintReportIssue, CapSlice } from '@/core/domain';
import {
  groupSprintsByQuarter,
  sprintCapBreakdown,
  velocitySummary,
  issueInSlice,
  CAP_SLICES,
  type QuarterGroup,
  type VelocitySummary,
  type CapBreakdown,
} from '@/core/metrics';
import { BUCKET_COLORS } from '@/components/ads-tokens';

/**
 * Спринты берём со стартом от Q4 2025 — раньше CAP-метки в Jira не проставлялись
 * (ранние спринты дали бы 100% «Без метки», см. проверку на живых данных).
 */
const SINCE_ISO = '2025-10-01';
/** Окно для average velocity. */
const VELOCITY_WINDOW = 6;
/** Свежесть кеша: старше — перезагружаем из сети (закрытые спринты меняются нечасто). */
const CACHE_TTL_MS = 30 * 60 * 1000;

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
}

/** Кеш готовых отчётов по команде В ПАМЯТИ страницы — мгновенное переключение между командами. */
const memCache = new Map<number, TeamReport>();

/** Собрать TeamReport из сырья спринтов. */
function buildReport(rvid: number, sprints: SprintReportDetail[], failed: number): TeamReport {
  const meta = TEAM_BOARDS.find((b) => b.rapidViewId === rvid);
  return {
    team: meta?.team ?? `board ${rvid}`,
    rapidViewId: rvid,
    sprints,
    quarters: groupSprintsByQuarter(sprints),
    velocity: velocitySummary(sprints, VELOCITY_WINDOW),
    sprintCount: sprints.length,
    failed,
  };
}

const loading = ref(true);
const error = ref<string | null>(null);
/** Отчёт по ВЫБРАННОЙ команде (грузим только её — не тянем лишнее). */
const report = ref<TeamReport | null>(null);
/** rapidViewId выбранной команды. Дефолт — из boardConfig (там ELCAS/80). */
const selectedRvid = ref<number>(TEAM_BOARDS[0].rapidViewId);
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
}

/** Прочитать спринты команды из persist-кеша (chrome.storage), если он свежий (в пределах TTL). */
async function readPersistCache(rvid: number): Promise<TeamReport | null> {
  const cache = await sprintReportsCache.getValue();
  if (!cache || Date.now() - cache.updatedAt > CACHE_TTL_MS) return null;
  const board = cache.boards.find((b) => b.rapidViewId === rvid);
  if (!board) return null;
  return buildReport(rvid, board.sprints, 0);
}

/** Записать спринты команды в persist-кеш (обновив/добавив её запись, освежив updatedAt). */
async function writePersistCache(rvid: number, team: string, sprints: SprintReportDetail[]) {
  const prev = await sprintReportsCache.getValue();
  const boards = (prev?.boards ?? []).filter((b) => b.rapidViewId !== rvid);
  boards.push({ team, rapidViewId: rvid, sprints });
  const next: SprintReportsCache = { updatedAt: Date.now(), boards };
  await sprintReportsCache.setValue(next);
}

/**
 * Загрузить отчёт выбранной команды. force=true (кнопка «Обновить») минует кеш.
 * Порядок без force: память страницы → persist-кеш (TTL) → сеть. После сети — кладём в оба кеша.
 */
async function load(force = false) {
  const rvid = selectedRvid.value;

  // 1) Кеш в памяти страницы — мгновенно.
  if (!force) {
    const cached = memCache.get(rvid);
    if (cached) {
      applyReport(cached);
      return;
    }
  }

  loading.value = true;
  error.value = null;
  try {
    const creds = await jiraCreds.getValue();
    if (!creds) {
      error.value =
        'Не заданы данные Jira. Откройте настройки расширения и введите email + API-токен.';
      return;
    }
    setJiraAuth({ baseUrl: creds.baseUrl, email: creds.email, apiToken: creds.apiToken });

    // 2) Persist-кеш (переживает закрытие вкладки), если свежий и не форсим.
    if (!force) {
      const persisted = await readPersistCache(rvid);
      if (persisted) {
        memCache.set(rvid, persisted);
        applyReport(persisted);
        return;
      }
    }

    // 3) Сеть.
    const { sprints, failed } = await getBoardSprintReportsSince(rvid, SINCE_ISO);
    const built = buildReport(rvid, sprints, failed);
    memCache.set(rvid, built);
    // Persist только полные данные — частичные (failed>0) не кешируем, чтобы «Обновить» дотянул.
    if (failed === 0) await writePersistCache(rvid, built.team, sprints);
    applyReport(built);
  } catch (e) {
    error.value =
      e instanceof JiraRequestError && e.error.kind === 'unauthorized'
        ? 'Jira отклонил запрос (401/403). Проверьте email и API-токен в настройках.'
        : `Ошибка загрузки: ${String(e)}`;
  } finally {
    loading.value = false;
  }
}

/** Кнопка «Обновить» — форсированная перезагрузка текущей команды из сети. */
function refresh() {
  memCache.delete(selectedRvid.value);
  void load(true);
}

/** Выбор команды в сегментированном контроле → загрузка отчёта (из кеша мгновенно или сеть). */
function selectTeam(rvid: number) {
  if (loading.value || rvid === selectedRvid.value) return;
  selectedRvid.value = rvid;
  void load();
}

onMounted(async () => {
  // Дефолтная команда — из настроек доски (boardConfig), если она есть среди TEAM_BOARDS.
  const cfg = await boardConfig.getValue();
  if (TEAM_BOARDS.some((b) => b.rapidViewId === cfg.rapidViewId)) {
    selectedRvid.value = cfg.rapidViewId;
  }
  await load();
});

const totalSprints = computed(() => report.value?.sprintCount ?? 0);

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
            Спринты с 2025 года по кварталам · распределение capacity по CAP-бакетам · velocity.
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

      <!-- Выбор команды: сегментированный контрол (ADS-стиль, как табы Jira) -->
      <div class="mb-6 flex items-center gap-3">
        <span class="text-xs font-medium uppercase tracking-wide text-slate-400">Команда</span>
        <div
          role="tablist"
          aria-label="Выбор команды"
          class="inline-flex gap-0.5 rounded-lg bg-slate-100 p-0.5 dark:bg-slate-800/80"
        >
          <button
            v-for="b in TEAM_BOARDS"
            :key="b.rapidViewId"
            type="button"
            role="tab"
            :aria-selected="selectedRvid === b.rapidViewId"
            :disabled="loading"
            class="rounded-md px-3.5 py-1.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-60"
            :class="
              selectedRvid === b.rapidViewId
                ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-950 dark:text-white'
                : 'text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200'
            "
            @click="selectTeam(b.rapidViewId)"
          >
            {{ b.team }}
          </button>
        </div>
      </div>

      <!-- Общая легенда бакетов -->
      <div
        v-if="!loading && !error && totalSprints"
        class="mb-6 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500 dark:text-slate-400"
      >
        <span
          v-for="slice in CAP_SLICES_ALL"
          :key="slice"
          class="inline-flex items-center gap-1.5"
        >
          <span class="inline-block size-2.5 rounded-sm" :style="{ background: sliceColor(slice) }" />
          {{ SLICE_LABEL[slice] }}
        </span>
      </div>

      <!-- Плашка частичных данных: часть спринтов не догрузилась (rate-limit/сеть) -->
      <div
        v-if="!loading && !error && report && report.failed > 0"
        class="mb-4 flex items-center gap-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
      >
        <span class="flex-1">
          Загружены не все спринты: {{ report.failed }}
          {{ report.failed === 1 ? 'спринт не удалось' : 'спринтов не удалось' }} получить
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
        class="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
      >
        {{ error }}
      </div>

      <!-- Загрузка -->
      <div v-else-if="loading" class="py-16 text-center text-sm text-slate-400">
        Загружаем отчёты по спринтам… (все закрытые спринты команды с 2025 года)
      </div>

      <!-- Пусто -->
      <div v-else-if="!report || totalSprints === 0" class="py-16 text-center text-sm text-slate-400">
        Нет закрытых спринтов с 2025 года для выбранной команды.
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
                velocity (посл. {{ report.velocity.count }}):
                <b class="text-slate-700 dark:text-slate-200">
                  медиана {{ fmtNum(report.velocity.median) }} SP
                </b>
                · среднее {{ fmtNum(report.velocity.mean!) }} SP
              </template>
              <template v-else>velocity: нет данных</template>
            </span>
          </div>

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
              <div class="mt-2 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-slate-500 dark:text-slate-400">
                <span
                  v-for="s in nonEmpty(q.breakdown)"
                  :key="s.slice"
                  class="inline-flex items-center gap-1"
                >
                  <span class="inline-block size-2 rounded-sm" :style="{ background: sliceColor(s.slice) }" />
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
                      <span class="flex h-2 flex-1 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
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
                        <span class="text-lg font-bold tabular-nums text-emerald-600 dark:text-emerald-400">
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

                    <table class="w-full text-sm">
                      <thead>
                        <tr class="text-left font-mono text-[11px] uppercase tracking-wide text-slate-400">
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
                                :href="`https://tvbet.atlassian.net/browse/${issue.key}`"
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
                            <div class="mt-0.5 max-w-md truncate text-xs text-slate-500 dark:text-slate-400">
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
                          <td class="px-2 py-2 text-right font-mono tabular-nums text-slate-700 dark:text-slate-300">
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
