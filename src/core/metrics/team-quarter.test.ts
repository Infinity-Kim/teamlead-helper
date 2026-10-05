import { describe, it, expect } from 'vitest';
import { assignQuarters, sprintQuarter, sprintsLeftInQuarter, teamCalendar } from './team-quarter';
import {
  CRASH_STARTS,
  ELCAS_STARTS,
  POC_STARTS,
  WEB_STARTS,
} from './__test-helpers__/tvbet-sprint-starts';

/** Кварталы доски по живым датам: квартал → имена спринтов в хронологии. */
function quartersOf(rows: Array<[string, string]>): Record<string, string[]> {
  const byRow = assignQuarters(rows, ([, start]) => start);
  const out: Record<string, string[]> = {};
  for (const r of rows) (out[byRow.get(r)!] ??= []).push(r[0]);
  return out;
}

/** Сколько спринтов в каждом квартале. */
const counts = (q: Record<string, string[]>) =>
  Object.fromEntries(Object.entries(q).map(([k, v]) => [k, v.length]));

describe('календарь команды — живые даты ELCAS и Web (2025–2026)', () => {
  for (const [board, rows] of [
    ['ELCAS', ELCAS_STARTS],
    ['Web', WEB_STARTS],
  ] as const) {
    it(`${board}: Q1–Q3 по 6 спринтов, Q4 — 7 с новогодним`, () => {
      expect(counts(quartersOf(rows))).toEqual({
        '2025-Q1': 6,
        '2025-Q2': 6,
        '2025-Q3': 6,
        '2025-Q4': 7,
        '2026-Q1': 6,
        '2026-Q2': 6,
        '2026-Q3': 6,
        // 26.9.2 (активный) + заведённые 10.1–12.1; 12.2 ещё не создан.
        '2026-Q4': 6,
      });
    });

    it(`${board}: 9.2 открывает Q4, новогодний 12.2 его закрывает`, () => {
      const q = quartersOf(rows);
      expect(q['2025-Q3']).toEqual(['25.7.1', '25.7.2', '25.7.3', '25.8.1', '25.8.2', '25.9.1']);
      expect(q['2025-Q4'][0]).toBe('25.9.2');
      expect(q['2025-Q4'].at(-1)).toBe('25.12.2');
      expect(q['2026-Q1']).toEqual(['26.1.1', '26.1.2', '26.2.1', '26.2.2', '26.3.1', '26.3.2']);
      expect(q['2026-Q2'][0]).toBe('26.4.1');
      expect(q['2026-Q4'][0]).toBe('26.9.2');
    });
  }
});

describe('календарь команды — доски без января 2025 в истории', () => {
  it('POC (с октября 2025): начало 2025 года выводится от 14.01.2026 − 52 недели', () => {
    const q = quartersOf(POC_STARTS);
    expect(q['2025-Q4']).toEqual([
      '25.10.1',
      '25.10.2',
      '25.11.1',
      '25.11.2',
      '25.12.1',
      '25.12.2',
    ]);
    expect(counts(q)).toMatchObject({ '2026-Q1': 6, '2026-Q2': 6, '2026-Q3': 6 });
  });

  it('CRASH: недельные спринты осени 2025 не сдвигают кварталы', () => {
    const q = quartersOf(CRASH_STARTS);
    expect(q['2025-Q3'].at(-1)).toBe('2025.9.1.2');
    expect(q['2025-Q4'][0]).toBe('2025.9.2.1');
    expect(q['2025-Q4'].at(-1)).toBe('2025.12.2');
    expect(counts(q)).toMatchObject({ '2026-Q1': 6, '2026-Q2': 6, '2026-Q3': 6, '2026-Q4': 7 });
    expect(q['2026-Q4'].at(-1)).toBe('2026.12.2*');
  });
});

describe('sprintQuarter', () => {
  const cal = teamCalendar(ELCAS_STARTS.map(([, s]) => s));

  it('год команды — с первого январского спринта; ритм — 14 дней', () => {
    expect(cal.cadenceDays).toBe(14);
    expect(new Date(cal.yearStarts[2026]).toISOString().slice(0, 10)).toBe('2026-01-14');
  });

  it('декабрьский старт — Q4 того же года; январь до старта года — Q4 прошлого', () => {
    expect(sprintQuarter('2026-12-15T08:00Z', cal)).toBe('2026-Q4');
    expect(sprintQuarter('2026-01-05T08:00Z', cal)).toBe('2025-Q4');
  });

  it('следующий год без январского спринта в истории — шаг 52 недели', () => {
    expect(sprintQuarter('2027-01-13T08:00Z', cal)).toBe('2027-Q1');
    expect(sprintQuarter('2027-09-22T08:00Z', cal)).toBe('2027-Q4');
  });

  it('доска без январских спринтов — календарный квартал по старту; без даты — null', () => {
    const none = teamCalendar(['2026-10-07T08:00Z', '2026-10-21T08:00Z']);
    expect(sprintQuarter('2026-10-21T08:00Z', none)).toBe('2026-Q4');
    expect(sprintQuarter(undefined, cal)).toBeNull();
    expect(sprintQuarter('nonsense', cal)).toBeNull();
  });
});

describe('sprintsLeftInQuarter — сколько спринтов квартала ещё стартует', () => {
  const cal = teamCalendar(ELCAS_STARTS.map(([, s]) => s));
  const start = (name: string) => ELCAS_STARTS.find(([n]) => n === name)![1];

  it('последний спринт квартала — 0', () => {
    expect(sprintsLeftInQuarter(start('26.9.1'), cal)).toBe(0);
    expect(sprintsLeftInQuarter(start('26.3.2'), cal)).toBe(0);
    expect(sprintsLeftInQuarter(start('25.12.2'), cal)).toBe(0);
  });

  it('первый спринт Q1–Q3 — впереди ещё 5', () => {
    expect(sprintsLeftInQuarter(start('26.1.1'), cal)).toBe(5);
    expect(sprintsLeftInQuarter(start('26.7.1'), cal)).toBe(5);
  });

  it('первый спринт Q4 — впереди 6, включая новогодний', () => {
    expect(sprintsLeftInQuarter(start('26.9.2'), cal)).toBe(6);
    expect(sprintsLeftInQuarter(start('25.9.2'), cal)).toBe(6);
  });

  it('без даты — 0', () => {
    expect(sprintsLeftInQuarter(undefined, cal)).toBe(0);
  });
});
