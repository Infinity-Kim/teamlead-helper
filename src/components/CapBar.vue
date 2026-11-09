<script lang="ts" setup>
import { computed } from 'vue';
import type { SprintCapStats, CapSlice } from '@/core/domain';
import type { PlanCapacity } from '@/core/metrics';
import { ADS, BUCKET_COLORS } from './ads-tokens';
import InfoTip from './InfoTip.vue';

const props = defineProps<{
  stats: SprintCapStats;
  /** Целевой % Product — для маркера на полосе. */
  targetProductPct: number;
  /** Активные бакеты-фильтры (мультивыбор; подсвечиваются). Пусто — фильтр не активен. */
  activeBuckets: CapSlice[];
  /** Рекомендуемый план на старте (цель выполнения + прилёты). null — нет данных. */
  plan: PlanCapacity | null;
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
/** Перекос словами: какая метка и в какую сторону. Число - в легенде у метки. */
const skewLabel = computed(() => {
  const s = props.stats.topSkew;
  if (!s) return null;
  return `${s.bucket} ${s.deltaPp > 0 ? 'выше' : 'ниже'} цели`;
});

/** Позиция маркера рекомендуемого плана на полосе, % от объёма спринта. null — не рисуем. */
const planPct = computed(() => {
  if (props.plan == null || props.stats.totalPoints <= 0) return null;
  return Math.min(100, (props.plan.recommended / props.stats.totalPoints) * 100);
});
/** Взято больше рекомендуемого плана — риск не уложиться в целевое выполнение. */
const overPlan = computed(
  () => props.plan != null && props.stats.totalPoints > props.plan.recommended,
);
/** Цель выполнения плана в процентах (80 при переносе до 20%). */
const targetPct = computed(() => Math.round((props.plan?.targetCompletion ?? 0.8) * 100));
/** Подсказка к плану: 2 строки, подробности - на странице отчёта «как посчитано». */
const planTitle = computed(() => {
  const p = props.plan;
  if (!p) return '';
  return (
    `Берите до ${p.recommended} SP: цель - закрыть ${targetPct.value}% взятого в 4 спринтах из 5.\n` +
    `Посчитано по ${p.count} последним спринтам, с риском - до ${p.stretch} SP.`
  );
});

/** Подпись метки в легенде: у задач без CAP-метки своей метки в Jira нет. */
const bucketLabel = (b: CapSlice) => (b === 'Unlabeled' ? 'Без метки' : b);

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
  head: {
    display: 'flex',
    flexWrap: 'wrap' as const,
    alignItems: 'center',
    gap: '2px 8px',
    marginBottom: '4px',
  },
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
  // Маркер рекомендуемого плана — пунктирная вертикаль поверх полосы.
  planMark: (left: number) => ({
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
      <span
        :style="{
          fontWeight: 600,
          color: T.text,
          display: 'inline-flex',
          alignItems: 'center',
          gap: '4px',
        }"
      >
        Capacity
        <InfoTip
          title="Баланс спринта по меткам"
          what="Доли SP спринта по меткам Product, Tech и Support. Пример: в спринте 40 SP, Product 26 - доля 65%."
          read="Чёрная черта - цель Product, пунктир - план на старт. «-19 пп» у метки - доля на 19 процентных пунктов ниже цели, показываем от 5."
          :plan="
            plan
              ? `Взяли больше плана - скорее всего, закроете меньше ${targetPct}% взятого.`
              : undefined
          "
        />
      </span>
      <span :style="{ color: T.subtle, whiteSpace: 'nowrap' }"
        >в спринте {{ stats.totalPoints }} SP</span
      >
      <span
        v-if="plan !== null"
        :style="{
          color: overPlan ? T.danger : T.subtle,
          display: 'inline-flex',
          alignItems: 'center',
          gap: '3px',
          whiteSpace: 'nowrap',
        }"
        :title="planTitle"
      >
        <span
          :style="{ borderLeft: '2px dashed currentColor', height: '9px', display: 'inline-block' }"
        />
        план до {{ plan.recommended }} SP
      </span>
      <span
        v-if="skewLabel"
        :style="{ color: T.danger, fontWeight: 600, whiteSpace: 'nowrap' }"
        :title="`Доля ${stats.topSkew!.bucket} отличается от цели на ${Math.abs(stats.topSkew!.deltaPp)} процентных пунктов, норма - до 5`"
        >⚠ {{ skewLabel }}</span
      >
      <span
        v-else-if="hasData"
        :style="{ color: T.success, whiteSpace: 'nowrap' }"
        title="Доли Product, Tech и Support отличаются от цели меньше чем на 5 процентных пунктов"
        >✓ баланс в норме</span
      >

      <span
        :style="{ display: 'inline-flex', alignItems: 'center', gap: '8px', marginLeft: 'auto' }"
      >
        <span v-if="refreshing" :style="{ color: T.subtlest }">обновляю…</span>
        <span
          v-if="activeBuckets.length"
          :style="{ color: T.subtlest, cursor: 'pointer' }"
          title="Показать на доске все задачи"
          @click="emit('clearAll')"
        >
          ✕ сбросить фильтр
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
        :title="`${bucketLabel(seg.bucket)}: ${seg.points} SP, ${seg.pct}% SP спринта`"
      />
      <div :style="S.target(targetProductPct)" :title="`Цель Product: ${targetProductPct}%`" />
      <div v-if="planPct !== null" :style="S.planMark(planPct)" :title="planTitle" />
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
        {{ bucketLabel(b.bucket) }} {{ b.pct }}%
        <em
          v-if="b.deltaPp !== null && Math.abs(b.deltaPp) >= 5"
          :style="{
            // На активном (залитом) чипе дельта наследует контрастный цвет текста чипа.
            color: isActive(b.bucket) ? 'inherit' : b.deltaPp > 0 ? T.danger : T.information,
            fontStyle: 'normal',
          }"
          :title="`${b.deltaPp > 0 ? 'Выше' : 'Ниже'} цели на ${Math.abs(b.deltaPp)} процентных пунктов`"
        >
          ({{ b.deltaPp > 0 ? '+' : '' }}{{ b.deltaPp }} пп)
        </em>
      </span>
    </div>
  </div>
</template>
