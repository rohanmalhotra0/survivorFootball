import { readFileSync } from 'node:fs';
import { mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'csv-parse/sync';
import { NFL_TEAMS } from '../shared/nfl.js';
import type { Game, ScheduleSnapshot } from '../shared/types.js';

/** Public nflverse schedule and final-results feed. Not a live score service. */
export const SCHEDULE_URL = 'https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv';
const CACHE_PATH = fileURLToPath(new URL('../data/schedule.json', import.meta.url));
const FIXTURE_PATH = fileURLToPath(new URL('./fixtures/schedule.json', import.meta.url));
const FRESH_MS = 2 * 60 * 60 * 1000;
const SOURCE = 'nflverse / nfldata';
const easternFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

function easternParts(date: Date): Record<string, number> {
  return Object.fromEntries(easternFormatter.formatToParts(date)
    .filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
}

/** nflverse kickoff times are Eastern local time, even for international games. */
export function easternToUtc(day: string, time: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !/^\d{2}:\d{2}$/.test(time)) {
    throw new Error('Invalid schedule kickoff date or time');
  }
  const [year, month, date] = day.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  if (month < 1 || month > 12 || date < 1 || date > 31 || hour > 23 || minute > 59) {
    throw new Error('Invalid schedule kickoff date or time');
  }
  if (new Date(Date.UTC(year, month - 1, date)).toISOString().slice(0, 10) !== day) {
    throw new Error('Invalid schedule calendar date');
  }
  const wallTime = Date.UTC(year, month - 1, date, hour, minute);
  let instant = wallTime;
  // Resolve the zone offset at the target instant; two passes also handle DST boundaries.
  for (let iteration = 0; iteration < 3; iteration++) {
    const p = easternParts(new Date(instant));
    const represented = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    instant += wallTime - represented;
  }
  const resolved = easternParts(new Date(instant));
  if (resolved.year !== year || resolved.month !== month || resolved.day !== date
    || resolved.hour !== hour || resolved.minute !== minute) {
    throw new Error('Schedule kickoff falls in a nonexistent Eastern local time');
  }
  return new Date(instant).toISOString();
}

function optionalNumber(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '' || value === 'NA') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

const aliases: Record<string, string> = { LA: 'LAR', STL: 'LAR', OAK: 'LV', SD: 'LAC', JAC: 'JAX' };
function teamId(abbreviation: string): string {
  const canonical = aliases[abbreviation] ?? abbreviation;
  const team = NFL_TEAMS.find(item => item.abbreviation === canonical);
  if (!team) throw new Error(`Unknown NFL team abbreviation: ${abbreviation}`);
  return team.id;
}

function seasonForDate(now: Date): number {
  const local = easternParts(now);
  return local.month <= 2 ? local.year - 1 : local.year;
}

/** Tuesday starts a new NFL week; keep Monday games within the preceding week. */
export function currentWeekForGames(games: Game[], now = new Date()): number {
  if (games.length === 0) return 1;
  const eligibleSeasons = games.map(game => game.season).filter(season => season <= seasonForDate(now));
  const activeSeason = eligibleSeasons.length ? Math.max(...eligibleSeasons) : Math.min(...games.map(game => game.season));
  const activeGames = games.filter(game => game.season === activeSeason);
  const weekStarts = new Map<number, number>();
  for (const game of activeGames) {
    const local = easternParts(new Date(game.kickoff));
    const wall = new Date(Date.UTC(local.year, local.month - 1, local.day));
    const daysSinceTuesday = (wall.getUTCDay() - 2 + 7) % 7;
    wall.setUTCDate(wall.getUTCDate() - daysSinceTuesday);
    const weekStart = Date.parse(easternToUtc(wall.toISOString().slice(0, 10), '00:00'));
    const existing = weekStarts.get(game.week);
    if (existing === undefined || weekStart < existing) weekStarts.set(game.week, weekStart);
  }
  const started = [...weekStarts.entries()].filter(([, start]) => start <= now.getTime());
  return started.length > 0 ? Math.max(...started.map(([week]) => week)) : Math.min(...weekStarts.keys());
}

export function parseScheduleCsv(csv: string, now = new Date(), retainedSeasons: number[] = []): ScheduleSnapshot {
  const rows = parse(csv, { columns: true, skip_empty_lines: true, trim: true }) as Record<string, string>[];
  if (!rows.length || !('game_id' in rows[0]) || !('gameday' in rows[0]) || !('home_team' in rows[0])) {
    throw new Error('Schedule provider returned an unexpected schema');
  }
  const targetSeason = seasonForDate(now);
  const available = [...new Set(rows.filter(row => row.game_type === 'REG').map(row => Number(row.season)))];
  const eligible = available.filter(season => Number.isInteger(season) && season <= targetSeason);
  if (!eligible.length) throw new Error('Schedule provider has no usable regular season');
  const season = Math.max(...eligible);
  const updatedAt = now.toISOString();
  const seasonsToKeep = new Set([season, ...retainedSeasons.filter(value => Number.isInteger(value) && value <= season)]);
  const games = rows.filter(row => row.game_type === 'REG' && seasonsToKeep.has(Number(row.season))).map(row => {
    const homeTeamId = teamId(row.home_team);
    const awayTeamId = teamId(row.away_team);
    const homeScore = optionalNumber(row.home_score);
    const awayScore = optionalNumber(row.away_score);
    const final = homeScore !== undefined && awayScore !== undefined;
    if (final && (!Number.isInteger(homeScore) || !Number.isInteger(awayScore) || homeScore < 0 || awayScore < 0)) {
      throw new Error('Schedule provider returned an invalid final score');
    }
    const game: Game = {
      id: row.game_id, season: Number(row.season), week: Number(row.week), homeTeamId, awayTeamId,
      kickoff: easternToUtc(row.gameday, row.gametime), status: final ? 'final' : 'scheduled',
    };
    if (!game.id || !Number.isInteger(game.week) || game.week < 1 || game.week > 18) {
      throw new Error('Schedule provider returned an invalid regular-season game');
    }
    if (final) {
      game.homeScore = homeScore;
      game.awayScore = awayScore;
      if (homeScore > awayScore) game.winnerTeamId = homeTeamId;
      if (awayScore > homeScore) game.winnerTeamId = awayTeamId;
    }
    const rawHomeMoneyline = optionalNumber(row.home_moneyline);
    const rawAwayMoneyline = optionalNumber(row.away_moneyline);
    const homeMoneyline = rawHomeMoneyline !== undefined && Math.abs(rawHomeMoneyline) >= 100 ? rawHomeMoneyline : undefined;
    const awayMoneyline = rawAwayMoneyline !== undefined && Math.abs(rawAwayMoneyline) >= 100 ? rawAwayMoneyline : undefined;
    const spread = optionalNumber(row.spread_line);
    const total = optionalNumber(row.total_line);
    if (homeMoneyline !== undefined || awayMoneyline !== undefined || spread !== undefined || total !== undefined) {
      game.odds = {
        ...(homeMoneyline && { homeMoneyline }), ...(awayMoneyline && { awayMoneyline }),
        ...(spread !== undefined && { homeSpread: -spread }), ...(total !== undefined && { total }),
        source: 'nflverse odds snapshot', updatedAt,
      };
    }
    return game;
  }).sort((a, b) => a.kickoff.localeCompare(b.kickoff));
  if (new Set(games.map(game => game.id)).size !== games.length) throw new Error('Duplicate games in schedule provider');
  return { games, season, currentWeek: currentWeekForGames(games, now), updatedAt, source: SOURCE, stale: false };
}

function isSnapshot(value: unknown): value is ScheduleSnapshot {
  if (!value || typeof value !== 'object') return false;
  const snapshot = value as ScheduleSnapshot;
  return Array.isArray(snapshot.games) && snapshot.games.length > 0
    && Number.isInteger(snapshot.season) && typeof snapshot.source === 'string'
    && snapshot.games.every(game => typeof game.id === 'string' && Number.isFinite(Date.parse(game.kickoff))
      && typeof game.homeTeamId === 'string' && typeof game.awayTeamId === 'string');
}

function loadCached(): ScheduleSnapshot {
  for (const path of [CACHE_PATH, FIXTURE_PATH]) {
    try {
      const candidate: unknown = JSON.parse(readFileSync(path, 'utf8'));
      if (isSnapshot(candidate)) return { ...candidate, stale: true };
    } catch { /* A missing/corrupt cache must not prevent startup. */ }
  }
  return { games: [], season: seasonForDate(new Date()), currentWeek: 1, updatedAt: null, source: SOURCE, stale: true };
}

let cached = loadCached();
let refreshInFlight: Promise<ScheduleSnapshot> | null = null;

export function getSchedule(): ScheduleSnapshot {
  const now = new Date();
  const timestamp = cached.updatedAt ? Date.parse(cached.updatedAt) : 0;
  return {
    ...cached, currentWeek: currentWeekForGames(cached.games, now),
    stale: cached.stale || !timestamp || now.getTime() - timestamp > FRESH_MS || cached.season !== seasonForDate(now),
  };
}

/** Atomic replacement with an independent temporary file for every process and refresh. */
export async function writeScheduleCache(snapshot: ScheduleSnapshot, cachePath = CACHE_PATH): Promise<void> {
  await mkdir(dirname(cachePath), { recursive: true });
  const temporary = `${cachePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(snapshot, null, 2), { mode: 0o600, flag: 'wx' });
    await rename(temporary, cachePath);
  } finally {
    // On failure, remove only this writer's temporary file and preserve the last good cache.
    // Successful rename has already removed the temporary name. Cleanup cannot mask errors.
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

/** Keep the last good snapshot on network/schema errors. Never log provider credentials. */
export function syncSchedule(): Promise<ScheduleSnapshot> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      const response = await fetch(SCHEDULE_URL, { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`Schedule provider HTTP ${response.status}`);
      const text = await response.text();
      if (text.length > 20_000_000) throw new Error('Schedule response exceeded size limit');
      const retainedSeasons = [...new Set(cached.games.map(game => game.season))];
      const next = parseScheduleCsv(text, new Date(), retainedSeasons);
      // Preserve historical games if upstream temporarily omits a retained season.
      const receivedSeasons = new Set(next.games.map(game => game.season));
      next.games.push(...cached.games.filter(game => !receivedSeasons.has(game.season) && game.season < next.season));
      if (!next.games.length) throw new Error('Schedule provider returned no games');
      await writeScheduleCache(next);
      cached = next;
    } catch (error) {
      cached = { ...cached, stale: true };
      const reason = error instanceof Error ? error.message : 'Unknown provider error';
      console.warn(`[schedule] Refresh failed; retaining cached data: ${reason}`);
    } finally {
      refreshInFlight = null;
    }
    return getSchedule();
  })();
  return refreshInFlight;
}
