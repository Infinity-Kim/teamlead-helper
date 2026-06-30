<script lang="ts" setup>
import { computed } from 'vue';
import type { QuarterBalance } from '@/core/domain';
import { SPRINTS_PER_QUARTER } from '@/core/domain';
import { sprintsRemaining } from '@/core/metrics';
import { ADS } from './ads-tokens';

const props = defineProps<{
  balance: QuarterBalance;
  /** Целевой % Product (для маркера и подписи). */
  targetPct: number;
  /** Полуширина коридора (пп). */
  bandPp: number;
}>();

// ADS-токены (общие для виджетов, см. ads-tokens.ts).
const T = ADS;

const productPct = computed(() => props.balance.productPct);
const otherPct = computed(() => +(100 - props.balance.productPct).toFixed(1));
const deltaLabel = computed(() => {
  const d = props.balance.deltaPp;
  return `${d > 0 ? '+' : ''}${d}%`;
});
const debtAbs = computed(() => Math.abs(props.balance.productDebtSp));
const skewDir = computed(() => (props.balance.deltaPp > 0 ? 'Product' : 'остального'));
const statusColor = computed(() => (props.balance.outOfBand ? T.danger : T.success));
const sprintsLabel = computed(
  () => `${props.balance.sprintsCounted} из ${SPRINTS_PER_QUARTER} спринтов`,
);

// План активного спринта показываем, когда в активном спринте есть незавершённый объём
// («взято, но не Done») — тогда есть что прогнозировать. Расхождение по кварталу может быть
// малым, но факт/план активного спринта всё равно различаются — это и есть суть разделения.
const planExtraSp = computed(() =>
  +(props.balance.plannedTotal - props.balance.totalPoints).toFixed(1),
);
const showPlan = computed(() => props.balance.hasActive && planExtraSp.value >= 1);
const planDeltaLabel = computed(() => {
  const d = props.balance.plannedDeltaPp;
  return `${d > 0 ? '+' : ''}${d}%`;
});
const planColor = computed(() => (props.balance.plannedOutOfBand ? T.danger : T.success));

// Сколько спринтов квартала ещё осталось (0 = квартал на последнем спринте).
const remaining = computed(() => sprintsRemaining(props.balance.sprintsCounted));
</script>

<template>
  <div
    :style="{
      fontFamily: T.fontFamily,
      fontSize: '12px',
      lineHeight: '16px',
      color: T.text,
      width: '100%',
      boxSizing: 'border-box',
    }"
  >
    <!-- Заголовок: квартал + прогресс + факт-статус + (план) -->
    <div
      :style="{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        marginBottom: '4px',
        flexWrap: 'wrap',
      }"
    >
      <span :style="{ fontWeight: 600 }">Квартал {{ balance.quarter }}</span>
      <span :style="{ color: T.subtle }">· {{ sprintsLabel }}</span>
      <span :style="{ color: T.subtle }">· {{ balance.totalPoints }} SP</span>
      <span
        :style="{ color: statusColor, fontWeight: 600 }"
        :title="
          balance.outOfBand
            ? `Отклонение факта от цели: ${deltaLabel} (процентных пунктов)`
            : 'Факт в пределах целевого коридора'
        "
      >
        {{ showPlan ? 'факт ' : '' }}Product {{ productPct }}%
        <template v-if="balance.outOfBand">⚠ {{ deltaLabel }}</template>
        <template v-else>✓</template>
      </span>
      <span
        v-if="showPlan"
        :style="{ color: planColor }"
        :title="`Прогноз, если закроют всё взятое в активный спринт (+${planExtraSp} SP ещё не Done)`"
      >
        · по плану {{ balance.plannedProductPct }}%
        <template v-if="balance.plannedOutOfBand">⚠ {{ planDeltaLabel }}</template>
        <span :style="{ color: T.subtlest }">(+{{ planExtraSp }} SP в работе)</span>
      </span>
    </div>

    <!-- Полоса Product vs остальное + целевой маркер + коридор -->
    <div
      :style="{
        position: 'relative',
        display: 'flex',
        height: '10px',
        borderRadius: '5px',
        background: T.track,
        width: '100%',
      }"
    >
      <div
        :style="{
          width: productPct + '%',
          background: T.productColor,
          borderTopLeftRadius: '5px',
          borderBottomLeftRadius: '5px',
        }"
        :title="`Product: ${balance.productPoints} SP (${productPct}%)`"
      />
      <div
        :style="{
          width: otherPct + '%',
          background: T.otherColor,
          borderTopRightRadius: '5px',
          borderBottomRightRadius: '5px',
        }"
        :title="`Остальное (Tech+Support): ${balance.otherPoints} SP (${otherPct}%)`"
      />
      <!-- коридор цели -->
      <div
        :style="{
          position: 'absolute',
          top: '-2px',
          bottom: '-2px',
          left: `${targetPct - bandPp}%`,
          width: `${bandPp * 2}%`,
          background: 'rgba(91,127,36,0.12)',
          border: '1px dashed var(--ds-text-success, #4c6b1f)',
          boxSizing: 'border-box',
        }"
        :title="`Допустимый коридор: ${targetPct - bandPp}–${targetPct + bandPp}%`"
      />
      <!-- целевая линия -->
      <div
        :style="{
          position: 'absolute',
          top: '-3px',
          bottom: '-3px',
          left: `calc(${targetPct}% - 1px)`,
          width: '0',
          borderLeft: '2px solid var(--ds-text, #292a2e)',
        }"
        :title="`Цель Product: ${targetPct}%`"
      />
    </div>

    <!-- Пояснение баланса -->
    <div :style="{ marginTop: '5px', color: T.subtle }">
      <template v-if="balance.outOfBand && debtAbs > 0 && remaining > 0">
        Перекос в {{ skewDir }}: чтобы выйти на цель {{ targetPct }}%, нужно ≈
        <b :style="{ color: T.danger }">{{ debtAbs }} SP</b>
        {{ balance.deltaPp > 0 ? 'на Tech/Support' : 'на Product' }} в оставшихся
        {{ remaining }} {{ remaining === 1 ? 'спринте' : 'спринтах' }}.
      </template>
      <template v-else-if="balance.outOfBand && debtAbs > 0">
        Квартал завершается: перекос в {{ skewDir }} на {{ deltaLabel }} (цель {{ targetPct }}%).
        Учесть в планировании следующего квартала.
      </template>
      <template v-else> Баланс в пределах цели ({{ targetPct }}% ±{{ bandPp }}%). </template>
    </div>
  </div>
</template>
