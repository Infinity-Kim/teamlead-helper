import type { QuarterId, SprintReportDetail } from '@/core/domain';
import {
  aggregateCapBreakdown,
  groupSprintsByQuarter,
  type CapBreakdown,
} from './sprint-report-stats';

/**
 * Квартальная статистика дивизиона — сумма по командам. ЧИСТЫЕ функции. Слой: core/metrics.
 *
 * Правила те же, что у отчёта одной команды (sprint-report-stats), чтобы цифры дивизиона
 * сходились с суммой цифр команд:
 *  - спринт относится к кварталу по дате СТАРТА, целиком;
 *  - CAP-микс — по completedIssues, проценты от всего completed (вкл. «Без метки»).
 */

/** Исходные данные одной команды: закрытые спринты от свежих к старым. */
export interface TeamSprints {
  rapidViewId: number;
  team: string;
  sprints: SprintReportDetail[];
}

/** Вклад одной команды в квартал. */
export interface TeamQuarterStats {
  rapidViewId: number;
  team: string;
  sprintCount: number;
  completedSp: number;
  /** Средний объём закрытого за спринт, SP. null — в квартале у команды нет спринтов. */
  spPerSprint: number | null;
  breakdown: CapBreakdown;
}

/** Квартал дивизиона: итог по всем командам + строка на каждую команду. */
export interface DivisionQuarter {
  quarter: QuarterId;
  sprintCount: number;
  completedSp: number;
  breakdown: CapBreakdown;
  /** Все команды дивизиона в исходном порядке — и те, у кого в квартале не было спринтов. */
  teams: TeamQuarterStats[];
}

const round1 = (n: number) => +n.toFixed(1);

/**
 * Сложить команды по кварталам. Кварталы — от НОВЫХ к старым (как на странице команды).
 * Команда без спринтов в квартале остаётся строкой с нулями: пропуск читался бы как
 * «команды нет в дивизионе», а не как «команда в этом квартале ничего не закрыла».
 */
export function divisionQuarters(teams: readonly TeamSprints[]): DivisionQuarter[] {
  const perTeam = teams.map((t) => ({
    team: t,
    byQuarter: new Map(groupSprintsByQuarter(t.sprints).map((q) => [q.quarter, q])),
  }));

  const quarters = new Set<QuarterId>();
  for (const t of perTeam) for (const q of t.byQuarter.keys()) quarters.add(q);

  return [...quarters]
    .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
    .map((quarter) => {
      const rows: TeamQuarterStats[] = perTeam.map(({ team, byQuarter }) => {
        const sprints = byQuarter.get(quarter)?.sprints ?? [];
        const completedSp = round1(sprints.reduce((s, d) => s + d.completedPoints, 0));
        return {
          rapidViewId: team.rapidViewId,
          team: team.team,
          sprintCount: sprints.length,
          completedSp,
          spPerSprint: sprints.length ? round1(completedSp / sprints.length) : null,
          breakdown: aggregateCapBreakdown(sprints),
        };
      });
      const all = perTeam.flatMap(({ byQuarter }) => byQuarter.get(quarter)?.sprints ?? []);
      return {
        quarter,
        sprintCount: all.length,
        completedSp: round1(rows.reduce((s, r) => s + r.completedSp, 0)),
        breakdown: aggregateCapBreakdown(all),
        teams: rows,
      };
    });
}
