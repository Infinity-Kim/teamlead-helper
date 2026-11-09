/**
 * Геометрия графика «Проверка на прошлых спринтах»: по проверенным спринтам - план модели и
 * сколько можно было взять (план ниже - выполнили), плюс «взяли на старте», если старт известен
 * во всех спринтах. Чистые функции без Vue: подписи раскладываются здесь, а тест проверяет, что
 * они не налезают и не выходят за viewBox.
 */
import { niceStep, textWidth, ticksBetween, type Box } from './plan-explain-chart';

export interface BacktestChartRow {
  name: string;
  /** Взяли на старте, SP. null - данных о старте нет. */
  start: number | null;
  /** Сколько можно было взять на старте: план не больше - выполнили. */
  allowed: number;
  /** План модели на старте этого спринта. */
  plan: number;
}

export type BacktestSeriesKey = 'allowed' | 'plan' | 'start';

export interface BacktestSeries {
  key: BacktestSeriesKey;
  label: string;
  values: number[];
  /** SVG-путь линии. */
  line: string;
}

export interface BacktestEndLabel {
  key: BacktestSeriesKey;
  text: string;
  /** Базовая линия текста. */
  y: number;
  box: Box;
}

export const BT = {
  W: 760,
  H: 260,
  /** Сверху - полоса под подсказку при наведении, чтобы она не закрывала линии. */
  PAD: { l: 36, r: 156, t: 34, b: 28 },
  tickFont: 10,
  endFont: 11,
  /** Минимальный шаг между подписями значений справа. */
  endRow: 15,
  /** Шаг сетки, SP. */
  gridStep: 20,
} as const;

const fmt = (x: number) => (Number.isInteger(x) ? String(x) : x.toFixed(1).replace('.', ','));
const f = (v: number) => Math.round(v * 10) / 10;

/** «POC-26.1.1» становится «26.1.1»: имя команды и так в заголовке. */
export const shortSprint = (name: string) => name.replace(/^[^-]+-(?=\d)/, '');

/**
 * Раскладка графика. Линия «взяли на старте» - только если старт известен во всех спринтах:
 * линию с дырами не рисуем.
 */
export function backtestChart(rows: readonly BacktestChartRow[]) {
  const { W, H, PAD } = BT;
  const n = rows.length;
  const hasStart = n > 0 && rows.every((r) => r.start !== null);

  const plotL = PAD.l;
  const plotR = W - PAD.r;
  const plotT = PAD.t;
  const base = H - PAD.b;

  const all = rows.flatMap((r) => [r.allowed, r.plan, ...(hasStart ? [r.start!] : [])]);
  const peak = Math.max(0, ...all);
  // Сетка через 20 SP; у очень больших команд - круглый шаг, чтобы не было больше 8 линий.
  const step = peak / BT.gridStep <= 8 ? BT.gridStep : niceStep(peak, 6);
  const yHi = Math.max(step, Math.ceil(peak / step - 1e-9) * step);
  const yTicks = ticksBetween(0, yHi, step);

  const colW = n > 1 ? (plotR - plotL) / (n - 1) : plotR - plotL;
  const x = (k: number) => (n > 1 ? plotL + k * colW : (plotL + plotR) / 2);
  const y = (v: number) => base - (base - plotT) * (v / yHi);
  const path = (vals: readonly number[]) =>
    vals.map((v, k) => `${k ? 'L' : 'M'}${f(x(k))},${f(y(v))}`).join(' ');

  const raw: Array<Omit<BacktestSeries, 'line'>> = [
    { key: 'allowed', label: 'можно было взять', values: rows.map((r) => r.allowed) },
    { key: 'plan', label: 'план модели', values: rows.map((r) => r.plan) },
  ];
  if (hasStart)
    raw.push({ key: 'start', label: 'взяли на старте', values: rows.map((r) => r.start!) });
  const series: BacktestSeries[] = raw.map((s) => ({ ...s, line: path(s.values) }));

  // Подписи трёх спринтов по оси X: первый, средний, последний.
  const xIdx = n ? [...new Set([0, Math.floor((n - 1) / 2), n - 1])] : [];
  const xLabels = xIdx.map((k) => ({ x: f(x(k)), text: shortSprint(rows[k].name) }));

  // Значения последнего спринта справа: по возрастанию y, при наложении - ниже на строку,
  // а если вылезли за низ графика - весь столбик поднимаем.
  const fh = BT.endFont;
  const ends: BacktestEndLabel[] = [];
  if (n) {
    const lbl = series
      .map((s) => ({
        key: s.key,
        text: `${s.label} ${fmt(s.values[n - 1])}`,
        y0: y(s.values[n - 1]) + 4,
      }))
      .sort((a, b) => a.y0 - b.y0);
    const ys: number[] = [];
    for (const r of lbl) ys.push(Math.max(r.y0, (ys.at(-1) ?? -Infinity) + BT.endRow));
    const over = ys[ys.length - 1] - (H - 4);
    if (over > 0) for (let i = 0; i < ys.length; i++) ys[i] -= over;
    const under = fh + 2 - ys[0];
    if (under > 0) for (let i = 0; i < ys.length; i++) ys[i] += under;
    lbl.forEach((r, i) => {
      const tx = plotR + 8;
      ends.push({
        key: r.key,
        text: r.text,
        y: f(ys[i]),
        box: { x0: tx, x1: tx + textWidth(r.text, fh), y0: ys[i] - fh, y1: ys[i] + 3 },
      });
    });
  }

  // Колонки наведения: на всю высоту графика, края - по границе области.
  const cols = rows.map((r, k) => {
    const x0 = Math.max(plotL, x(k) - colW / 2);
    const x1 = Math.min(plotR, x(k) + colW / 2);
    return {
      name: r.name,
      cx: f(x(k)),
      x0: f(x0),
      width: f(x1 - x0),
      points: series.map((s) => ({ key: s.key, cy: f(y(s.values[k])) })),
      tip: `${r.name}: план ${fmt(r.plan)}, можно было взять ${fmt(r.allowed)}${
        hasStart ? `, взяли ${fmt(r.start!)}` : ''
      } SP - ${r.plan <= r.allowed ? 'выполнили' : 'не выполнили'}`,
      /** Подсказка правее колонки в левой половине графика и левее - в правой. */
      tipSide: (x(k) < (plotL + plotR) / 2 ? 'right' : 'left') as 'right' | 'left',
    };
  });

  return {
    W,
    H,
    plotL,
    plotR,
    plotT,
    base,
    y,
    yTicks,
    hasStart,
    series,
    xLabels,
    xLabelY: base + 18,
    ends,
    cols,
  };
}
