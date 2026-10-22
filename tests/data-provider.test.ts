import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseScheduleCsv, easternToUtc, currentWeekForGames, writeScheduleCache } from '../server/data-provider.js';
import type { ScheduleSnapshot } from '../shared/types.js';

const headers = ['game_id', 'season', 'game_type', 'week', 'gameday', 'gametime', 'away_team', 'home_team', 'away_score', 'home_score', 'away_moneyline', 'home_moneyline', 'spread_line', 'total_line'];
const csv = (rows: string[][]) => [headers.join(','), ...rows.map(row => row.join(','))].join('\n');
const row = (values: Record<string, string> = {}) => {
  const data: Record<string, string> = {
  game_id: '2026_07_NE_CHI', season: '2026', game_type: 'REG', week: '7', gameday: '2026-10-22',
  gametime: '20:15', away_team: 'NE', home_team: 'CHI', away_score: '', home_score: '',
  away_moneyline: '130', home_moneyline: '-155', spread_line: '3', total_line: '50.5', ...values,
  };
  return headers.map(key => data[key]);
};
const now = new Date('2026-10-22T15:00:00Z');

test('NFL kickoff conversion honors summer time, winter time, and DST transition Sundays', () => {
  assert.equal(easternToUtc('2026-10-25', '13:00'), '2026-10-25T17:00:00.000Z');
  assert.equal(easternToUtc('2026-11-01', '13:00'), '2026-11-01T18:00:00.000Z');
  assert.equal(easternToUtc('2026-03-08', '13:00'), '2026-03-08T17:00:00.000Z');
  assert.equal(easternToUtc('2027-01-04', '20:15'), '2027-01-05T01:15:00.000Z');
  assert.throws(() => easternToUtc('2026-02-30', '13:00'));
  assert.throws(() => easternToUtc('2026-03-08', '02:30'));
});

test('missing scores remain scheduled; zero scores and ties are real final results', () => {
  const result = parseScheduleCsv(csv([
    row(),
    row({ game_id: 'shutout', away_score: '0', home_score: '20' }),
    row({ game_id: 'tie', away_score: '10', home_score: '10' }),
    row({ game_id: 'incomplete', away_score: '7' }),
  ]), now);
  assert.equal(result.games[0].status, 'scheduled');
  assert.equal(result.games[0].homeScore, undefined);
  const shutout = result.games.find(game => game.id === 'shutout')!;
  assert.equal(shutout.status, 'final');
  assert.equal(shutout.awayScore, 0);
  assert.equal(shutout.winnerTeamId, shutout.homeTeamId);
  const tie = result.games.find(game => game.id === 'tie')!;
  assert.equal(tie.status, 'final');
  assert.equal(tie.winnerTeamId, undefined);
  assert.equal(result.games.find(game => game.id === 'incomplete')!.status, 'scheduled');
});

test('odds keep source provenance and normalize nflverse home-spread sign', () => {
  const result = parseScheduleCsv(csv([row()]), now);
  assert.deepEqual(result.games[0].odds, {
    homeMoneyline: -155, awayMoneyline: 130, homeSpread: -3, total: 50.5,
    source: 'nflverse odds snapshot', updatedAt: now.toISOString(),
  });
  const invalidMarkets = parseScheduleCsv(csv([row({ home_moneyline: '0', away_moneyline: '80', spread_line: '', total_line: '' })]), now);
  assert.equal(invalidMarkets.games[0].odds, undefined);
});

test('regular-season parsing selects NFL season and normalizes Rams/Jaguars aliases', () => {
  const result = parseScheduleCsv(csv([
    row({ season: '2025', game_id: '2025-test' }),
    row({ game_type: 'WC', game_id: 'playoff' }),
    row({ away_team: 'LA', home_team: 'JAC' }),
  ]), now);
  assert.equal(result.season, 2026);
  assert.equal(result.games.length, 1);
  assert.equal(result.games[0].awayTeamId, '14');
  assert.equal(result.games[0].homeTeamId, '30');
  assert.equal(parseScheduleCsv(csv([row({ season: '2025' })]), new Date('2026-01-10T15:00:00Z')).season, 2025);
});

test('week changes on Eastern Tuesday while Monday stays in its NFL week', () => {
  const snapshot: ScheduleSnapshot = JSON.parse(readFileSync(new URL('../server/fixtures/schedule.json', import.meta.url), 'utf8'));
  assert.equal(snapshot.games.length, 272);
  assert.equal(new Set(snapshot.games.map(game => game.week)).size, 18);
  assert.equal(currentWeekForGames(snapshot.games, new Date('2026-10-27T03:59:59Z')), 7);
  assert.equal(currentWeekForGames(snapshot.games, new Date('2026-10-27T04:00:00Z')), 8);
});

test('unrecognized teams, duplicate IDs, and malformed scores reject corrupted snapshots', () => {
  assert.throws(() => parseScheduleCsv(csv([row({ home_team: 'UNKNOWN' })]), now), /Unknown NFL team/);
  assert.throws(() => parseScheduleCsv(csv([row(), row()]), now), /Duplicate games/);
  assert.throws(() => parseScheduleCsv(csv([row({ home_score: '-1', away_score: '7' })]), now), /invalid final score/);
  assert.throws(() => parseScheduleCsv('wrong,headers\na,b', now), /unexpected schema/);
});


test('season rollover retains historical finals without letting old week 18 override the current week', () => {
  const rollover = parseScheduleCsv(csv([
    row({ season: '2025', week: '18', game_id: 'old-final', gameday: '2026-01-04', home_score: '21', away_score: '14' }),
    row(),
  ]), now, [2025]);
  assert.equal(rollover.season, 2026);
  assert.equal(rollover.currentWeek, 7);
  assert.equal(rollover.games.length, 2);
  assert.equal(rollover.games.find(game => game.id === 'old-final')!.season, 2025);
  assert.equal(rollover.games.find(game => game.id === 'old-final')!.status, 'final');
});


test('separate processes can replace the schedule cache concurrently without corrupting or losing writes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'survivor-schedule-race-'));
  const target = join(directory, 'schedule.json');
  const providerUrl = new URL('../server/data-provider.ts', import.meta.url).href;
  const fixtureUrl = new URL('../server/fixtures/schedule.json', import.meta.url).href;
  const run = promisify(execFile);
  try {
    await Promise.all(Array.from({ length: 6 }, (_, worker) => {
      const script = `
        import { readFileSync } from 'node:fs';
        import { writeScheduleCache } from ${JSON.stringify(providerUrl)};
        const snapshot = JSON.parse(readFileSync(new URL(${JSON.stringify(fixtureUrl)}), 'utf8'));
        snapshot.source = 'worker-${worker}';
        for (let i = 0; i < 12; i++) await writeScheduleCache(snapshot, ${JSON.stringify(target)});
      `;
      return run(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], { timeout: 20_000 });
    }));
    const snapshot: ScheduleSnapshot = JSON.parse(readFileSync(target, 'utf8'));
    assert.equal(snapshot.games.length, 272);
    assert.match(snapshot.source, /^worker-[0-5]$/);
    assert.deepEqual(await readdir(directory), ['schedule.json']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('failed cache replacement cleans up its own temporary file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'survivor-schedule-failure-'));
  const target = join(directory, 'schedule.json');
  try {
    await mkdir(target);
    const snapshot: ScheduleSnapshot = JSON.parse(readFileSync(new URL('../server/fixtures/schedule.json', import.meta.url), 'utf8'));
    await assert.rejects(writeScheduleCache(snapshot, target));
    assert.deepEqual(await readdir(directory), ['schedule.json']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
