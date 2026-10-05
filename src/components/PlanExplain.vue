<script lang="ts" setup>
import { computed } from 'vue';
import type { PlanExplanation } from '@/core/metrics';

/**
 * «Как посчитан план» — разбор рекомендации по шагам на данных одной команды. Все числа
 * приходят из explainPlan (тот же код, что считает план), страница ничего не пересчитывает
 * своими формулами — только рисует. Графики — встроенный SVG, подсказки по наведению — <title>.
 */
const props = defineProps<{
  team: string;
  e: PlanExplanation;
}>();

const p = computed(() => props.e.plan);
const c = computed(() => props.e.constants);
const pct = (x: number) => `${Math.round(x * 100)}%`;
const fmt = (x: number) => (Number.isInteger(x) ? String(x) : x.toFixed(1));
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
const inStretch = computed(() => outOf(1 - c.value.stretchTau));

// --- График 1: допустимый план по спринтам (столбики) + линии рекомендации и медианы ---

const W = 760;
const H = 220;
const PAD = { l: 36, r: 120, t: 12, b: 36 };

const bars = computed(() => {
  const rows = props.e.sprints;
  const max = Math.max(...rows.map((r) => r.allowed), p.value.recommended, 1) * 1.08;
  const step = (W - PAD.l - PAD.r) / rows.length;
  const bw = Math.min(24, step - 2);
  const y = (v: number) => PAD.t + (H - PAD.t - PAD.b) * (1 - v / max);
  return {
    max,
    y,
    ticks: niceTicks(max),
    items: rows.map((r, i) => ({
      ...r,
      x: PAD.l + i * step + (step - bw) / 2,
      w: bw,
      top: y(r.allowed),
      ok: r.allowed >= p.value.recommended,
      label: i === 0 || i === rows.length - 1 || i % Math.ceil(rows.length / 8) === 0,
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

// --- График 2: все допустимые планы по возрастанию, отмечены 20% / 30% / медиана ---

const strip = computed(() => {
  const sorted = [...props.e.sprints].sort((a, b) => a.allowed - b.allowed);
  const max = Math.max(...sorted.map((r) => r.allowed), 1);
  const x = (v: number) => 24 + (W - 48) * (v / max);
  return {
    x,
    dots: sorted.map((r, i) => ({ ...r, cx: x(r.allowed), cy: 46 + (i % 3) * 10 })),
    marks: [
      { v: props.e.q20, label: `нижние ${pct(c.value.tau)}`, strong: true },
      { v: props.e.q30, label: `нижние ${pct(c.value.stretchTau)}`, strong: false },
      { v: props.e.medianAllowed, label: 'медиана', strong: false },
    ],
  };
});

// --- График 3: тренд допустимого плана за последние спринты + линия Тейла–Сена ---

const trend = computed(() => {
  const t = props.e.trendLine;
  if (!t) return null;
  const n = t.values.length;
  const fitAt = (i: number) => t.intercept + t.slope * i;
  const lo = Math.min(...t.values, fitAt(0), fitAt(n - 1)) * 0.9;
  const hi = Math.max(...t.values, fitAt(0), fitAt(n - 1)) * 1.08;
  const x = (i: number) => PAD.l + ((W - PAD.l - PAD.r) * i) / Math.max(1, n - 1);
  const y = (v: number) => PAD.t + (H - PAD.t - PAD.b) * (1 - (v - lo) / (hi - lo || 1));
  return {
    x,
    y,
    ticks: niceTicks(hi).filter((v) => v >= lo),
    line: t.values.map((v, i) => `${i ? 'L' : 'M'}${x(i)},${y(v)}`).join(' '),
    fit: `M${x(0)},${y(fitAt(0))} L${x(n - 1)},${y(fitAt(n - 1))}`,
    points: t.values.map((v, i) => ({ v, name: t.names[i], cx: x(i), cy: y(v) })),
    fitEnd: { cx: x(n - 1), cy: y(fitAt(n - 1)) },
  };
});

const trendVerdict = computed(() => {
  const t = p.value.trend;
  if (!t) return 'Истории мало, чтобы проверять тренд — прогноз опирается на уровень.';
  if (!t.active) {
    return `Устойчивого тренда нет (Z = ${fmt(t.z)}, порог ±${c.value.trendZ}): колебания похожи на шум, прогноз опирается на уровень.`;
  }
  const dir = t.slope > 0 ? 'растёт' : 'снижается';
  return `Допустимый план ${dir} ≈ на ${fmt(Math.abs(t.slope))} SP за спринт (Z = ${fmt(t.z)}, порог ±${c.value.trendZ}) — модели с трендом учитывают это в прогнозе.`;
});

// --- Модели смеси ---

const models = computed(() => [...props.e.models].sort((a, b) => b.weight - a.weight));
const maxWeight = computed(() => Math.max(...props.e.models.map((m) => m.weight), 0.01));
const modelHint: Record<string, string> = {
  уровень: 'нижние 20% за последние N спринтов — «команда стабильна, помним N спринтов»',
  забывание: 'то же, но старые спринты весят меньше: вес вдвое меньше каждые N спринтов',
  тренд: 'если рост/спад значим — продлеваем линию Тейла–Сена на шаг, иначе как «уровень»',
};
const hintOf = (name: string) => modelHint[name.split(' ')[0]] ?? '';

const bt = computed(() => props.e.backtest);
</script>

<template>
  <article class="pe space-y-6 pe-text">
    <!-- Итог -->
    <section class="rounded-lg border pe-border pe-surface p-5">
      <p class="text-xs pe-subtlest">{{ team }} · план на старт спринта</p>
      <p class="mt-1 text-5xl font-semibold tabular-nums pe-text">≤ {{ p.recommended }} SP</p>
      <p class="mt-2">
        Столько брать в спринт на планировании, чтобы закрыть не меньше
        <b>{{ pct(target) }}</b> взятого с учётом задач, которые прилетят по ходу. Это план
        <b>с вызовом</b>: модель целится в {{ inTarget }} спринтов, а на истории команды
        <template v-if="bt.scored">
          уложилась бы в цель в <b>{{ bt.hitsPlan }} из {{ bt.scored }}</b> ({{
            pct(bt.hitsPlan / bt.scored)
          }}).
        </template>
        <template v-else>пока проверить не на чем.</template>
        Если готовы рискнуть ещё — до <b>{{ p.stretch }} SP</b>.
      </p>
      <p class="mt-2 text-xs pe-subtle">
        Посчитано по {{ p.count }} закрытым спринтам с Q4 2025 (с появления CAP-меток). Для
        сравнения: медиана закрытого за последние 18 — {{ fmt(p.medianCompleted) }} SP, медиана
        прилётов — {{ fmt(p.medianAdded) }} SP.
      </p>
    </section>

    <!-- Шаг 1 -->
    <section class="space-y-2">
      <h3 class="text-base font-semibold pe-text">1. Цель: закрыть ≥ {{ pct(target) }} взятого</h3>
      <p>
        Это договорённость команды, а не константа: порог переноса в настройках здоровья —
        {{ carryover }}%. Перенос ≤ {{ carryover }}% ⇔ выполнение ≥ {{ pct(target) }}. Поменяете
        порог — поменяется и план.
      </p>
      <p class="rounded pe-sunken px-3 py-2 font-mono text-xs">
        выполнение = закрыто ÷ (взяли на старте + прилёты) ≥ {{ target }}
      </p>
    </section>

    <!-- Шаг 2 -->
    <section class="space-y-2">
      <h3 class="text-base font-semibold pe-text">
        2. Сколько можно было взять в каждом прошлом спринте
      </h3>
      <p>
        Переворачиваем формулу цели: для каждого закрытого спринта считаем, сколько можно было взять
        на старте, чтобы при фактически закрытом и фактических прилётах ровно уложиться в
        {{ pct(target) }}. Прилёты вычитаем — на планировании их ещё нет, под них надо оставить
        место.
      </p>
      <p class="rounded pe-sunken px-3 py-2 font-mono text-xs">
        допустимый план = закрыто ÷ {{ target }} − прилёты
      </p>
      <p class="text-xs pe-subtle">
        Пример — первый спринт истории {{ e.sprints[0].name }}: {{ fmt(e.sprints[0].completed) }} ÷
        {{ target }} − {{ fmt(e.sprints[0].added) }} = {{ fmt(e.sprints[0].allowed) }} SP.
      </p>

      <figure class="overflow-x-auto rounded-lg border pe-border pe-surface p-3">
        <figcaption class="mb-1 flex flex-wrap gap-x-4 text-xs pe-subtle">
          <span>Допустимый план по спринтам, SP</span>
          <span class="inline-flex items-center gap-1.5">
            <i class="inline-block h-2.5 w-2.5 rounded-sm pe-bg-bar" /> план ≤
            {{ p.recommended }} уложился бы
          </span>
          <span class="inline-flex items-center gap-1.5">
            <i class="inline-block h-2.5 w-2.5 rounded-sm pe-bg-muted" /> не уложился бы
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
            :class="b.ok ? 'pe-fill-bar' : 'pe-fill-muted'"
          >
            <title>
              {{ b.name }}: закрыто {{ fmt(b.completed) }}, прилёты {{ fmt(b.added) }} → допустимый
              план {{ fmt(b.allowed) }} SP
            </title>
          </path>
          <g v-for="b in bars.items" :key="'l' + b.name">
            <text
              v-if="b.label"
              :x="b.x + b.w / 2"
              :y="H - PAD.b + 14"
              text-anchor="middle"
              class="pe-fill-subtlest text-[10px]"
            >
              {{ shortName(b.name) }}
            </text>
          </g>
          <!-- Линии: рекомендация и медиана -->
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
          <line
            :x1="PAD.l"
            :x2="W - PAD.r"
            :y1="bars.y(e.medianAllowed)"
            :y2="bars.y(e.medianAllowed)"
            class="pe-stroke-subtlest"
            stroke-width="1"
          />
          <text
            :x="W - PAD.r + 6"
            :y="bars.y(e.medianAllowed) + 4"
            class="pe-fill-subtle text-[11px]"
          >
            медиана {{ fmt(e.medianAllowed) }}
          </text>
        </svg>
      </figure>

      <details class="text-xs">
        <summary class="cursor-pointer pe-subtle">Таблица по спринтам</summary>
        <table class="mt-2 w-full tabular-nums">
          <thead class="text-left pe-subtlest">
            <tr>
              <th class="py-1 font-normal">спринт</th>
              <th class="font-normal">закрыто</th>
              <th class="font-normal">прилёты</th>
              <th class="font-normal">допустимый план</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in [...e.sprints].reverse()" :key="r.name" class="border-t pe-border">
              <td class="py-1">{{ r.name }}</td>
              <td>{{ fmt(r.completed) }}</td>
              <td>{{ fmt(r.added) }}</td>
              <td>{{ fmt(r.allowed) }}</td>
            </tr>
          </tbody>
        </table>
      </details>
    </section>

    <!-- Шаг 3 -->
    <section class="space-y-2">
      <h3 class="text-base font-semibold pe-text">
        3. Почему нижние {{ pct(c.tau) }}, а не медиана
      </h3>
      <p>
        Допустимый план от спринта к спринту гуляет. Если взять медиану, план будет больше
        допустимого в каждом втором спринте. Если минимум — один провальный спринт обрушит план.
        Берём <b>нижний квантиль {{ pct(c.tau) }}</b
        >: план, который был допустим в {{ inTarget }} спринтов. «Вызов» — квантиль
        {{ pct(c.stretchTau) }} (≈ {{ inStretch }}).
      </p>
      <figure class="overflow-x-auto rounded-lg border pe-border pe-surface p-3">
        <figcaption class="mb-1 text-xs pe-subtle">
          Все допустимые планы по возрастанию (каждая точка — спринт), SP
        </figcaption>
        <svg :viewBox="`0 0 ${W} 110`" class="w-full min-w-[560px]" role="img">
          <line x1="24" :x2="W - 24" y1="86" y2="86" class="pe-stroke-grid" stroke-width="1" />
          <g v-for="m in strip.marks" :key="m.label">
            <line
              :x1="strip.x(m.v)"
              :x2="strip.x(m.v)"
              y1="20"
              y2="86"
              :class="m.strong ? 'pe-stroke-text' : 'pe-stroke-subtlest'"
              :stroke-width="m.strong ? 2 : 1"
            />
            <text
              :x="strip.x(m.v)"
              :y="m.label === 'медиана' ? 104 : 14"
              text-anchor="middle"
              :class="m.strong ? 'pe-fill-text font-semibold ' : 'pe-fill-subtle'"
              class="text-[11px]"
            >
              {{ m.label }} · {{ fmt(m.v) }}
            </text>
          </g>
          <circle
            v-for="d in strip.dots"
            :key="d.name"
            :cx="d.cx"
            :cy="d.cy"
            r="4.5"
            class="pe-fill-bar pe-stroke-surface"
            stroke-width="2"
          >
            <title>{{ d.name }}: допустимый план {{ fmt(d.allowed) }} SP</title>
          </circle>
        </svg>
      </figure>
      <p class="text-xs pe-subtle">
        Простые квантили по всей истории ({{ fmt(e.q20) }} / {{ fmt(e.q30) }}) — для наглядности.
        Итоговый план {{ p.recommended }} считает смесь моделей из шага 5: она учитывает, что свежие
        спринты важнее старых и что команда может расти.
      </p>

      <div class="rounded-lg border pe-border pe-surface p-3">
        <p class="font-medium pe-text">Проверка на истории команды</p>
        <p class="mt-1">
          Для каждого из последних {{ bt.scored }} спринтов план пересчитан
          <b>только по спринтам до него</b> — как если бы мы планировали тогда — и сравнён с тем,
          что было допустимо:
        </p>
        <ul class="mt-1 list-disc pl-5">
          <li>
            рекомендация уложилась бы в цель в <b>{{ bt.hitsPlan }} из {{ bt.scored }}</b> спринтов
            ({{ pct(bt.hitsPlan / bt.scored) }});
          </li>
          <li>
            медиана закрытого за {{ c.velocityWindow }} спринтов (прежняя «velocity») — в
            <b>{{ bt.hitsMedian }} из {{ bt.scored }}</b> ({{ pct(bt.hitsMedian / bt.scored) }}).
          </li>
        </ul>
        <p class="mt-1 text-xs pe-subtle">
          Ориентир — {{ inTarget }} ({{ pct(1 - c.tau) }}). На коротком ряду в один-два спринта
          разница случайна; числа показаны как есть, без подгонки.
        </p>
        <details class="mt-2 text-xs">
          <summary class="cursor-pointer pe-subtle">По спринтам</summary>
          <table class="mt-2 w-full tabular-nums">
            <thead class="text-left pe-subtlest">
              <tr>
                <th class="py-1 font-normal">спринт</th>
                <th class="font-normal">рекомендация</th>
                <th class="font-normal">медиана закрытого</th>
                <th class="font-normal">было допустимо</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in [...bt.rows].reverse()" :key="r.name" class="border-t pe-border">
                <td class="py-1">{{ r.name }}</td>
                <td>{{ r.plan }} {{ r.plan <= r.allowed ? '✓' : '✗' }}</td>
                <td>{{ fmt(r.median) }} {{ r.median <= r.allowed ? '✓' : '✗' }}</td>
                <td>{{ fmt(r.allowed) }}</td>
              </tr>
            </tbody>
          </table>
        </details>
      </div>
    </section>

    <!-- Шаг 4 -->
    <section class="space-y-2">
      <h3 class="text-base font-semibold pe-text">4. Растёт ли команда</h3>
      <p>
        Проверяем последние {{ c.trendWindow }} спринтов тестом <b>Манна–Кендалла</b>: для каждой
        пары спринтов смотрим, стал ли поздний больше раннего. Если «больше» заметно перевешивает
        «меньше» (|Z| ≥ {{ c.trendZ }}, это ≈ 90% уверенности), рост неслучаен. Наклон считаем
        линией <b>Тейла–Сена</b> — медиана наклонов всех пар, один выброс её не сдвигает.
      </p>
      <p class="font-medium">{{ trendVerdict }}</p>
      <figure v-if="trend" class="overflow-x-auto rounded-lg border pe-border pe-surface p-3">
        <figcaption class="mb-1 flex flex-wrap gap-x-4 text-xs pe-subtle">
          <span>Допустимый план, последние {{ c.trendWindow }} спринтов, SP</span>
          <span class="inline-flex items-center gap-1.5"
            ><i class="inline-block h-0.5 w-4 pe-bg-bar" /> факт</span
          >
          <span class="inline-flex items-center gap-1.5"
            ><i class="inline-block h-0.5 w-4 pe-bg-fit" /> линия Тейла–Сена</span
          >
        </figcaption>
        <svg :viewBox="`0 0 ${W} ${H}`" class="w-full min-w-[560px]" role="img">
          <g v-for="t in trend.ticks" :key="t">
            <line
              :x1="PAD.l"
              :x2="W - PAD.r"
              :y1="trend.y(t)"
              :y2="trend.y(t)"
              class="pe-stroke-grid"
              stroke-width="1"
            />
            <text
              :x="PAD.l - 6"
              :y="trend.y(t) + 3"
              text-anchor="end"
              class="pe-fill-subtlest text-[10px]"
            >
              {{ t }}
            </text>
          </g>
          <path
            :d="trend.fit"
            class="pe-stroke-fit"
            stroke-width="2"
            fill="none"
            stroke-linecap="round"
          />
          <path
            :d="trend.line"
            class="pe-stroke-bar"
            stroke-width="2"
            fill="none"
            stroke-linejoin="round"
            stroke-linecap="round"
          />
          <circle
            v-for="pt in trend.points"
            :key="pt.name"
            :cx="pt.cx"
            :cy="pt.cy"
            r="4"
            class="pe-fill-bar pe-stroke-surface"
            stroke-width="2"
          >
            <title>{{ pt.name }}: {{ fmt(pt.v) }} SP</title>
          </circle>
          <text
            :x="trend.fitEnd.cx + 8"
            :y="trend.fitEnd.cy + 4"
            class="pe-fill-subtle text-[11px]"
          >
            {{ p.trend && p.trend.slope >= 0 ? '+' : '' }}{{ fmt(p.trend?.slope ?? 0) }} SP/спр.
          </text>
          <g v-for="(pt, i) in trend.points" :key="'n' + pt.name">
            <text
              v-if="i % 2 === 0 || i === trend.points.length - 1"
              :x="pt.cx"
              :y="H - PAD.b + 14"
              text-anchor="middle"
              class="pe-fill-subtlest text-[10px]"
            >
              {{ shortName(pt.name) }}
            </text>
          </g>
        </svg>
      </figure>
    </section>

    <!-- Шаг 5 -->
    <section class="space-y-2">
      <h3 class="text-base font-semibold pe-text">5. Смесь моделей: какая память у команды</h3>
      <p>
        Неизвестно заранее, сколько спринтов «помнить»: у команд меняется состав и режим. Поэтому
        {{ e.models.length || 11 }} моделей с разной памятью делают прогноз, и каждую проверяем на
        последних {{ c.hedgeLookback }} спринтах — как будто планировали тогда. Ошибка —
        <b>pinball-loss</b>: перелёт (взяли больше допустимого) штрафуется в
        {{ fmt((1 - c.tau) / c.tau) }} раза сильнее недолёта, потому что перенос дороже недогруза.
        Вес модели — <b>e<sup>−(ошибка − лучшая ошибка)</sup></b> (метод Hedge): на 1 SP хуже лучшей
        — вес в e ≈ 2.7 раза меньше. План — взвешенная сумма прогнозов, округлённая вниз.
      </p>
      <p v-if="!models.length" class="text-xs pe-subtle">
        Истории пока мало для честной проверки моделей — работает одна запасная модель (тренд по 12
        / уровень по 18 спринтам).
      </p>
      <div v-else class="overflow-x-auto rounded-lg border pe-border pe-surface p-3">
        <table class="w-full text-xs tabular-nums">
          <thead class="text-left pe-subtlest">
            <tr>
              <th class="py-1 font-normal">модель</th>
              <th class="font-normal">прогноз, SP</th>
              <th class="font-normal">ошибка, SP</th>
              <th class="w-1/3 font-normal">вес в плане</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="m in models"
              :key="m.model"
              class="border-t pe-border"
              :title="hintOf(m.model)"
            >
              <td class="py-1.5 pr-2">{{ m.model }}</td>
              <td>{{ fmt(m.forecast) }}</td>
              <td>{{ fmt(m.loss) }}</td>
              <td>
                <div class="flex items-center gap-2">
                  <div
                    class="h-2.5 rounded-r pe-bg-bar"
                    :style="{ width: `${(m.weight / maxWeight) * 80}%` }"
                  />
                  <span>{{ pct(m.weight) }}</span>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
        <ul class="mt-2 space-y-0.5 text-xs pe-subtle">
          <li><b>уровень N</b> — {{ modelHint['уровень'] }}.</li>
          <li><b>забывание ½ за N</b> — {{ modelHint['забывание'] }}.</li>
          <li><b>тренд N / уровень M</b> — {{ modelHint['тренд'] }}.</li>
        </ul>
      </div>
    </section>

    <!-- Шаг 6 -->
    <section class="space-y-2">
      <h3 class="text-base font-semibold pe-text">6. Итог</h3>
      <p>
        План <b>≤ {{ p.recommended }} SP</b> — взвешенный прогноз нижних
        {{ pct(c.tau) }} допустимого плана на следующий спринт, вниз до целого (лишний SP сверху —
        уже выход за цель в пограничном спринте). «Вызов» <b>{{ p.stretch }} SP</b> — та же смесь
        для {{ pct(c.stretchTau) }}. Ни одного ручного параметра под команду: окна, тренд и веса
        выбирают её же данные, и при смене режима (найм, уход, другой тип задач) вес сам перетечёт к
        моделям, которые угадывают лучше.
      </p>
    </section>

    <!-- Словарь -->
    <section class="space-y-2 rounded-lg border pe-border pe-surface p-4 text-xs">
      <h3 class="text-sm font-semibold pe-text">Словарь</h3>
      <dl class="grid gap-x-4 gap-y-1.5 sm:grid-cols-[10rem_1fr]">
        <dt class="font-medium">Прилёты</dt>
        <dd>
          задачи, добавленные в спринт после старта и оставшиеся в нём (закрытые или перенесённые).
        </dd>
        <dt class="font-medium">Допустимый план</dt>
        <dd>сколько можно было взять на старте, чтобы спринт ровно уложился в цель выполнения.</dd>
        <dt class="font-medium">Квантиль 20%</dt>
        <dd>
          значение, ниже которого 20% наблюдений. План на нём допустим примерно в 80% спринтов.
        </dd>
        <dt class="font-medium">Pinball-loss</dt>
        <dd>
          ошибка прогноза квантиля: недолёт × 0.2, перелёт × 0.8. Минимальна ровно у правильного
          квантиля.
        </dd>
        <dt class="font-medium">Hedge</dt>
        <dd>
          смешивание прогнозов с весами, экспоненциально убывающими по ошибке; гарантирует, что
          смесь не сильно хуже лучшей модели.
        </dd>
        <dt class="font-medium">Манн–Кендалл</dt>
        <dd>
          ранговый тест на монотонный тренд: не требует нормальности, выбросы на него почти не
          влияют.
        </dd>
        <dt class="font-medium">Тейл–Сен</dt>
        <dd>
          робастная прямая: наклон = медиана наклонов всех пар точек, выдерживает до ~29% выбросов.
        </dd>
      </dl>
      <h3 class="pt-2 text-sm font-semibold pe-text">Литература</h3>
      <ul class="list-disc space-y-0.5 pl-5">
        <li>
          Koenker R., Bassett G. Regression Quantiles. Econometrica, 1978 — квантили и pinball-loss.
        </li>
        <li>Gneiting T. Quantiles as Optimal Point Forecasts. Int. J. of Forecasting, 2011.</li>
        <li>
          Mann H. B. Nonparametric Tests Against Trend. Econometrica, 1945; Kendall M. G. Rank
          Correlation Methods, 1975.
        </li>
        <li>
          Theil H. A Rank-Invariant Method of Linear Regression, 1950; Sen P. K. Estimates of the
          Regression Coefficient Based on Kendall's Tau. JASA, 1968.
        </li>
        <li>
          Freund Y., Schapire R. A Decision-Theoretic Generalization of On-Line Learning (Hedge),
          1997.
        </li>
        <li>Cohn M. Agile Estimating and Planning, 2005 — velocity и планирование итераций.</li>
        <li>
          Vacanti D. Actionable Agile Metrics for Predictability, 2015 — прогноз по распределению, а
          не по среднему.
        </li>
      </ul>
    </section>
  </article>
</template>

<style scoped>
/*
 * Цвета и шрифт — токены Atlassian Design System (как в Jira и в виджетах CapBar/QuarterBar,
 * см. ads-tokens.ts). Внутри Jira берутся живые var(--ds-*); на странице расширения их нет —
 * тогда значения темы atlassian-light, а в тёмной системной теме — atlassian-dark.
 */
.pe {
  --pe-text: var(--ds-text, #292a2e);
  --pe-subtle: var(--ds-text-subtle, #505258);
  --pe-subtlest: var(--ds-text-subtlest, #6b6e76);
  --pe-surface: var(--ds-surface, #ffffff);
  --pe-sunken: var(--ds-surface-sunken, #f8f8f8);
  --pe-border: var(--ds-border, #0b120e24);
  --pe-grid: var(--ds-border, #0b120e24);
  /* Синий данных — background.information.bold, как бакет Tech и chart.brand в Jira. */
  --pe-bar: var(--ds-background-information-bold, #1868db);
  --pe-muted: var(--ds-background-accent-gray-subtler, #dddee1);
  --pe-fit: var(--ds-background-neutral-bold, #8590a2);
  --pe-link: var(--ds-link, #1868db);
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
.pe-bg-fit {
  background-color: var(--pe-fit);
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
.pe a {
  color: var(--pe-link);
}
</style>
