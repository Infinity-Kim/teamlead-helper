<script lang="ts" setup>
import { ref, onMounted, computed } from 'vue';
import {
  capTargets,
  sprintHistoryCount,
  quarterTarget,
  quarterUiMode,
  statusConfig,
  jiraCreds,
  sprintHealthThresholds,
  teams,
  divisions,
  type QuarterUiMode,
  type SprintHealthThresholds,
} from '@/shared/storage';
import {
  DEFAULT_TEAMS,
  newDivisionId,
  parseBoardRef,
  type CapTargets,
  type Division,
  type TeamBoard,
} from '@/core/domain';

const targets = ref<CapTargets>({ Product: 67, Tech: 16.5, Support: 16.5 });
const historyN = ref(6);
const qProduct = ref(67);
const qBand = ref(5);
const qMode = ref<QuarterUiMode>('topBoard');
// Статусы для Work Item Age (в UI — строкой через запятую; в хранилище — массивы).
const workStatuses = ref('');
const doneStatuses = ref('');
// Jira API для страницы отчёта по спринтам (Basic auth: email + токен).
const jiraBaseUrl = ref('https://tvbet.atlassian.net');
const jiraEmail = ref('');
const jiraToken = ref('');
const saved = ref(false);

// --- Команды и дивизионы (отчёт по спринтам) ---
const teamList = ref<TeamBoard[]>([]);
const divisionList = ref<Division[]>([]);
const newBoard = ref('');
const newTeamName = ref('');
const newTeamDivision = ref('');
const teamError = ref<string | null>(null);
const newDivisionName = ref('');

/**
 * Добавить команду по ссылке на доску (или номеру). Имя по умолчанию — ключ проекта из ссылки.
 * Команда сразу попадает в выбранный дивизион — иначе её пришлось бы искать в «Другие команды».
 */
function addTeam() {
  teamError.value = null;
  const board = parseBoardRef(newBoard.value);
  if (!board) {
    teamError.value =
      'Не нашёл номер доски. Вставьте ссылку вида …/projects/CORE/boards/20 или просто номер доски.';
    return;
  }
  const existing = teamList.value.find((t) => t.rapidViewId === board.rapidViewId);
  if (existing) {
    teamError.value = `Доска ${board.rapidViewId} уже добавлена как «${existing.name}».`;
    return;
  }
  const name = newTeamName.value.trim() || board.projectKey || `Доска ${board.rapidViewId}`;
  teamList.value.push({
    rapidViewId: board.rapidViewId,
    name,
    enabled: true,
    projectKey: board.projectKey,
  });
  const div = divisionList.value.find((d) => d.id === newTeamDivision.value);
  if (div) div.teamIds.push(board.rapidViewId);
  newBoard.value = '';
  newTeamName.value = '';
}

function removeTeam(rapidViewId: number) {
  teamList.value = teamList.value.filter((t) => t.rapidViewId !== rapidViewId);
  for (const d of divisionList.value) d.teamIds = d.teamIds.filter((id) => id !== rapidViewId);
}

/** Вернуть стандартные команды (El Casino / POC / Web), не трогая добавленные пользователем. */
function restoreDefaultTeams() {
  for (const def of DEFAULT_TEAMS) {
    const cur = teamList.value.find((t) => t.rapidViewId === def.rapidViewId);
    if (cur) cur.enabled = true;
    else teamList.value.push({ ...def });
  }
}
const missingDefaults = computed(() =>
  DEFAULT_TEAMS.some((d) => {
    const cur = teamList.value.find((t) => t.rapidViewId === d.rapidViewId);
    return !cur || !cur.enabled;
  }),
);

function toggleDivisionTeam(d: Division, rapidViewId: number, on: boolean) {
  d.teamIds = on
    ? [...new Set([...d.teamIds, rapidViewId])]
    : d.teamIds.filter((id) => id !== rapidViewId);
}

function addDivision() {
  const name = newDivisionName.value.trim();
  if (!name) return;
  divisionList.value.push({ id: newDivisionId(name, divisionList.value), name, teamIds: [] });
  newDivisionName.value = '';
}

function removeDivision(id: string) {
  divisionList.value = divisionList.value.filter((d) => d.id !== id);
  if (newTeamDivision.value === id) newTeamDivision.value = divisionList.value[0]?.id ?? '';
}

/** Без имени команду/дивизион в отчёте не узнать — такие не сохраняем. */
const namesValid = computed(
  () =>
    teamList.value.every((t) => t.name.trim()) && divisionList.value.every((d) => d.name.trim()),
);
const canSave = computed(() => sumValid.value && namesValid.value);

/**
 * Пороги правил «здоровья спринта». Настраиваются, а не захардкожены: это командная
 * договорённость, и у разных команд она может отличаться.
 */
const health = ref<SprintHealthThresholds>({
  velocityDropPct: 10,
  carryoverPct: 20,
  reestimatePct: 10,
  scopeAddedPct: 10,
  puntedCount: 0,
  velocityWindow: 6,
});

/** Поля порогов: ключ + подпись + пояснение. */
const HEALTH_FIELDS: Array<{
  key: keyof SprintHealthThresholds;
  label: string;
  hint: string;
  unit: string;
}> = [
  {
    key: 'velocityDropPct',
    label: 'Просадка скорости',
    hint: 'Насколько спринт может быть ниже медианы предыдущих, не вызывая флага',
    unit: '%',
  },
  {
    key: 'carryoverPct',
    label: 'Перенос по SP',
    hint: 'Доля незавершённого от взятого объёма (completed + перенос)',
    unit: '%',
  },
  {
    key: 'reestimatePct',
    label: 'Переоценка взятых задач',
    hint: 'Рост оценок задач, которые уже были в спринте на старте',
    unit: '%',
  },
  {
    key: 'scopeAddedPct',
    label: 'Добавлено после старта',
    hint: 'Объём задач, влетевших в спринт по ходу, от объёма на старте',
    unit: '%',
  },
  {
    key: 'puntedCount',
    label: 'Выброшено из спринта',
    hint: 'Сколько задач допустимо убрать из спринта после старта (0 — ни одной)',
    unit: 'зад.',
  },
  {
    key: 'velocityWindow',
    label: 'Окно истории',
    hint: 'Сколько предыдущих спринтов берётся за базу скорости',
    unit: 'спр.',
  },
];

/** Строка «A, B, C» → массив без пустых/пробелов. */
function parseStatuses(s: string): string[] {
  return s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

const sum = computed(
  () => +(targets.value.Product + targets.value.Tech + targets.value.Support).toFixed(1),
);
const sumValid = computed(() => Math.abs(sum.value - 100) < 0.05);

const QUARTER_MODES: { value: QuarterUiMode; label: string }[] = [
  { value: 'topBoard', label: 'Блок вверху доски' },
  { value: 'perSprint', label: 'Над активным спринтом' },
  { value: 'off', label: 'Выключено' },
];

onMounted(async () => {
  targets.value = await capTargets.getValue();
  historyN.value = await sprintHistoryCount.getValue();
  const qt = await quarterTarget.getValue();
  qProduct.value = qt.productPct;
  qBand.value = qt.bandPp;
  qMode.value = await quarterUiMode.getValue();
  const sc = await statusConfig.getValue();
  workStatuses.value = sc.workStatuses.join(', ');
  doneStatuses.value = sc.doneStatuses.join(', ');
  const creds = await jiraCreds.getValue();
  if (creds) {
    jiraBaseUrl.value = creds.baseUrl;
    jiraEmail.value = creds.email;
    jiraToken.value = creds.apiToken;
  }
  health.value = await sprintHealthThresholds.getValue();
  teamList.value = await teams.getValue();
  divisionList.value = await divisions.getValue();
  newTeamDivision.value = divisionList.value[0]?.id ?? '';
});

async function save() {
  if (!canSave.value) return;
  const teamIds = new Set(teamList.value.map((t) => t.rapidViewId));
  await teams.setValue(teamList.value.map((t) => ({ ...t, name: t.name.trim() })));
  await divisions.setValue(
    divisionList.value.map((d) => ({
      ...d,
      name: d.name.trim(),
      teamIds: d.teamIds.filter((id) => teamIds.has(id)),
    })),
  );
  await capTargets.setValue(targets.value);
  await sprintHistoryCount.setValue(Math.max(1, Math.round(historyN.value)));
  await quarterTarget.setValue({ productPct: qProduct.value, bandPp: qBand.value });
  await quarterUiMode.setValue(qMode.value);
  await statusConfig.setValue({
    workStatuses: parseStatuses(workStatuses.value),
    doneStatuses: parseStatuses(doneStatuses.value),
  });
  // Пороги: отрицательных не бывает, окно истории — минимум 2 спринта (иначе «медиана» бессмысленна).
  await sprintHealthThresholds.setValue({
    velocityDropPct: Math.max(0, health.value.velocityDropPct),
    carryoverPct: Math.max(0, health.value.carryoverPct),
    reestimatePct: Math.max(0, health.value.reestimatePct),
    scopeAddedPct: Math.max(0, health.value.scopeAddedPct),
    puntedCount: Math.max(0, Math.round(health.value.puntedCount)),
    velocityWindow: Math.max(2, Math.round(health.value.velocityWindow)),
  });
  // Jira-креды: сохраняем только если заполнены email и токен.
  if (jiraEmail.value.trim() && jiraToken.value.trim()) {
    await jiraCreds.setValue({
      baseUrl: jiraBaseUrl.value.trim().replace(/\/$/, ''),
      email: jiraEmail.value.trim(),
      apiToken: jiraToken.value.trim(),
    });
  }
  saved.value = true;
  setTimeout(() => (saved.value = false), 2000);
}
</script>

<template>
  <div class="min-h-screen bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
    <div class="mx-auto max-w-xl px-6 py-10">
      <header class="mb-8 flex items-center gap-3">
        <span
          class="grid size-9 place-items-center rounded-lg bg-indigo-600 text-base font-bold text-white"
        >
          TL
        </span>
        <div>
          <h1 class="text-lg font-semibold">Team Lead Helper</h1>
          <p class="text-sm text-slate-500 dark:text-slate-400">Настройки</p>
        </div>
      </header>

      <form
        class="space-y-5 rounded-xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-900"
        @submit.prevent="save"
      >
        <div>
          <h2 class="text-sm font-semibold">Команды</h2>
          <p class="mt-1 text-xs text-slate-400">
            Доски, которые попадают в «Отчёт по спринтам». Снимите галочку, чтобы исключить команду
            из отчёта и сводок, не удаляя её.
          </p>
        </div>

        <ul
          class="divide-y divide-slate-100 rounded-md border border-slate-200 dark:divide-slate-800 dark:border-slate-800"
        >
          <li v-for="t in teamList" :key="t.rapidViewId" class="flex items-center gap-2 px-3 py-2">
            <input
              v-model="t.enabled"
              type="checkbox"
              class="size-4 accent-indigo-600"
              :title="t.enabled ? 'Исключить из отчёта' : 'Включить в отчёт'"
            />
            <input
              v-model="t.name"
              type="text"
              aria-label="Название команды"
              class="min-w-0 flex-1 rounded-md border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-indigo-500 dark:border-slate-700 dark:bg-slate-800"
              :class="t.enabled ? '' : 'text-slate-400'"
            />
            <span class="shrink-0 font-mono text-[11px] text-slate-400">
              {{ t.projectKey ? t.projectKey + ' · ' : '' }}доска {{ t.rapidViewId }}
            </span>
            <button
              type="button"
              class="shrink-0 rounded px-1.5 text-slate-400 hover:bg-slate-100 hover:text-red-600 dark:hover:bg-slate-800"
              :title="`Удалить «${t.name}»`"
              @click="removeTeam(t.rapidViewId)"
            >
              ✕
            </button>
          </li>
          <li v-if="!teamList.length" class="px-3 py-3 text-xs text-slate-400">Команд нет.</li>
        </ul>
        <button
          v-if="missingDefaults"
          type="button"
          class="text-xs text-indigo-600 hover:underline dark:text-indigo-400"
          @click="restoreDefaultTeams"
        >
          Вернуть El Casino, POC и Web
        </button>

        <div class="rounded-md bg-slate-50 p-3 dark:bg-slate-800/50">
          <span class="mb-2 block text-xs font-medium">Добавить команду</span>
          <div class="grid gap-2 sm:grid-cols-[1fr_10rem]">
            <input
              v-model="newBoard"
              type="text"
              placeholder="https://tvbet.atlassian.net/jira/software/c/projects/CORE/boards/20"
              aria-label="Ссылка на доску или её номер"
              class="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-indigo-500 dark:border-slate-700 dark:bg-slate-800"
              @keydown.enter.prevent="addTeam"
            />
            <input
              v-model="newTeamName"
              type="text"
              placeholder="Название (необязательно)"
              aria-label="Название команды"
              class="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-indigo-500 dark:border-slate-700 dark:bg-slate-800"
              @keydown.enter.prevent="addTeam"
            />
          </div>
          <div class="mt-2 flex flex-wrap items-center gap-2">
            <label
              v-if="divisionList.length"
              class="flex items-center gap-2 text-xs text-slate-500"
            >
              в дивизион
              <span class="relative inline-flex">
                <select
                  v-model="newTeamDivision"
                  class="cursor-pointer appearance-none rounded-md border border-slate-300 bg-white py-1.5 pl-3 pr-8 text-sm outline-none focus:border-indigo-500 dark:border-slate-700 dark:bg-slate-800"
                >
                  <option v-for="d in divisionList" :key="d.id" :value="d.id">{{ d.name }}</option>
                  <option value="">— без дивизиона —</option>
                </select>
                <svg
                  class="pointer-events-none absolute right-2.5 top-1/2 size-3.5 -translate-y-1/2 text-slate-400"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.8"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                >
                  <path d="M4 6l4 4 4-4" />
                </svg>
              </span>
            </label>
            <button
              type="button"
              class="ml-auto rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
              @click="addTeam"
            >
              Добавить
            </button>
          </div>
          <p v-if="teamError" class="mt-2 text-xs text-red-500">{{ teamError }}</p>
          <p v-else class="mt-2 text-xs text-slate-400">
            Ссылка на доску из адресной строки Jira или просто номер доски. Если название не
            указать, возьмём ключ проекта из ссылки.
          </p>
        </div>

        <div class="border-t border-slate-200 pt-4 dark:border-slate-800">
          <h2 class="text-sm font-semibold">Дивизионы</h2>
          <p class="mt-1 text-xs text-slate-400">
            Группы команд для общей квартальной сводки в отчёте («Весь дивизион»). Команда может
            входить в несколько дивизионов.
          </p>
        </div>

        <div
          v-for="d in divisionList"
          :key="d.id"
          class="rounded-md border border-slate-200 p-3 dark:border-slate-800"
        >
          <div class="flex items-center gap-2">
            <input
              v-model="d.name"
              type="text"
              aria-label="Название дивизиона"
              class="min-w-0 flex-1 font-medium rounded-md border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-indigo-500 dark:border-slate-700 dark:bg-slate-800"
            />
            <button
              type="button"
              class="shrink-0 rounded px-2 py-1 text-xs text-slate-400 hover:bg-slate-100 hover:text-red-600 dark:hover:bg-slate-800"
              @click="removeDivision(d.id)"
            >
              Удалить
            </button>
          </div>
          <div class="mt-2 flex flex-wrap gap-x-4 gap-y-1.5">
            <label
              v-for="t in teamList"
              :key="t.rapidViewId"
              class="inline-flex items-center gap-1.5 text-sm"
              :class="t.enabled ? '' : 'text-slate-400'"
              :title="t.enabled ? '' : 'Команда исключена из отчёта — в сводку не попадёт'"
            >
              <input
                type="checkbox"
                class="size-4 accent-indigo-600"
                :checked="d.teamIds.includes(t.rapidViewId)"
                @change="
                  toggleDivisionTeam(d, t.rapidViewId, ($event.target as HTMLInputElement).checked)
                "
              />
              {{ t.name || 'без имени' }}
            </label>
            <span v-if="!teamList.length" class="text-xs text-slate-400"
              >Сначала добавьте команды.</span
            >
          </div>
        </div>

        <div class="flex gap-2">
          <input
            v-model="newDivisionName"
            type="text"
            placeholder="Название нового дивизиона"
            aria-label="Название нового дивизиона"
            class="min-w-0 flex-1 rounded-md border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-indigo-500 dark:border-slate-700 dark:bg-slate-800"
            @keydown.enter.prevent="addDivision"
          />
          <button
            type="button"
            :disabled="!newDivisionName.trim()"
            class="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:hover:bg-slate-800"
            @click="addDivision"
          >
            Создать дивизион
          </button>
        </div>

        <div class="border-t border-slate-200 pt-4 dark:border-slate-800">
          <h2 class="text-sm font-semibold">Целевое распределение capacity (%)</h2>
          <p class="mt-1 text-xs text-slate-400">Сумма должна равняться 100%.</p>
        </div>

        <div class="grid grid-cols-3 gap-3">
          <label class="block">
            <span class="mb-1 block text-xs font-medium text-emerald-600">Product</span>
            <input
              v-model.number="targets.Product"
              type="number"
              step="0.5"
              min="0"
              max="100"
              class="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-indigo-500 dark:border-slate-700 dark:bg-slate-800"
            />
          </label>
          <label class="block">
            <span class="mb-1 block text-xs font-medium text-sky-600">Tech</span>
            <input
              v-model.number="targets.Tech"
              type="number"
              step="0.5"
              min="0"
              max="100"
              class="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-indigo-500 dark:border-slate-700 dark:bg-slate-800"
            />
          </label>
          <label class="block">
            <span class="mb-1 block text-xs font-medium text-amber-600">Support</span>
            <input
              v-model.number="targets.Support"
              type="number"
              step="0.5"
              min="0"
              max="100"
              class="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-indigo-500 dark:border-slate-700 dark:bg-slate-800"
            />
          </label>
        </div>
        <p class="text-xs" :class="sumValid ? 'text-slate-400' : 'text-red-500'">
          Сумма: {{ sum }}%<span v-if="!sumValid"> — должно быть 100%</span>
        </p>

        <label class="block border-t border-slate-200 pt-4 dark:border-slate-800">
          <span class="mb-1 block text-sm font-medium">Спринтов истории для расчётов</span>
          <input
            v-model.number="historyN"
            type="number"
            min="1"
            max="50"
            class="w-24 rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-indigo-500 dark:border-slate-700 dark:bg-slate-800"
          />
          <span class="mt-1 block text-xs text-slate-400">
            Сколько последних закрытых спринтов брать для медианы velocity и порогов возраста задач.
          </span>
        </label>

        <div class="border-t border-slate-200 pt-4 dark:border-slate-800">
          <h2 class="mb-2 text-sm font-semibold">Квартальный баланс</h2>
          <div class="grid grid-cols-2 gap-3">
            <label class="block">
              <span class="mb-1 block text-xs font-medium">Цель Product за квартал, %</span>
              <input
                v-model.number="qProduct"
                type="number"
                min="0"
                max="100"
                step="1"
                class="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-indigo-500 dark:border-slate-700 dark:bg-slate-800"
              />
            </label>
            <label class="block">
              <span class="mb-1 block text-xs font-medium">Коридор ±, пп</span>
              <input
                v-model.number="qBand"
                type="number"
                min="0"
                max="50"
                step="1"
                class="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-indigo-500 dark:border-slate-700 dark:bg-slate-800"
              />
            </label>
          </div>
          <span class="mt-1 block text-xs text-slate-400">
            Остальное (Tech+Support) = {{ 100 - qProduct }}%. Алерт при выходе накопленного за
            квартал за {{ qProduct - qBand }}–{{ qProduct + qBand }}%.
          </span>

          <label class="mt-3 block">
            <span class="mb-1 block text-xs font-medium">Где показывать квартальный баланс</span>
            <span class="relative block">
              <select
                v-model="qMode"
                class="w-full cursor-pointer appearance-none rounded-md border border-slate-300 bg-white py-1.5 pl-3 pr-8 text-sm outline-none focus:border-indigo-500 dark:border-slate-700 dark:bg-slate-800"
              >
                <option v-for="m in QUARTER_MODES" :key="m.value" :value="m.value">
                  {{ m.label }}
                </option>
              </select>
              <svg
                class="pointer-events-none absolute right-2.5 top-1/2 size-3.5 -translate-y-1/2 text-slate-400"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                stroke-width="1.8"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <path d="M4 6l4 4 4-4" />
              </svg>
            </span>
            <span class="mt-1 block text-xs text-slate-400">
              Переключай и смотри на доске/в панели, какой вариант удобнее.
            </span>
          </label>
        </div>

        <div class="border-t border-slate-200 pt-4 dark:border-slate-800">
          <h2 class="mb-1 text-sm font-semibold">Возраст задач (Work Item Age)</h2>
          <p class="mb-3 text-xs text-slate-400">
            Задачи, которые давно «в работе», подсвечиваются на доске. Возраст считается с момента
            входа в один из статусов «в работе». Пороги («стареет» / «застряла») берутся из истории
            команды автоматически. Статусы — через запятую, регистр не важен.
          </p>
          <label class="block">
            <span class="mb-1 block text-xs font-medium">Статусы «в работе» (старт возраста)</span>
            <input
              v-model="workStatuses"
              type="text"
              placeholder="DEV, В работе, In Progress"
              class="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-indigo-500 dark:border-slate-700 dark:bg-slate-800"
            />
            <span class="mt-1 block text-xs text-slate-400">
              Первый вход в любой из этих статусов = начало работы. Очередь на разработку (напр.
              «Ready for DEV») сюда НЕ включать — иначе возраст раздуется ожиданием.
            </span>
          </label>
          <label class="mt-3 block">
            <span class="mb-1 block text-xs font-medium">Статусы «завершено»</span>
            <input
              v-model="doneStatuses"
              type="text"
              placeholder="Готово, Done, Closed"
              class="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-indigo-500 dark:border-slate-700 dark:bg-slate-800"
            />
            <span class="mt-1 block text-xs text-slate-400">
              Для расчёта времени цикла (start → done) по закрытым задачам — от него зависят пороги
              возраста.
            </span>
          </label>
        </div>

        <div class="border-t border-slate-200 pt-4 dark:border-slate-800">
          <h2 class="mb-1 text-sm font-semibold">Здоровье спринта (пороги)</h2>
          <p class="mb-3 text-xs text-slate-400">
            Правила на странице «Отчёт по спринтам»: спринт вне нормы помечается янтарным чипом. Это
            ориентиры для планирования, а не оценка команды — меняйте под свои договорённости.
          </p>
          <div class="grid gap-3 sm:grid-cols-2">
            <label v-for="f in HEALTH_FIELDS" :key="f.key" class="block">
              <span class="mb-1 block text-xs font-medium">{{ f.label }}</span>
              <div class="flex items-center gap-2">
                <input
                  v-model.number="health[f.key]"
                  type="number"
                  min="0"
                  step="1"
                  class="w-20 rounded-md border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-indigo-500 dark:border-slate-700 dark:bg-slate-800"
                />
                <span class="text-xs text-slate-400">{{ f.unit }}</span>
              </div>
              <span class="mt-1 block text-xs text-slate-400">{{ f.hint }}</span>
            </label>
          </div>
        </div>

        <div class="border-t border-slate-200 pt-4 dark:border-slate-800">
          <h2 class="mb-1 text-sm font-semibold">Доступ к Jira (отчёт по спринтам)</h2>
          <p class="mb-3 text-xs text-slate-400">
            Нужен для отдельной страницы «Отчёт по спринтам» (по кнопке в popup). Используется
            Basic-авторизация: рабочий email + персональный API-токен Atlassian. Токен создаётся в
            <span class="font-mono">id.atlassian.com → Security → API tokens</span> и хранится
            только локально в браузере (не синхронизируется, не отправляется никуда, кроме самой
            Jira).
          </p>
          <label class="block">
            <span class="mb-1 block text-xs font-medium">Base URL</span>
            <input
              v-model="jiraBaseUrl"
              type="url"
              placeholder="https://tvbet.atlassian.net"
              class="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-indigo-500 dark:border-slate-700 dark:bg-slate-800"
            />
          </label>
          <label class="mt-3 block">
            <span class="mb-1 block text-xs font-medium">Email</span>
            <input
              v-model="jiraEmail"
              type="email"
              autocomplete="username"
              placeholder="name@tvbet.tv"
              class="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-indigo-500 dark:border-slate-700 dark:bg-slate-800"
            />
          </label>
          <label class="mt-3 block">
            <span class="mb-1 block text-xs font-medium">API-токен</span>
            <input
              v-model="jiraToken"
              type="password"
              autocomplete="new-password"
              placeholder="••••••••••••"
              class="w-full rounded-md border border-slate-300 px-2 py-1.5 font-mono text-sm outline-none focus:border-indigo-500 dark:border-slate-700 dark:bg-slate-800"
            />
            <span class="mt-1 block text-xs text-slate-400">
              Сохраняется, только если заполнены и email, и токен. Токен можно отозвать в любой
              момент в настройках Atlassian.
            </span>
          </label>
        </div>

        <p class="border-t border-slate-200 pt-4 text-xs text-slate-400 dark:border-slate-800">
          Виджет работает на любой доске автоматически — настройки применяются ко всем. Статусы по
          умолчанию настроены под доску ELCAS; для другой доски укажите её названия статусов.
        </p>

        <div class="flex items-center gap-3 pt-1">
          <button
            type="submit"
            :disabled="!canSave"
            class="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-indigo-500 disabled:opacity-50"
          >
            Сохранить
          </button>
          <span v-if="saved" class="text-sm text-green-600">Сохранено ✓</span>
          <span v-else-if="!namesValid" class="text-sm text-red-500">
            У каждой команды и дивизиона должно быть имя
          </span>
        </div>
      </form>
    </div>
  </div>
</template>
