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
const windowRows = computed(() => props.e.sprints.filter((s) => s.inWindow));
/** Спринты окна, где такой план не уложился бы, — с их прилётами: главный ответ «почему не больше». */
const windowMisses = computed(() =>
  windowRows.value.filter((r) => r.allowed < p.value.recommended),
);
const olderCount = computed(() => props.e.sprints.length - windowRows.value.length);
/** Есть спринты, где крупные задачи разнесены (работа ≠ закрыто). */
const hasBigTasks = computed(() => props.e.sprints.some((s) => s.work !== s.completed));

// --- График 1: допустимый план по спринтам (столбики), окно прогноза выделено ---

const W = 760;
const H = 220;
const PAD = { l: 36, r: 120, t: 12, b: 36 };

const bars = computed(() => {
  const rows = props.e.sprints;
  const max = Math.max(...rows.map((r) => r.allowed), p.value.recommended, 1) * 1.08;
  const step = (W - PAD.l - PAD.r) / rows.length;
  const bw = Math.min(24, step - 2);
  const y = (v: number) => PAD.t + (H - PAD.t - PAD.b) * (1 - v / max);
  const first = rows.findIndex((r) => r.inWindow);
  return {
    max,
    y,
    ticks: niceTicks(max),
    windowX: PAD.l + first * step,
    items: rows.map((r, i) => ({
      ...r,
      x: PAD.l + i * step + (step - bw) / 2,
      w: bw,
      top: y(r.allowed),
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

// --- График 2: плотность симуляции следующего спринта + отметки плана / вызова / медианы ---

const SH = 190;
const sim = computed(() => {
  const d = props.e.density;
  if (!d.length) return null;
  const lo = Math.min(d[0].x, ...windowRows.value.map((r) => r.allowed));
  const hi = Math.max(d[d.length - 1].x, ...windowRows.value.map((r) => r.allowed));
  const ymax = Math.max(...d.map((q) => q.y)) * 1.1;
  const x = (v: number) => 24 + (W - 48) * ((v - lo) / (hi - lo || 1));
  const y = (v: number) => 30 + (SH - 30 - 50) * (1 - v / ymax);
  const base = y(0);
  const line = d.map((q, i) => `${i ? 'L' : 'M'}${x(q.x)},${y(q.y)}`).join(' ');
  // Заливка «левее плана» — доля симуляций, где план не уложился бы (≈ τ).
  const left = d.filter((q) => q.x <= p.value.recommended);
  const area = left.length
    ? `M${x(left[0].x)},${base} ` +
      left.map((q) => `L${x(q.x)},${y(q.y)}`).join(' ') +
      ` L${x(left[left.length - 1].x)},${base} Z`
    : '';
  return {
    x,
    base,
    line,
    area,
    marks: [
      { v: p.value.recommended, label: `план ${p.value.recommended}`, strong: true },
      { v: p.value.stretch, label: `вызов ${p.value.stretch}`, strong: false },
      { v: props.e.medianSim, label: `медиана ${fmt(props.e.medianSim)}`, strong: false },
    ],
    dots: windowRows.value.map((r) => ({ ...r, cx: x(r.allowed) })),
  };
});

const bt = computed(() => props.e.backtest);

const trendVerdict = computed(() => {
  const t = p.value.trend;
  if (!t?.active) return '';
  const dir = t.slope > 0 ? 'растёт' : 'снижается';
  return `Внутри окна допустимый план ${dir} ≈ на ${fmt(Math.abs(t.slope))} SP за спринт (Манн–Кендалл Z = ${fmt(t.z)}, порог ±${c.value.trendZ}). В план тренд не добавляем: окно короткое, и план сам догонит новый уровень за ${c.value.window} спринтов — стрелка ${t.slope > 0 ? '↗' : '↘'} рядом с планом лишь предупреждает.`;
});
</script>

<template>
  <article class="pe space-y-6 pe-text">
    <!-- Итог -->
    <section class="rounded-lg border pe-border pe-surface p-5">
      <p class="text-xs pe-subtlest">{{ team }} · план на старт спринта</p>
      <p class="mt-1 text-5xl font-semibold tabular-nums pe-text">≤ {{ p.recommended }} SP</p>
      <p class="mt-2">
        Столько брать в спринт на планировании, чтобы закрыть не меньше
        <b>{{ pct(target) }}</b> взятого с учётом задач, которые прилетят по ходу. Модель целится в
        {{ inTarget }} спринтов; на истории команды
        <template v-if="bt.scored">
          уложилась бы в цель в <b>{{ bt.hitsPlan }} из {{ bt.scored }}</b> ({{
            pct(bt.hitsPlan / bt.scored)
          }}).
        </template>
        <template v-else>пока проверить не на чем.</template>
        Если готовы рискнуть — до <b>{{ p.stretch }} SP</b> (≈ {{ inStretch }}).
      </p>
      <div class="mt-3 rounded pe-sunken px-3 py-2">
        <p class="font-medium pe-text">Почему столько, а не больше</p>
        <p class="mt-1">
          За последние {{ p.count }} спринтов команда закрывала обычно ≈
          <b>{{ fmt(p.medianCompleted) }} SP</b>, но по ходу спринта прилетало ≈
          <b>{{ fmt(p.medianAdded) }} SP</b>. План — это сколько брать <b>на старте</b>: прилёты
          тоже войдут во «взятое», под них оставлено место. Такой план уложился бы в
          <b>{{ p.windowFits }} из {{ p.count }}</b> последних спринтов<template
            v-if="windowMisses.length"
          >
            ; не уложился бы в
            <template v-for="(r, i) in windowMisses" :key="r.name"
              >{{ i ? ', ' : '' }}{{ r.name }} (прилёты {{ fmt(r.added) }} SP → можно было
              {{ fmt(r.allowed) }})</template
            ></template
          >.
        </p>
        <p class="mt-1 text-xs pe-subtle">
          Хотите план больше — меньше прилётов: каждые 10 SP прилётов в среднем дают +10 SP к плану.
        </p>
      </div>
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
      <p>
        <b>Крупные задачи</b> (от {{ c.bigTaskSp }} SP) делаются дольше спринта, а Jira засчитывает
        их целиком в спринте закрытия: спринт старта выглядит провалом, спринт закрытия — рекордом.
        Поэтому вместо «закрыто» берём <b>работу</b>: SP крупной задачи раздаём спринтам по дням,
        когда она была в работе (от первого входа в рабочий статус до закрытия), — даже если в
        первый спринт она формально не входила.
      </p>
      <p class="text-xs pe-subtle">
        Пример — последний спринт {{ windowRows[windowRows.length - 1].name }}:
        {{ fmt(windowRows[windowRows.length - 1].work) }} ÷ {{ target }} −
        {{ fmt(windowRows[windowRows.length - 1].added) }} =
        {{ fmt(windowRows[windowRows.length - 1].allowed) }} SP.
      </p>

      <figure class="overflow-x-auto rounded-lg border pe-border pe-surface p-3">
        <figcaption class="mb-1 flex flex-wrap gap-x-4 text-xs pe-subtle">
          <span>Допустимый план по спринтам, SP</span>
          <span class="inline-flex items-center gap-1.5">
            <i class="inline-block h-2.5 w-2.5 rounded-sm pe-bg-bar" /> окно прогноза ({{
              windowRows.length
            }})
          </span>
          <span v-if="olderCount" class="inline-flex items-center gap-1.5">
            <i class="inline-block h-2.5 w-2.5 rounded-sm pe-bg-muted" /> раньше — только для
            проверки
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
          <line
            v-if="olderCount"
            :x1="bars.windowX"
            :x2="bars.windowX"
            :y1="PAD.t"
            :y2="bars.y(0)"
            class="pe-stroke-subtlest"
            stroke-dasharray="3 3"
            stroke-width="1"
          />
          <path
            v-for="b in bars.items"
            :key="b.name"
            :d="barPath(b.x, b.top, b.w, bars.y(0))"
            :class="b.inWindow ? 'pe-fill-bar' : 'pe-fill-muted'"
          >
            <title>
              {{ b.name }}: закрыто {{ fmt(b.completed) }}<template v-if="b.work !== b.completed">
              (по работе {{ fmt(b.work) }})</template >, прилёты {{ fmt(b.added) }} → допустимый
              план {{ fmt(b.allowed) }} SP{{ b.inWindow ? '' : ' (вне окна)' }}
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

      <details class="text-xs">
        <summary class="cursor-pointer pe-subtle">Таблица по спринтам</summary>
        <table class="mt-2 w-full tabular-nums">
          <thead class="text-left pe-subtlest">
            <tr>
              <th class="py-1 font-normal">спринт</th>
              <th class="font-normal">закрыто</th>
              <th v-if="hasBigTasks" class="font-normal">по работе</th>
              <th class="font-normal">прилёты</th>
              <th class="font-normal">допустимый план</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="r in [...e.sprints].reverse()"
              :key="r.name"
              class="border-t pe-border"
              :class="r.inWindow ? '' : 'pe-subtlest'"
            >
              <td class="py-1">{{ r.name }}{{ r.inWindow ? ' ·' : '' }}</td>
              <td>{{ fmt(r.completed) }}</td>
              <td v-if="hasBigTasks">{{ r.work !== r.completed ? fmt(r.work) : '' }}</td>
              <td>{{ fmt(r.added) }}</td>
              <td>{{ fmt(r.allowed) }}</td>
            </tr>
          </tbody>
        </table>
        <p class="mt-1 pe-subtlest">
          · — спринт в окне прогноза. «По работе» — закрыто с крупными задачами, разнесёнными по
          времени работы; допустимый план считается от него.
        </p>
      </details>
    </section>

    <!-- Шаг 3 -->
    <section class="space-y-2">
      <h3 class="text-base font-semibold pe-text">3. Почему только {{ c.window }} спринтов</h3>
      <p>
        План должен описывать команду <b>в нынешнем составе</b>. Длинная история смешивает режимы:
        найм, уход, другой тип задач — и план месяцами тянется к тому, какой команда была.
        {{ c.window }} последних спринтов ≈ квартал: достаточно, чтобы увидеть разброс, и после
        смены состава план полностью перестраивается за {{ c.window }} спринтов. Более старые
        спринты на графике — только для проверки на истории ниже.
      </p>
      <p>
        Но 6 точек — мало для «нижних {{ pct(c.tau) }}» в лоб: это второй снизу спринт, один спринт
        двигает план скачком, а в цель такой план попадает лишь в ≈ 5 из 7. Поэтому следующий спринт
        мы <b>симулируем</b>.
      </p>
    </section>

    <!-- Шаг 4 -->
    <section class="space-y-2">
      <h3 class="text-base font-semibold pe-text">4. Монте-Карло следующего спринта</h3>
      <p>Один симулированный спринт:</p>
      <ol class="list-decimal space-y-0.5 pl-5">
        <li>
          берём случайный спринт из окна <b>целиком</b> — пару «закрыто + прилёты» (в спринт с
          большими прилётами команда обычно и закрывает больше, связь сохраняется);
        </li>
        <li>
          добавляем шум: закрыто ± {{ fmt(e.bandwidth.completed) }} SP, прилёты ±
          {{ fmt(e.bandwidth.added) }} SP (σ нормального шума) — следующий спринт не обязан
          повторить один из шести;
        </li>
        <li>считаем его допустимый план по формуле шага 2.</li>
      </ol>
      <p>
        Ширина шума — <b>правило Сильвермана</b> по разбросу окна: h = 0.9 · min(σ, IQR ÷ 1.34) ·
        n<sup>−1/5</sup>. Чем ровнее команда, тем уже шум. Шум добавляет к разбросу шести спринтов
        свой — без поправки хвост уходил бы ниже реальных спринтов и план был бы занижен. Поэтому
        симуляцию <b>сжимаем к среднему</b> (поправка Сильвермана): её разброс равен разбросу окна.
        Миллионы таких спринтов дают кривую ниже; её считаем точно, формулой (смесь нормальных
        распределений), а не случайными прогонами — поэтому план не дрожит от перезагрузки страницы.
      </p>
      <p class="rounded pe-sunken px-3 py-2 font-mono text-xs">
        P(допустимый ≤ x) = ⅙ · Σ Φ((x − c<sub>i</sub>) ÷ {{ fmt(p.spread) }}) · план = x, где P =
        {{ c.tau }}; c<sub>i</sub> = среднее + k · (допустимый<sub>i</sub> − среднее), k = 1 ÷ √(1 +
        h² ÷ σ²)
      </p>

      <figure v-if="sim" class="overflow-x-auto rounded-lg border pe-border pe-surface p-3">
        <figcaption class="mb-1 flex flex-wrap gap-x-4 text-xs pe-subtle">
          <span>Допустимый план следующего спринта по симуляции, SP</span>
          <span class="inline-flex items-center gap-1.5">
            <i class="inline-block h-2.5 w-2.5 rounded-sm pe-bg-muted" /> {{ pct(c.tau) }} худших
            исходов — план бы не уложился
          </span>
          <span class="inline-flex items-center gap-1.5">
            <i class="inline-block h-2.5 w-2.5 rounded-full pe-bg-bar" /> спринты окна
          </span>
        </figcaption>
        <svg :viewBox="`0 0 ${W} ${SH}`" class="w-full min-w-[560px]" role="img">
          <path :d="sim.area" class="pe-fill-muted" />
          <path
            :d="sim.line"
            class="pe-stroke-bar"
            stroke-width="2"
            fill="none"
            stroke-linejoin="round"
          />
          <line
            x1="24"
            :x2="W - 24"
            :y1="sim.base"
            :y2="sim.base"
            class="pe-stroke-grid"
            stroke-width="1"
          />
          <g v-for="(m, i) in sim.marks" :key="m.label">
            <line
              :x1="sim.x(m.v)"
              :x2="sim.x(m.v)"
              y1="22"
              :y2="sim.base"
              :class="m.strong ? 'pe-stroke-text' : 'pe-stroke-subtlest'"
              :stroke-width="m.strong ? 2 : 1"
            />
            <text
              :x="sim.x(m.v)"
              :y="i === 2 ? SH - 4 : 14"
              text-anchor="middle"
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
            :cy="sim.base + 14"
            r="4.5"
            class="pe-fill-bar pe-stroke-surface"
            stroke-width="2"
          >
            <title>{{ d.name }}: допустимый план {{ fmt(d.allowed) }} SP</title>
          </circle>
        </svg>
      </figure>
      <p v-else class="text-xs pe-subtle">
        Разброса в окне нет — симулировать нечего, план равен допустимому плану спринтов окна.
      </p>
      <p>
        План <b>≤ {{ p.recommended }} SP</b> — точка, левее которой {{ pct(c.tau) }} симуляций
        (округлено вниз: лишний SP сверху — уже выход за цель в пограничном спринте). «Вызов»
        <b>{{ p.stretch }} SP</b> — то же для {{ pct(c.stretchTau) }}.
      </p>
      <p v-if="trendVerdict" class="text-xs pe-subtle">{{ trendVerdict }}</p>
    </section>

    <!-- Шаг 5 -->
    <section class="space-y-2">
      <h3 class="text-base font-semibold pe-text">5. Проверка на истории команды</h3>
      <div class="rounded-lg border pe-border pe-surface p-3">
        <p v-if="!bt.scored">
          Пока спринтов меньше {{ c.window + 1 }} — проверить не на чем: каждому проверяемому
          спринту нужно {{ c.window }} спринтов перед ним.
        </p>
        <template v-else>
          <p>
            Для каждого из последних {{ bt.scored }} спринтов план пересчитан
            <b>только по {{ c.window }} спринтам перед ним</b> — как если бы мы планировали тогда —
            и сравнён с тем, что было допустимо:
          </p>
          <ul class="mt-1 list-disc pl-5">
            <li>
              рекомендация уложилась бы в цель в
              <b>{{ bt.hitsPlan }} из {{ bt.scored }}</b> спринтов ({{
                pct(bt.hitsPlan / bt.scored)
              }});
            </li>
            <li>
              медиана закрытого за {{ c.window }} спринтов (прежняя «velocity») — в
              <b>{{ bt.hitsMedian }} из {{ bt.scored }}</b> ({{ pct(bt.hitsMedian / bt.scored) }}).
            </li>
          </ul>
          <p class="mt-1 text-xs pe-subtle">
            Ориентир — {{ inTarget }} ({{ pct(1 - c.tau) }}). На трёх командах (59 спринтов, живые
            данные Jira) схема попадает в 78% — ближе всех проверенных вариантов к цели. На коротком
            ряду одной команды разница в один-два спринта случайна; числа показаны как есть, без
            подгонки.
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
        </template>
      </div>
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
        <dd>значение, ниже которого 20% исходов. План на нём допустим примерно в 80% спринтов.</dd>
        <dt class="font-medium">Монте-Карло</dt>
        <dd>
          оценка через симуляцию множества возможных исходов вместо одной формулы «в среднем».
        </dd>
        <dt class="font-medium">Сглаженный бутстреп</dt>
        <dd>
          симуляция из своих же наблюдений с небольшим шумом: исходы похожи на прошлые, но не
          обязаны их повторять.
        </dd>
        <dt class="font-medium">Правило Сильвермана</dt>
        <dd>ширина шума по разбросу данных и их числу; устойчиво к одному выбросу (через IQR).</dd>
        <dt class="font-medium">Манн–Кендалл</dt>
        <dd>ранговый тест на монотонный тренд — по нему показываем стрелку ↗ / ↘ у плана.</dd>
      </dl>
      <h3 class="pt-2 text-sm font-semibold pe-text">Литература</h3>
      <ul class="list-disc space-y-0.5 pl-5">
        <li>Efron B., Tibshirani R. An Introduction to the Bootstrap, 1993.</li>
        <li>
          Silverman B. W. Density Estimation for Statistics and Data Analysis, 1986 — сглаженный
          бутстреп и правило ширины.
        </li>
        <li>Gneiting T. Quantiles as Optimal Point Forecasts. Int. J. of Forecasting, 2011.</li>
        <li>
          Mann H. B. Nonparametric Tests Against Trend. Econometrica, 1945; Sen P. K. Estimates of
          the Regression Coefficient Based on Kendall's Tau. JASA, 1968.
        </li>
        <li>Cohn M. Agile Estimating and Planning, 2005 — velocity и планирование итераций.</li>
        <li>
          Vacanti D. When Will It Be Done?, 2017 — Монте-Карло для прогнозов в agile-командах.
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
