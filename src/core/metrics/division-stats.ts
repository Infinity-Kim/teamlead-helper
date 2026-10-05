import type { QuarterId, SprintReportDetail, TeamCalendar } from '@/core/domain';
import {
  aggregateCapBreakdown,
  groupSprintsByQuarter,
  type CapBreakdown,
} from './sprint-report-stats';
import { completionRates, type CompletionRates } from './sprint-completion';
import { sprintsLeftInQuarter, teamCalendar } from './team-quarter';

/**
 * Квартальная статистика дивизиона — сумма по командам. ЧИСТЫЕ функции. Слой: core/metrics.
 *
 * Правила те же, что у отчёта одной команды (sprint-report-stats), чтобы цифры дивизиона
 * сходились с суммой цифр команд:
 *  - спринт относится к кварталу команды по дате старта, целиком (team-quarter);
 *  - CAP-микс — по completedIssues, проценты от всего completed (вкл. «Без метки»).
 */

/** Исходные данные одной команды: закрытые спринты от свежих к старым. */
export interface TeamSprints {
  rapidViewId: number;
  team: string;
  sprints: SprintReportDetail[];
  /** Календарь команды по всей истории доски. Нет — строится из `sprints`. */
  calendar?: TeamCalendar;
}

/** Вклад одной команды в квартал. */
export interface TeamQuarterStats {
  rapidViewId: number;
  team: string;
  sprintCount: number;
  /** Сколько спринтов команды ещё закончится в квартале после последнего закрытого. */
  sprintsLeft: number;
  completedSp: number;
  /** Средний объём закрытого за спринт, SP. null — в квартале у команды нет спринтов. */
  spPerSprint: number | null;
  breakdown: CapBreakdown;
  /** Закрыто от взятого на старте и от итогового объёма спринтов. */
  completion: CompletionRates;
}

/** Квартал дивизиона: итог по всем командам + строка на каждую команду. */
export interface DivisionQuarter {
  quarter: QuarterId;
  sprintCount: number;
  completedSp: number;
  breakdown: CapBreakdown;
  completion: CompletionRates;
  /** Все команды дивизиона в исходном порядке — и те, у кого в квартале не было спринтов. */
  teams: TeamQuarterStats[];
}

const round1 = (n: number) => +n.toFixed(1);

/** Сколько спринтов квартала впереди у команды — после её самого свежего спринта в квартале. */
function lastSprintsLeft(sprints: readonly SprintReportDetail[], cal: TeamCalendar): number {
  if (sprints.length === 0) return 0;
  const last = sprints.reduce((a, s) =>
    Date.parse(s.isoStartDate ?? '') > Date.parse(a.isoStartDate ?? '') ? s : a,
  );
  return sprintsLeftInQuarter(last.isoStartDate, cal);
}

/**
 * Сложить команды по кварталам. Кварталы — от НОВЫХ к старым (как на странице команды).
 * Команда без спринтов в квартале остаётся строкой с нулями: пропуск читался бы как
 * «команды нет в дивизионе», а не как «команда в этом квартале ничего не закрыла».
 */
export function divisionQuarters(teams: readonly TeamSprints[]): DivisionQuarter[] {
  const perTeam = teams.map((t) => {
    const calendar = t.calendar ?? teamCalendar(t.sprints.map((d) => d.isoStartDate));
    return {
      team: t,
      calendar,
      byQuarter: new Map(groupSprintsByQuarter(t.sprints, calendar).map((q) => [q.quarter, q])),
    };
  });

  const quarters = new Set<QuarterId>();
  for (const t of perTeam) for (const q of t.byQuarter.keys()) quarters.add(q);

  return [...quarters]
    .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
    .map((quarter) => {
      const rows: TeamQuarterStats[] = perTeam.map(({ team, calendar, byQuarter }) => {
        const sprints = byQuarter.get(quarter)?.sprints ?? [];
        const completedSp = round1(sprints.reduce((s, d) => s + d.completedPoints, 0));
        return {
          rapidViewId: team.rapidViewId,
          team: team.team,
          sprintCount: sprints.length,
          sprintsLeft: lastSprintsLeft(sprints, calendar),
          completedSp,
          spPerSprint: sprints.length ? round1(completedSp / sprints.length) : null,
          breakdown: aggregateCapBreakdown(sprints),
          completion: completionRates(sprints),
        };
      });
      const all = perTeam.flatMap(({ byQuarter }) => byQuarter.get(quarter)?.sprints ?? []);
      return {
        quarter,
        sprintCount: all.length,
        completedSp: round1(rows.reduce((s, r) => s + r.completedSp, 0)),
        breakdown: aggregateCapBreakdown(all),
        completion: completionRates(all),
        teams: rows,
      };
    });
}
