import assert from 'node:assert/strict';
import test from 'node:test';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getHostedSchedule } from '../server/hosted/schedule.js';
import type { ScheduleSnapshot } from '../shared/types.js';

const today = new Date();
const season = today.getUTCMonth() < 2 ? today.getUTCFullYear() - 1 : today.getUTCFullYear();
function schedule(stale = false): ScheduleSnapshot {
  return { season, currentWeek: 7, updatedAt: new Date().toISOString(), stale, source: 'durable test cache', games: [{ id: `${season}_07_NE_CHI`, season, week: 7, homeTeamId: '3', awayTeamId: '17', kickoff: `${season}-10-22T00:15:00Z`, status: 'scheduled' }] };
}
const csv = [
  'game_id,season,game_type,week,gameday,gametime,away_team,home_team,away_score,home_score,away_moneyline,home_moneyline,spread_line,total_line',
  `${season}_07_NE_CHI,${season},REG,7,${season}-10-22,20:15,NE,CHI,,,130,-155,3,50.5`,
  `${season - 1}_07_NE_CHI,${season - 1},REG,7,${season - 1}-10-22,20:15,NE,CHI,10,20,130,-155,3,50.5`,
].join('\n');

type Reply = { data: unknown; error: null | { message: string } };
function fakeClient(handler: (name: string, args?: Record<string, unknown>) => Reply | Promise<Reply>) {
  const calls: Array<{ name: string; args?: Record<string, unknown> }> = [];
  return { calls, client: { rpc: async (name: string, args?: Record<string, unknown>) => { calls.push({ name, args }); return handler(name, args); } } as unknown as Pick<SupabaseClient, 'rpc'> };
}
const noFetch: typeof fetch = async () => { throw new Error('The network must not be contacted for this case.'); };

test('hosted schedule reads a fresh durable cache without a refresh lease or provider fetch', async () => {
  const cached = schedule();
  const h = fakeClient(name => { assert.equal(name, 'survivor_schedule'); return { data: cached, error: null }; });
  const result = await getHostedSchedule({ client: h.client, fetchFeed: noFetch });
  assert.deepEqual(result, cached);
  assert.deepEqual(h.calls.map(call => call.name), ['survivor_schedule']);
});

test('hosted refresh lease contention never fetches twice and strict jobs reject stale success', async () => {
  const cached = schedule(true);
  const h = fakeClient(name => ({ data: name === 'survivor_schedule' ? cached : { acquired: false, retryAfter: 30 }, error: null }));
  assert.deepEqual(await getHostedSchedule({ client: h.client, fetchFeed: noFetch }), cached);
  await assert.rejects(getHostedSchedule({ client: h.client, fetchFeed: noFetch, force: true, requirePersistence: true }), /refresh|progress|retry/i);
  assert.ok(h.calls.every(call => ['survivor_schedule', 'survivor_claim_schedule_refresh'].includes(call.name)));
});

test('hosted refresh persists parsed data then rereads PostgreSQL and refreshes retained seasons', async () => {
  let cached = schedule(true);
  cached.games.push({ ...cached.games[0], id: `${season - 1}_07_NE_CHI`, season: season - 1 });
  let written: ScheduleSnapshot | undefined;
  const h = fakeClient((name, args) => {
    if (name === 'survivor_schedule') return { data: cached, error: null };
    if (name === 'survivor_claim_schedule_refresh') return { data: { acquired: true }, error: null };
    assert.equal(name, 'survivor_sync_schedule');
    written = args?.p_snapshot as ScheduleSnapshot;
    cached = { ...written, source: 'persisted provider snapshot' };
    return { data: { games: written.games.length }, error: null };
  });
  const result = await getHostedSchedule({ client: h.client, fetchFeed: async () => new Response(csv), requirePersistence: true });
  assert.ok(written);
  assert.equal(result.source, 'persisted provider snapshot');
  assert.equal(result.stale, false);
  assert.equal(written.games.find(game => game.season === season - 1)?.status, 'final');
  assert.deepEqual(h.calls.map(call => call.name), ['survivor_schedule', 'survivor_claim_schedule_refresh', 'survivor_sync_schedule', 'survivor_schedule']);
});

test('provider failure marks a durable retry cooldown and preserves the last good schedule', async () => {
  const cached = schedule(true);
  const h = fakeClient(name => ({ data: name === 'survivor_schedule' ? cached : { acquired: true }, error: null }));
  const result = await getHostedSchedule({ client: h.client, fetchFeed: async () => new Response('unavailable', { status: 503 }) });
  assert.deepEqual(result.games, cached.games);
  assert.equal(result.stale, true);
  assert.ok(h.calls.some(call => call.name === 'survivor_fail_schedule_refresh'));
  assert.ok(!h.calls.some(call => call.name === 'survivor_sync_schedule'));
});

test('lease transport failure falls back for browsing but fails a required durable sync', async () => {
  const cached = schedule(true);
  const h = fakeClient(name => {
    if (name === 'survivor_schedule') return { data: cached, error: null };
    throw new Error('transport disconnected');
  });
  const result = await getHostedSchedule({ client: h.client, fetchFeed: noFetch });
  assert.equal(result.stale, true);
  assert.deepEqual(result.games, cached.games);
  await assert.rejects(getHostedSchedule({ client: h.client, fetchFeed: noFetch, requirePersistence: true }), /schedule|refresh|transport/i);
});

test('required hosted persistence fails closed when the database cannot read or save', async () => {
  const absent = fakeClient(() => ({ data: null, error: { message: 'PRIVATE_DATABASE_DETAILS' } }));
  await assert.rejects(getHostedSchedule({ client: absent.client, requirePersistence: true }), /migration/i);
  const cached = schedule(true);
  const h = fakeClient(name => {
    if (name === 'survivor_schedule') return { data: cached, error: null };
    if (name === 'survivor_claim_schedule_refresh') return { data: { acquired: true }, error: null };
    return { data: null, error: { message: 'PRIVATE_DATABASE_DETAILS' } };
  });
  await assert.rejects(getHostedSchedule({ client: h.client, fetchFeed: async () => new Response(csv), requirePersistence: true }), error => {
    assert.match(String(error), /saved|Supabase/i);
    assert.doesNotMatch(String(error), /PRIVATE_DATABASE_DETAILS/);
    return true;
  });
  assert.ok(h.calls.some(call => call.name === 'survivor_fail_schedule_refresh'));
});
