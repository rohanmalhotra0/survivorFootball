import type { Dashboard, Member, PickHistory, ScheduleSnapshot } from '../shared/types.js';
import { revealAtForWeek } from './domain.js';

/** A read-only illustrative league. NFL games and odds come from the real schedule feed. */
export function createDemoDashboard(snapshot: ScheduleSnapshot, selectedWeek?: number): Dashboard {
  const week = Number.isInteger(selectedWeek) && selectedWeek! >= 1 && selectedWeek! <= 18 ? selectedWeek! : snapshot.currentWeek;
  const season = snapshot.season;
  const revealAt = revealAtForWeek(season, week).toISOString();
  const picksRevealed = Date.now() >= Date.parse(revealAt);
  const games = snapshot.games.filter(game => game.season === season && game.week === week);
  const names = ['You', 'Jordan Mitchell', 'Alex Rivera', 'Sam Carter', 'Taylor Brooks', 'Chris Parker', 'Morgan Lee', 'Drew Wilson', 'Jamie Collins', 'Casey Reed', 'Riley James', 'Blake Turner'];
  const members: Member[] = names.map((name, index) => {
    const history: PickHistory[] = [];
    const used = new Set<string>();
    const eliminatedWeek = index > 8 ? Math.max(1, Math.min(week - 1, index - 7)) : undefined;
    for (let w = 1; w < week; w++) {
      if (eliminatedWeek && w > eliminatedWeek) break;
      const eligible = snapshot.games.filter(g => g.season === season && g.week === w && g.status === 'final');
      const game = eligible.find((g, i) => !used.has(g.winnerTeamId || g.homeTeamId) && i >= index % 4) || eligible.find(g => !used.has(g.winnerTeamId || g.homeTeamId));
      if (!game) continue;
      let teamId = game.winnerTeamId || game.homeTeamId;
      if (w === eliminatedWeek) teamId = teamId === game.homeTeamId ? game.awayTeamId : game.homeTeamId;
      if (used.has(teamId)) continue;
      used.add(teamId);
      history.push({ week: w, teamId, gameId: game.id, status: w === eliminatedWeek ? 'loss' : 'win' });
    }
    const selection = index && !eliminatedWeek ? games.find((g, i) => i >= index % Math.max(games.length, 1) && (!used.has(g.homeTeamId) || !used.has(g.awayTeamId))) : undefined;
    const pickedTeam = selection ? (!used.has(selection.homeTeamId) ? selection.homeTeamId : selection.awayTeamId) : undefined;
    const pick = selection && pickedTeam && picksRevealed ? { teamId: pickedTeam, gameId: selection.id, status: 'pending' as const } : null;
    return { id: index === 0 ? 'demo-you' : `demo-${index}`, name, status: eliminatedWeek ? 'eliminated' : 'alive', eliminatedWeek, pick, pickState: index === 0 || eliminatedWeek ? 'missing' : picksRevealed ? 'revealed' : 'hidden', history };
  });
  return {
    demo: true,
    currentUserId: 'demo-you',
    currentWeek: snapshot.currentWeek,
    league: { id: 'demo', name: 'The Sunday Club', inviteCode: 'DEMO', season, startWeek: 1, memberCount: members.length, role: 'member', createdAt: `${season}-09-01T00:00:00.000Z` },
    season, week, revealAt, picksRevealed, games, members, myPick: null,
    usedTeamIds: members[0].history.flatMap(p => p.teamId ? [p.teamId] : []),
    oddsUpdatedAt: snapshot.updatedAt, dataSource: snapshot.source, dataStale: snapshot.stale,
  };
}
