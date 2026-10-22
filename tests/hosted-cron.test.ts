import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { createHostedEntry } from '../server/hosted/entry.js';
import type { ScheduleSnapshot } from '../shared/types.js';

// Real Express entry and Supabase SDK; controlled upstream HTTP boundaries only.
async function harness() {
  const originalFetch = globalThis.fetch;
  const values = { CRON_SECRET: 'cron-test-secret-not-a-real-credential', SUPABASE_URL: 'https://cron-fixture.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'test-publishable', SUPABASE_SECRET_KEY: 'PRIVATE_ADMIN_TEST_KEY', APP_ORIGIN: 'https://survivor.example.test' };
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  const today = new Date();
  const season = today.getUTCMonth() < 2 ? today.getUTCFullYear() - 1 : today.getUTCFullYear();
  const state = { calls: [] as string[], fail: false, cache: { season, currentWeek: 7, updatedAt: new Date().toISOString(), source: 'test durable schedule', stale: false, games: [{ id: `${season}_07_NE_CHI`, season, week: 7, homeTeamId: '3', awayTeamId: '17', kickoff: `${season}-10-22T00:15:00Z`, status: 'scheduled' }] } as ScheduleSnapshot };
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.hostname === 'cron-fixture.supabase.co') {
      const rpc = url.pathname.split('/').at(-1)!;
      state.calls.push(rpc);
      if (rpc === 'survivor_schedule') return Response.json(state.cache);
      if (rpc === 'survivor_claim_schedule_refresh') return Response.json({ acquired: true });
      if (rpc === 'survivor_sync_schedule') {
        state.cache = JSON.parse(String(init?.body)).p_snapshot;
        return Response.json({ games: state.cache.games.length });
      }
      if (rpc === 'survivor_fail_schedule_refresh') return Response.json({ stale: true });
      throw new Error(`Unexpected RPC: ${rpc}`);
    }
    if (url.hostname === 'raw.githubusercontent.com') {
      state.calls.push('feed');
      if (state.fail) return new Response('PRIVATE_PROVIDER_DETAILS', { status: 503 });
      return new Response(`game_id,season,game_type,week,gameday,gametime,away_team,home_team,away_score,home_score\n${season}_07_NE_CHI,${season},REG,7,${season}-10-22,20:15,NE,CHI,,`);
    }
    return originalFetch(input, init);
  };
  const server = createHostedEntry().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { state, secret: values.CRON_SECRET, request: (authorization?: string) => originalFetch(`http://127.0.0.1:${address.port}/api/cron/sync`, { headers: authorization ? { Authorization: authorization } : {} }), close: async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  } };
}

test('cron rejects absent and incorrect secrets before touching Supabase or the provider', async t => {
  const h = await harness(); t.after(h.close);
  for (const authorization of [undefined, 'Bearer wrong', `Bearer ${'x'.repeat(h.secret.length)}`]) {
    const response = await h.request(authorization);
    assert.equal(response.status, 401);
    assert.match(response.headers.get('cache-control') || '', /no-store/);
    assert.deepEqual(await response.json(), { error: 'Unauthorized.' });
  }
  assert.deepEqual(h.state.calls, []);
});

test('authorized cron performs and reports a persisted refresh without exposing credentials', async t => {
  const h = await harness(); t.after(h.close);
  const response = await h.request(`Bearer ${h.secret}`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.games, 1);
  assert.equal(body.stale, false);
  assert.ok(h.state.calls.includes('survivor_sync_schedule'));
  assert.doesNotMatch(JSON.stringify(body), /PRIVATE_|secret|token|key/i);
});

test('authorized cron returns failure when provider refresh cannot be persisted', async t => {
  const h = await harness(); t.after(h.close); h.state.fail = true;
  const response = await h.request(`Bearer ${h.secret}`);
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.doesNotMatch(JSON.stringify(body), /PRIVATE_|ADMIN_TEST|PROVIDER_DETAILS/);
  assert.ok(h.state.calls.includes('survivor_fail_schedule_refresh'));
  assert.ok(!h.state.calls.includes('survivor_sync_schedule'));
});
