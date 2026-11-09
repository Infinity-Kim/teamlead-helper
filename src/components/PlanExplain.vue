<script lang="ts" setup>
import { computed, nextTick, ref, watch } from 'vue';
import type { PlanExplanation } from '@/core/metrics';
import { backtestChart, type BacktestSeriesKey } from './plan-backtest-chart';
import { simChart } from './plan-explain-chart';

/**
 * «Как посчитан план» - ответ и 5 шагов расчёта на данных одной команды, каждый шаг - 1 фраза
 * и 1 число. Все числа приходят из explainPlan (тот же код, что считает план), страница ничего
 * не пересчитывает - только рисует. Графики - встроенный SVG, числа по наведению - <title>.
 */
const props = defineProps<{
  team: string;
  e: PlanExplanation;
}>();

const p = computed(() => props.e.plan);
const c = computed(() => props.e.constants);
const pct = (x: number) => `${Math.round(x * 100)}%`;
const fmt = (x: number) => (Number.isInteger(x) ? String(x) : x.toFixed(1).replace('.', ','));
/** «4 из 5» из доли 0.8. */
const outOf = (share: number) => {
  for (const d of [5, 10]) {
    const n = share * d;
    if (Math.abs(n - Math.round(n)) < 1e-9) return `${Math.round(n)} из ${d}`;
  }
  return pct(share);
};

const target = computed(() => p.value.targetCompletion);
const carryover = computed(() => Math.round((1 - target.value) * 100));
const inTarget = computed(() => outOf(1 - c.value.tau));
const windowRows = computed(() => props.e.sprints.filter((s) => s.inWindow));
/** Самый свежий спринт окна - пример расчёта на числах команды. */
const last = computed(() => windowRows.value[windowRows.value.length - 1]);
/** Есть спринты, где крупные задачи разнесены по дням работы. */
const hasBigTasks = computed(() => windowRows.value.some((s) => s.work !== s.completed));

// --- Шаг 2: сколько можно было взять в последних спринтах, линия плана ---

const W = 760;
const H = 200;
const PAD = { l: 36, r: 76, t: 12, b: 28 };

const bars = computed(() => {
  const rows = windowRows.value;
  const max = Math.max(...rows.map((r) => r.allowed), p.value.recommended, 1) * 1.08;
  const step = (W - PAD.l - PAD.r) / rows.length;
  const bw = Math.min(48, step * 0.6);
  const y = (v: number) => PAD.t + (H - PAD.t - PAD.b) * (1 - v / max);
  return {
    y,
    ticks: niceTicks(max),
    items: rows.map((r, i) => ({
      ...r,
      x: PAD.l + i * step + (step - bw) / 2,
      w: bw,
      top: y(r.allowed),
      fits: r.allowed >= p.value.recommended,
    })),
  };
});

/** Круглые деления оси: 0, 25, 50… */
function niceTicks(max: number): number[] {
  const raw = max / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = 0; v <= max; v += step) out.push(Math.round(v));
  return out;
}

/** Путь столбика: скругление 4px сверху, квадратное основание. */
function barPath(x: number, top: number, w: number, base: number): string {
  const r = Math.min(4, w / 2, Math.max(0, base - top));
  return `M${x},${base} V${top + r} Q${x},${top} ${x + r},${top} H${x + w - r} Q${x + w},${top} ${x + w},${top + r} V${base} Z`;
}

const shortName = (n: string) => n.replace(/^.*?[-\\]/, '');

// --- Шаг 4: все исходы переигрывания и отметки плана, с риском, в среднем ---

const sim = computed(() => {
  if (!props.e.density.length) return null;
  return simChart({
    density: props.e.density,
    shadeTo: p.value.recommended,
    marks: [
      { v: p.value.recommended, label: `план ${p.value.recommended}`, strong: true },
      { v: p.value.stretch, label: `с риском ${p.value.stretch}`, strong: false },
      { v: props.e.medianSim, label: `в среднем ${fmt(props.e.medianSim)}`, strong: false },
    ],
    dots: windowRows.value.map((r) => ({ name: r.name, v: r.allowed })),
  });
});

const trendLine = computed(() => {
  const t = p.value.trend;
  if (!t?.active) return '';
  const up = t.slope > 0;
  return `Сколько можно взять, ${up ? 'растёт' : 'падает'} на ${fmt(Math.abs(t.slope))} SP за спринт. План догонит за ${c.value.window} спринтов, а пока у плана стоит стрелка ${up ? '↗' : '↘'}.`;
});

// --- Шаг 5: проверка на прошлых спринтах ---

const bt = computed(() => props.e.backtest);

/**
 * Сколько нужно попаданий и что делать с планом - из того же счёта «N из 12», что в ответе.
 * Совет сдвинуть план - только когда попаданий заметно больше или меньше нужного.
 */
const btAction = computed(() => {
  const s = bt.value.summary;
  const goal = `Нужно ${s.targetHits} из ${s.scored}`;
  if (s.verdict === 'under' && s.shift > 0)
    return `${goal}, поэтому план можно поднять на ${fmt(s.shift)} SP.`;
  if (s.verdict === 'over' && s.shift < 0)
    return `${goal}, для этого план стоит снизить на ${fmt(-s.shift)} SP.`;
  if (s.hits === s.targetHits) return 'Столько и нужно.';
  return `${goal}, разница в пределах случайности.`;
});

const btChart = computed(() => (bt.value.scored ? backtestChart(bt.value.rows) : null));
/** Спринт под курсором на графике проверки. */
const btHover = ref<number | null>(null);
const btHoverCol = computed(() =>
  btHover.value === null ? null : (btChart.value?.cols[btHover.value] ?? null),
);
/** Подсказка графика проверки: прокручиваемая обёртка, полотно графика, сама подсказка. */
const btScroll = ref<HTMLElement | null>(null);
const btBox = ref<HTMLElement | null>(null);
const btTip = ref<HTMLElement | null>(null);
const btTipPos = ref({ left: 0, maxW: 320, ready: false });
/**
 * Ставит подсказку у колонки и удерживает её в видимой части графика: на узком экране график
 * шире окна и прокручивается, а подсказка в одну строку длиннее половины графика.
 */
async function placeBtTip() {
  const s = btScroll.value;
  if (!s || btHoverCol.value === null) return;
  const view0 = s.scrollLeft + 4;
  const view1 = s.scrollLeft + s.clientWidth - 4;
  btTipPos.value = { left: 0, maxW: Math.min(320, view1 - view0), ready: false };
  await nextTick();
  const col = btHoverCol.value;
  const chart = btChart.value;
  const box = btBox.value;
  const tip = btTip.value;
  if (!col || !chart || !box || !tip) return;
  const w = tip.offsetWidth;
  const cx = (col.cx / chart.W) * box.clientWidth;
  const left = col.tipSide === 'right' ? cx + 10 : cx - 10 - w;
  btTipPos.value = {
    ...btTipPos.value,
    left: Math.max(view0, Math.min(left, view1 - w)),
    ready: true,
  };
}
watch(btHover, () => void placeBtTip());
const btLineClass: Record<BacktestSeriesKey, string> = {
  allowed: 'pe-stroke-bar pe-line-main',
  plan: 'pe-stroke-model pe-line-main',
  start: 'pe-stroke-fit pe-line-start',
};
const btDotClass: Record<BacktestSeriesKey, string> = {
  allowed: 'pe-fill-bar',
  plan: 'pe-fill-model',
  start: 'pe-fill-fit',
};
</script>

<template>
  <article class="pe space-y-6 pe-text">
    <!-- Ответ: сколько брать и как поднять план -->
    <section class="rounded-lg border pe-border pe-surface p-5">
      <p class="text-xs pe-subtlest">{{ team }} · сколько брать в следующий спринт</p>
      <p class="mt-1 text-5xl font-semibold tabular-nums pe-text">до {{ p.recommended }} SP</p>
      <template v-if="bt.scored">
        <p class="mt-2">
          План, посчитанный так же, выполнили бы в
          <b>{{ bt.summary.hits }} из {{ bt.summary.scored }}</b> прошлых спринтов: закрыли бы не
          меньше {{ pct(target) }} взятого.
        </p>
        <p class="mt-1">{{ btAction }}</p>
      </template>
      <p v-else class="mt-2">
        Тогда команда закроет не меньше <b>{{ pct(target) }}</b> взятого в {{ inTarget }}
        спринтов, даже с задачами, добавленными по ходу.
      </p>
      <p class="mt-1">
        С риском - до <b>{{ p.stretch }} SP</b>, но выполнять такой план будете реже.
      </p>
      <p class="mt-2 text-xs pe-subtle">
        Чтобы план вырос, добавляйте меньше задач по ходу спринта: каждые 10 SP, которые не
        добавили, дают +10 SP к плану.
      </p>
    </section>

    <!-- Шаг 1 -->
    <section class="space-y-2">
      <h3 class="text-base font-semibold pe-text">1. Цель - закрыть {{ pct(target) }} взятого</h3>
      <p>
        Взятое - задачи на старте и добавленные по ходу, а {{ pct(target) }} следует из порога
        переноса {{ carryover }}% в настройках здоровья.
      </p>
    </section>

    <!-- Шаг 2 -->
    <section class="space-y-2">
      <h3 class="text-base font-semibold pe-text">2. Сколько можно было взять на старте</h3>
      <p>
        Спринт {{ last.name }}: закрыли {{ fmt(last.work) }} SP, это {{ pct(target) }} от
        {{ fmt(last.work / target) }} SP; без {{ fmt(last.added) }} SP, добавленных по ходу, на
        старте можно было взять <b>{{ fmt(last.allowed) }} SP</b>.
      </p>
      <p v-if="hasBigTasks" class="text-xs pe-subtle">
        Задачи от {{ c.bigTaskSp }} SP, которые шли несколько спринтов, делим между ними по дням
        работы.
      </p>

      <figure class="overflow-x-auto rounded-lg border pe-border pe-surface p-3">
        <figcaption class="mb-1 flex flex-wrap gap-x-4 text-xs pe-subtle">
          <span
            >{{ windowRows.length }} последних спринтов - примерно квартал в нынешнем составе</span
          >
          <span class="inline-flex items-center gap-1.5">
            <i class="inline-block h-2.5 w-2.5 rounded-sm pe-bg-bar" /> можно было взять не меньше
            {{ p.recommended }} SP
          </span>
          <span class="inline-flex items-center gap-1.5">
            <i class="inline-block h-2.5 w-2.5 rounded-sm pe-bg-muted" /> меньше
            {{ p.recommended }} SP
          </span>
        </figcaption>
        <svg :viewBox="`0 0 ${W} ${H}`" class="w-full min-w-[560px]" role="img">
          <g class="pe-subtlest">
            <g v-for="t in bars.ticks" :key="t">
              <line
                :x1="PAD.l"
                :x2="W - PAD.r"
                :y1="bars.y(t)"
                :y2="bars.y(t)"
                class="pe-stroke-grid"
                stroke-width="1"
              />
              <text
                :x="PAD.l - 6"
                :y="bars.y(t) + 3"
                text-anchor="end"
                class="fill-current text-[10px]"
              >
                {{ t }}
              </text>
            </g>
          </g>
          <path
            v-for="b in bars.items"
            :key="b.name"
            :d="barPath(b.x, b.top, b.w, bars.y(0))"
            :class="b.fits ? 'pe-fill-bar' : 'pe-fill-muted'"
          >
            <title>
              {{ b.name }}: закрыли {{ fmt(b.work) }}, добавили по ходу {{ fmt(b.added) }}, можно
              было взять {{ fmt(b.allowed) }} SP
            </title>
          </path>
          <text
            v-for="b in bars.items"
            :key="'l' + b.name"
            :x="b.x + b.w / 2"
            :y="H - PAD.b + 16"
            text-anchor="middle"
            class="pe-fill-subtlest text-[10px]"
          >
            {{ shortName(b.name) }}
          </text>
          <line
            :x1="PAD.l"
            :x2="W - PAD.r"
            :y1="bars.y(p.recommended)"
            :y2="bars.y(p.recommended)"
            class="pe-stroke-text"
            stroke-width="2"
          />
          <text
            :x="W - PAD.r + 6"
            :y="bars.y(p.recommended) + 4"
            class="pe-fill-text text-[11px] font-semibold"
          >
            план {{ p.recommended }}
          </text>
        </svg>
      </figure>
    </section>

    <!-- Шаг 3 -->
    <section class="space-y-2">
      <h3 class="text-base font-semibold pe-text">3. Почему не среднее</h3>
      <p>
        В среднем можно взять <b>{{ fmt(e.medianSim) }} SP</b>, но с таким планом спринт уложится
        только в половине случаев.
      </p>
    </section>

    <!-- Шаг 4 -->
    <section class="space-y-2">
      <h3 class="text-base font-semibold pe-text">
        4. План - граница {{ pct(c.tau) }} худших исходов
      </h3>
      <p>
        Переигрываем {{ c.window }} спринтов с небольшими сдвигами: в {{ pct(1 - c.tau) }} исходов
        можно взять больше <b>{{ p.recommended }} SP</b>.
      </p>
      <figure v-if="sim" class="overflow-x-auto rounded-lg border pe-border pe-surface p-3">
        <figcaption class="mb-1 flex flex-wrap gap-x-4 text-xs pe-subtle">
          <span>Чем выше кривая, тем чаще исход</span>
          <span class="inline-flex items-center gap-1.5">
            <i class="inline-block h-2.5 w-2.5 rounded-sm pe-bg-muted" /> {{ pct(c.tau) }} исходов,
            где можно взять меньше {{ p.recommended }} SP
          </span>
          <span class="inline-flex items-center gap-1.5">
            <i class="inline-block h-2.5 w-2.5 rounded-full pe-bg-bar" />
            {{ windowRows.length }} последних спринтов
          </span>
        </figcaption>
        <svg :viewBox="`0 0 ${sim.W} ${sim.H}`" class="w-full min-w-[560px]" role="img">
          <g class="pe-subtlest">
            <g v-for="t in sim.xTicks" :key="'x' + t">
              <line
                :x1="sim.x(t)"
                :x2="sim.x(t)"
                :y1="sim.base"
                :y2="sim.base + 4"
                class="pe-stroke-subtlest"
                stroke-width="1"
              />
              <text
                :x="sim.x(t)"
                :y="sim.xTickY"
                text-anchor="middle"
                class="fill-current text-[10px]"
              >
                {{ t }}
              </text>
            </g>
            <text
              :x="sim.xTitle.x"
              :y="sim.xTitle.y"
              text-anchor="middle"
              class="fill-current text-[11px]"
            >
              SP, которые можно взять на старте следующего спринта
            </text>
          </g>
          <path :d="sim.area" class="pe-fill-muted" />
          <path
            :d="sim.line"
            class="pe-stroke-bar"
            stroke-width="2"
            fill="none"
            stroke-linejoin="round"
          />
          <line
            :x1="sim.plotL"
            :x2="sim.plotR"
            :y1="sim.base"
            :y2="sim.base"
            class="pe-stroke-subtlest"
            stroke-width="1"
          />
          <g v-for="m in sim.marks" :key="m.label">
            <line
              :x1="m.x"
              :x2="m.x"
              :y1="m.lineTop"
              :y2="sim.base"
              :class="m.strong ? 'pe-stroke-text' : 'pe-stroke-subtlest'"
              :stroke-width="m.strong ? 2 : 1"
              :stroke-dasharray="m.strong ? undefined : '3 3'"
            />
            <text
              :x="m.tx"
              :y="m.ty"
              :text-anchor="m.anchor"
              :class="m.strong ? 'pe-fill-text font-semibold' : 'pe-fill-subtle'"
              class="text-[11px]"
            >
              {{ m.label }}
            </text>
          </g>
          <circle
            v-for="d in sim.dots"
            :key="d.name"
            :cx="d.cx"
            :cy="d.cy"
            :r="4.5"
            class="pe-fill-bar pe-stroke-surface"
            stroke-width="2"
          >
            <title>{{ d.name }}: можно было взять {{ fmt(d.v) }} SP</title>
          </circle>
        </svg>
      </figure>
      <p v-else class="text-xs pe-subtle">
        Во всех {{ windowRows.length }} спринтах можно было взять одинаково: план равен этому числу.
      </p>
      <p v-if="trendLine" class="text-xs pe-subtle">{{ trendLine }}</p>
    </section>

    <!-- Шаг 5 -->
    <section class="space-y-2">
      <h3 class="text-base font-semibold pe-text">5. Проверка на прошлых спринтах</h3>
      <p v-if="!bt.scored">Проверить пока не на чем: нужно хотя бы {{ c.window + 1 }} спринтов.</p>
      <template v-else>
        <p>
          Откуда «{{ bt.summary.hits }} из {{ bt.summary.scored }}» в ответе: план считаем на старте
          каждого из {{ bt.summary.scored }} прошлых спринтов только по {{ c.window }} спринтам до
          него.
        </p>
        <figure v-if="btChart" class="rounded-lg border pe-border pe-surface p-3">
          <figcaption class="mb-1 flex flex-wrap gap-x-4 text-xs pe-subtle">
            <span>Синяя линия выше оранжевой - план выполнили. Наведите на спринт.</span>
            <span v-for="s in btChart.series" :key="s.key" class="inline-flex items-center gap-1.5">
              <svg width="18" height="6" aria-hidden="true">
                <line x1="0" x2="18" y1="3" y2="3" :class="btLineClass[s.key]" />
              </svg>
              {{ s.label }}
            </span>
          </figcaption>
          <div ref="btScroll" class="overflow-x-auto" @scroll="placeBtTip">
            <div ref="btBox" class="relative min-w-[560px]">
              <svg
                :viewBox="`0 0 ${btChart.W} ${btChart.H}`"
                class="block w-full"
                role="img"
                :aria-label="`${team}: план модели и сколько можно было взять по спринтам`"
                @mouseleave="btHover = null"
              >
                <rect
                  v-if="btHoverCol"
                  :x="btHoverCol.x0"
                  :y="btChart.plotT"
                  :width="btHoverCol.width"
                  :height="btChart.base - btChart.plotT"
                  class="pe-fill-muted"
                  opacity="0.5"
                />
                <g class="pe-subtlest">
                  <g v-for="t in btChart.yTicks" :key="t">
                    <line
                      :x1="btChart.plotL"
                      :x2="btChart.plotR"
                      :y1="btChart.y(t)"
                      :y2="btChart.y(t)"
                      class="pe-stroke-grid"
                      stroke-width="1"
                    />
                    <text
                      :x="btChart.plotL - 6"
                      :y="btChart.y(t) + 3"
                      text-anchor="end"
                      class="fill-current text-[10px]"
                    >
                      {{ t }}
                    </text>
                  </g>
                  <text
                    v-for="l in btChart.xLabels"
                    :key="l.text"
                    :x="l.x"
                    :y="btChart.xLabelY"
                    text-anchor="middle"
                    class="fill-current text-[10px]"
                  >
                    {{ l.text }}
                  </text>
                </g>
                <path
                  v-for="s in btChart.series"
                  :key="s.key"
                  :d="s.line"
                  fill="none"
                  stroke-linejoin="round"
                  stroke-linecap="round"
                  :class="btLineClass[s.key]"
                />
                <text
                  v-for="l in btChart.ends"
                  :key="l.key"
                  :x="l.box.x0"
                  :y="l.y"
                  class="pe-fill-subtle text-[11px]"
                >
                  {{ l.text }}
                </text>
                <g v-if="btHoverCol">
                  <circle
                    v-for="d in btHoverCol.points"
                    :key="d.key"
                    :cx="btHoverCol.cx"
                    :cy="d.cy"
                    r="4"
                    :class="btDotClass[d.key]"
                    class="pe-stroke-surface"
                    stroke-width="2"
                  />
                </g>
                <rect
                  v-for="(col, k) in btChart.cols"
                  :key="col.name"
                  :x="col.x0"
                  :y="btChart.plotT"
                  :width="col.width"
                  :height="btChart.base - btChart.plotT"
                  fill="transparent"
                  @mouseenter="btHover = k"
                />
              </svg>
              <p
                v-if="btHoverCol"
                ref="btTip"
                class="pointer-events-none absolute top-1 w-max rounded border pe-border pe-surface px-2 py-1 text-xs pe-text shadow-sm"
                :style="{
                  left: `${btTipPos.left}px`,
                  maxWidth: `${btTipPos.maxW}px`,
                  visibility: btTipPos.ready ? 'visible' : 'hidden',
                }"
              >
                {{ btHoverCol.tip }}
              </p>
            </div>
          </div>
        </figure>
      </template>
    </section>
  </article>
</template>

<style scoped>
/*
 * Цвета и шрифт - токены Atlassian Design System (как в Jira и в виджетах CapBar/QuarterBar,
 * см. ads-tokens.ts). Внутри Jira берутся живые var(--ds-*); на странице расширения их нет -
 * тогда значения темы atlassian-light, а в тёмной системной теме - atlassian-dark.
 */
.pe {
  --pe-text: var(--ds-text, #292a2e);
  --pe-subtle: var(--ds-text-subtle, #505258);
  --pe-subtlest: var(--ds-text-subtlest, #6b6e76);
  --pe-surface: var(--ds-surface, #ffffff);
  --pe-sunken: var(--ds-surface-sunken, #f8f8f8);
  --pe-border: var(--ds-border, #0b120e24);
  --pe-grid: var(--ds-border, #0b120e24);
  /* Синий данных - background.information.bold, как бакет Tech и chart.brand в Jira. */
  --pe-bar: var(--ds-background-information-bold, #1868db);
  --pe-muted: var(--ds-background-accent-gray-subtler, #dddee1);
  --pe-fit: var(--ds-background-neutral-bold, #8590a2);
  --pe-link: var(--ds-link, #1868db);
  /* Оранжевый «план модели» на графике проверки - chart.orange.bold. */
  --pe-model: var(--ds-chart-orange-bold, #e06c00);
  font-family: var(
    --ds-font-family-body,
    'Atlassian Sans',
    ui-sans-serif,
    -apple-system,
    BlinkMacSystemFont,
    'Segoe UI',
    Ubuntu,
    'Helvetica Neue',
    sans-serif
  );
  font-size: 14px;
  line-height: 20px;
}
@media (prefers-color-scheme: dark) {
  .pe {
    --pe-text: #cecfd2;
    --pe-subtle: #a9abaf;
    --pe-subtlest: #96999e;
    --pe-surface: #1f1f21;
    --pe-sunken: #18191a;
    --pe-border: #e3e4f21f;
    --pe-grid: #e3e4f21f;
    --pe-bar: #669df1;
    --pe-muted: #4b4d51;
    --pe-fit: #7e8188;
    --pe-link: #669df1;
    --pe-model: #ec7a1c;
  }
}
.pe h3 {
  font-size: 16px;
  line-height: 20px;
  font-weight: 653;
}
.pe-text {
  color: var(--pe-text);
}
.pe-subtle {
  color: var(--pe-subtle);
}
.pe-subtlest {
  color: var(--pe-subtlest);
}
.pe-surface {
  background-color: var(--pe-surface);
}
.pe-sunken {
  background-color: var(--pe-sunken);
}
.pe-border {
  border-color: var(--pe-border);
}
.pe-bg-bar {
  background-color: var(--pe-bar);
}
.pe-bg-muted {
  background-color: var(--pe-muted);
}
.pe-fill-bar {
  fill: var(--pe-bar);
}
.pe-fill-muted {
  fill: var(--pe-muted);
}
.pe-fill-text {
  fill: var(--pe-text);
}
.pe-fill-subtle {
  fill: var(--pe-subtle);
}
.pe-fill-subtlest {
  fill: var(--pe-subtlest);
}
.pe-stroke-bar {
  stroke: var(--pe-bar);
}
.pe-stroke-text {
  stroke: var(--pe-text);
}
.pe-stroke-grid {
  stroke: var(--pe-grid);
}
.pe-stroke-subtlest {
  stroke: var(--pe-subtlest);
}
.pe-stroke-fit {
  stroke: var(--pe-fit);
}
.pe-stroke-surface {
  stroke: var(--pe-surface);
}
.pe-stroke-model {
  stroke: var(--pe-model);
}
.pe-fill-model {
  fill: var(--pe-model);
}
.pe-fill-fit {
  fill: var(--pe-fit);
}
.pe-line-main {
  stroke-width: 2px;
}
.pe-line-start {
  stroke-width: 1.5px;
  stroke-dasharray: 4 3;
}
.pe a {
  color: var(--pe-link);
}
</style>
