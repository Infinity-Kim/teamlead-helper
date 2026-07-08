<script lang="ts" setup>
import { computed } from 'vue';
import type { ThroughputForecast } from '@/core/domain';
import { ADS } from './ads-tokens';
import InfoTip from './InfoTip.vue';

/**
 * Диапазон-бар прогноза Monte Carlo «сколько задач реально закроем»: p85 (консерв.) — p50 — p15 (оптим.).
 * Даёт честный интервал вместо точки-оценки (Cohn: prediction interval). Полоса от p85 до p15,
 * маркер p50 в середине. Стили инлайном (light DOM Jira). Слой: components.
 */
const props = defineProps<{
  forecast: ThroughputForecast;
}>();

const T = ADS;

// Шкала бара: от p85 (низ) до p15 (верх), с небольшим запасом по краям для читаемости.
const scale = computed(() => {
  const lo = props.forecast.p85;
  const hi = props.forecast.p15;
  const span = hi - lo || 1;
  const pad = span * 0.25;
  return { min: Math.max(0, lo - pad), max: hi + pad };
});
function pct(v: number): number {
  const { min, max } = scale.value;
  return +(((v - min) / (max - min || 1)) * 100).toFixed(1);
}
const bandLeft = computed(() => pct(props.forecast.p85));
const bandRight = computed(() => pct(props.forecast.p15));
const bandWidth = computed(() => Math.max(0, bandRight.value - bandLeft.value));
const p50Left = computed(() => pct(props.forecast.p50));

// Заголовочная подпись диапазона: «18–24 задачи» (p85–p15).
const rangeLabel = computed(() => `${props.forecast.p85}–${props.forecast.p15}`);
// Параллельный SP-диапазон (справочно, привязка к capacity в SP). null — не показываем.
const spLabel = computed(() => {
  const sp = props.forecast.sp;
  return sp ? `≈ ${sp.p85}–${sp.p15} SP` : null;
});
</script>

<template>
  <div :style="{ minWidth: '200px' }">
    <!-- Заголовок секции + «?» -->
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
        marginBottom: '3px',
      }"
    >
      Сколько реально влезет
      <InfoTip
        title="Прогноз ёмкости спринта (Monte Carlo)"
        what="Сколько задач команда реально закроет за спринт — как диапазон, а не одно число."
        how="10 000 симуляций: случайно берём throughput прошлых спринтов и суммируем. p85 / p50 / p15 — перцентили исходов."
        read="p85 = осторожно (85% исходов дают не меньше), p50 = серединный исход, p15 = если всё сложится."
        plan="Берите в спринт около p85 — это честное обязательство, которое команда выполнит с высокой вероятностью, без переоценки."
      />
    </div>

    <!-- Крупное число диапазона -->
    <div
      :style="{
        fontSize: '15px',
        fontWeight: 600,
        fontVariantNumeric: 'tabular-nums',
        lineHeight: '18px',
      }"
    >
      {{ rangeLabel }}
      <span :style="{ fontSize: '11px', fontWeight: 400, color: T.subtle }">задач</span>
    </div>
    <div v-if="spLabel" :style="{ fontSize: '11px', color: T.subtlest, marginBottom: '2px' }">
      {{ spLabel }}
    </div>

    <!-- Диапазон-бар: дорожка + полоса p85..p15 + маркер p50. Подписи РАЗВЕДЕНЫ по высоте. -->
    <div :style="{ position: 'relative', height: '30px', width: '200px', marginTop: '5px' }">
      <!-- дорожка -->
      <div
        :style="{
          position: 'absolute',
          top: '4px',
          height: '4px',
          left: '0',
          right: '0',
          background: T.track,
          borderRadius: '2px',
        }"
      />
      <!-- полоса вероятного диапазона p85..p15 -->
      <div
        :style="{
          position: 'absolute',
          top: '3px',
          height: '6px',
          left: bandLeft + '%',
          width: bandWidth + '%',
          background: T.selected,
          border: `1px solid ${T.information}`,
          borderRadius: '3px',
        }"
      />
      <!-- маркер медианного исхода p50 -->
      <div
        :style="{
          position: 'absolute',
          top: '0',
          height: '12px',
          width: '2px',
          left: `calc(${p50Left}% - 1px)`,
          background: T.information,
        }"
      />
      <!-- подписи краёв на РАЗНЫХ строках, чтобы не наезжали друг на друга при узком диапазоне -->
      <span
        :style="{
          position: 'absolute',
          top: '13px',
          left: '0',
          fontSize: '9px',
          color: T.subtlest,
          fontVariantNumeric: 'tabular-nums',
          whiteSpace: 'nowrap',
        }"
      >
        осторожно {{ forecast.p85 }}
      </span>
      <span
        :style="{
          position: 'absolute',
          top: '13px',
          right: '0',
          fontSize: '9px',
          color: T.subtlest,
          fontVariantNumeric: 'tabular-nums',
          whiteSpace: 'nowrap',
        }"
      >
        оптимизм {{ forecast.p15 }}
      </span>
    </div>
  </div>
</template>
