import { describe, it, expect } from 'vitest';
import {
  ruleVelocityDrop,
  ruleCarryover,
  ruleReestimate,
  ruleScopeAdded,
  rulePunted,
  healthBySprint,
  healthSummary,
  toThresholds,
  type HealthThresholds,
} from './sprint-health';
import { issue, sprint } from './__test-helpers__/sprint-fixtures';

/** Пороги по умолчанию (как в настройках расширения): 10/20/10/10/0, окно 6. */
const T: HealthThresholds = toThresholds({
  velocityDropPct: 10,
  carryoverPct: 20,
  reestimatePct: 10,
  scopeAddedPct: 10,
  puntedCount: 0,
  velocityWindow: 6,
});

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
    expect(r.status).toBe('warn');
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

  it('просадка на 10.1% нарушает', () => {
    const s = sprint({ sprintId: 1, completedIssues: [], completedPoints: 89.9 });
    const r = ruleVelocityDrop(s, history([100, 100, 100, 100, 100, 100]), T);
    expect(r.status).toBe('warn');
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

  it('превышение порога помечается warn и несёт ключи задач', () => {
    const s = sprint({
      sprintId: 1,
      completedIssues: [issue('A', 70)],
      notCompletedIssues: [issue('B', 20), issue('C', 10)],
    });
    const r = ruleCarryover(s, T);
    expect(r.value).toBe(0.3);
    expect(r.status).toBe('warn');
    expect(r.evidence?.issueKeys).toEqual(['B', 'C']);
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
    expect(r.status).toBe('warn');
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
    expect(r.status).toBe('warn');
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

  it('любой выброс при пороге 0 → warn, с ключами и SP', () => {
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
    expect(drop?.status).toBe('warn');
  });

  it('даёт результат по каждому спринту и по каждому из 5 правил', () => {
    const sprints = [sprint({ sprintId: 1, completedIssues: [issue('A', 5)] })];
    const health = healthBySprint(sprints, T);
    expect(health.get(1)).toHaveLength(5);
  });
});

describe('healthSummary', () => {
  it('считает нарушения и отделяет их от неоценённых спринтов', () => {
    // Свежий спринт просел вдвое; у остальных нет полной истории → insufficient-history.
    const sprints = [
      sprint({ sprintId: 10, completedIssues: [], completedPoints: 50 }),
      ...history([100, 100, 100, 100, 100, 100]),
    ];
    const summary = healthSummary(sprints, T, 6);
    const drop = summary.find((s) => s.rule === 'velocity-drop')!;
    expect(drop.warnCount).toBe(1);
    expect(drop.evaluated).toBe(1); // остальные 5 — insufficient-history
  });

  it('тренд разворачивается в хронологию (старые слева)', () => {
    const sprints = [
      sprint({ sprintId: 2, completedIssues: [issue('A', 90)], notCompletedIssues: [issue('B', 10)] }),
      sprint({ sprintId: 1, completedIssues: [issue('C', 50)], notCompletedIssues: [issue('D', 50)] }),
    ];
    const carry = healthSummary(sprints, T, 6).find((s) => s.rule === 'carryover')!;
    // sprintId=1 старше → его 50% идут первыми, свежие 10% — последними.
    expect(carry.trend).toEqual([0.5, 0.1]);
  });
});
