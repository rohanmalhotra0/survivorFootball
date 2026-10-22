import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createHostedApp } from '../server/hosted/app.js';
import type { ScheduleSnapshot } from '../shared/types.js';

const alice = { id: '11111111-1111-4111-8111-111111111111', email: 'alice@example.test', user_metadata: { name: 'Alice' }, app_metadata: {}, aud: 'authenticated', created_at: '2026-10-22T00:00:00Z' };
const leagueId = '22222222-2222-4222-8222-222222222222';
const password = 'Hosted-test-password-2026!';
const schedule: ScheduleSnapshot = { season: 2026, currentWeek: 7, games: [], updatedAt: '2026-10-22T00:00:00Z', source: 'test fixture', stale: false };

type FakeState = {
  user: typeof alice | null;
  confirmationRequired: boolean;
  rpcData: unknown;
  rpcError: unknown;
  authError: { message: string; status: number } | null;
  limited: boolean;
  calls: Array<{ name: string; parameters: unknown }>;
};

async function harness() {
  const state: FakeState = { user: null, confirmationRequired: false, rpcData: { leagues: [] }, rpcError: null, authError: null, limited: false, calls: [] };
  const client = {
    auth: {
      getUser: async () => ({ data: { user: state.user }, error: state.user ? null : { message: 'Auth session missing', status: 401 } }),
      signUp: async (parameters: unknown) => {
        state.calls.push({ name: 'signUp', parameters });
        return { data: { user: alice, session: state.confirmationRequired ? null : { access_token: 'PRIVATE_ACCESS_TOKEN', refresh_token: 'PRIVATE_REFRESH_TOKEN', user: alice } }, error: state.authError };
      },
      signInWithPassword: async (parameters: unknown) => {
        state.calls.push({ name: 'signInWithPassword', parameters });
        return { data: { user: state.authError ? null : alice, session: state.authError ? null : { access_token: 'PRIVATE_ACCESS_TOKEN', refresh_token: 'PRIVATE_REFRESH_TOKEN', user: alice } }, error: state.authError };
      },
      signOut: async () => { state.user = null; return { error: null }; },
      resetPasswordForEmail: async (email: unknown, parameters: unknown) => { state.calls.push({ name: 'resetPasswordForEmail', parameters: { email, parameters } }); return { data: {}, error: state.authError }; },
      updateUser: async (parameters: unknown) => { state.calls.push({ name: 'updateUser', parameters }); return { data: { user: state.user }, error: state.authError }; },
      exchangeCodeForSession: async (parameters: unknown) => { state.calls.push({ name: 'exchangeCodeForSession', parameters }); return { data: { user: alice, session: { user: alice } }, error: state.authError }; },
    },
    rpc: async (name: string, parameters: unknown) => { state.calls.push({ name, parameters }); return { data: state.rpcData, error: state.rpcError }; },
  } as unknown as SupabaseClient;
  const app = createHostedApp({
    getSchedule: async () => schedule,
    config: { supabaseUrl: 'https://project.supabase.co', publishableKey: 'test-publishable-key', serviceRoleKey: 'PRIVATE_SERVICE_KEY', appOrigin: 'https://survivor.example.test', cookieSecure: true },
    createRequestClient: () => client,
    enforceRateLimit: async () => ({ allowed: !state.limited, retryAfter: state.limited ? 60 : 0 }),
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  async function request(path: string, options: { method?: string; body?: unknown; origin?: string; contentType?: string } = {}) {
    const response = await fetch(origin + path, { method: options.method || 'GET', redirect: 'manual', headers: { 'Content-Type': options.contentType || 'application/json', Origin: options.origin || 'https://survivor.example.test' }, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
    const text = await response.text();
    let body: any;
    try { body = JSON.parse(text); } catch { body = text; }
    return { status: response.status, body, headers: response.headers };
  }
  return { state, request, close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}

// These tests exercise the actual Express routes with a controlled Supabase SDK
// boundary. PostgreSQL authorization and survivor logic are tested separately.
test('hosted routes require a verified Supabase user and never return credentials', async t => {
  const h = await harness(); t.after(h.close);
  const me = await h.request('/api/auth/me');
  assert.equal(me.status, 200);
  assert.equal(me.body.user, null);
  assert.equal((await h.request('/api/leagues')).status, 401);
  h.state.user = alice;
  const authenticated = await h.request('/api/auth/me');
  assert.deepEqual(authenticated.body.user, { id: alice.id, name: 'Alice', email: alice.email });
  assert.doesNotMatch(JSON.stringify(authenticated.body), /PRIVATE_|refresh_token|access_token|serviceRole/);
  assert.match(authenticated.headers.get('cache-control') || '', /no-store/);
});

test('hosted registration represents email confirmation without claiming a session', async t => {
  const h = await harness(); t.after(h.close);
  h.state.confirmationRequired = true;
  const response = await h.request('/api/auth/register', { method: 'POST', body: { name: 'Alice', email: 'alice@example.test', password } });
  assert.ok(response.status >= 200 && response.status < 300);
  assert.equal(response.body.confirmationRequired, true);
  assert.equal(response.body.user, null);
  assert.doesNotMatch(JSON.stringify(response.body), /PRIVATE_|refresh_token|access_token/);
  const signup = h.state.calls.find(call => call.name === 'signUp');
  assert.ok(signup);
  assert.match(JSON.stringify(signup.parameters), /https:\/\/survivor\.example\.test\/api\/auth\/callback/);
});

test('hosted authenticated mutations use RPC parameters and ignore forged user identities', async t => {
  const h = await harness(); t.after(h.close); h.state.user = alice;
  h.state.rpcData = { league: { id: leagueId, name: 'Private hosted league' } };
  const created = await h.request('/api/leagues', { method: 'POST', body: { name: 'Private hosted league', userId: 'attacker', ownerId: 'attacker' } });
  assert.ok(created.status >= 200 && created.status < 300);
  const createCall = h.state.calls.find(call => call.name === 'survivor_create_league');
  assert.deepEqual(createCall?.parameters, { p_name: 'Private hosted league' });
  h.state.rpcData = { week: 7, members: [], myPick: { teamId: '12' } };
  assert.equal((await h.request(`/api/leagues/${leagueId}/picks`, { method: 'POST', body: { teamId: '12', week: 7, userId: 'attacker' } })).status, 200);
  const pickCall = h.state.calls.find(call => call.name === 'survivor_submit_pick');
  assert.deepEqual(pickCall?.parameters, { p_league_id: leagueId, p_team_id: '12', p_week: 7 });
});

test('hosted mutations reject cross-origin requests, non-JSON bodies, and rate-limit failures', async t => {
  const h = await harness(); t.after(h.close); h.state.user = alice;
  assert.equal((await h.request('/api/leagues', { method: 'POST', body: { name: 'Bad origin' }, origin: 'https://attacker.example' })).status, 403);
  assert.equal((await h.request('/api/leagues', { method: 'POST', body: { name: 'Bad MIME' }, contentType: 'text/plain' })).status, 415);
  h.state.limited = true;
  const limited = await h.request('/api/auth/login', { method: 'POST', body: { email: alice.email, password } });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) >= 1);
});

test('hosted RPC validation errors stay client errors and never leak provider internals', async t => {
  const h = await harness(); t.after(h.close); h.state.user = alice;
  h.state.rpcData = { error: { message: 'Your selected game has locked.', status: 409 } };
  const locked = await h.request(`/api/leagues/${leagueId}/picks`, { method: 'POST', body: { teamId: '12', week: 7 } });
  assert.equal(locked.status, 409);
  assert.match(JSON.stringify(locked.body), /locked/);
  h.state.rpcData = null; h.state.rpcError = { message: 'PRIVATE_DATABASE_INTERNALS', code: 'XX000' };
  const failure = await h.request('/api/leagues');
  assert.ok(failure.status >= 500);
  assert.doesNotMatch(JSON.stringify(failure.body), /PRIVATE_DATABASE_INTERNALS/);
});

test('hosted password recovery gives a generic response and password changes require authentication', async t => {
  const h = await harness(); t.after(h.close);
  const requested = await h.request('/api/auth/forgot-password', { method: 'POST', body: { email: alice.email } });
  assert.equal(requested.status, 200);
  assert.equal((await h.request('/api/auth/reset-password', { method: 'POST', body: { password } })).status, 401);
  h.state.user = alice;
  const reset = await h.request('/api/auth/reset-password', { method: 'POST', body: { password } });
  assert.equal(reset.status, 200);
  assert.deepEqual(h.state.calls.find(call => call.name === 'updateUser')?.parameters, { password });
});

test('hosted callback never redirects to an untrusted next URL', async t => {
  const h = await harness(); t.after(h.close);
  const callback = await h.request('/api/auth/callback?code=valid-code&next=https://attacker.example');
  assert.ok(callback.status >= 300 && callback.status < 400);
  assert.ok((callback.headers.get('location') || '').startsWith('https://survivor.example.test') || (callback.headers.get('location') || '').startsWith('/'));
  assert.doesNotMatch(callback.headers.get('location') || '', /attacker\.example/);
});

test('hosted PostgREST SQL error codes map to useful status without exposing SQL details', async t => {
  const h = await harness(); t.after(h.close); h.state.user = alice;
  for (const [code,status] of [['PT404',404],['PT409',409],['42501',403],['PGRST301',401],['23505',409]] as const) {
    h.state.rpcData = null;
    h.state.rpcError = { code, message: 'PRIVATE SQL statement or credential detail' };
    const response = await h.request('/api/leagues');
    assert.equal(response.status,status);
    assert.doesNotMatch(JSON.stringify(response.body), /PRIVATE SQL/);
  }
});
