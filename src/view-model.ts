export type Team = { id: string; abbreviation: string; name: string; city: string; color: string; logo: string };
export type Game = { id: string; homeTeamId: string; awayTeamId: string; kickoff: string; status: string; homeScore?: number | null; awayScore?: number | null; odds?: { homeMoneyline?: number | null; awayMoneyline?: number | null; spread?: number | null; source?: string; updatedAt?: string } | null };
export type Member = { id: string; name: string; status: string; joinedAt?: string; weeksSurvived?: number; pick?: { teamId?: string | null; hidden?: boolean; submitted?: boolean; result?: string } | null; isYou?: boolean };
export type Pick = { week: number; teamId: string; result: string; gameId?: string; season?: number; locked?: boolean };
export type League = { id: string; name: string; inviteCode?: string; season: number; startWeek?: number; memberCount?: number };
export type User = { id: string; name: string; email: string };
export type Dashboard = { demo: boolean; user: User | null; league: League | null; leagues: League[]; season: number; week: number; revealAt: string; picksRevealed: boolean; games: Game[]; members: Member[]; myPicks: Pick[]; myPick: Pick | null; usedTeamIds: string[]; oddsUpdatedAt?: string | null; dataSource?: string; dataWarning?: string; deadline?: string };
