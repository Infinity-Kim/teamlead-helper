/**
 * Команды (доски Jira) и дивизионы — группы команд для общей квартальной статистики.
 * Состав настраивается пользователем в options; здесь только модель и чистые правила.
 * Слой: core/domain (DDD), без зависимостей наружу.
 */

/** Команда = доска Jira. Идентичность — rapidViewId (уникален в пределах инстанса Jira). */
export interface TeamBoard {
  rapidViewId: number;
  /** Имя для UI, напр. "El Casino". */
  name: string;
  /** Выключенная команда остаётся в настройках, но не показывается в отчёте и сводках. */
  enabled: boolean;
  /** Ключ проекта из ссылки на доску (CORE, ELCAS) — справочно, для подсказки в UI. */
  projectKey?: string;
}

/** Дивизион — именованный набор команд (по rapidViewId). */
export interface Division {
  id: string;
  name: string;
  teamIds: number[];
}

/** Команды по умолчанию — те, что были зашиты в отчёт до появления настроек. */
export const DEFAULT_TEAMS: readonly TeamBoard[] = [
  { rapidViewId: 80, name: 'El Casino', enabled: true, projectKey: 'ELCAS' },
  { rapidViewId: 1178, name: 'POC', enabled: true, projectKey: 'PL' },
  { rapidViewId: 16, name: 'Web', enabled: true, projectKey: 'WEB' },
];

/** По умолчанию есть только Games, и в него входят все стандартные команды. */
export const DEFAULT_DIVISIONS: readonly Division[] = [
  { id: 'games', name: 'Games', teamIds: DEFAULT_TEAMS.map((t) => t.rapidViewId) },
];

/** Что удалось вытащить из пользовательского ввода «ссылка на доску или её номер». */
export interface BoardRef {
  rapidViewId: number;
  projectKey?: string;
}

/**
 * Разобрать ссылку на доску Jira или просто номер доски.
 * Поддерживаем все формы, которые Jira реально отдаёт в адресной строке:
 *  - /jira/software/c/projects/CORE/boards/20 (team-managed и company-managed, с /backlog и без);
 *  - /secure/RapidBoard.jspa?rapidView=20 (старый UI);
 *  - «20» — номер доски.
 * null — ни номера доски, ни ссылки на неё не нашлось.
 */
export function parseBoardRef(input: string): BoardRef | null {
  const raw = input.trim();
  if (/^\d+$/.test(raw)) return positive(Number(raw));

  const boards = raw.match(/\/boards\/(\d+)/);
  const rapid = raw.match(/[?&]rapidView=(\d+)/);
  const id = boards?.[1] ?? rapid?.[1];
  if (!id) return null;

  const ref = positive(Number(id));
  if (!ref) return null;
  const project = raw.match(/\/projects\/([A-Za-z][A-Za-z0-9_]*)/);
  return project ? { ...ref, projectKey: project[1].toUpperCase() } : ref;
}

function positive(n: number): BoardRef | null {
  return Number.isSafeInteger(n) && n > 0 ? { rapidViewId: n } : null;
}

/**
 * Включённые команды дивизиона в порядке списка команд (порядок задаёт пользователь в
 * настройках, а не порядок добавления в дивизион). Ссылки на удалённые команды пропускаются —
 * дивизион не ломается, если команду убрали из настроек.
 */
export function divisionTeams(division: Division, teams: readonly TeamBoard[]): TeamBoard[] {
  const ids = new Set(division.teamIds);
  return teams.filter((t) => t.enabled && ids.has(t.rapidViewId));
}

/** id для нового дивизиона: латиница из имени + суффикс, чтобы не пересечься с существующими. */
export function newDivisionId(name: string, existing: readonly Division[]): string {
  const base =
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'division';
  const taken = new Set(existing.map((d) => d.id));
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(`${base}-${i}`)) i++;
  return `${base}-${i}`;
}
