import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApp } from '../server/app.js';
import type { Dashboard, Game, League, ScheduleSnapshot, User } from '../shared/types.js';

type ApiResult<T = Record<string, unknown>> = { status: number; body: T; cookie: string; headers: Headers };
const password = 'A-real-test-passphrase-47!';

function sampleGames(): Game[] {
  return [
    { id: 'thu7', season: 2026, week: 7, homeTeamId: '1', awayTeamId: '2', kickoff: '2026-10-23T00:15:00.000Z', status: 'scheduled' },
    { id: 'sun7', season: 2026, week: 7, homeTeamId: '12', awayTeamId: '13', kickoff: '2026-10-25T17:00:00.000Z', status: 'scheduled' },
    { id: 'late7', season: 2026, week: 7, homeTeamId: '10', awayTeamId: '11', kickoff: '2026-10-26T00:20:00.000Z', status: 'scheduled' },
    { id: 'sun8', season: 2026, week: 8, homeTeamId: '12', awayTeamId: '14', kickoff: '2026-11-01T18:00:00.000Z', status: 'scheduled' },
    { id: 'late8', season: 2026, week: 8, homeTeamId: '1', awayTeamId: '2', kickoff: '2026-11-02T01:20:00.000Z', status: 'scheduled' },
  ];
}

async function harness(dbPath = ':memory:') {
  let clock = new Date('2026-10-22T12:00:00.000Z');
  const games = sampleGames();
  const service = createApp({ dbPath, now: () => clock, getSchedule: (): ScheduleSnapshot => ({
    games, season: 2026, currentWeek: clock < new Date('2026-10-27T04:00:00Z') ? 7 : 8,
    updatedAt: clock.toISOString(), source: 'deterministic test fixture', stale: false,
  }) });
  const server = service.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  async function request<T = Record<string, unknown>>(path: string, options: { method?: string; body?: unknown; cookie?: string; origin?: string } = {}): Promise<ApiResult<T>> {
    const response = await fetch(`${origin}${path}`, {
      method: options.method || 'GET',
      headers: { 'Content-Type': 'application/json', Origin: options.origin || origin, ...(options.cookie ? { Cookie: options.cookie } : {}) },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    return { status: response.status, body: await response.json() as T, cookie: (response.headers.get('set-cookie') || '').split(';')[0], headers: response.headers };
  }
  async function register(name: string) {
    const result = await request<{ user: User }>('/api/auth/register', { method: 'POST', body: { name, email: `${name.toLowerCase()}@example.test`, password } });
    assert.equal(result.status, 201, JSON.stringify(result.body));
    assert.ok(result.body.user.id);
    assert.ok(result.cookie);
    return { ...result.body.user, cookie: result.cookie };
  }
  async function league(cookie: string) {
    const result = await request<{ league: League }>('/api/leagues', { method: 'POST', cookie, body: { name: 'Sunday survivors', season: 2026, startWeek: 7 } });
    assert.equal(result.status, 201, JSON.stringify(result.body));
    return result.body.league;
  }
  async function pick(leagueId: string, cookie: string, teamId: string, week = 7) {
    return request(`/api/leagues/${leagueId}/picks`, { method: 'POST', cookie, body: { teamId, week } });
  }
  async function dashboard(leagueId: string, cookie: string, week = 7) {
    const result = await request<Dashboard>(`/api/leagues/${leagueId}?week=${week}`, { cookie });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return result.body;
  }
  return { request, register, league, pick, dashboard, games, setTime: (value: string) => { clock = new Date(value); },
    close: async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); service.close(); },
  };
}

function success(status: number) { assert.ok(status >= 200 && status < 300, `Expected success, received ${status}`); }
function rejected(status: number) { assert.ok(status >= 400 && status < 500, `Expected a client rejection, received ${status}`); }

test('email registration, secure cookie, sign-in, and logout use real server sessions', async t => {
  const h = await harness(); t.after(h.close);
  const created = await h.request<{ user: User }>('/api/auth/register', { method: 'POST', body: { name: 'Alice', email: 'ALICE@example.test', password } });
  assert.equal(created.status, 201);
  assert.match(created.headers.get('set-cookie') || '', /HttpOnly/i);
  assert.match(created.headers.get('set-cookie') || '', /SameSite=Lax/i);
  assert.doesNotMatch(JSON.stringify(created.body), /password|scrypt|token_hash/i);
  const me = await h.request<{ user: User }>('/api/auth/me', { cookie: created.cookie });
  assert.equal(me.body.user.email, 'alice@example.test');
  rejected((await h.request('/api/auth/login', { method: 'POST', body: { email: 'alice@example.test', password: 'incorrect-password' } })).status);
  const signedIn = await h.request<{ user: User }>('/api/auth/login', { method: 'POST', body: { email: 'alice@example.test', password } });
  success(signedIn.status);
  assert.notEqual(signedIn.cookie, created.cookie);
  success((await h.request('/api/auth/logout', { method: 'POST', cookie: signedIn.cookie })).status);
  const signedOut = await h.request<{ user: User | null }>('/api/auth/me', { cookie: signedIn.cookie });
  assert.ok(signedOut.status === 401 || signedOut.body.user === null);
});

test('credentials and invite inputs validate, and browser cross-origin writes are rejected', async t => {
  const h = await harness(); t.after(h.close);
  rejected((await h.request('/api/auth/register', { method: 'POST', body: { name: 'Alice', email: 'invalid', password } })).status);
  rejected((await h.request('/api/auth/register', { method: 'POST', body: { name: 'Alice', email: 'a@example.test', password: 'short' } })).status);
  const alice = await h.register('Alice');
  rejected((await h.request('/api/auth/register', { method: 'POST', body: { name: 'Other', email: 'alice@example.test', password } })).status);
  assert.equal((await h.request('/api/leagues', { method: 'POST', cookie: alice.cookie, origin: 'https://attacker.example', body: { name: 'Injected league' } })).status, 403);
  rejected((await h.request('/api/leagues/join', { method: 'POST', cookie: alice.cookie, body: { inviteCode: 'does-not-exist' } })).status);
});

test('private leagues require membership, and an invite grants one membership', async t => {
  const h = await harness(); t.after(h.close);
  const alice = await h.register('Alice'); const bob = await h.register('Bob');
  const league = await h.league(alice.cookie);
  rejected((await h.request(`/api/leagues/${league.id}`)).status);
  rejected((await h.request(`/api/leagues/${league.id}`, { cookie: bob.cookie })).status);
  rejected((await h.pick(league.id, bob.cookie, '12')).status);
  success((await h.request('/api/leagues/join', { method: 'POST', cookie: bob.cookie, body: { inviteCode: league.inviteCode } })).status);
  await h.request('/api/leagues/join', { method: 'POST', cookie: bob.cookie, body: { inviteCode: league.inviteCode } });
  const view = await h.dashboard(league.id, alice.cookie);
  assert.equal(view.members.length, 2);
});

test('opponent picks and history remain hidden until the exact global reveal', async t => {
  const h = await harness(); t.after(h.close);
  const alice = await h.register('Alice'); const bob = await h.register('Bob');
  const league = await h.league(alice.cookie);
  success((await h.request('/api/leagues/join', { method: 'POST', cookie: bob.cookie, body: { inviteCode: league.inviteCode } })).status);
  success((await h.pick(league.id, alice.cookie, '12')).status);
  success((await h.pick(league.id, bob.cookie, '13')).status);
  h.setTime('2026-10-25T16:59:59.999Z');
  const hidden = await h.dashboard(league.id, alice.cookie);
  assert.equal(hidden.picksRevealed, false);
  assert.equal(hidden.myPick?.teamId, '12');
  const bobHidden = hidden.members.find(member => member.id === bob.id)!;
  assert.ok(bobHidden);
  assert.equal(bobHidden.pick, null);
  assert.ok(bobHidden.history.every(pick => pick.teamId === undefined && pick.gameId === undefined));
  for (const requestedWeek of [1, 8, 18]) {
    const alternate = await h.dashboard(league.id, alice.cookie, requestedWeek);
    const alternateBob = alternate.members.find(member => member.id === bob.id)!;
    assert.ok(alternateBob.history.filter(pick => pick.week >= 7).every(pick => pick.teamId === undefined && pick.gameId === undefined));
  }
  const rawBob = JSON.stringify(bobHidden);
  assert.doesNotMatch(rawBob, /"teamId"|"gameId"/);
  h.setTime('2026-10-25T17:00:00.000Z');
  const revealed = await h.dashboard(league.id, alice.cookie);
  assert.equal(revealed.picksRevealed, true);
  assert.equal(revealed.members.find(member => member.id === bob.id)?.pick?.teamId, '13');
});

test('early-game outcome does not leak a hidden pick through elimination or history', async t => {
  const h = await harness(); t.after(h.close);
  const alice = await h.register('Alice'); const bob = await h.register('Bob');
  const league = await h.league(alice.cookie);
  success((await h.request('/api/leagues/join', { method: 'POST', cookie: bob.cookie, body: { inviteCode: league.inviteCode } })).status);
  success((await h.pick(league.id, alice.cookie, '12')).status);
  success((await h.pick(league.id, bob.cookie, '2')).status);
  Object.assign(h.games[0], { status: 'final', homeScore: 28, awayScore: 14 });
  h.setTime('2026-10-24T12:00:00Z');
  const before = (await h.dashboard(league.id, alice.cookie)).members.find(member => member.id === bob.id)!;
  assert.equal(before.status, 'alive');
  assert.equal(before.eliminatedWeek, undefined);
  assert.equal(before.pick, null);
  assert.ok(before.history.every(pick => pick.status === 'hidden'));
  h.setTime('2026-10-25T17:00:00Z');
  const after = (await h.dashboard(league.id, alice.cookie)).members.find(member => member.id === bob.id)!;
  assert.equal(after.status, 'eliminated');
  assert.equal(after.pick?.status, 'loss');
  assert.equal(after.eliminatedWeek, 7);
});

test('Thursday kickoff locks an existing pick against replacement and deletion', async t => {
  const h = await harness(); t.after(h.close);
  const alice = await h.register('Alice'); const league = await h.league(alice.cookie);
  success((await h.pick(league.id, alice.cookie, '1')).status);
  h.setTime('2026-10-23T00:15:00Z');
  rejected((await h.pick(league.id, alice.cookie, '12')).status);
  rejected((await h.request(`/api/leagues/${league.id}/picks?week=7`, { method: 'DELETE', cookie: alice.cookie })).status);
  assert.equal((await h.dashboard(league.id, alice.cookie)).myPick?.teamId, '1');
});

test('Sunday deadline rejects a late-game choice even before that game kicks off', async t => {
  const h = await harness(); t.after(h.close);
  const alice = await h.register('Alice'); const league = await h.league(alice.cookie);
  h.setTime('2026-10-25T17:00:00Z');
  rejected((await h.pick(league.id, alice.cookie, '10')).status);
  const view = await h.dashboard(league.id, alice.cookie);
  assert.equal(view.members.find(member => member.id === alice.id)?.status, 'eliminated');
});

test('eligible picks can be replaced/deleted, and invalid weekly teams are rejected', async t => {
  const h = await harness(); t.after(h.close);
  const alice = await h.register('Alice'); const league = await h.league(alice.cookie);
  rejected((await h.pick(league.id, alice.cookie, '9999')).status);
  rejected((await h.pick(league.id, alice.cookie, '14')).status);
  success((await h.pick(league.id, alice.cookie, '12')).status);
  success((await h.pick(league.id, alice.cookie, '13')).status);
  assert.equal((await h.dashboard(league.id, alice.cookie)).myPick?.teamId, '13');
  success((await h.request(`/api/leagues/${league.id}/picks?week=7`, { method: 'DELETE', cookie: alice.cookie })).status);
  assert.equal((await h.dashboard(league.id, alice.cookie)).myPick, null);
});

test('winning survivors cannot reuse a team in the following week', async t => {
  const h = await harness(); t.after(h.close);
  const alice = await h.register('Alice'); const league = await h.league(alice.cookie);
  success((await h.pick(league.id, alice.cookie, '12')).status);
  Object.assign(h.games[1], { status: 'final', homeScore: 30, awayScore: 10 });
  h.setTime('2026-10-27T12:00:00Z');
  rejected((await h.pick(league.id, alice.cookie, '12', 8)).status);
  success((await h.pick(league.id, alice.cookie, '14', 8)).status);
  const view = await h.dashboard(league.id, alice.cookie, 8);
  assert.equal(view.myPick?.teamId, '14');
  assert.ok(view.usedTeamIds.includes('12'));
  assert.equal(view.members.find(member => member.id === alice.id)?.history.find(pick => pick.week === 7)?.status, 'win');
});

test('a tied result eliminates and blocks the next week, while a postponed game stays pending', async t => {
  const h = await harness(); t.after(h.close);
  const alice = await h.register('Alice'); const bob = await h.register('Bob');
  const league = await h.league(alice.cookie);
  success((await h.request('/api/leagues/join', { method: 'POST', cookie: bob.cookie, body: { inviteCode: league.inviteCode } })).status);
  success((await h.pick(league.id, alice.cookie, '12')).status);
  success((await h.pick(league.id, bob.cookie, '10')).status);
  Object.assign(h.games[1], { status: 'final', homeScore: 20, awayScore: 20 });
  Object.assign(h.games[2], { status: 'postponed' });
  h.setTime('2026-10-27T12:00:00Z');
  const view = await h.dashboard(league.id, bob.cookie);
  assert.equal(view.members.find(member => member.id === alice.id)?.status, 'eliminated');
  assert.equal(view.members.find(member => member.id === alice.id)?.pick?.status, 'tie');
  assert.notEqual(view.members.find(member => member.id === bob.id)?.status, 'eliminated');
  assert.equal(view.myPick?.status, 'pending');
  rejected((await h.pick(league.id, alice.cookie, '14', 8)).status);
});

test('SQLite preserves accounts, league membership and picks after server restart', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'survivor-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const dbPath = join(directory, 'test.sqlite');
  const first = await harness(dbPath);
  const alice = await first.register('Alice'); const league = await first.league(alice.cookie);
  success((await first.pick(league.id, alice.cookie, '12')).status);
  await first.close();
  const second = await harness(dbPath); t.after(second.close);
  const me = await second.request<{ user: User }>('/api/auth/me', { cookie: alice.cookie });
  assert.equal(me.body.user.id, alice.id);
  assert.equal((await second.dashboard(league.id, alice.cookie)).myPick?.teamId, '12');
});

test('expired session cookies stop authenticating after seven days', async t => {
  const h = await harness(); t.after(h.close);
  const alice = await h.register('Alice');
  h.setTime('2026-10-29T12:00:00Z');
  const response = await h.request<{ user: User | null }>('/api/auth/me', { cookie: alice.cookie });
  assert.ok(response.status === 401 || response.body.user === null);
  rejected((await h.request('/api/leagues', { cookie: alice.cookie })).status);
});

test('joining closes at the first reveal and future weekly picks cannot bypass current-week rules', async t => {
  const h = await harness(); t.after(h.close);
  const alice = await h.register('Alice'); const bob = await h.register('Bob');
  const league = await h.league(alice.cookie);
  rejected((await h.pick(league.id, alice.cookie, '14', 8)).status);
  h.setTime('2026-10-25T17:00:00Z');
  rejected((await h.request('/api/leagues/join', { method: 'POST', cookie: bob.cookie, body: { inviteCode: league.inviteCode } })).status);
});

test('a new pick cannot select a game at kickoff even when the Sunday deadline is later', async t => {
  const h = await harness(); t.after(h.close);
  const alice = await h.register('Alice'); const league = await h.league(alice.cookie);
  h.setTime('2026-10-23T00:15:00Z');
  rejected((await h.pick(league.id, alice.cookie, '1')).status);
  success((await h.pick(league.id, alice.cookie, '12')).status);
});

test('a sole survivor is crowned only after winning, and stays champion in later weeks', async t => {
  const h = await harness(); t.after(h.close);
  const alice = await h.register('Alice'); const bob = await h.register('Bob');
  const league = await h.league(alice.cookie);
  success((await h.request('/api/leagues/join', { method: 'POST', cookie: bob.cookie, body: { inviteCode: league.inviteCode } })).status);
  success((await h.pick(league.id, alice.cookie, '12')).status);
  success((await h.pick(league.id, bob.cookie, '2')).status);
  Object.assign(h.games[0], { status: 'final', homeScore: 28, awayScore: 14 });
  h.setTime('2026-10-25T17:00:00Z');
  let view = await h.dashboard(league.id, alice.cookie);
  assert.equal(view.members.find(member => member.id === alice.id)?.status, 'alive', 'pending Sunday game cannot crown a winner');
  Object.assign(h.games[1], { status: 'final', homeScore: 30, awayScore: 10 });
  view = await h.dashboard(league.id, alice.cookie);
  assert.equal(view.members.find(member => member.id === alice.id)?.status, 'winner');
  assert.equal(view.members.find(member => member.id === bob.id)?.status, 'eliminated');
  h.setTime('2026-10-27T12:00:00Z');
  rejected((await h.pick(league.id, alice.cookie, '14', 8)).status);
  h.setTime('2026-11-01T18:00:00Z');
  // Authenticate anew because the initial seven-day session has expired.
  const login = await h.request<{ user: User }>('/api/auth/login', { method: 'POST', body: { email: alice.email, password } });
  success(login.status);
  view = await h.dashboard(league.id, login.cookie, 8);
  assert.equal(view.members.find(member => member.id === alice.id)?.status, 'winner');
  assert.equal(view.members.find(member => member.id === alice.id)?.eliminatedWeek, undefined);
});

test('Thursday results cannot announce a champion or eliminate opponents before Sunday', async t => {
  const h = await harness(); t.after(h.close);
  const alice = await h.register('Alice'); const bob = await h.register('Bob');
  const league = await h.league(alice.cookie);
  success((await h.request('/api/leagues/join', { method: 'POST', cookie: bob.cookie, body: { inviteCode: league.inviteCode } })).status);
  success((await h.pick(league.id, alice.cookie, '1')).status);
  success((await h.pick(league.id, bob.cookie, '2')).status);
  Object.assign(h.games[0], { status: 'final', homeScore: 28, awayScore: 14 });
  h.setTime('2026-10-25T16:59:59.999Z');
  for (const viewer of [alice, bob]) {
    const hidden = await h.dashboard(league.id, viewer.cookie);
    assert.ok(hidden.members.every(member => member.status === 'alive'));
    assert.equal(hidden.members.find(member => member.id !== viewer.id)?.pick, null);
  }
  h.setTime('2026-10-25T17:00:00.000Z');
  const publicView = await h.dashboard(league.id, bob.cookie);
  assert.equal(publicView.members.find(member => member.id === alice.id)?.status, 'winner');
  assert.equal(publicView.members.find(member => member.id === bob.id)?.status, 'eliminated');
});

test('if the final active group all lose in one week, they become co-winners', async t => {
  const h = await harness(); t.after(h.close);
  const alice = await h.register('Alice'); const bob = await h.register('Bob');
  const league = await h.league(alice.cookie);
  success((await h.request('/api/leagues/join', { method: 'POST', cookie: bob.cookie, body: { inviteCode: league.inviteCode } })).status);
  success((await h.pick(league.id, alice.cookie, '2')).status);
  success((await h.pick(league.id, bob.cookie, '2')).status);
  Object.assign(h.games[0], { status: 'final', homeScore: 28, awayScore: 14 });
  h.setTime('2026-10-25T17:00:00Z');
  const view = await h.dashboard(league.id, alice.cookie);
  assert.ok(view.members.every(member => member.status === 'winner'));
  assert.ok(view.members.every(member => member.pick?.status === 'loss'), 'co-winner status does not rewrite losing game outcomes');
});

test('all-out co-winners exclude entries eliminated in an earlier week', async t => {
  const h = await harness(); t.after(h.close);
  const alice = await h.register('Alice'); const bob = await h.register('Bob'); const carol = await h.register('Carol');
  const league = await h.league(alice.cookie);
  for (const member of [bob, carol]) success((await h.request('/api/leagues/join', { method: 'POST', cookie: member.cookie, body: { inviteCode: league.inviteCode } })).status);
  success((await h.pick(league.id, alice.cookie, '12')).status);
  success((await h.pick(league.id, bob.cookie, '12')).status);
  success((await h.pick(league.id, carol.cookie, '13')).status);
  Object.assign(h.games[1], { status: 'final', homeScore: 30, awayScore: 10 });
  h.setTime('2026-10-27T12:00:00Z');
  success((await h.pick(league.id, alice.cookie, '14', 8)).status);
  success((await h.pick(league.id, bob.cookie, '14', 8)).status);
  Object.assign(h.games[3], { status: 'final', homeScore: 21, awayScore: 7 });
  h.setTime('2026-11-01T22:00:00Z');
  const login = await h.request<{ user: User }>('/api/auth/login', { method: 'POST', body: { email: alice.email, password } });
  success(login.status);
  const view = await h.dashboard(league.id, login.cookie, 8);
  assert.equal(view.members.find(member => member.id === alice.id)?.status, 'winner');
  assert.equal(view.members.find(member => member.id === bob.id)?.status, 'winner');
  assert.equal(view.members.find(member => member.id === carol.id)?.status, 'eliminated');
  assert.equal(view.members.find(member => member.id === carol.id)?.eliminatedWeek, 7);
});

test('unresolved earlier games prevent a premature all-out championship', async t => {
  const h = await harness(); t.after(h.close);
  const alice = await h.register('Alice'); const bob = await h.register('Bob');
  const league = await h.league(alice.cookie);
  success((await h.request('/api/leagues/join', { method: 'POST', cookie: bob.cookie, body: { inviteCode: league.inviteCode } })).status);
  success((await h.pick(league.id, alice.cookie, '12')).status);
  success((await h.pick(league.id, bob.cookie, '10')).status);
  Object.assign(h.games[1], { status: 'postponed' });
  Object.assign(h.games[2], { status: 'final', homeScore: 21, awayScore: 7 });
  h.setTime('2026-10-27T12:00:00Z');
  success((await h.pick(league.id, alice.cookie, '14', 8)).status);
  success((await h.pick(league.id, bob.cookie, '14', 8)).status);
  Object.assign(h.games[3], { status: 'final', homeScore: 21, awayScore: 7 });
  h.setTime('2026-11-01T22:00:00Z');
  const login = await h.request<{ user: User }>('/api/auth/login', { method: 'POST', body: { email: bob.email, password } });
  success(login.status);
  let view = await h.dashboard(league.id, login.cookie, 8);
  assert.ok(!view.members.some(member => member.status === 'winner'));
  Object.assign(h.games[1], { status: 'final', homeScore: 7, awayScore: 28 });
  view = await h.dashboard(league.id, login.cookie, 8);
  assert.equal(view.members.find(member => member.id === bob.id)?.status, 'winner', 'settled earlier result establishes the earlier surviving champion');
  assert.equal(view.members.find(member => member.id === alice.id)?.status, 'eliminated');
  assert.equal(view.members.find(member => member.id === alice.id)?.eliminatedWeek, 7);
});
