<script lang="ts" setup>
import { ref, onMounted, computed } from 'vue';
import {
  capTargets,
  quarterTarget,
  quarterUiMode,
  statusConfig,
  jiraCreds,
  sprintHealthThresholds,
  sprintHealthColors,
  teams,
  divisions,
} from '@/shared/storage';
import {
  DEFAULT_QUARTER_TARGET,
  DEFAULT_TEAMS,
  newDivisionId,
  parseBoardRef,
  type CapTargets,
  type Division,
  type TeamBoard,
} from '@/core/domain';
import {
  DEFAULT_HEALTH_COLORS,
  DEFAULT_HEALTH_SETTINGS,
  normalizeHealthSettings,
  withHealthDefaults,
  type HealthSettings,
} from '@/core/metrics';

const targets = ref<CapTargets>({ Product: 67, Tech: 16.5, Support: 16.5 });
// Статусы для времени работы крупных задач (в UI - строкой через запятую; в хранилище - массивы).
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
 * Добавить команду по ссылке на доску (или номеру). Имя по умолчанию - ключ проекта из ссылки.
 * Команда сразу попадает в выбранный дивизион - иначе её пришлось бы искать в «Другие команды».
 */
function addTeam() {
  teamError.value = null;
  const board = parseBoardRef(newBoard.value);
  if (!board) {
    teamError.value =
      'В ссылке нет номера доски. Вставьте адрес доски из Jira или её номер, например 20.';
    return;
  }
  const existing = teamList.value.find((t) => t.rapidViewId === board.rapidViewId);
  if (existing) {
    teamError.value = `Доска ${board.rapidViewId} уже есть в списке под именем «${existing.name}».`;
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

/** Без имени команду/дивизион в отчёте не узнать - такие не сохраняем. */
const namesValid = computed(
  () =>
    teamList.value.every((t) => t.name.trim()) && divisionList.value.every((d) => d.name.trim()),
);
const canSave = computed(() => sumValid.value && namesValid.value);

/**
 * Пороги правил «здоровья спринта». Настраиваются, а не захардкожены: это командная
 * договорённость, и у разных команд она может отличаться.
 */
const health = ref<HealthSettings>({ ...DEFAULT_HEALTH_SETTINGS });

/** Цвета точек у заголовков порогов - те же, что у меток в отчёте. */
const LEVEL_COLORS = DEFAULT_HEALTH_COLORS;

/** Ключи порогов с числовым значением (для v-model по ключу). */
type HealthKey = keyof HealthSettings;

/**
 * Правила с двумя порогами: первый красит чип в жёлтый, второй - в красный.
 * Второй ниже первого не сохранится - поднимется до первого (иначе жёлтой зоны нет).
 */
const HEALTH_FIELDS: Array<{
  warnKey: HealthKey;
  critKey: HealthKey;
  label: string;
  hint: string;
  unit: string;
}> = [
  {
    warnKey: 'velocityDropPct',
    critKey: 'velocityDropCritPct',
    label: 'Просадка скорости',
    hint: 'Ниже медианы 6 прошлых спринтов: медиана 100 SP, закрыли 80 - 20%.',
    unit: '%',
  },
  {
    warnKey: 'carryoverPct',
    critKey: 'carryoverCritPct',
    label: 'Перенос по SP',
    hint: 'Не закрыли 20 SP из 100 - 20%. Жёлтый порог задаёт и план: при 20% план на 80% закрытия.',
    unit: '%',
  },
  {
    warnKey: 'reestimatePct',
    critKey: 'reestimateCritPct',
    label: 'Переоценка взятых задач',
    hint: 'Оценки задач со старта выросли: взяли 100 SP, задача 5 стала 8 - 3%.',
    unit: '%',
  },
  {
    warnKey: 'scopeAddedPct',
    critKey: 'scopeAddedCritPct',
    label: 'Добавлено после старта',
    hint: 'Взяли 100 SP, после старта добавили 15 - 15%.',
    unit: '%',
  },
  {
    warnKey: 'puntedPct',
    critKey: 'puntedCritPct',
    label: 'Выброшено из спринта',
    hint: 'Взяли 100 SP, после старта убрали 10 - 10%. На красном пороге уже красный.',
    unit: '%',
  },
];

/** Второй порог ниже первого - подсвечиваем сразу, не дожидаясь сохранения. */
const critBelowWarn = (f: (typeof HEALTH_FIELDS)[number]) =>
  health.value[f.critKey] < health.value[f.warnKey];

/** Строка «A, B, C» в массив без пустых/пробелов. */
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

onMounted(async () => {
  targets.value = await capTargets.getValue();
  const sc = await statusConfig.getValue();
  workStatuses.value = sc.workStatuses.join(', ');
  doneStatuses.value = sc.doneStatuses.join(', ');
  const creds = await jiraCreds.getValue();
  if (creds) {
    jiraBaseUrl.value = creds.baseUrl;
    jiraEmail.value = creds.email;
    jiraToken.value = creds.apiToken;
  }
  // Настройки до v0.6 не содержат вторых порогов - дополняем дефолтами.
  health.value = withHealthDefaults(await sprintHealthThresholds.getValue());
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
  // Убранные из интерфейса настройки (решение 09.11.2026): цель Product за квартал = цель
  // Product спринта, допуск 5 пп как у полосы спринта, блок квартала всегда вверху доски.
  await quarterTarget.setValue({
    productPct: targets.value.Product,
    bandPp: DEFAULT_QUARTER_TARGET.bandPp,
  });
  await quarterUiMode.setValue('topBoard');
  await statusConfig.setValue({
    workStatuses: parseStatuses(workStatuses.value),
    doneStatuses: parseStatuses(doneStatuses.value),
  });
  // Пороги: без отрицательных, окно ≥ 2 спринтов, второй порог не ниже первого.
  // Окно истории убрано из интерфейса: всегда 6 спринтов, как у плана на старт.
  health.value = normalizeHealthSettings({
    ...health.value,
    velocityWindow: DEFAULT_HEALTH_SETTINGS.velocityWindow,
  });
  await sprintHealthThresholds.setValue({ ...health.value });
  // Цвета уровней убраны из интерфейса: всегда цвета Jira.
  await sprintHealthColors.setValue({ ...DEFAULT_HEALTH_COLORS });
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
    <div class="mx-auto max-w-2xl px-6 py-10">
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
            Доски для отчёта по спринтам. Без галочки команда не попадает в отчёт и сводки.
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
                  <option value="">Без дивизиона</option>
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
            Адрес доски из Jira или её номер, например 20.
          </p>
        </div>

        <div class="border-t border-slate-200 pt-4 dark:border-slate-800">
          <h2 class="text-sm font-semibold">Дивизионы</h2>
          <p class="mt-1 text-xs text-slate-400">
            Команды для общей сводки за квартал в отчёте. Команда может быть в нескольких.
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
              :title="
                t.enabled ? '' : 'Команда выключена в списке команд, поэтому в сводку не попадёт'
              "
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
          <h2 class="text-sm font-semibold">Цель по долям SP, %</h2>
          <p class="mt-1 text-xs text-slate-400">
            Доли SP по меткам задач Product, Tech и Support. Цель Product - и для спринта, и для
            квартала. Отклонение больше 5 пунктов доска подсветит: цель 67%, факт 61%.
          </p>
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
          Сумма {{ sum }}%<span v-if="!sumValid">, нужно 100%</span>
        </p>

        <div class="border-t border-slate-200 pt-4 dark:border-slate-800">
          <h2 class="mb-1 text-sm font-semibold">Статусы задач</h2>
          <p class="mb-3 text-xs text-slate-400">
            По ним план считает дни работы над задачами от 3 SP. По умолчанию - статусы доски ELCAS.
          </p>
          <label class="block">
            <span class="mb-1 block text-xs font-medium">Статусы «в работе»</span>
            <input
              v-model="workStatuses"
              type="text"
              placeholder="DEV, В работе, In Progress"
              class="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-indigo-500 dark:border-slate-700 dark:bg-slate-800"
            />
            <span class="mt-1 block text-xs text-slate-400">
              Первый вход в статус - начало работы. «Ready for DEV» не включайте: ожидание станет
              работой.
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
          </label>
        </div>

        <div class="border-t border-slate-200 pt-4 dark:border-slate-800">
          <h2 class="mb-1 text-sm font-semibold">Здоровье спринта: пороги</h2>
          <p class="mb-3 text-xs text-slate-400">
            Метка спринта в отчёте жёлтая выше жёлтого порога и красная выше красного.
          </p>
          <div
            class="mb-1 grid grid-cols-[minmax(0,1fr)_5rem_5rem_2.5rem] items-end gap-x-2 text-[11px] text-slate-400"
          >
            <span></span>
            <span class="inline-flex items-center gap-1">
              <span
                class="inline-block size-2 rounded-full"
                :style="{ backgroundColor: LEVEL_COLORS.warn }"
              ></span
              >жёлтый
            </span>
            <span class="inline-flex items-center gap-1">
              <span
                class="inline-block size-2 rounded-full"
                :style="{ backgroundColor: LEVEL_COLORS.crit }"
              ></span
              >красный
            </span>
            <span></span>
          </div>
          <div class="grid gap-2.5">
            <div
              v-for="f in HEALTH_FIELDS"
              :key="f.warnKey"
              class="grid grid-cols-[minmax(0,1fr)_5rem_5rem_2.5rem] items-center gap-x-2"
            >
              <div class="min-w-0">
                <span class="block text-xs font-medium">{{ f.label }}</span>
                <span class="block text-xs text-slate-400">{{ f.hint }}</span>
                <span
                  v-if="critBelowWarn(f)"
                  class="block text-xs text-rose-600 dark:text-rose-400"
                >
                  Красный ниже жёлтого - сохраним равным жёлтому
                </span>
              </div>
              <input
                v-model.number="health[f.warnKey]"
                type="number"
                min="0"
                step="1"
                :aria-label="`${f.label}: жёлтый порог`"
                class="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-indigo-500 dark:border-slate-700 dark:bg-slate-800"
              />
              <input
                v-model.number="health[f.critKey]"
                type="number"
                min="0"
                step="1"
                :aria-label="`${f.label}: красный порог`"
                class="w-full rounded-md border px-2 py-1.5 text-sm outline-none focus:border-indigo-500 dark:bg-slate-800"
                :class="
                  critBelowWarn(f)
                    ? 'border-rose-400 dark:border-rose-700'
                    : 'border-slate-300 dark:border-slate-700'
                "
              />
              <span class="text-xs text-slate-400">{{ f.unit }}</span>
            </div>
          </div>
        </div>

        <div class="border-t border-slate-200 pt-4 dark:border-slate-800">
          <h2 class="mb-1 text-sm font-semibold">API-токен Jira, необязательно</h2>
          <p class="mb-3 text-xs text-slate-400">
            Без токена отчёт берёт данные из открытой вкладки Jira, с токеном - без неё. Токен
            создаётся в <span class="font-mono">id.atlassian.com, Security, API tokens</span> и
            хранится только в этом браузере.
          </p>
          <label class="block">
            <span class="mb-1 block text-xs font-medium">Адрес Jira</span>
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
              Сохраним, если заполнены и email, и токен.
            </span>
          </label>
        </div>

        <div class="flex items-center gap-3 pt-1">
          <button
            type="submit"
            :disabled="!canSave"
            class="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-indigo-500 disabled:opacity-50"
          >
            Сохранить
          </button>
          <span v-if="saved" class="text-sm text-green-600">Сохранено</span>
          <span v-else-if="!namesValid" class="text-sm text-red-500">
            У каждой команды и дивизиона должно быть имя
          </span>
        </div>
      </form>
    </div>
  </div>
</template>
