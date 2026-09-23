import { describe, it, expect } from 'vitest';
import { parseBoardRef, divisionTeams, newDivisionId, type TeamBoard } from './team';

describe('parseBoardRef', () => {
  it('ссылка на доску из адресной строки Jira', () => {
    expect(
      parseBoardRef('https://tvbet.atlassian.net/jira/software/c/projects/CORE/boards/20'),
    ).toEqual({ rapidViewId: 20, projectKey: 'CORE' });
  });

  it('ссылка на backlog с параметрами', () => {
    expect(
      parseBoardRef(
        'https://x.atlassian.net/jira/software/projects/elcas/boards/80/backlog?label=CAP_Tech',
      ),
    ).toEqual({ rapidViewId: 80, projectKey: 'ELCAS' });
  });

  it('старый UI RapidBoard', () => {
    expect(parseBoardRef('https://x.atlassian.net/secure/RapidBoard.jspa?rapidView=16')).toEqual({
      rapidViewId: 16,
    });
  });

  it('просто номер доски', () => {
    expect(parseBoardRef(' 1178 ')).toEqual({ rapidViewId: 1178 });
  });

  it('мусор и ноль — null', () => {
    expect(parseBoardRef('')).toBeNull();
    expect(parseBoardRef('0')).toBeNull();
    expect(parseBoardRef('https://x.atlassian.net/browse/CORE-1')).toBeNull();
  });
});

describe('divisionTeams', () => {
  const teams: TeamBoard[] = [
    { rapidViewId: 1, name: 'A', enabled: true },
    { rapidViewId: 2, name: 'B', enabled: false },
    { rapidViewId: 3, name: 'C', enabled: true },
  ];

  it('берёт только включённые команды в порядке списка команд', () => {
    const d = { id: 'd', name: 'D', teamIds: [3, 2, 1] };
    expect(divisionTeams(d, teams).map((t) => t.name)).toEqual(['A', 'C']);
  });

  it('пропускает ссылки на удалённые команды', () => {
    expect(divisionTeams({ id: 'd', name: 'D', teamIds: [99, 1] }, teams)).toHaveLength(1);
  });
});

describe('newDivisionId', () => {
  it('slug из имени и суффикс при совпадении', () => {
    expect(newDivisionId('Games', [])).toBe('games');
    expect(newDivisionId('Games', [{ id: 'games', name: 'Games', teamIds: [] }])).toBe('games-2');
  });

  it('кириллическое имя — запасной id', () => {
    expect(newDivisionId('Платформа', [])).toBe('division');
  });
});
