-- A durable lease prevents concurrent Vercel cold starts from all fetching NFL data.
begin;
alter table survivor_private.schedule_state add column refresh_lease_until timestamptz;

create function public.survivor_claim_schedule_refresh(p_force boolean default false) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_now timestamptz:=survivor_private.clock(); v_state survivor_private.schedule_state;
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception using errcode='42501',message='Service role required.'; end if;
  select * into v_state from survivor_private.schedule_state where singleton for update;
  if v_state.refresh_lease_until>v_now then
    return jsonb_build_object('acquired',false,'retryAfter',greatest(1,ceil(extract(epoch from v_state.refresh_lease_until-v_now))::integer));
  end if;
  if not coalesce(p_force,false) and not v_state.upstream_stale and v_state.fetched_at>v_now-interval '30 minutes' then
    return jsonb_build_object('acquired',false,'retryAfter',greatest(1,ceil(extract(epoch from v_state.fetched_at+interval '30 minutes'-v_now))::integer));
  end if;
  update survivor_private.schedule_state set refresh_lease_until=v_now+interval '60 seconds' where singleton;
  return jsonb_build_object('acquired',true,'retryAfter',0);
end $$;

create function public.survivor_fail_schedule_refresh() returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception using errcode='42501',message='Service role required.'; end if;
  -- A short durable retry cooldown avoids an outage causing a request stampede.
  update survivor_private.schedule_state set upstream_stale=true,
    refresh_lease_until=survivor_private.clock()+interval '60 seconds' where singleton;
  return jsonb_build_object('stale',true,'retryAfter',60);
end $$;

-- Preserve the validated synchronizer privately; the public wrapper clears the
-- lease only after a successful, atomic database update.
alter function public.survivor_sync_schedule(jsonb) set schema survivor_private;
revoke all on function survivor_private.survivor_sync_schedule(jsonb) from public,anon,authenticated,service_role;
create function public.survivor_sync_schedule(p_snapshot jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_result jsonb;
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception using errcode='42501',message='Service role required.'; end if;
  v_result:=survivor_private.survivor_sync_schedule(p_snapshot);
  update survivor_private.schedule_state set refresh_lease_until=null where singleton;
  return v_result;
end $$;
revoke all on function public.survivor_claim_schedule_refresh(boolean),public.survivor_fail_schedule_refresh(),
  public.survivor_sync_schedule(jsonb) from public,anon,authenticated;
grant execute on function public.survivor_claim_schedule_refresh(boolean),public.survivor_fail_schedule_refresh(),
  public.survivor_sync_schedule(jsonb) to service_role;
commit;
