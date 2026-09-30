<script lang="ts" setup>
import { computed } from 'vue';
import {
  DEFAULT_HEALTH_COLORS,
  isEvaluated,
  type HealthColors,
  type RuleId,
  type RuleResult,
  type RuleStatus,
} from '@/core/metrics';
import { levelStyle } from './health-tone';

/**
 * Чипы «здоровья спринта»: по одному на правило, с коротким значением и цветом.
 *
 * Три уровня: зелёный — в норме, жёлтый — за первым порогом, красный — за вторым (issue #18).
 * Одного порога не хватало: 11% и 60% переноса красились одинаково, и по чипам было не
 * понять, где «стоит обсудить», а где «надо разбираться». Пороги и цвета — в Options.
 *
 * `no-data` / `insufficient-history` показываются серым прочерком — визуально отличимы от ok,
 * чтобы «данных нет» нельзя было принять за «всё хорошо».
 */

const props = defineProps<{
  results: RuleResult[];
  /** Какое правило сейчас раскрыто (подсветка активного чипа). */
  active?: RuleId | null;
  /** Цвета уровней из настроек; по умолчанию — палитра ADS. */
  colors?: HealthColors;
}>();

const emit = defineEmits<{ pick: [rule: RuleId] }>();

/** Короткие подписи — в строке спринта места мало. */
const LABEL: Record<RuleId, string> = {
  'velocity-drop': 'скорость',
  carryover: 'перенос',
  reestimate: 'переоценка',
  'scope-added': 'добавлено',
  punted: 'выброшено',
};

/** Уровень словами — первой строкой подсказки, чтобы цвет чипа не приходилось угадывать. */
const LEVEL: Partial<Record<RuleStatus, string>> = {
  ok: 'в норме',
  warn: 'за первым порогом (жёлтый)',
  crit: 'за вторым порогом (красный)',
};

/** Развёрнутое пояснение для title (что именно значит число и с чем сравнили). */
function hint(r: RuleResult): string {
  const detail = describe(r);
  const level = LEVEL[r.status];
  return level ? `${detail}\nУровень: ${level}` : detail;
}

function describe(r: RuleResult): string {
  const pct = (v: number) => `${(v * 100).toFixed(0)}%`;
  // «20% / 30%» — первый (жёлтый) и второй (красный).
  const limits = `${pct(r.threshold)} / ${pct(r.critThreshold)}`;
  switch (r.status) {
    case 'insufficient-history':
      return `${LABEL[r.rule]}: мало истории для сравнения (нужно больше закрытых спринтов)`;
    case 'no-data':
      return `${LABEL[r.rule]}: Jira не отдала данные для этого правила`;
    default:
      break;
  }
  switch (r.rule) {
    case 'velocity-drop':
      // Явно говорим «ПРЕДЫДУЩИХ, без этого спринта»: в шапке страницы медиана считается
      // по последним 6 ВКЛЮЧАЯ текущий, и без уточнения два числа выглядят противоречиво.
      return `Скорость ${r.value! > 0 ? 'ниже' : 'выше'} на ${pct(Math.abs(r.value!))} базы ${r.baseline} SP — это медиана 6 ПРЕДЫДУЩИХ спринтов (сам спринт в базу не входит, иначе он влиял бы на собственный порог). Пороги: не ниже −${pct(r.threshold)} / −${pct(r.critThreshold)}`;
    case 'carryover':
      return `Перенесено ${pct(r.value!)} от взятого объёма (${r.evidence?.points ?? 0} SP, ${r.evidence?.issueKeys.length ?? 0} зад.). Пороги: не более ${limits}`;
    case 'reestimate':
      return `Оценки уже взятых задач выросли на ${pct(r.value!)} (+${r.evidence?.points ?? 0} SP). Пороги: не более ${limits}`;
    case 'scope-added':
      return `Добавлено после старта ${pct(r.value!)} от объёма (${r.evidence?.points ?? 0} SP, ${r.evidence?.issueKeys.length ?? 0} зад.). Пороги: не более ${limits}`;
    case 'punted':
      return r.value === 0
        ? 'Из спринта после старта ничего не выбрасывали'
        : `Выброшено ${r.value} зад. (${r.evidence?.points ?? 0} SP) после старта. Пороги: не более ${r.threshold} / ${r.critThreshold} зад.`;
  }
}

/** Компактное значение на чипе. */
function display(r: RuleResult): string {
  if (r.value === null) return '—';
  if (r.rule === 'punted') return `${r.value}`;
  const pct = Math.round(Math.abs(r.value) * 100);
  if (r.rule === 'velocity-drop') return `${r.value > 0 ? '↓' : '↑'}${pct}%`;
  return `${pct}%`;
}

/** Серый для правил без оценки — чтобы «данных нет» не читалось как «всё хорошо». */
const NEUTRAL =
  'border-slate-200 bg-slate-50 text-slate-400 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-500';

function tone(status: RuleStatus): { class: string; style?: ReturnType<typeof levelStyle> } {
  if (!isEvaluated(status)) return { class: NEUTRAL };
  const c = props.colors ?? DEFAULT_HEALTH_COLORS;
  return { class: 'text-slate-800 dark:text-slate-100', style: levelStyle(c[status]) };
}

/** Правила без данных кликать незачем — раскрывать нечего. */
const clickable = (r: RuleResult) =>
  isEvaluated(r.status) && (r.evidence?.issueKeys.length ?? 0) > 0;

const chips = computed(() => props.results);
</script>

<template>
  <div class="flex flex-wrap items-center gap-1">
    <button
      v-for="r in chips"
      :key="r.rule"
      type="button"
      :disabled="!clickable(r)"
      class="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium transition enabled:hover:brightness-95 disabled:cursor-default"
      :style="tone(r.status).style"
      :class="[
        tone(r.status).class,
        active === r.rule ? 'ring-2 ring-indigo-400 ring-offset-1 dark:ring-offset-slate-900' : '',
      ]"
      :title="hint(r)"
      @click.stop="clickable(r) && emit('pick', r.rule)"
    >
      <span class="opacity-70">{{ LABEL[r.rule] }}</span>
      <span class="tabular-nums">{{ display(r) }}</span>
    </button>
  </div>
</template>
