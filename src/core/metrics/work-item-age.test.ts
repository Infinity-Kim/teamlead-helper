import { describe, it, expect } from 'vitest';
import {
  ageThresholdsFromHistory,
  ageDaysOf,
  severityOf,
  calcAgingIssues,
  firstWorkStart,
  cycleTimeDays,
} from './work-item-age';

// Рабочие/финальные статусы ELCAS доски 80 (реальные, из recon 2026-07-08).
const WORK = ['DEV', 'В работе'];
const DONE = ['Готово', 'Done'];

// Фиксированный «сейчас» для детерминированных тестов: 2026-07-08T12:00:00Z.
const NOW = Date.parse('2026-07-08T12:00:00Z');
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

describe('firstWorkStart — момент реального начала работы', () => {
  // Реальный changelog ELCAS-11485 (из recon): Ready for DEV — очередь, DEV — начало работы.
  const t11485 = [
    { at: '2026-04-17T13:22:01.371+0300', to: 'Doc/Design' },
    { at: '2026-05-21T18:06:00.373+0300', to: 'DoR/PBR' },
    { at: '2026-06-11T16:29:58.325+0300', to: 'Ready for DEV' },
    { at: '2026-07-02T17:06:37.777+0300', to: 'DEV' },
  ];

  it('берёт вход в DEV, а не Ready for DEV (очередь не считается)', () => {
    expect(firstWorkStart(t11485, WORK)).toBe('2026-07-02T17:06:37.777+0300');
  });

  it('регистронезависимо + берёт ПЕРВЫЙ вход в рабочий статус', () => {
    const tr = [
      { at: '2026-07-05T10:00:00Z', to: 'dev' }, // первый (lowercase)
      { at: '2026-07-06T10:00:00Z', to: 'В работе' }, // второй рабочий — игнор
    ];
    expect(firstWorkStart(tr, WORK)).toBe('2026-07-05T10:00:00Z');
  });

  it('задача не дошла до работы → null', () => {
    const tr = [{ at: '2026-07-01T10:00:00Z', to: 'Ready for DEV' }];
    expect(firstWorkStart(tr, WORK)).toBeNull();
  });
});

describe('cycleTimeDays — start(DEV)→done', () => {
  it('от входа в DEV до входа в Готово', () => {
    const tr = [
      { at: '2026-06-11T10:00:00+0300', to: 'Ready for DEV' },
      { at: '2026-07-02T10:00:00+0300', to: 'DEV' }, // старт
      { at: '2026-07-07T10:00:00+0300', to: 'Готово' }, // финиш → 5 дней
    ];
    expect(cycleTimeDays(tr, WORK, DONE)).toBe(5);
  });

  it('не завершена → null', () => {
    const tr = [{ at: '2026-07-02T10:00:00Z', to: 'DEV' }];
    expect(cycleTimeDays(tr, WORK, DONE)).toBeNull();
  });

  it('не начата → null', () => {
    const tr = [{ at: '2026-07-02T10:00:00Z', to: 'Готово' }];
    expect(cycleTimeDays(tr, WORK, DONE)).toBeNull();
  });
});

describe('ageThresholdsFromHistory', () => {
  it('agingDays = медиана, stuckDays = p85', () => {
    // cycle times: 1,2,3,4,5,6,7,8,9,10 → median 5.5, p85(nearest-rank ceil(0.85*10)=9-й)=9
    const t = ageThresholdsFromHistory([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(t).not.toBeNull();
    expect(t!.agingDays).toBe(5.5);
    expect(t!.stuckDays).toBe(9);
  });

  it('пустая история → null (порогов нет)', () => {
    expect(ageThresholdsFromHistory([])).toBeNull();
  });

  it('малая история: stuck не ниже aging', () => {
    const t = ageThresholdsFromHistory([3])!;
    expect(t.stuckDays).toBeGreaterThanOrEqual(t.agingDays);
  });
});

describe('ageDaysOf', () => {
  it('считает возраст в днях (wall-clock)', () => {
    expect(ageDaysOf(daysAgo(3), NOW)).toBe(3);
  });
  it('старт в будущем → 0, не отрицательный', () => {
    expect(ageDaysOf(daysAgo(-2), NOW)).toBe(0);
  });
  it('невалидная дата → null', () => {
    expect(ageDaysOf('nonsense', NOW)).toBeNull();
  });
});

describe('severityOf', () => {
  const t = { agingDays: 5, stuckDays: 10 };
  it('ниже aging → normal', () => {
    expect(severityOf(3, t)).toBe('normal');
  });
  it('между aging и stuck → aging', () => {
    expect(severityOf(7, t)).toBe('aging');
  });
  it('на/выше stuck → stuck', () => {
    expect(severityOf(10, t)).toBe('stuck');
    expect(severityOf(15, t)).toBe('stuck');
  });
  it('без порогов → всегда normal', () => {
    expect(severityOf(100, null)).toBe('normal');
  });
});

describe('calcAgingIssues', () => {
  const thresholds = { agingDays: 5, stuckDays: 10 };

  it('возвращает только aging/stuck, отсортированные по убыванию возраста', () => {
    const r = calcAgingIssues(
      [
        { key: 'A', startedAt: daysAgo(2) }, // normal — отфильтрован
        { key: 'B', startedAt: daysAgo(7) }, // aging
        { key: 'C', startedAt: daysAgo(12) }, // stuck
      ],
      thresholds,
      NOW,
    );
    expect(r.map((x) => x.key)).toEqual(['C', 'B']); // по убыванию
    expect(r[0].severity).toBe('stuck');
    expect(r[1].severity).toBe('aging');
  });

  it('без порогов — ничего не подсвечивается', () => {
    const r = calcAgingIssues([{ key: 'A', startedAt: daysAgo(100) }], null, NOW);
    expect(r).toEqual([]);
  });

  it('невалидные даты пропускаются', () => {
    const r = calcAgingIssues(
      [
        { key: 'A', startedAt: 'nonsense' },
        { key: 'B', startedAt: daysAgo(12) },
      ],
      thresholds,
      NOW,
    );
    expect(r.map((x) => x.key)).toEqual(['B']);
  });

  it('пустой вход → пусто', () => {
    expect(calcAgingIssues([], thresholds, NOW)).toEqual([]);
  });
});
