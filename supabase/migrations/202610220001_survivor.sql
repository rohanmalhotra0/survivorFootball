-- Survivor Club: hosted persistence and authoritative survivor rules.
-- Apply with the Supabase migration owner. The private schema is never exposed
-- through PostgREST; clients receive only the explicitly granted public RPCs.
begin;

create schema if not exists survivor_private;
revoke all on schema survivor_private from public, anon, authenticated;

create table survivor_private.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check (char_length(display_name) between 2 and 40),
  created_at timestamptz not null default clock_timestamp()
);
create table survivor_private.leagues (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 3 and 60),
  invite_code text not null unique,
  owner_id uuid not null references survivor_private.profiles(id),
  season integer not null check (season between 2000 and 2100),
  start_week integer not null check (start_week between 1 and 18),
  created_at timestamptz not null default clock_timestamp()
);
create table survivor_private.members (
  league_id uuid not null references survivor_private.leagues(id) on delete cascade,
  user_id uuid not null references survivor_private.profiles(id) on delete cascade,
  joined_at timestamptz not null default clock_timestamp(),
  primary key (league_id, user_id)
);
create table survivor_private.picks (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null,
  user_id uuid not null,
  week integer not null check (week between 1 and 18),
  team_id text not null,
  game_id text not null,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  foreign key (league_id, user_id) references survivor_private.members(league_id,user_id) on delete cascade,
  unique (league_id,user_id,week),
  unique (league_id,user_id,team_id)
);
create index picks_league_week on survivor_private.picks(league_id,week);
create index members_user on survivor_private.members(user_id);
create table survivor_private.games (
  id text primary key,
  season integer not null check (season between 2000 and 2100),
  week integer not null check (week between 1 and 18),
  home_team_id text not null,
  away_team_id text not null,
  kickoff timestamptz not null,
  status text not null check (status in ('scheduled','in_progress','final','postponed','canceled')),
  home_score integer check (home_score >= 0),
  away_score integer check (away_score >= 0),
  odds jsonb,
  check (home_team_id <> away_team_id)
);
create index games_season_week on survivor_private.games(season,week);
create table survivor_private.schedule_state (
  singleton boolean primary key default true check (singleton),
  season integer check (season between 2000 and 2100),
  fetched_at timestamptz,
  source text not null default 'nflverse / nfldata',
  upstream_stale boolean not null default true
);
insert into survivor_private.schedule_state(singleton) values(true);
create table survivor_private.rate_buckets (
  bucket_key text primary key,
  attempts integer not null,
  resets_at timestamptz not null
);

alter table survivor_private.profiles enable row level security;
alter table survivor_private.leagues enable row level security;
alter table survivor_private.members enable row level security;
alter table survivor_private.picks enable row level security;
alter table survivor_private.games enable row level security;
alter table survivor_private.schedule_state enable row level security;
alter table survivor_private.rate_buckets enable row level security;
-- No direct data API policy is intentional. RPC owners perform the narrowly
-- scoped reads/writes; anon/authenticated cannot query, count, stream, or mutate
-- raw picks, membership, invite codes, or rate buckets.
revoke all on all tables in schema survivor_private from public, anon, authenticated;

create function survivor_private.clock() returns timestamptz
language sql volatile set search_path = '' as $$ select clock_timestamp() $$;

create function survivor_private.reveal_at(p_season integer,p_week integer) returns timestamptz
language sql immutable strict set search_path = '' as $$
  select (make_date(p_season,9,1)
    + ((8 - extract(dow from make_date(p_season,9,1))::integer) % 7)
    + 6 + (p_week-1)*7 + time '13:00') at time zone 'America/New_York'
$$;

create function survivor_private.current_week(p_season integer,p_at timestamptz) returns integer
language sql stable strict set search_path = '' as $$
  select coalesce(max(w),1)::integer from generate_series(1,18) w
  where ((survivor_private.reveal_at(p_season,w) at time zone 'America/New_York')::date - 5)
    ::timestamp at time zone 'America/New_York' <= p_at
$$;

create function survivor_private.require_user() returns uuid
language plpgsql stable set search_path = '' as $$
declare v_user uuid := auth.uid();
begin
  if v_user is null then raise exception using errcode='PT401',message='Sign in to continue.'; end if;
  return v_user;
end $$;

create function survivor_private.require_member(p_league uuid,p_user uuid) returns survivor_private.leagues
language plpgsql stable set search_path = '' as $$
declare v_league survivor_private.leagues;
begin
  select l.* into v_league from survivor_private.leagues l
    join survivor_private.members m on m.league_id=l.id where l.id=p_league and m.user_id=p_user;
  if not found then raise exception using errcode='PT404',message='League not found.'; end if;
  return v_league;
end $$;

create function survivor_private.profile_from_auth() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_name text;
begin
  v_name := left(trim(coalesce(new.raw_user_meta_data->>'name',new.raw_user_meta_data->>'display_name','Player')),40);
  if char_length(v_name)<2 then v_name := 'Player'; end if;
  insert into survivor_private.profiles(id,display_name) values(new.id,v_name) on conflict(id) do nothing;
  return new;
end $$;
create trigger survivor_profile_created after insert on auth.users for each row execute function survivor_private.profile_from_auth();
insert into survivor_private.profiles(id,display_name)
  select id,case when char_length(trim(coalesce(raw_user_meta_data->>'name','')))>=2
    then left(trim(raw_user_meta_data->>'name'),40) else 'Player' end from auth.users
  on conflict(id) do nothing;

create function survivor_private.limit_attempt(p_key text,p_limit integer,p_seconds integer) returns jsonb
language plpgsql volatile set search_path = '' as $$
declare v_now timestamptz:=survivor_private.clock(); v_bucket survivor_private.rate_buckets;
begin
  insert into survivor_private.rate_buckets(bucket_key,attempts,resets_at)
    values(p_key,1,v_now+make_interval(secs=>p_seconds))
  on conflict(bucket_key) do update set
    attempts=case when survivor_private.rate_buckets.resets_at<=v_now then 1 else survivor_private.rate_buckets.attempts+1 end,
    resets_at=case when survivor_private.rate_buckets.resets_at<=v_now then v_now+make_interval(secs=>p_seconds) else survivor_private.rate_buckets.resets_at end
  returning * into v_bucket;
  -- Remove only expired buckets; current rejected attempts remain durable.
  delete from survivor_private.rate_buckets where resets_at < v_now - interval '1 day';
  return jsonb_build_object('allowed',v_bucket.attempts<=p_limit,'retryAfter',
    case when v_bucket.attempts<=p_limit then 0 else greatest(1,ceil(extract(epoch from v_bucket.resets_at-v_now))::integer) end);
end $$;

create function public.survivor_rate_limit(p_kind text,p_key_hash text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_limit integer; v_seconds integer;
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception using errcode='42501',message='Service role required.'; end if;
  if p_key_hash !~ '^[a-f0-9]{64}$' then raise exception using errcode='22023',message='A SHA-256 key digest is required.'; end if;
  case p_kind
    when 'auth-register' then v_limit:=20; v_seconds:=3600;
    when 'auth-login' then v_limit:=30; v_seconds:=900;
    when 'auth-reset' then v_limit:=10; v_seconds:=3600;
    when 'auth-confirm' then v_limit:=30; v_seconds:=900;
    else raise exception using errcode='22023',message='Unknown rate-limit kind.';
  end case;
  return survivor_private.limit_attempt(p_kind||':'||p_key_hash,v_limit,v_seconds);
end $$;

create function survivor_private.game_json(p_game survivor_private.games) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_strip_nulls(jsonb_build_object('id',p_game.id,'season',p_game.season,'week',p_game.week,
    'homeTeamId',p_game.home_team_id,'awayTeamId',p_game.away_team_id,'kickoff',p_game.kickoff,
    'status',p_game.status,'homeScore',p_game.home_score,'awayScore',p_game.away_score,
    'winnerTeamId',case when p_game.status='final' and p_game.home_score>p_game.away_score then p_game.home_team_id
      when p_game.status='final' and p_game.away_score>p_game.home_score then p_game.away_team_id end,
    'odds',p_game.odds))
$$;

create function public.survivor_schedule() returns jsonb
language plpgsql security definer stable set search_path = '' as $$
declare v_state survivor_private.schedule_state; v_now timestamptz:=survivor_private.clock(); v_season integer; v_games jsonb;
begin
  select * into v_state from survivor_private.schedule_state where singleton;
  v_season:=coalesce(v_state.season,extract(year from v_now at time zone 'America/New_York')::integer
    - case when extract(month from v_now at time zone 'America/New_York')<3 then 1 else 0 end);
  select coalesce(jsonb_agg(survivor_private.game_json(g) order by g.kickoff),'[]'::jsonb) into v_games from survivor_private.games g;
  return jsonb_build_object('games',v_games,'season',v_season,'currentWeek',survivor_private.current_week(v_season,v_now),
    'updatedAt',v_state.fetched_at,'source',v_state.source,
    'stale',v_state.upstream_stale or v_state.fetched_at is null or v_state.fetched_at<v_now-interval '2 hours');
end $$;

create function public.survivor_sync_schedule(p_snapshot jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_game jsonb; v_now timestamptz:=survivor_private.clock(); v_season integer;
  v_team_ids constant text[]:=array['1','2','3','4','5','6','7','8','9','10','11','12','13','14','15','16','17','18','19','20','21','22','23','24','25','26','27','28','29','30','33','34'];
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception using errcode='42501',message='Service role required.'; end if;
  if jsonb_typeof(p_snapshot->'games') is distinct from 'array' or jsonb_array_length(p_snapshot->'games') not between 1 and 20000 then
    raise exception using errcode='22023',message='Expected a nonempty schedule snapshot.';
  end if;
  v_season:=(p_snapshot->>'season')::integer;
  if v_season not between 2000 and 2100 then raise exception using errcode='22023',message='Invalid season.'; end if;
  perform pg_advisory_xact_lock(hashtextextended('survivor-schedule-sync',0));
  if exists(select 1 from jsonb_array_elements(p_snapshot->'games') e group by e->>'id' having count(*)>1) then
    raise exception using errcode='22023',message='Duplicate schedule game IDs.';
  end if;
  for v_game in select value from jsonb_array_elements(p_snapshot->'games') loop
    if char_length(coalesce(v_game->>'id','')) not between 1 and 128
      or not (v_game->>'homeTeamId'=any(v_team_ids)) or not (v_game->>'awayTeamId'=any(v_team_ids))
      or v_game->>'homeTeamId'=v_game->>'awayTeamId' then
      raise exception using errcode='22023',message='Invalid schedule team or identifier.';
    end if;
    insert into survivor_private.games(id,season,week,home_team_id,away_team_id,kickoff,status,home_score,away_score,odds)
      values(v_game->>'id',(v_game->>'season')::integer,(v_game->>'week')::integer,v_game->>'homeTeamId',v_game->>'awayTeamId',
        (v_game->>'kickoff')::timestamptz,v_game->>'status',(v_game->>'homeScore')::integer,(v_game->>'awayScore')::integer,v_game->'odds')
      on conflict(id) do update set season=excluded.season,week=excluded.week,home_team_id=excluded.home_team_id,
        away_team_id=excluded.away_team_id,kickoff=excluded.kickoff,status=excluded.status,
        home_score=excluded.home_score,away_score=excluded.away_score,odds=excluded.odds;
  end loop;
  -- Retain prior seasons and absent games to avoid reviving old eliminated entries.
  update survivor_private.schedule_state set season=v_season,
    fetched_at=least(coalesce((p_snapshot->>'updatedAt')::timestamptz,v_now),v_now),
    source=left(coalesce(nullif(p_snapshot->>'source',''),'nflverse / nfldata'),100),
    upstream_stale=coalesce((p_snapshot->>'stale')::boolean,false) where singleton;
  return jsonb_build_object('season',v_season,'games',jsonb_array_length(p_snapshot->'games'),'updatedAt',v_now);
end $$;

create function survivor_private.pick_result(p_game_id text,p_team_id text) returns text
language plpgsql stable set search_path = '' as $$
declare v_game survivor_private.games;
begin
  select * into v_game from survivor_private.games where id=p_game_id;
  if not found then return 'pending'; end if;
  if v_game.status='canceled' then return 'void'; end if;
  if v_game.status<>'final' or v_game.home_score is null or v_game.away_score is null then return 'pending'; end if;
  if v_game.home_score=v_game.away_score then return 'tie'; end if;
  if (v_game.home_score>v_game.away_score and v_game.home_team_id=p_team_id)
    or (v_game.away_score>v_game.home_score and v_game.away_team_id=p_team_id) then return 'win'; end if;
  return 'loss';
end $$;

create function survivor_private.league_json(p_league survivor_private.leagues,p_user uuid) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('id',p_league.id,'name',p_league.name,'inviteCode',p_league.invite_code,
    'season',p_league.season,'startWeek',p_league.start_week,
    'memberCount',(select count(*) from survivor_private.members where league_id=p_league.id),
    'role',case when p_league.owner_id=p_user then 'commissioner' else 'member' end,'createdAt',p_league.created_at)
$$;

create function survivor_private.league_results(p_league survivor_private.leagues,p_at timestamptz) returns jsonb
language plpgsql stable set search_path = '' as $$
declare v_states jsonb:='{}'; v_unresolved uuid[]:='{}'; v_active uuid[]; v_alive uuid[]; v_user uuid;
  v_count integer; v_week integer; v_pick survivor_private.picks; v_result text; v_results jsonb; v_has_games boolean;
  v_ready boolean; v_ended integer;
begin
  select count(*) into v_count from survivor_private.members where league_id=p_league.id;
  for v_user in select user_id from survivor_private.members where league_id=p_league.id loop
    v_states:=v_states||jsonb_build_object(v_user::text,jsonb_build_object('status','alive'));
  end loop;
  for v_week in p_league.start_week..18 loop
    exit when survivor_private.reveal_at(p_league.season,v_week)>p_at;
    select coalesce(array_agg(key::uuid),'{}'::uuid[]) into v_active from jsonb_each(v_states) where value->>'status'='alive';
    v_has_games:=exists(select 1 from survivor_private.games where season=p_league.season and week=v_week);
    v_results:='{}';
    foreach v_user in array v_active loop
      select * into v_pick from survivor_private.picks where league_id=p_league.id and user_id=v_user and week=v_week;
      if found then v_result:=survivor_private.pick_result(v_pick.game_id,v_pick.team_id);
      elsif v_has_games then v_result:='missed'; else v_result:='pending'; end if;
      v_results:=v_results||jsonb_build_object(v_user::text,v_result);
      if v_result='pending' then v_unresolved:=array_append(v_unresolved,v_user); end if;
      if v_result in ('loss','tie','missed') then
        v_states:=v_states||jsonb_build_object(v_user::text,jsonb_build_object('status','eliminated','eliminatedWeek',v_week));
      end if;
    end loop;
    select coalesce(array_agg(key::uuid),'{}'::uuid[]) into v_alive from jsonb_each(v_states) where value->>'status'='alive';
    v_ready:=cardinality(v_alive)>0;
    foreach v_user in array v_alive loop
      if v_user=any(v_unresolved) or coalesce(v_results->>v_user::text,'') not in ('win','void') then v_ready:=false; end if;
    end loop;
    if v_ready and ((cardinality(v_alive)=1 and v_count>1) or v_week=18) then
      foreach v_user in array v_alive loop v_states:=v_states||jsonb_build_object(v_user::text,jsonb_build_object('status','winner')); end loop;
      v_ended:=v_week; exit;
    end if;
    if cardinality(v_alive)=0 then
      if v_count>1 and not (v_active&&v_unresolved) then
        foreach v_user in array v_active loop v_states:=v_states||jsonb_build_object(v_user::text,jsonb_build_object('status','winner')); end loop;
      end if;
      v_ended:=v_week; exit;
    end if;
  end loop;
  return jsonb_strip_nulls(jsonb_build_object('statuses',v_states,'endedWeek',v_ended));
end $$;

create function survivor_private.dashboard(p_league survivor_private.leagues,p_user uuid,p_week integer,p_at timestamptz) returns jsonb
language plpgsql stable set search_path = '' as $$
declare v_state survivor_private.schedule_state; v_week integer; v_current integer; v_results jsonb;
  v_members jsonb:='[]'; v_member record; v_member_state jsonb; v_history jsonb; v_pick survivor_private.picks;
  v_selected jsonb; v_my_pick jsonb; v_used jsonb; v_games jsonb; v_result text; v_history_week integer;
  v_revealed boolean; v_has_pick boolean; v_eliminated integer; v_has_games boolean; v_locked boolean;
begin
  select * into v_state from survivor_private.schedule_state where singleton;
  v_current:=case when p_league.season<coalesce(v_state.season,p_league.season) then 18
    else survivor_private.current_week(p_league.season,p_at) end;
  v_week:=coalesce(p_week,greatest(p_league.start_week,v_current));
  if v_week not between 1 and 18 then raise exception using errcode='PT400',message='Week must be between 1 and 18.'; end if;
  v_revealed:=p_at>=survivor_private.reveal_at(p_league.season,v_week);
  v_results:=survivor_private.league_results(p_league,p_at);
  for v_member in select p.id,p.display_name from survivor_private.members m join survivor_private.profiles p on p.id=m.user_id
    where m.league_id=p_league.id order by m.joined_at,p.id loop
    v_member_state:=v_results->'statuses'->v_member.id::text;
    v_eliminated:=(v_member_state->>'eliminatedWeek')::integer;
    v_history:='[]';
    for v_history_week in p_league.start_week..least(coalesce((v_results->>'endedWeek')::integer,18),greatest(v_week,v_current)) loop
      exit when v_eliminated is not null and v_history_week>v_eliminated;
      if v_member.id<>p_user and p_at<survivor_private.reveal_at(p_league.season,v_history_week) then
        v_history:=v_history||jsonb_build_array(jsonb_build_object('week',v_history_week,'status','hidden'));
      else
        select * into v_pick from survivor_private.picks where league_id=p_league.id and user_id=v_member.id and week=v_history_week;
        if found then
          v_history:=v_history||jsonb_build_array(jsonb_build_object('week',v_history_week,'teamId',v_pick.team_id,'gameId',v_pick.game_id,
            'status',survivor_private.pick_result(v_pick.game_id,v_pick.team_id)));
        else
          v_has_games:=exists(select 1 from survivor_private.games where season=p_league.season and week=v_history_week);
          v_result:=case when p_at>=survivor_private.reveal_at(p_league.season,v_history_week) and v_has_games then 'missed' else 'pending' end;
          v_history:=v_history||jsonb_build_array(jsonb_build_object('week',v_history_week,'status',v_result));
        end if;
      end if;
    end loop;
    v_selected:=null; v_has_pick:=false;
    -- Do not even expose submission existence for an unrevealed opponent.
    if v_member.id=p_user or v_revealed then
      select * into v_pick from survivor_private.picks where league_id=p_league.id and user_id=v_member.id and week=v_week;
      v_has_pick:=found;
      if v_has_pick then
        select v_revealed or g.status<>'scheduled' or g.kickoff<=p_at into v_locked from survivor_private.games g where id=v_pick.game_id;
        v_selected:=jsonb_build_object('teamId',v_pick.team_id,'gameId',v_pick.game_id,'week',v_week,
          'status',survivor_private.pick_result(v_pick.game_id,v_pick.team_id),'locked',coalesce(v_locked,true));
      end if;
    end if;
    if v_member.id=p_user then v_my_pick:=v_selected; end if;
    v_members:=v_members||jsonb_build_array(jsonb_build_object('id',v_member.id,'name',v_member.display_name,
      'status',v_member_state->>'status','pick',v_selected,'pickState',
      case when v_member.id<>p_user and not v_revealed then 'hidden' when not v_has_pick then 'missing'
        when v_revealed then 'revealed' else 'submitted' end,'history',v_history)
      ||case when v_eliminated is not null then jsonb_build_object('eliminatedWeek',v_eliminated) else '{}'::jsonb end);
  end loop;
  select coalesce(jsonb_agg(team_id order by week),'[]'::jsonb) into v_used from survivor_private.picks
    where league_id=p_league.id and user_id=p_user and week<>v_week;
  select coalesce(jsonb_agg(survivor_private.game_json(g) order by g.kickoff),'[]'::jsonb) into v_games from survivor_private.games g
    where g.season=p_league.season and g.week=v_week;
  return jsonb_build_object('league',survivor_private.league_json(p_league,p_user),'season',p_league.season,'week',v_week,
    'revealAt',survivor_private.reveal_at(p_league.season,v_week),'picksRevealed',v_revealed,'games',v_games,
    'members',v_members,'myPick',v_my_pick,'usedTeamIds',v_used,'currentUserId',p_user,'currentWeek',v_current,
    'oddsUpdatedAt',v_state.fetched_at,'dataSource',v_state.source,
    'dataStale',v_state.upstream_stale or v_state.fetched_at is null or v_state.fetched_at<p_at-interval '2 hours','demo',false);
end $$;

create function public.survivor_list_leagues() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_user uuid; v_leagues jsonb;
begin
  v_user:=survivor_private.require_user();
  select coalesce(jsonb_agg(survivor_private.league_json(l,v_user) order by l.created_at desc),'[]'::jsonb) into v_leagues
    from survivor_private.leagues l join survivor_private.members m on m.league_id=l.id where m.user_id=v_user;
  return jsonb_build_object('leagues',v_leagues);
exception when sqlstate 'PT401' then return jsonb_build_object('error',jsonb_build_object('message',sqlerrm,'status',401));
end $$;

create function public.survivor_dashboard(p_league_id uuid,p_week integer default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_user uuid; v_league survivor_private.leagues;
begin
  v_user:=survivor_private.require_user();
  v_league:=survivor_private.require_member(p_league_id,v_user);
  return survivor_private.dashboard(v_league,v_user,p_week,survivor_private.clock());
exception when sqlstate 'PT400' or sqlstate 'PT401' or sqlstate 'PT404' then
  return jsonb_build_object('error',jsonb_build_object('message',sqlerrm,'status',substring(sqlstate from 3)::integer));
end $$;

create function public.survivor_create_league(p_name text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_user uuid; v_limit jsonb; v_name text:=trim(p_name); v_now timestamptz; v_state survivor_private.schedule_state;
  v_week integer; v_league survivor_private.leagues;
begin
  v_user:=auth.uid();
  if v_user is null then return jsonb_build_object('error',jsonb_build_object('message','Sign in to continue.','status',401)); end if;
  v_limit:=survivor_private.limit_attempt('create-league:'||v_user::text,30,3600);
  if not (v_limit->>'allowed')::boolean then return jsonb_build_object('error',jsonb_build_object('message','Too many attempts. Please try again later.','status',429,'retryAfter',v_limit->'retryAfter')); end if;
  begin
    if v_name is null or char_length(v_name) not between 3 and 60 then raise exception using errcode='PT400',message='League name must be between 3 and 60 characters.'; end if;
    v_now:=survivor_private.clock();
    select * into v_state from survivor_private.schedule_state where singleton;
    if v_state.season is null then raise exception using errcode='PT503',message='The NFL schedule is not initialized yet.'; end if;
    v_week:=survivor_private.current_week(v_state.season,v_now);
    if v_now>=survivor_private.reveal_at(v_state.season,v_week) then v_week:=v_week+1; end if;
    if v_week>18 then raise exception using errcode='PT409',message='The regular season has ended. New leagues open with the next schedule.'; end if;
    if not exists(select 1 from survivor_private.games where season=v_state.season and week=v_week) then
      raise exception using errcode='PT503',message='The next NFL schedule is not available yet.';
    end if;
    insert into survivor_private.leagues(name,invite_code,owner_id,season,start_week)
      values(v_name,upper(substr(replace(gen_random_uuid()::text,'-',''),1,24)),v_user,v_state.season,v_week) returning * into v_league;
    insert into survivor_private.members(league_id,user_id) values(v_league.id,v_user);
    return jsonb_build_object('league',survivor_private.league_json(v_league,v_user));
  exception when sqlstate 'PT400' or sqlstate 'PT409' or sqlstate 'PT503' then
    return jsonb_build_object('error',jsonb_build_object('message',sqlerrm,'status',substring(sqlstate from 3)::integer));
  end;
end $$;

create function public.survivor_join_league(p_invite_code text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_user uuid; v_limit jsonb; v_league survivor_private.leagues; v_code text:=upper(trim(p_invite_code));
begin
  v_user:=auth.uid();
  if v_user is null then return jsonb_build_object('error',jsonb_build_object('message','Sign in to continue.','status',401)); end if;
  v_limit:=survivor_private.limit_attempt('join-league:'||v_user::text,30,900);
  if not (v_limit->>'allowed')::boolean then return jsonb_build_object('error',jsonb_build_object('message','Too many attempts. Please try again later.','status',429,'retryAfter',v_limit->'retryAfter')); end if;
  begin
    if v_code is null or char_length(v_code) not between 6 and 32 then raise exception using errcode='PT400',message='Enter a valid invite code.'; end if;
    select * into v_league from survivor_private.leagues where invite_code=v_code for update;
    if not found then raise exception using errcode='PT404',message='Invite code was not found.'; end if;
    if exists(select 1 from survivor_private.members where league_id=v_league.id and user_id=v_user) then
      return jsonb_build_object('league',survivor_private.league_json(v_league,v_user));
    end if;
    if survivor_private.clock()>=survivor_private.reveal_at(v_league.season,v_league.start_week) then raise exception using errcode='PT409',message='Joining closed at this league’s first Sunday reveal.'; end if;
    if (select count(*) from survivor_private.members where league_id=v_league.id)>=100 then raise exception using errcode='PT409',message='This league has reached its 100-member limit.'; end if;
    insert into survivor_private.members(league_id,user_id) values(v_league.id,v_user);
    return jsonb_build_object('league',survivor_private.league_json(v_league,v_user));
  exception when sqlstate 'PT400' or sqlstate 'PT404' or sqlstate 'PT409' then
    return jsonb_build_object('error',jsonb_build_object('message',sqlerrm,'status',substring(sqlstate from 3)::integer));
  end;
end $$;

create function survivor_private.mutate_pick(p_league_id uuid,p_team_id text,p_week integer,p_delete boolean) returns jsonb
language plpgsql set search_path = '' as $$
declare v_user uuid; v_limit jsonb; v_league survivor_private.leagues; v_state survivor_private.schedule_state;
  v_now timestamptz; v_current integer; v_week integer; v_results jsonb; v_status text;
  v_existing survivor_private.picks; v_game survivor_private.games; v_existing_game survivor_private.games;
begin
  v_user:=auth.uid();
  if v_user is null then return jsonb_build_object('error',jsonb_build_object('message','Sign in to continue.','status',401)); end if;
  v_limit:=survivor_private.limit_attempt('pick:'||v_user::text,120,60);
  if not (v_limit->>'allowed')::boolean then return jsonb_build_object('error',jsonb_build_object('message','Too many attempts. Please try again later.','status',429,'retryAfter',v_limit->'retryAfter')); end if;
  begin
    -- Lock the entry before inspecting history or replacing its pick. Every
    -- mutation for that entry follows this lock order, including deletion.
    perform 1 from survivor_private.members where league_id=p_league_id and user_id=v_user for update;
    if not found then raise exception using errcode='PT404',message='League not found.'; end if;
    v_league:=survivor_private.require_member(p_league_id,v_user);
    v_now:=survivor_private.clock();
    select * into v_state from survivor_private.schedule_state where singleton;
    v_current:=survivor_private.current_week(coalesce(v_state.season,v_league.season),v_now);
    v_week:=coalesce(p_week,greatest(v_league.start_week,v_current));
    if v_week not between 1 and 18 then raise exception using errcode='PT400',message='Week must be between 1 and 18.'; end if;
    if v_league.season is distinct from v_state.season or v_week<v_league.start_week or v_week<v_current
      or v_week>greatest(v_league.start_week,v_current) then raise exception using errcode='PT409',message='Picks are open only for your league’s current week.'; end if;
    if v_now>=survivor_private.reveal_at(v_league.season,v_week) then raise exception using errcode='PT409',message='Picks locked at Sunday 1 p.m. New York time.'; end if;
    v_results:=survivor_private.league_results(v_league,v_now);
    v_status:=v_results->'statuses'->v_user::text->>'status';
    if v_status='eliminated' then raise exception using errcode='PT409',message='Your entry has been eliminated.'; end if;
    if v_status='winner' then raise exception using errcode='PT409',message='This league is complete. Your entry is a winner!'; end if;
    select * into v_existing from survivor_private.picks where league_id=p_league_id and user_id=v_user and week=v_week;
    if found then
      select * into v_existing_game from survivor_private.games where id=v_existing.game_id;
      if not found or v_existing_game.status<>'scheduled' or v_existing_game.kickoff<=v_now then
        raise exception using errcode='PT409',message='Your selected game has locked. This pick cannot be changed.';
      end if;
    end if;
    if p_delete then
      delete from survivor_private.picks where league_id=p_league_id and user_id=v_user and week=v_week;
    else
      if p_team_id is null or char_length(p_team_id) not between 1 and 10 then raise exception using errcode='PT400',message='Choose an eligible NFL team.'; end if;
      select * into v_game from survivor_private.games where season=v_league.season and week=v_week and p_team_id in (home_team_id,away_team_id);
      if not found then raise exception using errcode='PT400',message='That team does not have an eligible game this week.'; end if;
      if v_game.status<>'scheduled' or v_game.kickoff<=v_now then raise exception using errcode='PT409',message='That game has already started or is unavailable.'; end if;
      if exists(select 1 from survivor_private.picks where league_id=p_league_id and user_id=v_user and team_id=p_team_id and week<>v_week) then
        raise exception using errcode='PT409',message='You have already used that team this season.';
      end if;
      insert into survivor_private.picks(league_id,user_id,week,team_id,game_id)
        values(p_league_id,v_user,v_week,p_team_id,v_game.id)
      on conflict(league_id,user_id,week) do update set team_id=excluded.team_id,game_id=excluded.game_id,updated_at=v_now;
    end if;
    return survivor_private.dashboard(v_league,v_user,v_week,v_now);
  exception when sqlstate 'PT400' or sqlstate 'PT404' or sqlstate 'PT409' then
    return jsonb_build_object('error',jsonb_build_object('message',sqlerrm,'status',substring(sqlstate from 3)::integer));
  end;
end $$;

create function public.survivor_submit_pick(p_league_id uuid,p_team_id text,p_week integer default null) returns jsonb
language sql security definer set search_path = '' as $$
  select survivor_private.mutate_pick(p_league_id,p_team_id,p_week,false)
$$;
create function public.survivor_delete_pick(p_league_id uuid,p_week integer default null) returns jsonb
language sql security definer set search_path = '' as $$
  select survivor_private.mutate_pick(p_league_id,null,p_week,true)
$$;

-- Every PostgreSQL function starts with PUBLIC execute unless explicitly revoked.
revoke all on all functions in schema survivor_private from public, anon, authenticated, service_role;
revoke all on function public.survivor_rate_limit(text,text) from public,anon,authenticated;
revoke all on function public.survivor_sync_schedule(jsonb) from public,anon,authenticated;
grant execute on function public.survivor_rate_limit(text,text),public.survivor_sync_schedule(jsonb) to service_role;
revoke all on function public.survivor_schedule() from public;
grant execute on function public.survivor_schedule() to anon,authenticated,service_role;
revoke all on function public.survivor_list_leagues(),public.survivor_create_league(text),public.survivor_join_league(text),
  public.survivor_dashboard(uuid,integer),public.survivor_submit_pick(uuid,text,integer),public.survivor_delete_pick(uuid,integer) from public,anon;
grant execute on function public.survivor_list_leagues(),public.survivor_create_league(text),public.survivor_join_league(text),
  public.survivor_dashboard(uuid,integer),public.survivor_submit_pick(uuid,text,integer),public.survivor_delete_pick(uuid,integer) to authenticated;

commit;
