<script lang="ts" setup>
import { computed } from 'vue';
import { ADS } from './ads-tokens';

/**
 * Минималистичный спарклайн (inline SVG) для трендов метрик — say/do, throughput, carryover.
 * Без осей/подписей: только линия + акцент на последней точке + опц. пунктир медианы.
 * Стили инлайном (монтируется в light DOM Jira, scoped-CSS не доедет). Читается слева→направо
 * по времени (свежие точки справа). Слой: components.
 */
const props = defineProps<{
  /** Значения по времени (старые слева). Нужно ≥2 для линии. */
  values: number[];
  /** Опциональная референс-линия (напр. медиана) — рисуется пунктиром. */
  baseline?: number | null;
  width?: number;
  height?: number;
  /** Цвет линии (по умолчанию акцент расширения). */
  color?: string;
}>();

const W = computed(() => props.width ?? 120);
const H = computed(() => props.height ?? 22);
const PAD = 3;

const domain = computed(() => {
  const vals = props.values.slice();
  if (props.baseline != null) vals.push(props.baseline);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  // Небольшой запас, чтобы линия не липла к краям; защита от min==max (плоский ряд).
  const span = max - min || 1;
  return { min: min - span * 0.1, max: max + span * 0.1 };
});

/** Спроецировать значение в y-координату SVG (инверсия: больше значение — выше). */
function toY(v: number): number {
  const { min, max } = domain.value;
  const t = (v - min) / (max - min || 1);
  return +(H.value - PAD - t * (H.value - 2 * PAD)).toFixed(2);
}
function toX(i: number, n: number): number {
  if (n <= 1) return PAD;
  return +(PAD + (i / (n - 1)) * (W.value - 2 * PAD)).toFixed(2);
}

const points = computed(() =>
  props.values.map((v, i) => `${toX(i, props.values.length)},${toY(v)}`).join(' '),
);
const last = computed(() => {
  const n = props.values.length;
  if (n === 0) return null;
  return { x: toX(n - 1, n), y: toY(props.values[n - 1]) };
});
const baselineY = computed(() => (props.baseline != null ? toY(props.baseline) : null));
const lineColor = computed(() => props.color ?? ADS.information);
</script>

<template>
  <svg
    :width="W"
    :height="H"
    :viewBox="`0 0 ${W} ${H}`"
    :style="{ display: 'block', overflow: 'visible' }"
    aria-hidden="true"
  >
    <!-- базовая линия «пола» -->
    <line
      :x1="0"
      :y1="H - 1"
      :x2="W"
      :y2="H - 1"
      :stroke="ADS.track"
      stroke-width="1"
    />
    <!-- референс (медиана) -->
    <line
      v-if="baselineY !== null"
      :x1="0"
      :y1="baselineY"
      :x2="W"
      :y2="baselineY"
      :stroke="ADS.subtlest"
      stroke-width="1"
      stroke-dasharray="2 2"
    />
    <!-- линия тренда -->
    <polyline
      v-if="values.length >= 2"
      :points="points"
      fill="none"
      :stroke="lineColor"
      stroke-width="1.5"
      stroke-linejoin="round"
      stroke-linecap="round"
    />
    <!-- акцент на последней точке -->
    <circle v-if="last" :cx="last.x" :cy="last.y" r="2.4" :fill="lineColor" />
  </svg>
</template>
