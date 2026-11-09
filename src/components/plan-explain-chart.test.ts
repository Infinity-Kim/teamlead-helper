import { describe, it, expect } from 'vitest';
import { explainPlan } from '@/core/metrics';
import { niceStep, overlaps, simChart, SIM, textWidth, ticksBetween } from './plan-explain-chart';

/** Детерминированный генератор: одни и те же «команды» на каждом прогоне. */
function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 2 ** 32;
    return s / 2 ** 32;
  };
}

function chartFor(seed: number) {
  const r = rng(seed);
  const level = 15 + r() * 120;
  const flows = Array.from({ length: 18 }, (_, i) => ({
    name: `T-26.${i + 1}`,
    completed: Math.round(level * (0.6 + r() * 0.8)),
    added: Math.round(level * r() * 0.5),
  }));
  const e = explainPlan(flows, 0.8)!;
  if (!e.density.length) return null;
  const chart = simChart({
    density: e.density,
    shadeTo: e.plan.recommended,
    marks: [
      { v: e.plan.recommended, label: `план ${e.plan.recommended}`, strong: true },
      { v: e.plan.stretch, label: `с риском ${e.plan.stretch}`, strong: false },
      { v: e.medianSim, label: `в среднем ${e.medianSim}`, strong: false },
    ],
    dots: e.sprints.filter((s) => s.inWindow).map((s) => ({ name: s.name, v: s.allowed })),
  });
  return { e, chart };
}

const inside = (b: { x0: number; x1: number; y0: number; y1: number }) =>
  b.x0 >= 0 && b.x1 <= SIM.W && b.y0 >= 0 && b.y1 <= SIM.H;

describe('niceStep / ticksBetween', () => {
  it('круглые шаги и края на делениях', () => {
    expect(niceStep(60, 6)).toBe(10);
    expect(niceStep(3.7, 4)).toBe(1);
    expect(niceStep(1.1, 4)).toBe(0.5);
    expect(ticksBetween(30, 90, 10)).toEqual([30, 40, 50, 60, 70, 80, 90]);
  });
});

describe('simChart - подписи читаются на 200 разных командах', () => {
  const cases = Array.from({ length: 200 }, (_, i) => chartFor(i + 1)).filter((c) => c !== null);

  it('отметки: подписи в viewBox, над графиком, не налезают друг на друга и на чужие линии', () => {
    for (const { chart } of cases) {
      const m = chart.marks;
      for (const a of m) {
        expect(inside(a.box)).toBe(true);
        expect(a.box.y1).toBeLessThanOrEqual(chart.plotT);
        expect(a.x).toBeGreaterThanOrEqual(chart.plotL);
        expect(a.x).toBeLessThanOrEqual(chart.plotR);
        for (const b of m) {
          if (a === b) continue;
          expect(overlaps(a.box, b.box)).toBe(false);
          const lineHits = b.x >= a.box.x0 && b.x <= a.box.x1 && b.lineTop < a.box.y1;
          expect(lineHits).toBe(false);
        }
      }
    }
  });

  it('деления X: на оси, по возрастанию, подписи не налезают друг на друга', () => {
    for (const { chart } of cases) {
      const boxes = chart.xTicks.map((t) => {
        const w = textWidth(String(t), 10);
        const cx = chart.x(t);
        return { x0: cx - w / 2, x1: cx + w / 2, y0: chart.xTickY - 10, y1: chart.xTickY + 2 };
      });
      expect(chart.xTicks.length).toBeGreaterThanOrEqual(3);
      expect(chart.x(chart.xTicks[0])).toBeCloseTo(chart.plotL);
      expect(chart.x(chart.xTicks.at(-1)!)).toBeCloseTo(chart.plotR);
      boxes.forEach((b, i) => {
        expect(inside(b)).toBe(true);
        if (i) expect(overlaps(boxes[i - 1], b, 2)).toBe(false);
      });
      // Подпись оси X ниже подписей делений.
      expect(chart.xTitle.y - 11).toBeGreaterThan(chart.xTickY + 2);
    }
  });

  it('кривая без оси Y: пик ниже верха графика и не выходит за основание', () => {
    for (const { chart } of cases) {
      const ys = [...chart.line.matchAll(/,(-?[\d.]+)/g)].map((m) => Number(m[1]));
      expect(Math.min(...ys)).toBeGreaterThanOrEqual(chart.plotT - 1e-6);
      expect(Math.max(...ys)).toBeLessThanOrEqual(chart.base + 1e-6);
    }
  });

  it('точки спринтов не сливаются и стоят внутри графика', () => {
    for (const { chart } of cases) {
      for (const a of chart.dots) {
        expect(a.cy - SIM.dotR).toBeGreaterThanOrEqual(chart.plotT);
        for (const b of chart.dots) {
          if (a === b) continue;
          expect(Math.hypot(a.cx - b.cx, a.cy - b.cy)).toBeGreaterThanOrEqual(SIM.dotR * 2);
        }
      }
    }
  });

  it('одинаковые план и «с риском» - одна подпись', () => {
    const c = simChart({
      density: [
        { x: 10, y: 0.01 },
        { x: 20, y: 0.05 },
        { x: 30, y: 0.01 },
      ],
      shadeTo: 18,
      marks: [
        { v: 18, label: 'план 18', strong: true },
        { v: 18, label: 'с риском 18', strong: false },
        { v: 20, label: 'в среднем 20', strong: false },
      ],
      dots: [],
    });
    expect(c.marks.map((m) => m.label)).toEqual(['план и с риском 18', 'в среднем 20']);
  });
});
