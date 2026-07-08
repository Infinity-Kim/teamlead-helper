import { describe, it, expect } from 'vitest';
import {
  labelsToBuckets,
  extractStoryPoints,
  mapIssue,
  mapSprint,
  extractStatusTransitions,
} from './mappers';
import type { GhBacklogIssueDto } from './dto';

describe('labelsToBuckets', () => {
  it('нормализует CAP-лейблы регистронезависимо', () => {
    expect(labelsToBuckets(['CAP_Product', 'cap_support'])).toEqual(['Product', 'Support']);
  });
  it('игнорирует не-CAP лейблы', () => {
    expect(labelsToBuckets(['template', 'QA_AQA', 'CAP_Tech'])).toEqual(['Tech']);
  });
  it('пусто → []', () => {
    expect(labelsToBuckets([])).toEqual([]);
    expect(labelsToBuckets(undefined)).toEqual([]);
  });
});

describe('extractStoryPoints', () => {
  const base: GhBacklogIssueDto = { id: 1, key: 'X-1', typeHierarchyLevel: 0 };
  it('берёт численное value', () => {
    expect(
      extractStoryPoints({
        ...base,
        estimateStatistic: {
          statFieldId: 'customfield_10033',
          statFieldValue: { value: 3, text: '3' },
        },
      }),
    ).toBe(3);
  });
  it('пустая оценка → 0', () => {
    expect(
      extractStoryPoints({
        ...base,
        estimateStatistic: { statFieldId: 'customfield_10033', statFieldValue: { text: '' } },
      }),
    ).toBe(0);
    expect(extractStoryPoints(base)).toBe(0);
  });
});

describe('mapIssue / mapSprint', () => {
  it('маппит реальную задачу ELCAS-8135', () => {
    const issue = mapIssue({
      id: 169001,
      key: 'ELCAS-8135',
      typeHierarchyLevel: 0,
      labels: ['CAP_Support'],
      sprintIds: [],
      estimateStatistic: {
        statFieldId: 'customfield_10033',
        statFieldValue: { value: 3, text: '3' },
      },
      statusName: 'Ready for DEV',
      status: { statusCategory: { key: 'indeterminate' } },
    });
    expect(issue).toEqual({
      id: 169001,
      key: 'ELCAS-8135',
      storyPoints: 3,
      capBuckets: ['Support'],
      sprintIds: [],
      hierarchyLevel: 0,
      statusName: 'Ready for DEV',
      statusCategory: 'indeterminate',
    });
  });

  it('неизвестная категория статуса → unknown, пустой статус → пустая строка', () => {
    const issue = mapIssue({ id: 1, key: 'X-1', typeHierarchyLevel: 0 });
    expect(issue.statusName).toBe('');
    expect(issue.statusCategory).toBe('unknown');
  });

  it('нормализует state спринта', () => {
    expect(mapSprint({ id: 8173, name: 'ELCAS-26.6.2', state: 'ACTIVE' }).state).toBe('ACTIVE');
    expect(mapSprint({ id: 1, name: 'S', state: 'weird' }).state).toBe('FUTURE');
  });
});

describe('extractStatusTransitions', () => {
  it('вытаскивает только переходы статуса из changelog', () => {
    const tr = extractStatusTransitions({
      changelog: {
        histories: [
          {
            created: '2026-07-02T17:06:37.777+0300',
            items: [
              { field: 'status', fromString: 'Ready for DEV', toString: 'DEV' },
              { field: 'assignee', toString: 'кто-то' }, // не статус — игнор
            ],
          },
          {
            created: '2026-07-05T10:00:00+0300',
            items: [{ field: 'status', fromString: 'DEV', toString: 'Testing' }],
          },
        ],
      },
    });
    expect(tr).toEqual([
      { at: '2026-07-02T17:06:37.777+0300', to: 'DEV' },
      { at: '2026-07-05T10:00:00+0300', to: 'Testing' },
    ]);
  });

  it('пустой changelog → []', () => {
    expect(extractStatusTransitions({})).toEqual([]);
  });
});
