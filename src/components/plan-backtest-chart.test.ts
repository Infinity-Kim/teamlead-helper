import { describe, it, expect } from 'vitest';
import { explainPlan } from '@/core/metrics';
import { BT, backtestChart, shortSprint } from './plan-backtest-chart';
import { overlaps, textWidth } from './plan-explain-chart';

/** Детерминированный генератор: одни и те же «команды» на каждом прогоне. */
function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 2 ** 32;
    return s / 2 ** 32;
  };
}

function chartFor(seed: number, withStart: boolean) {
  const r = rng(seed);
  const level = 15 + r() * 200;
  const flows = Array.from({ length: 18 }, (_, i) => {
    const completed = Math.round(level * (0.6 + r() * 0.8));
    return {
      name: `T-26.${i + 1}.1`,
      completed,
      added: Math.round(level * r() * 0.5),
      ...(withStart ? { start: Math.round(completed * (0.7 + r() * 0.6)) } : {}),
    };
  });
  const e = explainPlan(flows, 0.8)!;
  return { e, chart: backtestChart(e.backtest.rows) };
}

const inside = (b: { x0: number; x1: number; y0: number; y1: number }) =>
  b.x0 >= 0 && b.x1 <= BT.W && b.y0 >= 0 && b.y1 <= BT.H;

describe('backtestChart - раскладка на 200 разных командах', () => {
  const cases = Array.from({ length: 200 }, (_, i) => chartFor(i + 1, i % 2 === 0));

  it('подписи значений справа: в viewBox, правее графика, не налезают друг на друга', () => {
    for (const { chart } of cases) {
      expect(chart.ends).toHaveLength(chart.hasStart ? 3 : 2);
      for (const a of chart.ends) {
        expect(inside(a.box)).toBe(true);
        expect(a.box.x0).toBeGreaterThan(chart.plotR);
        for (const b of chart.ends) if (a !== b) expect(overlaps(a.box, b.box)).toBe(false);
      }
    }
  });

  it('сетка через 20 SP от 0 до верха не ниже максимума, подписи делений левее оси', () => {
    for (const { e, chart } of cases) {
      const rows = e.backtest.rows;
      const peak = Math.max(...rows.flatMap((r) => [r.start ?? r.allowed, r.plan, r.allowed]));
      expect(chart.yTicks[0]).toBe(0);
      if (peak <= 160) expect(chart.yTicks[1]).toBe(20);
      expect(chart.yTicks.length).toBeLessThanOrEqual(9);
      expect(chart.yTicks.at(-1)!).toBeGreaterThanOrEqual(
        Math.max(...chart.series.flatMap((s) => s.values)),
      );
      for (const t of chart.yTicks)
        expect(chart.plotL - 6 - textWidth(String(t), BT.tickFont)).toBeGreaterThanOrEqual(0);
    }
  });

  it('3 подписи спринтов по оси X: в viewBox и не налезают', () => {
    for (const { chart } of cases) {
      expect(chart.xLabels).toHaveLength(3);
      const boxes = chart.xLabels.map((l) => {
        const w = textWidth(l.text, BT.tickFont);
        return { x0: l.x - w / 2, x1: l.x + w / 2, y0: chart.xLabelY - 10, y1: chart.xLabelY + 2 };
      });
      boxes.forEach((b, i) => {
        expect(inside(b)).toBe(true);
        if (i) expect(overlaps(boxes[i - 1], b, 4)).toBe(false);
      });
    }
  });

  it('колонки наведения закрывают график без зазоров и подсказка с числами строки', () => {
    for (const { e, chart } of cases) {
      const cols = chart.cols;
      expect(cols).toHaveLength(e.backtest.rows.length);
      expect(cols[0].x0).toBeCloseTo(chart.plotL, 0);
      const lastCol = cols.at(-1)!;
      expect(lastCol.x0 + lastCol.width).toBeCloseTo(chart.plotR, 0);
      cols.forEach((c, i) => {
        if (i) expect(c.x0).toBeCloseTo(cols[i - 1].x0 + cols[i - 1].width, 0);
      });
      const r = e.backtest.rows[0];
      expect(cols[0].tip).toContain(`план ${r.plan}`);
      expect(cols[0].tip).toContain(`можно было взять ${String(r.allowed).replace('.', ',')}`);
      if (chart.hasStart) expect(cols[0].tip).toContain(`взяли ${r.start}`);
      expect(cols[0].tip).toMatch(r.plan <= r.allowed ? /- выполнили$/ : /- не выполнили$/);
    }
  });

  it('линия «взяли на старте» только если старт известен во всех спринтах', () => {
    const { chart: withStart } = chartFor(7, true);
    expect(withStart.series.map((s) => s.key)).toEqual(['allowed', 'plan', 'start']);
    const { e, chart } = chartFor(7, false);
    expect(chart.series.map((s) => s.key)).toEqual(['allowed', 'plan']);
    expect(chart.series[0].values).toEqual(e.backtest.rows.map((r) => r.allowed));
    const mixed = backtestChart(e.backtest.rows.map((r, i) => ({ ...r, start: i ? 50 : null })));
    expect(mixed.hasStart).toBe(false);
  });

  it('совпадающие значения последнего спринта разводятся на строку', () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({
      name: `T-${i}`,
      start: 60,
      allowed: 60,
      plan: 60,
    }));
    const ends = backtestChart(rows).ends.map((l) => l.y);
    expect(ends[1] - ends[0]).toBeGreaterThanOrEqual(BT.endRow);
    expect(ends[2] - ends[1]).toBeGreaterThanOrEqual(BT.endRow);
  });

  it('короткое имя спринта без команды', () => {
    expect(shortSprint('POC-26.1.1')).toBe('26.1.1');
    expect(shortSprint('Web-25.10.2')).toBe('25.10.2');
    expect(shortSprint('Спринт 5')).toBe('Спринт 5');
  });
});
