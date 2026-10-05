import { describe, it, expect } from 'vitest';
import {
  ruleVelocityDrop,
  ruleCarryover,
  ruleReestimate,
  ruleScopeAdded,
  rulePunted,
  healthBySprint,
  toThresholds,
  withHealthDefaults,
  normalizeHealthSettings,
  grade,
  DEFAULT_HEALTH_SETTINGS,
  DEFAULT_HEALTH_COLORS,
  withHealthColorDefaults,
  type HealthThresholds,
} from './sprint-health';
import { issue, sprint } from './__test-helpers__/sprint-fixtures';

/**
 * Пороги по умолчанию (как в настройках расширения), первый / второй:
 * скорость 10/20, перенос 20/30, переоценка 10/20, добавлено 10/20, выброшено 0/3; окно 6.
 */
const T: HealthThresholds = toThresholds(DEFAULT_HEALTH_SETTINGS);

/** Шесть предыдущих спринтов с заданной скоростью — база для velocity-drop. */
function history(velocities: number[]) {
  return velocities.map((v, i) =>
    sprint({ sprintId: 900 + i, completedIssues: [], completedPoints: v }),
  );
}

describe('ruleVelocityDrop', () => {
  it('без полного окна истории даёт insufficient-history, а НЕ ok', () => {
    const s = sprint({ sprintId: 1, completedIssues: [], completedPoints: 10 });
    const r = ruleVelocityDrop(s, history([50, 50, 50]), T);
    expect(r.status).toBe('insufficient-history');
    expect(r.value).toBeNull();
  });

  it('база — медиана предыдущих, оцениваемый спринт в неё НЕ входит', () => {
    // Медиана [100,100,100,100,100,100] = 100; сам спринт (10 SP) базу не занижает.
    const s = sprint({ sprintId: 1, completedIssues: [], completedPoints: 10 });
    const r = ruleVelocityDrop(s, history([100, 100, 100, 100, 100, 100]), T);
    expect(r.baseline).toBe(100);
    expect(r.value).toBe(0.9);
    expect(r.status).toBe('crit');
  });

  it('медиана устойчива к одиночному выбросу в истории', () => {
    // Среднее [100,100,100,100,100,0] = 83.3, медиана = 100 — берём медиану.
    const s = sprint({ sprintId: 1, completedIssues: [], completedPoints: 95 });
    const r = ruleVelocityDrop(s, history([100, 100, 100, 100, 100, 0]), T);
    expect(r.baseline).toBe(100);
  });

  it('просадка ровно на пороге (10%) НЕ нарушает правило', () => {
    const s = sprint({ sprintId: 1, completedIssues: [], completedPoints: 90 });
    const r = ruleVelocityDrop(s, history([100, 100, 100, 100, 100, 100]), T);
    expect(r.value).toBe(0.1);
    expect(r.status).toBe('ok');
  });

  it('просадка на 10.1% нарушает первый порог (жёлтый)', () => {
    const s = sprint({ sprintId: 1, completedIssues: [], completedPoints: 89.9 });
    const r = ruleVelocityDrop(s, history([100, 100, 100, 100, 100, 100]), T);
    expect(r.status).toBe('warn');
  });

  it('просадка ровно на втором пороге (20%) — ещё жёлтый, 20.1% — красный', () => {
    const base = history([100, 100, 100, 100, 100, 100]);
    const at = sprint({ sprintId: 1, completedIssues: [], completedPoints: 80 });
    const over = sprint({ sprintId: 2, completedIssues: [], completedPoints: 79.9 });
    expect(ruleVelocityDrop(at, base, T).status).toBe('warn');
    expect(ruleVelocityDrop(over, base, T).status).toBe('crit');
  });

  it('рост скорости — ok (отрицательная просадка)', () => {
    const s = sprint({ sprintId: 1, completedIssues: [], completedPoints: 150 });
    const r = ruleVelocityDrop(s, history([100, 100, 100, 100, 100, 100]), T);
    expect(r.value).toBeLessThan(0);
    expect(r.status).toBe('ok');
  });

  it('нулевая база → no-data (делить не на что)', () => {
    const s = sprint({ sprintId: 1, completedIssues: [], completedPoints: 10 });
    const r = ruleVelocityDrop(s, history([0, 0, 0, 0, 0, 0]), T);
    expect(r.status).toBe('no-data');
  });
});

describe('ruleCarryover', () => {
  it('доля от ВЗЯТОГО объёма (completed + carryover)', () => {
    const s = sprint({
      sprintId: 1,
      completedIssues: [issue('A', 80)],
      notCompletedIssues: [issue('B', 20)],
    });
    const r = ruleCarryover(s, T);
    expect(r.value).toBe(0.2); // 20 / (80+20)
    expect(r.status).toBe('ok'); // ровно порог
  });

  it('превышение первого порога помечается warn и несёт ключи задач', () => {
    const s = sprint({
      sprintId: 1,
      completedIssues: [issue('A', 70)],
      notCompletedIssues: [issue('B', 20), issue('C', 10)],
    });
    const r = ruleCarryover(s, T);
    expect(r.value).toBe(0.3);
    expect(r.status).toBe('warn'); // ровно второй порог 30% — ещё жёлтый
    expect(r.threshold).toBe(0.2);
    expect(r.critThreshold).toBe(0.3);
    expect(r.evidence?.issueKeys).toEqual(['B', 'C']);
  });

  it('превышение второго порога → crit', () => {
    const s = sprint({
      sprintId: 1,
      completedIssues: [issue('A', 60)],
      notCompletedIssues: [issue('B', 40)],
    });
    expect(ruleCarryover(s, T).status).toBe('crit');
  });

  it('пустой спринт → no-data, а не деление на ноль', () => {
    const s = sprint({ sprintId: 1, completedIssues: [], completedPoints: 0 });
    expect(ruleCarryover(s, T).status).toBe('no-data');
  });
});

describe('ruleReestimate', () => {
  it('считает рост оценок взятых задач', () => {
    const s = sprint({
      sprintId: 1,
      completedIssues: [issue('A', 8, [], 5), issue('B', 5, [], 5)],
    });
    const r = ruleReestimate(s, T);
    expect(r.value).toBe(0.3); // рост 3 при базе 10
    expect(r.status).toBe('crit'); // выше второго порога 20%
    expect(r.evidence?.issueKeys).toEqual(['A']);
  });

  it('в evidence даёт «было → стало» по каждой задаче, а не только прирост', () => {
    const s = sprint({
      sprintId: 1,
      completedIssues: [issue('A', 8, [], 3), issue('B', 5, [], 5)],
    });
    const grown = ruleReestimate(s, T).evidence!.issues;
    // Только выросшие; B (5→5) не попадает.
    expect(grown).toEqual([{ key: 'A', points: 5, from: 3, to: 8 }]);
  });

  it('НЕ считает переоценкой задачу, добавленную после старта (кейс ELCAS-12646)', () => {
    // Реальный кейс: у добавленной по ходу задачи нет оценки на старте (initial=null),
    // и её SP не должны выглядеть как рост оценок — иначе двойной счёт с scope-added.
    const s = sprint({
      sprintId: 1,
      completedIssues: [issue('ELCAS-12441', 2, [], 1), issue('ELCAS-12646', 1, [], null)],
      addedIssueKeys: new Set(['ELCAS-12646']),
    });
    const r = ruleReestimate(s, T);
    expect(r.evidence?.issueKeys).toEqual(['ELCAS-12441']);
    expect(r.evidence?.points).toBe(1); // только рост 1→2, без 1 SP добавленной задачи
  });

  it('задачи без оценки на старте отсеиваются (базы для сравнения нет)', () => {
    const s = sprint({ sprintId: 1, completedIssues: [issue('A', 5, [], null)] });
    expect(ruleReestimate(s, T).status).toBe('no-data');
  });

  it('снижение оценки не засчитывается как рост', () => {
    const s = sprint({ sprintId: 1, completedIssues: [issue('A', 3, [], 8)] });
    const r = ruleReestimate(s, T);
    expect(r.value).toBe(0);
    expect(r.status).toBe('ok');
  });
});

describe('ruleScopeAdded', () => {
  it('доля добавленного от объёма на старте', () => {
    const s = sprint({
      sprintId: 1,
      completedIssues: [issue('A', 80), issue('NEW', 20)],
      addedIssueKeys: new Set(['NEW']),
      allPoints: 100,
    });
    const r = ruleScopeAdded(s, T);
    expect(r.value).toBe(0.25); // 20 / (100−20)
    expect(r.status).toBe('crit'); // выше второго порога 20%
    expect(r.evidence?.issueKeys).toEqual(['NEW']);
  });

  it('ищет добавленные задачи во ВСЕХ массивах, включая punted', () => {
    const s = sprint({
      sprintId: 1,
      completedIssues: [issue('A', 90)],
      puntedIssues: [issue('NEW', 10)],
      addedIssueKeys: new Set(['NEW']),
      allPoints: 100,
    });
    expect(ruleScopeAdded(s, T).evidence?.issueKeys).toEqual(['NEW']);
  });

  it('отсутствие данных Jira → no-data, а не ok', () => {
    const s = sprint({ sprintId: 1, completedIssues: [issue('A', 10)], hasAddedData: false });
    expect(ruleScopeAdded(s, T).status).toBe('no-data');
  });

  it('ничего не добавляли → 0%, ok', () => {
    const s = sprint({ sprintId: 1, completedIssues: [issue('A', 10)], allPoints: 10 });
    const r = ruleScopeAdded(s, T);
    expect(r.value).toBe(0);
    expect(r.status).toBe('ok');
  });
});

describe('rulePunted', () => {
  it('пустой массив = выбросов не было = ok', () => {
    const s = sprint({ sprintId: 1, completedIssues: [issue('A', 5)] });
    const r = rulePunted(s, T);
    expect(r.status).toBe('ok');
    expect(r.value).toBe(0);
  });

  it('ОТСУТСТВИЕ поля ≠ пустой массив: no-data, а не ok', () => {
    const s = sprint({ sprintId: 1, completedIssues: [issue('A', 5)], hasPuntedData: false });
    expect(rulePunted(s, T).status).toBe('no-data');
  });

  it('любой выброс при первом пороге 0 → warn, с ключами и SP', () => {
    const s = sprint({
      sprintId: 1,
      completedIssues: [issue('A', 5)],
      puntedIssues: [issue('X', 3), issue('Y', 2)],
    });
    const r = rulePunted(s, T);
    expect(r.status).toBe('warn');
    expect(r.value).toBe(2);
    expect(r.evidence?.issueKeys).toEqual(['X', 'Y']);
    expect(r.evidence?.points).toBe(5);
  });

  it('больше 3 выброшенных задач (второй порог) → crit, ровно 3 — ещё warn', () => {
    const mk = (n: number) =>
      sprint({
        sprintId: 1,
        completedIssues: [issue('A', 5)],
        puntedIssues: Array.from({ length: n }, (_, i) => issue(`P${i}`, 1)),
      });
    expect(rulePunted(mk(3), T).status).toBe('warn');
    expect(rulePunted(mk(4), T).status).toBe('crit');
  });

  it('порог можно ослабить договорённостью команды', () => {
    const relaxed = { ...T, punted: 2 };
    const s = sprint({
      sprintId: 1,
      completedIssues: [issue('A', 5)],
      puntedIssues: [issue('X', 3), issue('Y', 2)],
    });
    expect(rulePunted(s, relaxed).status).toBe('ok');
  });
});

describe('healthBySprint', () => {
  it('предыдущими считает более СТАРЫЕ спринты (вход от свежих к старым)', () => {
    const sprints = [
      sprint({ sprintId: 10, completedIssues: [], completedPoints: 50 }),
      ...history([100, 100, 100, 100, 100, 100]),
    ];
    const health = healthBySprint(sprints, T);
    const drop = health.get(10)?.find((r) => r.rule === 'velocity-drop');
    expect(drop?.baseline).toBe(100);
    expect(drop?.status).toBe('crit'); // просадка 50% — за вторым порогом
  });

  it('даёт результат по каждому спринту и по каждому из 5 правил', () => {
    const sprints = [sprint({ sprintId: 1, completedIssues: [issue('A', 5)] })];
    const health = healthBySprint(sprints, T);
    expect(health.get(1)).toHaveLength(5);
  });
});

describe('grade', () => {
  it('три уровня, границы включительно', () => {
    expect(grade(0.1, 0.1, 0.2)).toBe('ok');
    expect(grade(0.15, 0.1, 0.2)).toBe('warn');
    expect(grade(0.2, 0.1, 0.2)).toBe('warn');
    expect(grade(0.21, 0.1, 0.2)).toBe('crit');
  });

  it('второй порог ниже первого не даёт красному сработать раньше жёлтого', () => {
    expect(grade(0.15, 0.2, 0.1)).toBe('ok');
    expect(grade(0.25, 0.2, 0.1)).toBe('crit');
  });
});

describe('настройки порогов', () => {
  it('дефолты — из issue #18', () => {
    expect(DEFAULT_HEALTH_SETTINGS).toEqual({
      velocityDropPct: 10,
      velocityDropCritPct: 20,
      carryoverPct: 20,
      carryoverCritPct: 30,
      reestimatePct: 10,
      reestimateCritPct: 20,
      scopeAddedPct: 10,
      scopeAddedCritPct: 20,
      puntedCount: 0,
      puntedCritCount: 3,
      velocityWindow: 6,
    });
  });

  it('настройки до v0.6 (без вторых порогов) дополняются дефолтами, свои значения сохраняются', () => {
    const legacy = {
      velocityDropPct: 15,
      carryoverPct: 25,
      reestimatePct: 10,
      scopeAddedPct: 10,
      puntedCount: 1,
      velocityWindow: 4,
    };
    const s = withHealthDefaults(legacy);
    expect(s.velocityDropPct).toBe(15);
    expect(s.carryoverCritPct).toBe(30);
    expect(s.puntedCritCount).toBe(3);
    const t = toThresholds(legacy);
    expect(t.carryover).toBe(0.25);
    expect(t.carryoverCrit).toBe(0.3);
    expect(t.velocityWindow).toBe(4);
  });

  it('мусор в storage (null, NaN, строка) не ломает сравнения', () => {
    const s = withHealthDefaults({ carryoverPct: NaN, carryoverCritPct: 'x' as unknown as number });
    expect(s.carryoverPct).toBe(20);
    expect(s.carryoverCritPct).toBe(30);
    expect(withHealthDefaults(null)).toEqual(DEFAULT_HEALTH_SETTINGS);
  });

  it('нормализация: без отрицательных, второй порог не ниже первого, штуки целые', () => {
    const n = normalizeHealthSettings({
      ...DEFAULT_HEALTH_SETTINGS,
      carryoverPct: 40,
      carryoverCritPct: 30,
      reestimatePct: -5,
      puntedCount: 1.6,
      puntedCritCount: 0,
      velocityWindow: 1,
    });
    expect(n.carryoverCritPct).toBe(40);
    expect(n.reestimatePct).toBe(0);
    expect(n.puntedCount).toBe(2);
    expect(n.puntedCritCount).toBe(2);
    expect(n.velocityWindow).toBe(2);
  });
});

describe('цвета уровней', () => {
  it('дефолты — accent-палитра ADS (жёлтый именно жёлтый, а не оранжевый warning)', () => {
    expect(DEFAULT_HEALTH_COLORS).toEqual({ ok: '#94C748', warn: '#EED12B', crit: '#F87168' });
  });

  it('свои цвета сохраняются, отсутствующие и битые заменяются дефолтами', () => {
    expect(withHealthColorDefaults({ warn: '#ffee00' })).toEqual({
      ...DEFAULT_HEALTH_COLORS,
      warn: '#ffee00',
    });
    expect(withHealthColorDefaults({ crit: 'red', ok: '#12345' })).toEqual(DEFAULT_HEALTH_COLORS);
    expect(withHealthColorDefaults(null)).toEqual(DEFAULT_HEALTH_COLORS);
  });
});
