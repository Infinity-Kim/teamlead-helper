<script lang="ts" setup>
import { computed } from 'vue';
import type { SprintCapStats, CapSlice } from '@/core/domain';
import { ADS, BUCKET_COLORS } from './ads-tokens';

const props = defineProps<{
  stats: SprintCapStats;
  /** Целевой % Product — для маркера на полосе. */
  targetProductPct: number;
  /** Активные бакеты-фильтры (мультивыбор; подсвечиваются). Пусто — фильтр не активен. */
  activeBuckets: CapSlice[];
  /** Медиана completed SP за последние N спринтов (рекомендуемый capacity). null — нет данных. */
  medianSp: number | null;
  /** Идёт пересчёт (после смены лейбла) — показываем индикатор. */
  refreshing: boolean;
}>();

const emit = defineEmits<{
  bucketClick: [bucket: CapSlice];
  clearAll: [];
  refresh: [];
}>();

const segments = computed(() =>
  props.stats.buckets
    .filter((b) => b.pct > 0)
    .map((b) => ({ ...b, color: BUCKET_COLORS[b.bucket] })),
);
const hasData = computed(() => props.stats.totalPoints > 0);
const skewLabel = computed(() => {
  const s = props.stats.topSkew;
  if (!s) return null;
  return `${s.bucket} ${s.deltaPp > 0 ? '+' : ''}${s.deltaPp}%`;
});

/** Позиция маркера медианы на полосе, % (медиана SP относительно объёма спринта). null — не рисуем. */
const medianPct = computed(() => {
  if (props.medianSp == null || props.stats.totalPoints <= 0) return null;
  return Math.min(100, (props.medianSp / props.stats.totalPoints) * 100);
});
/** Перебран ли план спринта относительно медианы (total > median). */
const overMedian = computed(
  () => props.medianSp != null && props.stats.totalPoints > props.medianSp,
);

// --- ADS-токены (общие для виджетов, см. ads-tokens.ts) ---
const T = ADS;

// host выравнивается по сетке Jira: боковой отступ как у строки заголовка спринта.
const S = {
  root: {
    fontFamily: T.fontFamily,
    fontSize: '12px',
    lineHeight: '16px',
    color: T.text,
    // Сводка по спринту во всю ширину контейнера: width:100% + симметричные отступы,
    // как у остальных детей контейнера спринта (они все на одной левой границе).
    width: '100%',
    padding: '4px 8px 8px',
    boxSizing: 'border-box' as const,
  },
  head: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' },
  track: {
    position: 'relative' as const,
    display: 'flex',
    height: '8px',
    borderRadius: '4px',
    background: T.track,
    width: '100%',
  },
  target: (left: number) => ({
    position: 'absolute' as const,
    top: '-2px',
    bottom: '-2px',
    left: `${left}%`,
    width: '2px',
    background: T.text,
    boxShadow: '0 0 0 1px var(--ds-surface, #fff)',
  }),
  // Маркер медианы velocity (рекомендуемый capacity) — пунктирная вертикаль поверх полосы.
  medianMark: (left: number) => ({
    position: 'absolute' as const,
    top: '-3px',
    bottom: '-3px',
    left: `calc(${left}% - 1px)`,
    width: '0',
    borderLeft: '2px dashed var(--ds-text, #292a2e)',
    zIndex: '2',
  }),
  legend: { display: 'flex', flexWrap: 'wrap' as const, gap: '4px', marginTop: '6px' },
};

// Бакеты со светлым фоном (жёлтый) требуют тёмного текста; остальные — белый.
const LIGHT_BG: Record<CapSlice, boolean> = {
  Product: false,
  Tech: false,
  Support: true, // жёлтый
  Unlabeled: false,
};

/** Активен ли бакет (входит в набор мультивыбора). */
function isActive(bucket: CapSlice): boolean {
  return props.activeBuckets.includes(bucket);
}

function legChip(bucket: CapSlice) {
  const active = isActive(bucket);
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    padding: '2px 7px',
    borderRadius: '4px',
    cursor: 'pointer',
    userSelect: 'none' as const,
    transition: 'background .12s, color .12s',
    // Активный чип заливается цветом своего бакета (явное выделение), текст контрастный + жирный.
    color: active ? (LIGHT_BG[bucket] ? '#172b4d' : '#fff') : T.subtle,
    background: active ? BUCKET_COLORS[bucket] : 'transparent',
    fontWeight: active ? 700 : 400,
    boxShadow: active ? 'inset 0 0 0 1px rgba(0,0,0,.08)' : 'none',
  };
}

function chipTitle(bucket: CapSlice): string {
  const active = isActive(bucket);
  if (bucket === 'Unlabeled') {
    return active ? 'Снять подсветку неразмеченных' : 'Подсветить на доске задачи без CAP-метки';
  }
  return active ? `Убрать ${bucket} из фильтра` : `Добавить ${bucket} в фильтр доски`;
}

function dot(bucket: CapSlice) {
  const active = isActive(bucket);
  return {
    width: '8px',
    height: '8px',
    borderRadius: '2px',
    display: 'inline-block',
    flex: '0 0 auto',
    // На активном (залитом) чипе точку делаем белой/тёмной — чтобы не сливалась с фоном.
    background: active ? (LIGHT_BG[bucket] ? '#172b4d' : '#fff') : BUCKET_COLORS[bucket],
  };
}
</script>

<template>
  <div :style="S.root">
    <div :style="S.head">
      <span :style="{ fontWeight: 600, color: T.text }">Capacity</span>
      <span :style="{ color: T.subtle }">{{ stats.totalPoints }} SP</span>
      <span
        v-if="medianSp !== null"
        :style="{
          color: overMedian ? T.danger : T.subtle,
          display: 'inline-flex',
          alignItems: 'center',
          gap: '3px',
        }"
        :title="`Медиана выполненных SP за последние спринты — рекомендуемый предел.${overMedian ? ' План превышает медиану.' : ''}`"
      >
        <span
          :style="{ borderLeft: '2px dashed currentColor', height: '9px', display: 'inline-block' }"
        />
        медиана {{ medianSp }} SP
      </span>
      <span v-if="skewLabel" :style="{ color: T.danger, fontWeight: 600 }">⚠ {{ skewLabel }}</span>
      <span v-else-if="hasData" :style="{ color: T.success }">✓ в норме</span>

      <span
        :style="{ display: 'inline-flex', alignItems: 'center', gap: '8px', marginLeft: 'auto' }"
      >
        <span v-if="refreshing" :style="{ color: T.subtlest }">обновляю…</span>
        <span
          v-if="activeBuckets.length"
          :style="{ color: T.subtlest, cursor: 'pointer' }"
          title="Сбросить все фильтры"
          @click="emit('clearAll')"
        >
          ✕ сбросить
        </span>
        <span
          :style="{
            color: T.subtlest,
            cursor: 'pointer',
            display: 'inline-block',
            transition: 'transform .3s',
            transform: refreshing ? 'rotate(360deg)' : 'none',
          }"
          title="Обновить сейчас"
          @click="emit('refresh')"
        >
          ↻
        </span>
      </span>
    </div>

    <div v-if="hasData" :style="S.track">
      <div
        v-for="(seg, i) in segments"
        :key="seg.bucket"
        :style="{
          width: seg.pct + '%',
          background: seg.color,
          height: '100%',
          borderTopLeftRadius: i === 0 ? '4px' : '0',
          borderBottomLeftRadius: i === 0 ? '4px' : '0',
          borderTopRightRadius: i === segments.length - 1 ? '4px' : '0',
          borderBottomRightRadius: i === segments.length - 1 ? '4px' : '0',
        }"
        :title="`${seg.bucket}: ${seg.points} SP (${seg.pct}%)`"
      />
      <div :style="S.target(targetProductPct)" :title="`Цель Product: ${targetProductPct}%`" />
      <div
        v-if="medianPct !== null"
        :style="S.medianMark(medianPct)"
        :title="`Медиана velocity (рекомендуемый capacity): ${medianSp} SP`"
      />
    </div>
    <div v-else :style="{ color: T.subtlest, fontStyle: 'italic', padding: '3px 0' }">
      нет оценённых задач
    </div>

    <div v-if="hasData" :style="S.legend">
      <span
        v-for="b in stats.buckets"
        :key="b.bucket"
        :style="legChip(b.bucket)"
        :title="chipTitle(b.bucket)"
        @click="emit('bucketClick', b.bucket)"
      >
        <i :style="dot(b.bucket)" />
        {{ b.bucket }} {{ b.pct }}%
        <em
          v-if="b.deltaPp !== null && Math.abs(b.deltaPp) >= 5"
          :style="{
            // На активном (залитом) чипе дельта наследует контрастный цвет текста чипа.
            color: isActive(b.bucket) ? 'inherit' : b.deltaPp > 0 ? T.danger : T.information,
            fontStyle: 'normal',
          }"
          :title="`Отклонение от цели: ${b.deltaPp > 0 ? '+' : ''}${b.deltaPp} процентных пунктов`"
        >
          ({{ b.deltaPp > 0 ? '+' : '' }}{{ b.deltaPp }}%)
        </em>
      </span>
    </div>
  </div>
</template>
