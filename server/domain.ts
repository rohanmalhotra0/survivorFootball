/** All calendar boundaries are America/New_York, including daylight saving time. */
export const LEAGUE_TIME_ZONE = 'America/New_York';

export type GameStatus = 'scheduled' | 'in_progress' | 'final' | 'postponed' | 'canceled';
export interface SurvivorGame {
  id: string;
  season: number;
  week: number;
  homeTeamId: string;
  awayTeamId: string;
  kickoff: string;
  status: GameStatus;
  homeScore?: number | null;
  awayScore?: number | null;
  winnerTeamId?: string | null;
}

export function newYorkDate(date: Date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: LEAGUE_TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
    minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  return Object.fromEntries(parts.filter(p => p.type !== 'literal').map(p => [p.type, Number(p.value)])) as {
    year: number; month: number; day: number; hour: number; minute: number; second: number;
  };
}

function zonedDate(year: number, month: number, day: number, hour: number): Date {
  const local = Date.UTC(year, month - 1, day, hour);
  let utc = local;
  for (let i = 0; i < 3; i++) {
    const actual = newYorkDate(new Date(utc));
    utc += local - Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second);
  }
  return new Date(utc);
}

/** NFL regular-season week one follows Labor Day; the reveal is its Sunday at 1 pm ET. */
export function revealAtForWeek(season: number, week: number): Date {
  const septemberFirst = new Date(Date.UTC(season, 8, 1));
  const laborDay = 1 + ((8 - septemberFirst.getUTCDay()) % 7);
  const sunday = new Date(Date.UTC(season, 8, laborDay + 6 + (week - 1) * 7));
  return zonedDate(sunday.getUTCFullYear(), sunday.getUTCMonth() + 1, sunday.getUTCDate(), 13);
}

export function seasonContext(now: Date): { season: number; week: number } {
  const local = newYorkDate(now);
  const season = local.month < 3 ? local.year - 1 : local.year;
  // Compare local calendar boundaries: elapsed-millisecond arithmetic drifts at DST.
  for (let week = 18; week >= 2; week--) {
    const sunday = newYorkDate(revealAtForWeek(season, week));
    const tuesday = new Date(Date.UTC(sunday.year, sunday.month - 1, sunday.day - 5));
    const starts = zonedDate(tuesday.getUTCFullYear(), tuesday.getUTCMonth() + 1, tuesday.getUTCDate(), 0);
    if (now >= starts) return { season, week };
  }
  return { season, week: 1 };
}

export function isRevealed(season: number, week: number, now: Date): boolean {
  return now.getTime() >= revealAtForWeek(season, week).getTime();
}

export function isGameLocked(game: SurvivorGame, now: Date): boolean {
  const kickoff = new Date(game.kickoff).getTime();
  return game.status !== 'scheduled' || !Number.isFinite(kickoff) || kickoff <= now.getTime();
}

export type PickResult = 'pending' | 'win' | 'loss' | 'tie' | 'void';

export function resolvePick(game: SurvivorGame | undefined, teamId: string): PickResult {
  if (!game) return 'pending';
  if (game.status === 'canceled') return 'void';
  if (game.status !== 'final') return 'pending';
  if (typeof game.homeScore !== 'number' || typeof game.awayScore !== 'number') return 'pending';
  if (game.homeScore === game.awayScore) return 'tie';
  const winner = game.homeScore > game.awayScore ? game.homeTeamId : game.awayTeamId;
  return winner === teamId ? 'win' : 'loss';
}

export function publicError(message: string, status = 400) {
  return Object.assign(new Error(message), { status });
}
