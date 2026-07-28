<script lang="ts" setup>
import { computed } from 'vue';
import type { RuleId, RuleResult, RuleStatus } from '@/core/metrics';

/**
 * Чипы «здоровья спринта»: по одному на правило, с коротким значением и цветом.
 *
 * Палитра намеренно зелёный/янтарный, БЕЗ красного: инструмент планировочный, а не светофор
 * соответствия. Красный провоцирует защитную реакцию и подталкивает команду играть с цифрами
 * (дробить задачи, не заводить carryover явно) вместо разговора о причинах.
 *
 * `no-data` / `insufficient-history` показываются серым прочерком — визуально отличимы от ok,
 * чтобы «данных нет» нельзя было принять за «всё хорошо».
 */

const props = defineProps<{
  results: RuleResult[];
  /** Какое правило сейчас раскрыто (подсветка активного чипа). */
  active?: RuleId | null;
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

/** Развёрнутое пояснение для title (что именно значит число и с чем сравнили). */
function hint(r: RuleResult): string {
  const pct = (v: number) => `${(v * 100).toFixed(0)}%`;
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
      return `Скорость ${r.value! > 0 ? 'ниже' : 'выше'} на ${pct(Math.abs(r.value!))} базы ${r.baseline} SP — это медиана 6 ПРЕДЫДУЩИХ спринтов (сам спринт в базу не входит, иначе он влиял бы на собственный порог). Порог: не ниже −${pct(r.threshold)}`;
    case 'carryover':
      return `Перенесено ${pct(r.value!)} от взятого объёма (${r.evidence?.points ?? 0} SP, ${r.evidence?.issueKeys.length ?? 0} зад.). Порог: не более ${pct(r.threshold)}`;
    case 'reestimate':
      return `Оценки уже взятых задач выросли на ${pct(r.value!)} (+${r.evidence?.points ?? 0} SP). Порог: не более ${pct(r.threshold)}`;
    case 'scope-added':
      return `Добавлено после старта ${pct(r.value!)} от объёма (${r.evidence?.points ?? 0} SP, ${r.evidence?.issueKeys.length ?? 0} зад.). Порог: не более ${pct(r.threshold)}`;
    case 'punted':
      return r.value === 0
        ? 'Из спринта после старта ничего не выбрасывали'
        : `Выброшено ${r.value} зад. (${r.evidence?.points ?? 0} SP) после старта. Порог: ${r.threshold}`;
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

const TONE: Record<RuleStatus, string> = {
  warn: 'border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200',
  ok: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300',
  'no-data':
    'border-slate-200 bg-slate-50 text-slate-400 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-500',
  'insufficient-history':
    'border-slate-200 bg-slate-50 text-slate-400 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-500',
};

/** Правила без данных кликать незачем — раскрывать нечего. */
const clickable = (r: RuleResult) =>
  (r.status === 'warn' || r.status === 'ok') && (r.evidence?.issueKeys.length ?? 0) > 0;

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
      :class="[TONE[r.status], active === r.rule ? 'ring-2 ring-indigo-400 ring-offset-1 dark:ring-offset-slate-900' : '']"
      :title="hint(r)"
      @click.stop="clickable(r) && emit('pick', r.rule)"
    >
      <span class="opacity-70">{{ LABEL[r.rule] }}</span>
      <span class="tabular-nums">{{ display(r) }}</span>
    </button>
  </div>
</template>
