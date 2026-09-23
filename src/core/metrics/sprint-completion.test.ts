import { describe, it, expect } from 'vitest';
import { sprintCompletion, completionRates } from './sprint-completion';
import { issue, sprint } from './__test-helpers__/sprint-fixtures';

/** Спринт из примера: взяли 75, докинули 10 (стало 85), закрыли 80, переехало 5. */
function example(id = 1) {
  return sprint({
    sprintId: id,
    completedIssues: [issue('A', 40), issue('B', 30), issue('ADD', 10, [], null)],
    notCompletedIssues: [issue('C', 5)],
    addedIssueKeys: new Set(['ADD']),
  });
}

describe('sprintCompletion', () => {
  it('взяли / стало / закрыли по примеру 75 → 85 → 80', () => {
    expect(sprintCompletion(example())).toEqual({
      startPoints: 75,
      finalPoints: 85,
      completedPoints: 80,
    });
  });

  it('база старта — оценки на старте, а не текущие (рост оценки в «взяли» не входит)', () => {
    const s = sprint({ sprintId: 1, completedIssues: [issue('A', 8, [], 5)] });
    expect(sprintCompletion(s).startPoints).toBe(5);
  });

  it('выброшенные после старта входят во взятое — их обещали', () => {
    const s = sprint({
      sprintId: 1,
      completedIssues: [issue('A', 5)],
      puntedIssues: [issue('P', 3)],
    });
    expect(sprintCompletion(s)).toMatchObject({ startPoints: 8, finalPoints: 5 });
  });

  it('задача в двух массивах считается один раз', () => {
    const s = sprint({
      sprintId: 1,
      completedIssues: [issue('A', 5)],
      completedInAnotherSprintIssues: [issue('A', 5)],
    });
    expect(sprintCompletion(s).startPoints).toBe(5);
  });
});

describe('completionRates', () => {
  it('проценты от взятого и от итога по примеру', () => {
    const r = completionRates([example()]);
    expect(r.ofStart).toBe(1.067);
    expect(r.ofFinal).toBe(0.941);
  });

  it('за период — отношение сумм, а не среднее процентов', () => {
    const small = sprint({ sprintId: 2, completedIssues: [issue('S', 0, [], 10)] }); // 0 из 10
    const r = completionRates([example(), small]); // 80 / (75 + 10)
    expect(r.ofStart).toBe(0.941);
  });

  it('нет базы — null, а не 0 и не деление на ноль', () => {
    expect(completionRates([])).toMatchObject({ ofStart: null, ofFinal: null });
  });
});
