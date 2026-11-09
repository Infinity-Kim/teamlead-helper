/**
 * Геометрия графика «все исходы переигрывания» на странице разбора плана. Чистые функции без
 * Vue: подписи раскладываются здесь, а тест проверяет, что они не налезают друг на друга, на
 * отметки и не выходят за viewBox.
 */

/** Круглые деления: шаг 1, 2, 2.5 или 5 × 10ⁿ, примерно `count` делений на [lo, hi]. */
export function niceStep(span: number, count = 5): number {
  if (!(span > 0)) return 1;
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 2.5, 5, 10].map((k) => k * mag).find((s) => s >= raw - 1e-12) ?? raw;
}

/** Деления от lo до hi с шагом step (оба края кратны шагу). */
export function ticksBetween(lo: number, hi: number, step: number): number[] {
  const out: number[] = [];
  for (let i = Math.round(lo / step); i * step <= hi + 1e-9; i++) out.push(round(i * step));
  return out;
}

const round = (v: number) => Math.round(v * 1000) / 1000;

/** Ширина строки в px: грубая оценка для Atlassian Sans / системного шрифта, с запасом. */
export function textWidth(text: string, fontPx: number): number {
  return text.length * fontPx * 0.6;
}

export interface Box {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

export const overlaps = (a: Box, b: Box, gap = 0) =>
  a.x0 < b.x1 + gap && b.x0 < a.x1 + gap && a.y0 < b.y1 + gap && b.y0 < a.y1 + gap;

export interface SimMarkInput {
  v: number;
  label: string;
  strong: boolean;
}

export interface SimMark extends SimMarkInput {
  x: number;
  /** Верх вертикальной линии отметки - под своей подписью. */
  lineTop: number;
  tx: number;
  ty: number;
  anchor: 'start' | 'end';
  box: Box;
}

export interface SimChartInput {
  /** Кривая: x - SP, y - плотность (доля исходов на 1 SP). */
  density: ReadonlyArray<{ x: number; y: number }>;
  marks: readonly SimMarkInput[];
  /** Сколько можно было взять в прошлых спринтах - точки под кривой. */
  dots: ReadonlyArray<{ name: string; v: number }>;
  /** Граница заливки «план не уложился бы». */
  shadeTo: number;
}

export const SIM = {
  W: 760,
  H: 260,
  PAD: { l: 24, r: 24, t: 52, b: 52 },
  /** Размер шрифта подписей отметок и делений, px. */
  markFont: 11,
  tickFont: 10,
  /** Высота строки подписей отметок. */
  row: 15,
  dotR: 4.5,
} as const;

/**
 * Раскладка графика. Ось X - SP, деления круглые и края оси на делениях. Ось Y без делений:
 * высота кривой - только «чаще или реже», число на ней одной строкой не объяснить. Подписи отметок: план левее своей линии, остальные
 * правее, при пересечении - строкой выше. Точки спринтов, которые слились бы, - столбиком.
 */
export function simChart(input: SimChartInput) {
  const { W, H, PAD } = SIM;
  const d = input.density;
  const xsAll = [
    ...d.map((q) => q.x),
    ...input.dots.map((q) => q.v),
    ...input.marks.map((m) => m.v),
  ];
  const rawLo = Math.min(...xsAll);
  const rawHi = Math.max(...xsAll);
  const xStep = niceStep(rawHi - rawLo || 1, 6);
  const xLo = Math.max(0, Math.floor(rawLo / xStep) * xStep);
  const xHi = Math.max(xLo + xStep, Math.ceil(rawHi / xStep) * xStep);
  const xTicks = ticksBetween(xLo, xHi, xStep);

  // Кривая не упирается в верх: 8% высоты запаса.
  const yHi = Math.max(...d.map((q) => q.y), 1e-9) * 1.08;

  const plotL = PAD.l;
  const plotR = W - PAD.r;
  const plotT = PAD.t;
  const base = H - PAD.b;
  const x = (v: number) => plotL + (plotR - plotL) * ((v - xLo) / (xHi - xLo));
  const yd = (density: number) => base - (base - plotT) * (density / yHi);

  const line = d.map((q, i) => `${i ? 'L' : 'M'}${f(x(q.x))},${f(yd(q.y))}`).join(' ');

  // Заливка левее плана: точки до плана и точка ровно на плане (линейная интерполяция).
  let area = '';
  const left = d.filter((q) => q.x <= input.shadeTo);
  if (left.length) {
    const next = d[left.length];
    const lastL = left[left.length - 1];
    const pts = [...left];
    if (next && next.x > lastL.x && input.shadeTo > lastL.x) {
      const t = (input.shadeTo - lastL.x) / (next.x - lastL.x);
      pts.push({ x: input.shadeTo, y: lastL.y + t * (next.y - lastL.y) });
    }
    area =
      `M${f(x(pts[0].x))},${f(base)} ` +
      pts.map((q) => `L${f(x(q.x))},${f(yd(q.y))}`).join(' ') +
      ` L${f(x(pts[pts.length - 1].x))},${f(base)} Z`;
  }

  // Подписи отметок над областью графика, строки снизу вверх: 0 - сразу над графиком.
  // Отметки с одним значением сливаются в одну подпись («план и с риском 40»).
  const fh = SIM.markFont;
  const rowY = (r: number) => plotT - 8 - r * SIM.row;
  const merged: SimMarkInput[] = [];
  for (const m of input.marks) {
    const same = merged.find((o) => Math.abs(x(o.v) - x(m.v)) < 1);
    if (same) {
      same.label = mergeLabels(same.label, m.label);
      same.strong ||= m.strong;
    } else merged.push({ ...m });
  }
  // Сначала главная отметка (план, подпись левее линии), потом остальные справа налево:
  // подпись правее линии накрывает только линии правее себя, а те уже стоят строкой ниже.
  const order = [
    ...merged.filter((m) => m.strong),
    ...merged.filter((m) => !m.strong).sort((a, b) => b.v - a.v),
  ];
  const placed: SimMark[] = [];
  const crossesLine = (box: Box, lx: number, top: number) =>
    lx >= box.x0 - 3 && lx <= box.x1 + 3 && top < box.y1 + 2;
  for (const m of order) {
    const mx = x(m.v);
    const w = textWidth(m.label, fh);
    const prefer: Array<'start' | 'end'> = m.strong ? ['end', 'start'] : ['start', 'end'];
    let done: SimMark | null = null;
    for (let r = 0; r < 3 && !done; r++) {
      for (const anchor of prefer) {
        let x0 = anchor === 'end' ? mx - 4 - w : mx + 4;
        x0 = Math.min(Math.max(x0, 2), W - 2 - w);
        const box = { x0, x1: x0 + w, y0: rowY(r) - fh, y1: rowY(r) + 3 };
        const lineTop = box.y1 - fh / 2;
        const clash = placed.some(
          (p) =>
            overlaps(p.box, box, 4) ||
            crossesLine(box, p.x, p.lineTop) ||
            crossesLine(p.box, mx, lineTop),
        );
        if (!clash) {
          const tx = anchor === 'end' ? x0 + w : x0;
          done = { ...m, x: mx, lineTop, tx, ty: rowY(r), anchor, box };
          break;
        }
      }
    }
    if (!done) {
      // Места нет (не бывает при 3 отметках): верхняя строка, линия обрывается под подписями.
      const x0 = Math.min(Math.max(mx + 4, 2), W - 2 - w);
      const box = { x0, x1: x0 + w, y0: rowY(2) - fh, y1: rowY(2) + 3 };
      done = { ...m, x: mx, lineTop: box.y1, tx: x0, ty: rowY(2), anchor: 'start', box };
    }
    placed.push(done);
  }
  placed.sort((a, b) => a.v - b.v);

  // Точки прошлых спринтов над осью: близкие (ближе диаметра) - столбиком вверх.
  const D = SIM.dotR * 2 + 2;
  const dotsSorted = [...input.dots].map((q) => ({ ...q, cx: x(q.v) })).sort((a, b) => a.cx - b.cx);
  const dots: Array<{ name: string; v: number; cx: number; cy: number }> = [];
  for (const q of dotsSorted) {
    let level = 0;
    while (dots.some((o) => Math.abs(o.cx - q.cx) < D && o.cy === base - SIM.dotR - 2 - level * D))
      level++;
    dots.push({ ...q, cy: base - SIM.dotR - 2 - level * D });
  }

  return {
    W,
    H,
    plotL,
    plotR,
    plotT,
    base,
    x,
    xTicks,
    line,
    area,
    marks: placed,
    dots,
    /** Подпись оси X. */
    xTitle: { x: (plotL + plotR) / 2, y: H - 8 },
    xTickY: base + 16,
  };
}

/** «план 40» + «с риском 40» = «план и с риском 40». */
function mergeLabels(a: string, b: string): string {
  const num = /\s(\S+)$/;
  const na = a.match(num)?.[1];
  const nb = b.match(num)?.[1];
  return na && na === nb ? `${a.replace(num, '')} и ${b.replace(num, '')} ${na}` : `${a}, ${b}`;
}

const f = (v: number) => Math.round(v * 10) / 10;
