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
 * понять, где «стоит обсудить», а где «надо разбираться». Пороги и цвета - в Options, в подсказке
 * чипа их не повторяем.
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

/** Уровень словами - последней строкой подсказки, чтобы цвет чипа не приходилось угадывать. */
const LEVEL: Partial<Record<RuleStatus, string>> = {
  ok: 'Зелёный: в норме.',
  warn: 'Жёлтый: стоит обсудить на ретро.',
  crit: 'Красный: надо разбираться.',
};

/** Подсказка чипа (title): число с тем, из чего оно, и уровень. До 2 строк. */
function hint(r: RuleResult): string {
  const level = LEVEL[r.status];
  const tail = [level, clickable(r) ? 'Нажмите - покажем задачи.' : ''].filter(Boolean).join(' ');
  return tail ? `${describe(r)}\n${tail}` : describe(r);
}

function describe(r: RuleResult): string {
  const pct = (v: number) => `${(v * 100).toFixed(0)}%`;
  const sp = r.evidence?.points ?? 0;
  const n = r.evidence?.issueKeys.length ?? 0;
  const name = LABEL[r.rule][0]!.toUpperCase() + LABEL[r.rule].slice(1);
  switch (r.status) {
    case 'insufficient-history':
      return `${name}: не с чем сравнить, нужно 6 закрытых спринтов до этого.`;
    case 'no-data':
      return `${name}: Jira не отдала данные.`;
    default:
      break;
  }
  switch (r.rule) {
    case 'velocity-drop': {
      // База - медиана 6 спринтов ДО этого, сам спринт в неё не входит: иначе он влиял бы на
      // собственный порог. В шапке отчёта медиана по последним 6 вместе со свежим.
      const base = r.baseline ?? 0;
      const closed = Math.round(base * (1 - r.value!));
      return `Скорость: закрыли ${closed} SP, обычно ${base} - на ${pct(Math.abs(r.value!))} ${r.value! > 0 ? 'меньше' : 'больше'}. Обычно - медиана 6 спринтов до этого.`;
    }
    case 'carryover':
      return `Перенос: не закрыли ${sp} SP в ${n} задачах, это ${pct(r.value!)} объёма спринта к концу.`;
    case 'reestimate':
      return `Переоценка: оценки задач со старта выросли на ${sp} SP, это ${pct(r.value!)}. Снижение оценок не вычитаем.`;
    case 'scope-added':
      return `Добавлено: после старта докинули ${sp} SP в ${n} задачах, это ${pct(r.value!)} от остального объёма.`;
    case 'punted':
      return n === 0
        ? 'Выброшено: после старта из спринта ничего не убирали.'
        : `Выброшено: после старта убрали ${sp} SP в ${n} задачах, это ${pct(r.value!)} от взятого на старте.`;
  }
}

/** Компактное значение на чипе: у скорости «-12%» - закрыли меньше обычного, «+12%» - больше. */
function display(r: RuleResult): string {
  if (r.value === null) return '-';
  const pct = Math.round(Math.abs(r.value) * 100);
  if (r.rule === 'velocity-drop') return `${r.value > 0 ? '-' : '+'}${pct}%`;
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
