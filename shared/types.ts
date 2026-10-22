export interface User { id: string; name: string; email: string }
export interface League { id: string; name: string; inviteCode?: string; season: number; startWeek: number; memberCount: number; role: 'commissioner' | 'member'; createdAt: string }
export interface Odds { homeMoneyline?: number; awayMoneyline?: number; homeSpread?: number; total?: number; source: string; updatedAt: string }
export interface Game { id: string; season: number; week: number; homeTeamId: string; awayTeamId: string; kickoff: string; status: 'scheduled' | 'in_progress' | 'final' | 'postponed' | 'canceled'; homeScore?: number; awayScore?: number; winnerTeamId?: string; odds?: Odds }
export interface ScheduleSnapshot { games: Game[]; season: number; currentWeek: number; updatedAt: string | null; source: string; stale: boolean }
export type PickStatus = 'pending' | 'win' | 'loss' | 'tie' | 'missed' | 'void';
export interface Pick { teamId: string; gameId: string; status: PickStatus; week?: number; locked?: boolean }
export interface PickHistory { week: number; teamId?: string; gameId?: string; status: PickStatus | 'hidden' }
export interface Member { id: string; name: string; status: 'alive' | 'eliminated' | 'winner'; eliminatedWeek?: number; pick: Pick | null; pickState: 'hidden' | 'submitted' | 'missing' | 'revealed'; history: PickHistory[] }
export interface Dashboard { league: League; season: number; week: number; revealAt: string; picksRevealed: boolean; games: Game[]; members: Member[]; myPick: Pick | null; usedTeamIds: string[]; currentUserId?: string; currentWeek?: number; oddsUpdatedAt?: string | null; dataSource?: string; dataStale?: boolean; demo?: boolean }
