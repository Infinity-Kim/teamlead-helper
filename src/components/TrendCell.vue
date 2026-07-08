<script lang="ts" setup>
import { computed } from 'vue';
import { ADS } from './ads-tokens';
import Sparkline from './Sparkline.vue';
import InfoTip from './InfoTip.vue';

/**
 * Ячейка тренда для квартал-панели: подпись + значение + направление + спарклайн.
 * НАМЕРЕННО без цветных «здоровых» порогов (research: пороги провалили верификацию; тренд, не таргет).
 * Направление подкрашивается по СМЫСЛУ (задаётся goodWhen), а не абсолютным цветом. Слой: components.
 */
const props = defineProps<{
  label: string;
  /** Главное значение (уже отформатировано). */
  value: string;
  /** Единица (напр. «задач», «SP»). */
  unit?: string;
  /** Значения для спарклайна (старые слева). */
  spark: number[];
  /** Опц. референс-линия (медиана). */
  baseline?: number | null;
  /** Направление тренда. */
  direction: 'up' | 'down' | 'flat' | null;
  /** Какое направление «хорошее» (для окраски стрелки): рост say/do — хорошо; рост carryover — плохо. */
  goodWhen?: 'up' | 'down' | null;
  /** Подпись под значением (контекст). */
  hint?: string;
  /** Объяснение метрики для тултипа-«?» (если задано — показываем значок рядом с label). */
  tip?: { what: string; how: string; read: string; plan: string };
}>();

const T = ADS;

const arrow = computed(() => {
  switch (props.direction) {
    case 'up':
      return '↑';
    case 'down':
      return '↓';
    case 'flat':
      return '→';
    default:
      return '';
  }
});
const directionWord = computed(() => {
  switch (props.direction) {
    case 'up':
      return 'растёт';
    case 'down':
      return 'снижается';
    case 'flat':
      return 'ровно';
    default:
      return '';
  }
});
// Цвет стрелки: зелёный если направление совпадает с «хорошим», красный если противоположно, иначе нейтр.
const arrowColor = computed(() => {
  if (!props.direction || props.direction === 'flat' || !props.goodWhen) return T.subtlest;
  return props.direction === props.goodWhen ? T.success : T.danger;
});
</script>

<template>
  <div :style="{ display: 'flex', flexDirection: 'column', gap: '2px', minWidth: '0' }">
    <div
      :style="{
        display: 'flex',
        alignItems: 'center',
        gap: '4px',
        fontSize: '10px',
        fontWeight: 700,
        letterSpacing: '0.05em',
        textTransform: 'uppercase',
        color: T.subtlest,
      }"
    >
      {{ label }}
      <InfoTip
        v-if="tip"
        :title="label"
        :what="tip.what"
        :how="tip.how"
        :read="tip.read"
        :plan="tip.plan"
      />
    </div>
    <div
      :style="{
        fontSize: '14px',
        fontWeight: 600,
        fontVariantNumeric: 'tabular-nums',
        display: 'flex',
        alignItems: 'baseline',
        gap: '5px',
      }"
    >
      <span>{{ value }}<span v-if="unit" :style="{ fontSize: '11px', fontWeight: 400, color: T.subtle }">&nbsp;{{ unit }}</span></span>
      <span v-if="arrow" :style="{ fontSize: '11px', fontWeight: 700, color: arrowColor }">
        {{ arrow }} {{ directionWord }}
      </span>
    </div>
    <Sparkline
      v-if="spark.length >= 2"
      :values="spark"
      :baseline="baseline ?? null"
      :width="140"
      :height="22"
    />
    <div v-if="hint" :style="{ fontSize: '11px', color: T.subtle }">{{ hint }}</div>
  </div>
</template>
