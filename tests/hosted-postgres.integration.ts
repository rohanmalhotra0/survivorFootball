import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { promisify } from 'node:util';
import test, { before, after } from 'node:test';

// An actual PostgreSQL engine exercises the migration. No Supabase HTTP mock is
// substituted for database privileges, transaction locks, or server-side rules.
const execute = promisify(execFile);
const suppliedContainer = process.env.SURVIVOR_TEST_POSTGRES_CONTAINER;
const container = suppliedContainer || `survivor-postgres-tests-${process.pid}`;
const alice = '11111111-1111-4111-8111-111111111111';
const bob = '22222222-2222-4222-8222-222222222222';
const outsider = '33333333-3333-4333-8333-333333333333';
const league = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const psqlArgs = ['exec', '-i', container, 'psql', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres'];
function sql(input: string): string {
  return execFileSync('docker', psqlArgs, { input, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });
}
function rows(input: string): any[] { return sql(input).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
function login(id = alice) { return `set local role authenticated; set local request.jwt.claim.sub='${id}'; set local request.jwt.claim.role='authenticated';`; }
function clock(at: string) { return `reset role; create or replace function survivor_private.clock() returns timestamptz language sql volatile set search_path='' as $$select '${at}'::timestamptz$$;`; }
const fixture = `
${clock('2026-10-22T12:00:00Z')}
truncate auth.users cascade;
truncate survivor_private.games,survivor_private.rate_buckets;
insert into auth.users(id,raw_user_meta_data) values
 ('${alice}','{"name":"Alice"}'),('${bob}','{"name":"Bob"}'),('${outsider}','{"name":"Outsider"}');
insert into survivor_private.leagues(id,name,invite_code,owner_id,season,start_week)
 values('${league}','SQL survivors','ABCDEF123456789012345678','${alice}',2026,7);
insert into survivor_private.members(league_id,user_id) values('${league}','${alice}'),('${league}','${bob}');
insert into survivor_private.games(id,season,week,home_team_id,away_team_id,kickoff,status) values
 ('thu7',2026,7,'1','2','2026-10-23T00:15:00Z','scheduled'),
 ('sun7',2026,7,'12','13','2026-10-25T17:00:00Z','scheduled'),
 ('late7',2026,7,'10','11','2026-10-26T00:20:00Z','scheduled'),
 ('sun8',2026,8,'12','14','2026-11-01T18:00:00Z','scheduled');
update survivor_private.schedule_state set season=2026,fetched_at='2026-10-22T12:00:00Z',source='SQL fixture',upstream_stale=false,refresh_lease_until=null;
`;
function transaction(input: string) { return rows(`begin; ${fixture} ${input} rollback;`); }
function pick(id: string, team = '12', week = 7) { return `${login(id)} select public.survivor_submit_pick('${league}','${team}',${week});`; }
function seedPicks(aliceTeam = '12', bobTeam = '13') {
  return `insert into survivor_private.picks(league_id,user_id,week,team_id,game_id) values
  ('${league}','${alice}',7,'${aliceTeam}','sun7'),('${league}','${bob}',7,'${bobTeam}','sun7');`;
}
function dashboard(id = alice, week = 7) { return `${login(id)} select public.survivor_dashboard('${league}',${week});`; }
function errorStatus(result: any) { return result.error?.status; }

before(async () => {
  if (suppliedContainer) return;
  await execute('docker', ['run', '--name', container, '--rm', '-d', '--network', 'none', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgres:17-alpine'], { timeout: 120_000 });
  for (let attempt = 0; attempt < 100; attempt++) {
    // The entrypoint's temporary initialization server accepts Unix sockets;
    // only the final server accepts TCP connections on the container loopback.
    try { await execute('docker', ['exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']); break; }
    catch { if (attempt === 99) throw new Error('PostgreSQL did not become ready'); await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  sql(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    create schema auth; create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb not null default '{}'::jsonb,created_at timestamptz not null default now());
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    create function auth.role() returns text language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claim.role',true),''),current_user::text)$$;
    grant usage on schema auth to anon,authenticated,service_role;
    grant execute on function auth.uid(),auth.role() to anon,authenticated,service_role;`);
  for (const filename of readdirSync(new URL('../supabase/migrations/', import.meta.url)).filter(name => name.endsWith('.sql')).sort()) {
    sql(readFileSync(new URL(`../supabase/migrations/${filename}`, import.meta.url), 'utf8'));
  }
}, { timeout: 150_000 });
after(async () => { if (!suppliedContainer) await execute('docker', ['stop', container], { timeout: 15_000 }); });

test('hosted SQL uses a private schema, RLS, revoked tables, and narrowly granted RPCs', () => {
  const [privileges] = rows(`select jsonb_build_object(
    'rawSchema',has_schema_privilege('authenticated','survivor_private','USAGE'),
    'rawPicks',has_table_privilege('authenticated','survivor_private.picks','SELECT'),
    'anonDashboard',has_function_privilege('anon','public.survivor_dashboard(uuid,integer)','EXECUTE'),
    'userSync',has_function_privilege('authenticated','public.survivor_sync_schedule(jsonb)','EXECUTE'),
    'userPrivate',has_function_privilege('authenticated','survivor_private.clock()','EXECUTE'),
    'anonSchedule',has_function_privilege('anon','public.survivor_schedule()','EXECUTE'),
    'rlsCount',(select count(*) from pg_class c join pg_namespace n on c.relnamespace=n.oid where n.nspname='survivor_private' and c.relkind='r' and c.relrowsecurity));`);
  assert.deepEqual(privileges, { rawSchema: false, rawPicks: false, anonDashboard: false, userSync: false, userPrivate: false, anonSchedule: true, rlsCount: 7 });
  assert.throws(() => sql(`begin; set local role authenticated; select * from survivor_private.picks; rollback;`), /permission denied/);
  assert.throws(() => sql(`begin; set local role anon; select public.survivor_dashboard('${league}',7); rollback;`), /permission denied/);
});

test('hosted SQL requires the authenticated identity and private league membership', () => {
  const [missing, outside, own] = transaction(`set local role authenticated; set local request.jwt.claim.sub=''; select public.survivor_list_leagues();
    ${dashboard(outsider)} ${dashboard(alice)}`);
  assert.equal(errorStatus(missing), 401);
  assert.equal(errorStatus(outside), 404);
  assert.equal(own.currentUserId, alice);
  assert.equal(own.members.length, 2);
});

test('hosted SQL redacts opponents and reveals precisely at the Sunday boundary', () => {
  const [before, pastQuery, futureQuery, afterReveal] = transaction(`${seedPicks()}
    ${clock('2026-10-25T16:59:59.999Z')} ${dashboard()} ${dashboard(alice,1)} ${dashboard(alice,18)}
    ${clock('2026-10-25T17:00:00Z')} ${dashboard()}`);
  assert.equal(before.picksRevealed, false);
  assert.equal(before.myPick.teamId, '12');
  for (const result of [before, pastQuery, futureQuery]) {
    const opponent = result.members.find((member: any) => member.id === bob);
    assert.equal(opponent.pick, null);
    assert.ok(opponent.history.filter((item: any) => item.week >= 7).every((item: any) => !item.teamId && !item.gameId && item.status === 'hidden'));
  }
  assert.equal(afterReveal.picksRevealed, true);
  assert.equal(afterReveal.members.find((member: any) => member.id === bob).pick.teamId, '13');
});

test('hosted SQL early losses do not leak through status, metadata, or history', () => {
  const [view] = transaction(`insert into survivor_private.picks(league_id,user_id,week,team_id,game_id) values('${league}','${bob}',7,'2','thu7');
    update survivor_private.games set status='final',home_score=30,away_score=10 where id='thu7';
    ${clock('2026-10-24T12:00:00Z')} ${dashboard()}`);
  const opponent = view.members.find((member: any) => member.id === bob);
  assert.equal(opponent.status, 'alive');
  assert.equal(opponent.pickState, 'hidden');
  assert.equal(opponent.pick, null);
  assert.equal(opponent.eliminatedWeek, undefined);
  assert.deepEqual(opponent.history, [{ week: 7, status: 'hidden' }]);
});

test('hosted SQL enforces kickoff locks for replacing, deleting, and new selections', () => {
  const [first, replaced, deleted, lateNew] = transaction(`${pick(alice,'1')}
    ${clock('2026-10-23T00:15:00Z')} ${pick(alice,'12')}
    ${login(alice)} select public.survivor_delete_pick('${league}',7);
    ${pick(bob,'2')}`);
  assert.equal(first.myPick.teamId, '1');
  for (const result of [replaced, deleted, lateNew]) assert.equal(errorStatus(result), 409);
});

test('hosted SQL permits unlocked replacement/removal and rejects future and repeated teams', () => {
  const [saved, changed, removed, future, repeated] = transaction(`${pick(alice,'12')} ${pick(alice,'1')}
    ${login(alice)} select public.survivor_delete_pick('${league}',7);
    ${pick(alice,'12',8)}
    reset role; update survivor_private.leagues set start_week=6 where id='${league}';
    insert into survivor_private.games(id,season,week,home_team_id,away_team_id,kickoff,status,home_score,away_score)
      values('past6',2026,6,'12','13','2026-10-18T17:00:00Z','final',21,7);
    insert into survivor_private.picks(league_id,user_id,week,team_id,game_id) values
      ('${league}','${alice}',6,'12','past6'),('${league}','${bob}',6,'12','past6');
    ${pick(alice,'12')}`);
  assert.equal(saved.myPick.teamId, '12');
  assert.equal(changed.myPick.teamId, '1');
  assert.equal(removed.myPick, null);
  assert.equal(errorStatus(future), 409);
  assert.equal(errorStatus(repeated), 409);
});

test('hosted SQL handles DST, Tuesday rollover, and all late-game selections at the deadline', () => {
  const [times, late] = transaction(`select jsonb_build_object(
    'summer',survivor_private.reveal_at(2026,7), 'winter',survivor_private.reveal_at(2026,8),
    'monday',survivor_private.current_week(2026,'2026-11-03T04:59:59Z'),
    'tuesday',survivor_private.current_week(2026,'2026-11-03T05:00:00Z'));
    ${clock('2026-10-25T17:00:00Z')} ${pick(alice,'10')}`);
  assert.equal(Date.parse(times.summer), Date.parse('2026-10-25T17:00:00Z'));
  assert.equal(Date.parse(times.winter), Date.parse('2026-11-01T18:00:00Z'));
  assert.equal(times.monday, 8); assert.equal(times.tuesday, 9);
  assert.equal(errorStatus(late), 409);
});

test('hosted SQL settles losses and ties, keeps delayed games pending, and awards final-group co-winners', () => {
  const [tied, pending, bothLose] = transaction(`${seedPicks()}
    update survivor_private.games set status='final',home_score=20,away_score=20 where id='sun7';
    ${clock('2026-10-26T12:00:00Z')} ${dashboard()}
    reset role; update survivor_private.games set status='postponed',home_score=null,away_score=null where id='sun7'; ${dashboard()}
    reset role; update survivor_private.games set status='final',home_score=20,away_score=7 where id='sun7';
    update survivor_private.picks set team_id='13' where user_id='${alice}'; ${dashboard()}`);
  assert.ok(tied.members.every((member: any) => member.status === 'winner' && member.pick.status === 'tie'));
  assert.ok(pending.members.every((member: any) => member.status === 'alive' && member.pick.status === 'pending'));
  assert.ok(bothLose.members.every((member: any) => member.status === 'winner' && member.pick.status === 'loss'));
});

test('hosted SQL joining is idempotent and closes at the opening reveal', () => {
  const [joined, again, late] = transaction(`${login(outsider)} select public.survivor_join_league('ABCDEF123456789012345678');
    select public.survivor_join_league('ABCDEF123456789012345678');
    reset role; delete from survivor_private.members where user_id='${outsider}';
    ${clock('2026-10-25T17:00:00Z')} ${login(outsider)} select public.survivor_join_league('ABCDEF123456789012345678');`);
  assert.equal(joined.league.memberCount, 3); assert.equal(again.league.memberCount, 3); assert.equal(errorStatus(late), 409);
});

test('hosted SQL failed invite attempts consume the durable rate limit', () => {
  const [last] = transaction(`${login(outsider)} do $$ begin for i in 1..30 loop perform public.survivor_join_league('DOESNOTEXIST'); end loop; end $$;
    select public.survivor_join_league('DOESNOTEXIST');`);
  assert.equal(errorStatus(last), 429);
});

test('hosted SQL schedule writes require service role while public reads reveal only NFL data', () => {
  const snapshot = JSON.stringify({ season: 2027, updatedAt: '2027-09-10T12:00:00Z', source: 'Verified fixture', stale: false, games: [{ id: 'next1', season: 2027, week: 1, homeTeamId: '1', awayTeamId: '2', kickoff: '2027-09-12T17:00:00Z', status: 'scheduled' }] });
  assert.throws(() => sql(`begin; set local role authenticated; select public.survivor_sync_schedule('{}'); rollback;`), /permission denied/);
  const [synced, publicView] = transaction(`set local role service_role; set local request.jwt.claim.role='service_role';
    select public.survivor_sync_schedule('${snapshot}'::jsonb); set local role anon; select public.survivor_schedule();`);
  assert.equal(synced.season, 2027);
  assert.ok(publicView.games.some((game: any) => game.id === 'sun7'));
  assert.ok(publicView.games.some((game: any) => game.id === 'next1'));
  assert.doesNotMatch(JSON.stringify(publicView), /inviteCode|Alice|Bob|userId|11111111/);
});

test('hosted SQL simultaneous pick changes remain atomic with one valid saved selection', async () => {
  sql(`begin; ${fixture} commit;`);
  try {
    const teams = ['1', '2', '12', '13', '10', '11'];
    const results = await Promise.all(teams.map(async team => {
      const result = await execute('docker', [...psqlArgs, '-c', `begin; ${pick(alice,team)} commit;`]);
      return JSON.parse(result.stdout.trim());
    }));
    assert.deepEqual(results.map(result => result.myPick.teamId), teams);
    const saved = rows(`select to_jsonb(p) from survivor_private.picks p where league_id='${league}' and user_id='${alice}';`);
    assert.equal(saved.length, 1);
    assert.ok(teams.includes(saved[0].team_id));
    const expectedGame: Record<string,string> = { '1':'thu7', '2':'thu7', '12':'sun7', '13':'sun7', '10':'late7', '11':'late7' };
    assert.equal(saved[0].game_id, expectedGame[saved[0].team_id]);
  } finally {
    sql(`truncate auth.users cascade; truncate survivor_private.games,survivor_private.rate_buckets;
      create or replace function survivor_private.clock() returns timestamptz language sql volatile set search_path='' as $$select clock_timestamp()$$;`);
  }
});

test('hosted SQL concurrent invite joins serialize the final available member slot', async () => {
  const userA = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const userB = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  sql(`begin; ${fixture}
    insert into auth.users(id,raw_user_meta_data) select ('00000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,'{"name":"Member"}' from generate_series(1,97) i;
    insert into survivor_private.members(league_id,user_id) select '${league}',id from auth.users where id::text like '00000000-%';
    insert into auth.users(id,raw_user_meta_data) values('${userA}','{"name":"Join A"}'),('${userB}','{"name":"Join B"}'); commit;`);
  try {
    const results = await Promise.all([userA,userB].map(async id => {
      const query = `begin; ${login(id)} select public.survivor_join_league('ABCDEF123456789012345678'); commit;`;
      const result = await execute('docker', [...psqlArgs, '-c', query], { maxBuffer: 1024 * 1024 });
      return JSON.parse(result.stdout.trim());
    }));
    assert.equal(results.filter(result => result.league?.memberCount === 100).length, 1);
    assert.equal(results.filter(result => errorStatus(result) === 409).length, 1);
    assert.equal(sql(`select count(*) from survivor_private.members where league_id='${league}';`).trim(), '100');
  } finally {
    sql(`truncate auth.users cascade; truncate survivor_private.games,survivor_private.rate_buckets;
      create or replace function survivor_private.clock() returns timestamptz language sql volatile set search_path='' as $$select clock_timestamp()$$;`);
  }
});


test('hosted SQL refresh leases skip fresh data, enforce cooldown, and deny user access', () => {
  assert.throws(() => sql(`begin; set local role authenticated; select public.survivor_claim_schedule_refresh(true); rollback;`), /permission denied/);
  const [fresh, forced, held, failure, cooldown] = transaction(`set local role service_role; set local request.jwt.claim.role='service_role';
    select public.survivor_claim_schedule_refresh(false);
    select public.survivor_claim_schedule_refresh(true);
    select public.survivor_claim_schedule_refresh(true);
    select public.survivor_fail_schedule_refresh();
    select public.survivor_claim_schedule_refresh(true);`);
  assert.equal(fresh.acquired,false);
  assert.equal(forced.acquired,true);
  assert.equal(held.acquired,false);
  assert.equal(failure.stale,true);
  assert.equal(cooldown.acquired,false);
  assert.equal(cooldown.retryAfter,60);
});

test('hosted SQL concurrent cold starts grant a refresh lease to exactly one process', async () => {
  sql(`begin; ${fixture} update survivor_private.schedule_state set upstream_stale=true; commit;`);
  try {
    const results = await Promise.all([1,2,3,4].map(async () => {
      const query = `begin; set local role service_role; set local request.jwt.claim.role='service_role'; select public.survivor_claim_schedule_refresh(false); commit;`;
      const result = await execute('docker', [...psqlArgs,'-c',query]);
      return JSON.parse(result.stdout.trim());
    }));
    assert.equal(results.filter(result => result.acquired).length,1);
    assert.equal(results.filter(result => !result.acquired && result.retryAfter===60).length,3);
  } finally {
    sql(`truncate auth.users cascade; truncate survivor_private.games,survivor_private.rate_buckets;
      create or replace function survivor_private.clock() returns timestamptz language sql volatile set search_path='' as $$select clock_timestamp()$$;`);
  }
});
