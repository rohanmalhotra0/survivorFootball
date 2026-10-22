import assert from 'node:assert/strict';
import test from 'node:test';
import { isGameLocked, isRevealed, newYorkDate, resolvePick, revealAtForWeek, seasonContext, type SurvivorGame } from '../server/domain.js';

const fixture: SurvivorGame = {
  id: 'fixture', season: 2026, week: 7, homeTeamId: '12', awayTeamId: '13',
  kickoff: '2026-10-25T17:00:00.000Z', status: 'scheduled',
};

test('Sunday reveal stays at 1 p.m. New York across fall daylight-saving boundary', () => {
  assert.equal(revealAtForWeek(2026, 7).toISOString(), '2026-10-25T17:00:00.000Z');
  assert.equal(revealAtForWeek(2026, 8).toISOString(), '2026-11-01T18:00:00.000Z');
  assert.equal(revealAtForWeek(2026, 9).toISOString(), '2026-11-08T18:00:00.000Z');
  for (const week of [1, 7, 8, 18]) {
    const local = newYorkDate(revealAtForWeek(2026, week));
    assert.equal(local.hour, 13);
    assert.equal(local.minute, 0);
    assert.equal(revealAtForWeek(2026, week).getUTCDay(), 0);
  }
});

test('picks reveal exactly at the deadline, never one millisecond earlier', () => {
  for (const week of [7, 8]) {
    const reveal = revealAtForWeek(2026, week);
    assert.equal(isRevealed(2026, week, new Date(reveal.getTime() - 1)), false);
    assert.equal(isRevealed(2026, week, reveal), true);
    assert.equal(isRevealed(2026, week, new Date(reveal.getTime() + 1)), true);
  }
});

test('game kickoff locks at the precise instant and in-progress status locks early', () => {
  assert.equal(isGameLocked(fixture, new Date('2026-10-25T16:59:59.999Z')), false);
  assert.equal(isGameLocked(fixture, new Date(fixture.kickoff)), true);
  assert.equal(isGameLocked({ ...fixture, status: 'in_progress' }, new Date('2026-10-24T00:00:00Z')), true);
});

test('final score settles home and away selections consistently', () => {
  const homeWin = { ...fixture, status: 'final' as const, homeScore: 24, awayScore: 17 };
  assert.equal(resolvePick(homeWin, fixture.homeTeamId), 'win');
  assert.equal(resolvePick(homeWin, fixture.awayTeamId), 'loss');
  const awayWin = { ...homeWin, homeScore: 13, awayScore: 31 };
  assert.equal(resolvePick(awayWin, fixture.homeTeamId), 'loss');
  assert.equal(resolvePick(awayWin, fixture.awayTeamId), 'win');
});

test('a final tie is a tie rather than a survivor win', () => {
  const tied = { ...fixture, status: 'final' as const, homeScore: 20, awayScore: 20 };
  assert.equal(resolvePick(tied, fixture.homeTeamId), 'tie');
  assert.equal(resolvePick(tied, fixture.awayTeamId), 'tie');
});

test('incomplete results and postponed games remain pending', () => {
  assert.equal(resolvePick(undefined, fixture.homeTeamId), 'pending');
  assert.equal(resolvePick({ ...fixture, status: 'final' }, fixture.homeTeamId), 'pending');
  assert.equal(resolvePick({ ...fixture, status: 'postponed', homeScore: 0, awayScore: 0 }, fixture.homeTeamId), 'pending');
  assert.equal(resolvePick({ ...fixture, status: 'in_progress', homeScore: 20, awayScore: 7 }, fixture.homeTeamId), 'pending');
});

test('canceled games are void and do not invent a loss', () => {
  assert.equal(resolvePick({ ...fixture, status: 'canceled' }, fixture.homeTeamId), 'void');
});

test('season week stays on the current slate through Monday and advances Tuesday', () => {
  assert.deepEqual(seasonContext(new Date('2026-10-22T12:00:00Z')), { season: 2026, week: 7 });
  assert.deepEqual(seasonContext(new Date('2026-10-27T03:59:59Z')), { season: 2026, week: 7 });
  assert.deepEqual(seasonContext(new Date('2026-10-27T04:00:00Z')), { season: 2026, week: 8 });
});

test('offseason and January resolve to a bounded regular-season context', () => {
  assert.deepEqual(seasonContext(new Date('2027-01-10T18:00:00Z')), { season: 2026, week: 18 });
  assert.deepEqual(seasonContext(new Date('2027-06-01T18:00:00Z')), { season: 2027, week: 1 });
});

test('weekly rollover follows New York midnight after daylight saving time ends', () => {
  assert.deepEqual(seasonContext(new Date('2026-11-03T04:59:59Z')), { season: 2026, week: 8 });
  assert.deepEqual(seasonContext(new Date('2026-11-03T05:00:00Z')), { season: 2026, week: 9 });
});
