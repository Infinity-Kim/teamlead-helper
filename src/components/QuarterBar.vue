<script lang="ts" setup>
import { computed } from 'vue';
import type { QuarterBalance } from '@/core/domain';
import { ADS } from './ads-tokens';
import InfoTip from './InfoTip.vue';

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
/** Число по-русски: до 1 знака после запятой, «74,8», «20». */
const fmt = (n: number) => n.toLocaleString('ru-RU', { maximumFractionDigits: 1 });
const otherPct = computed(() => +(100 - props.balance.productPct).toFixed(1));
const debtAbs = computed(() => Math.abs(props.balance.productDebtSp));
const statusColor = computed(() => (props.balance.outOfBand ? T.danger : T.success));
const bandLabel = computed(
  () => `${props.targetPct - props.bandPp}-${props.targetPct + props.bandPp}%`,
);
const sprintsLabel = computed(
  () =>
    `${props.balance.sprintsCounted} из ${props.balance.sprintsCounted + props.balance.sprintsLeft} спринтов`,
);

// «С активным» показываем, когда в активном спринте ещё не закрыто от 1 SP: тогда доля
// Product к концу спринта может отличаться от факта.
const planExtraSp = computed(
  () => +(props.balance.plannedTotal - props.balance.totalPoints).toFixed(1),
);
const showPlan = computed(() => props.balance.hasActive && planExtraSp.value >= 1);
const planColor = computed(() => (props.balance.plannedOutOfBand ? T.danger : T.subtle));
/** «за 1 оставшийся спринт», «за 2 оставшихся спринта», «за 5 оставшихся спринтов». */
function sprintsWord(n: number): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return 'оставшийся спринт';
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return 'оставшихся спринта';
  return 'оставшихся спринтов';
}
const plannedPct = computed(() => Math.round(props.balance.plannedProductPct));

// Сколько спринтов квартала ещё осталось (0 = квартал на последнем спринте).
const remaining = computed(() => props.balance.sprintsLeft);
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
    <!-- Заголовок: квартал, прогресс, доля Product и где окажется с активным спринтом -->
    <div
      :style="{
        display: 'flex',
        alignItems: 'center',
        gap: '2px 8px',
        marginBottom: '4px',
        flexWrap: 'wrap',
      }"
    >
      <span :style="{ fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: '4px' }">
        Квартал {{ balance.quarter }}
        <InfoTip
          title="Доля Product за квартал"
          :what="`Доля Product в закрытых SP квартала. Пример: закрыли 300 SP, Product 210 - доля 70%.`"
          :read="`Зелёная рамка на полосе - цель ${bandLabel}, её задают в настройках. В начале квартала доля скачет, смотрите с середины.`"
        />
      </span>
      <span :style="{ color: T.subtle, whiteSpace: 'nowrap' }">{{ sprintsLabel }}</span>
      <span
        :style="{ color: statusColor, fontWeight: 600, whiteSpace: 'nowrap' }"
        :title="`Product: ${fmt(balance.productPoints)} из ${fmt(balance.totalPoints)} закрытых SP квартала`"
      >
        Product {{ fmt(productPct) }}%, цель {{ bandLabel }}
        {{ balance.outOfBand ? '⚠' : '✓' }}
      </span>
      <span
        v-if="showPlan"
        :style="{ color: planColor, whiteSpace: 'nowrap' }"
        :title="`Если закроют ещё ${fmt(planExtraSp)} SP активного спринта`"
      >
        с активным спринтом {{ plannedPct }}%
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
        :title="`Product: ${fmt(balance.productPoints)} SP, ${fmt(productPct)}% закрытых SP квартала`"
      />
      <div
        :style="{
          width: otherPct + '%',
          background: T.otherColor,
          borderTopRightRadius: '5px',
          borderBottomRightRadius: '5px',
        }"
        :title="`Tech, Support и без метки: ${fmt(balance.otherPoints)} SP, ${fmt(otherPct)}% закрытых SP квартала`"
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
        :title="`Цель Product: ${bandLabel}`"
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
        :title="`Середина цели: ${targetPct}%`"
      />
    </div>

    <!-- Что делать: только при выходе из цели -->
    <div v-if="balance.outOfBand && debtAbs > 0" :style="{ marginTop: '5px', color: T.subtle }">
      <template v-if="remaining > 0">
        Чтобы вернуться к {{ targetPct }}%, возьмите ещё
        <b :style="{ color: T.danger }">{{ fmt(debtAbs) }} SP</b>
        {{ balance.deltaPp > 0 ? 'Tech и Support' : 'Product' }} за {{ remaining }}
        {{ sprintsWord(remaining) }}.
      </template>
      <template v-else>Квартал закрывается вне цели: учтите в планах следующего.</template>
    </div>
  </div>
</template>
