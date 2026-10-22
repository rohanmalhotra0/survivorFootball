import type { Dashboard as ServerDashboard, League as ServerLeague } from '../shared/types';
import type { Dashboard, Pick, User } from './view-model';
import { getDemoDashboard } from './demo';

export class ApiError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...options,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...options?.headers },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data.error?.message || data.error || data.message;
    throw new ApiError(typeof message === 'string' ? message : 'Something went wrong. Please try again.', response.status);
  }
  return data as T;
}

const resultName = (status: string) => status === 'win' ? 'won' : status === 'loss' ? 'lost' : status;

export function normalizeDashboard(data: ServerDashboard, user: User | null, leagues: ServerLeague[] = []): Dashboard {
  const me = data.members.find(member => member.id === data.currentUserId);
  const history: Pick[] = (me?.history || [])
    .filter(pick => pick.teamId)
    .map(pick => ({ week: pick.week, teamId: pick.teamId!, result: resultName(pick.status), gameId: pick.gameId }));
  return {
    ...data,
    demo: !!data.demo,
    user,
    leagues,
    members: data.members.map(member => ({
      id: member.id,
      name: member.name,
      status: member.status === 'alive' ? 'active' : member.status,
      isYou: member.id === data.currentUserId,
      weeksSurvived: member.history.filter(pick => pick.status === 'win').length,
      pick: {
        hidden: member.pickState === 'hidden',
        submitted: member.pickState === 'submitted' || member.pickState === 'revealed',
        teamId: member.pick?.teamId,
        result: member.pick?.status,
      },
    })),
    myPicks: history,
    myPick: data.myPick ? {
      week: data.week,
      teamId: data.myPick.teamId,
      result: resultName(data.myPick.status),
      gameId: data.myPick.gameId,
      locked: data.myPick.locked,
    } : null,
    dataWarning: data.dataStale ? 'Schedule data is cached. Automatic refresh will retry when the provider is available.' : undefined,
    games: data.games.map(game => ({ ...game, odds: game.odds ? { ...game.odds, spread: game.odds.homeSpread } : undefined })),
  };
}

export function emptyDashboard(user: User): Dashboard {
  return {
    ...getDemoDashboard(),
    demo: false,
    user,
    league: null,
    leagues: [],
    members: [],
    myPicks: [],
    myPick: null,
    usedTeamIds: [],
  };
}

export async function fetchDemoDashboard(week?: number, signal?: AbortSignal): Promise<Dashboard> {
  try {
    return normalizeDashboard(await request<ServerDashboard>(`/api/demo${week ? `?week=${week}` : ''}`, { signal }), null);
  } catch (error) {
    if (signal?.aborted) throw error;
    return getDemoDashboard();
  }
}

export async function fetchDashboard(user: User, leagueId?: string, week?: number, signal?: AbortSignal): Promise<Dashboard> {
  const { leagues } = await request<{ leagues: ServerLeague[] }>('/api/leagues', { signal });
  const selected = leagues.find(league => league.id === leagueId) || leagues[0];
  if (!selected) return emptyDashboard(user);
  const data = await request<ServerDashboard>(`/api/leagues/${encodeURIComponent(selected.id)}${week ? `?week=${week}` : ''}`, { signal });
  return normalizeDashboard(data, user, leagues);
}
