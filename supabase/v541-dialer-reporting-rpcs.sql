-- =========================================================================
-- v541: reporting on the portal's own CDR
-- =========================================================================
--
-- Aggregate counterpart to v532's dialer_call_log(): that one lists calls
-- with filters, these summarise them. Together they replace what the
-- business reads out of readymode_calls / readymode_productivity_daily.
--
-- Aggregated in Postgres rather than the browser for the reason that has
-- bitten this codebase before: any Supabase read over ~1000 rows truncates
-- silently, so summing a month of calls client-side would quietly
-- under-report rather than fail.
--
-- security definer + role_can_review_calls() so a Quality reviewer or team
-- leader sees the whole floor, not only their own rows. The guard is inside
-- each function, so opening the page directly gains nobody anything.
--
-- Applied live 2026-09-05.
-- =========================================================================

create or replace function dialer_agent_stats(from_ts timestamptz, to_ts timestamptz)
returns table(
  agent_id uuid, agent_name text,
  dials bigint, connects bigint, answer_rate numeric,
  talk_seconds bigint, billed_seconds bigint,
  leads bigint, manual_dials bigint, unchecked_hours bigint
)
language sql stable security definer set search_path = public
as $$
  select a.agent_id, p.full_name,
         count(*)::bigint,
         count(a.answered_at)::bigint,
         case when count(*) > 0
              then round(count(a.answered_at)::numeric / count(*), 4) else null end,
         coalesce(sum(a.talk_seconds), 0)::bigint,
         coalesce(sum(a.billed_seconds), 0)::bigint,
         count(*) filter (where d.creates_lead)::bigint,
         count(*) filter (where a.is_manual)::bigint,
         -- Manual dials skip the calling-hours check by policy (v527). That
         -- is only defensible if somebody looks, so it is a first-class
         -- column here rather than a query nobody runs.
         count(*) filter (where not a.hours_checked)::bigint
  from dialer_attempts a
  left join profiles p on p.id = a.agent_id
  left join dialer_dispositions d on d.code = a.disposition
  where a.initiated_at >= from_ts and a.initiated_at < to_ts
    and role_can_review_calls()
  group by a.agent_id, p.full_name
  order by count(*) desc;
$$;

create or replace function dialer_campaign_stats(from_ts timestamptz, to_ts timestamptz)
returns table(
  campaign_id uuid, campaign_name text,
  dials bigint, connects bigint, answer_rate numeric,
  leads bigint, abandoned bigint, dispositions jsonb
)
language sql stable security definer set search_path = public
as $$
  select a.campaign_id, c.name,
         count(*)::bigint,
         count(a.answered_at)::bigint,
         case when count(*) > 0
              then round(count(a.answered_at)::numeric / count(*), 4) else null end,
         count(*) filter (where d.creates_lead)::bigint,
         -- Should always be zero at one line per agent. Non-zero means the
         -- call path is broken, not that pacing needs tuning.
         count(*) filter (where a.was_abandoned)::bigint,
         coalesce(jsonb_object_agg(a.disposition, cnt)
                  filter (where a.disposition is not null), '{}'::jsonb)
  from (
    select campaign_id, answered_at, was_abandoned, disposition, initiated_at,
           count(*) over (partition by campaign_id, disposition) as cnt
    from dialer_attempts
  ) a
  left join dialer_campaigns c on c.id = a.campaign_id
  left join dialer_dispositions d on d.code = a.disposition
  where a.initiated_at >= from_ts and a.initiated_at < to_ts
    and role_can_review_calls()
  group by a.campaign_id, c.name
  order by count(*) desc;
$$;

-- Who is on the floor right now. A session with a stale heartbeat and no
-- ended_at was a closed tab or a dropped connection, not somebody working --
-- surfaced as stale rather than counted as ready, the same distinction the
-- extension's timesheets already make.
create or replace function dialer_live_floor()
returns table(
  agent_id uuid, agent_name text, status text, pause_reason text,
  campaign_name text, since timestamptz, seconds_in_state int,
  heartbeat_age_seconds int, is_stale boolean
)
language sql stable security definer set search_path = public
as $$
  select s.agent_id, p.full_name, s.status, s.pause_reason, c.name,
         s.started_at,
         extract(epoch from (now() - s.started_at))::int,
         extract(epoch from (now() - s.last_heartbeat_at))::int,
         (now() - s.last_heartbeat_at) > interval '2 minutes'
  from dialer_agent_sessions s
  left join profiles p on p.id = s.agent_id
  left join dialer_campaigns c on c.id = s.campaign_id
  where s.ended_at is null and role_can_review_calls()
  order by s.started_at;
$$;

revoke all on function dialer_agent_stats(timestamptz, timestamptz) from public;
revoke all on function dialer_campaign_stats(timestamptz, timestamptz) from public;
revoke all on function dialer_live_floor() from public;
grant execute on function dialer_agent_stats(timestamptz, timestamptz) to authenticated, service_role;
grant execute on function dialer_campaign_stats(timestamptz, timestamptz) to authenticated, service_role;
grant execute on function dialer_live_floor() to authenticated, service_role;
