-- =========================================================================
-- v566: the live floor was reading a superseded status model, and the
--       sessions behind it never ended
-- =========================================================================
--
-- APPLIED LIVE 2026-09-07 via apply_migration
-- (v566_live_floor_current_status_model_and_session_reap).
--
-- dialer_live_floor() had no callers, which is how both faults survived.
--
-- FAULT 1 -- it read s.status, s.pause_reason and s.started_at: the pause
-- model v537 REPLACED with agent_status / agent_status_since. Those columns
-- still exist on the table, so it did not fail -- it returned plausible,
-- wrong answers. That is the worse failure mode, and the reason an uncalled
-- function is not harmless: nothing was exercising it, so nothing noticed it
-- had been left behind by a schema change.
--
-- FAULT 2 -- and the bigger one. A session is ended by a sendBeacon on tab
-- close, which is best-effort and never fires on a crash, a killed browser or
-- a closed laptop. Nothing else ever closes one. At this audit:
--
--   133 sessions open, from 3 distinct agents
--   133 of them with NO heartbeat inside 2 minutes
--   100 of them over a DAY old, oldest 2026-09-05
--
-- The admin Agents tab selected open sessions, newest 50 first, and called
-- them "Live sessions". It was showing fifty dead tabs.
--
-- So: reap the day-old backlog, and make the function define "on the floor"
-- rather than leaving it to whoever writes the next screen. Anything with no
-- heartbeat for 15 minutes is not the floor. The 2-15 minute band still comes
-- back, with is_stale set, because a stale heartbeat means a CRASHED TAB
-- rather than a logout and that distinction is worth showing rather than
-- hiding.
--
-- Names and campaign are resolved inside the function now. profiles is
-- readable only through 'self or admin', so the old client-side join handed
-- raw uuids to any manager who could not see through that policy.
--
-- NOT FIXED HERE: nothing prevents the backlog rebuilding. The honest fix is
-- a reaper on a schedule; this migration only clears what had accumulated and
-- stops the view showing it.

update dialer_agent_sessions
   set ended_at = coalesce(last_heartbeat_at, started_at),
       status = 'offline'
 where ended_at is null
   and now() - coalesce(last_heartbeat_at, started_at) > interval '1 day';

-- Safe to drop: no callers at all, which is how the staleness was found.
drop function if exists dialer_live_floor();

create or replace function dialer_live_floor()
returns table (
  agent_id uuid, agent_name text, agent_status text, status_label text,
  campaign_name text, since timestamptz, seconds_in_state integer,
  heartbeat_age_seconds integer, is_stale boolean
)
language sql
stable
security definer
set search_path = public
as $$
  select s.agent_id,
         p.full_name,
         s.agent_status,
         st.label,
         c.name,
         s.agent_status_since,
         extract(epoch from (now() - s.agent_status_since))::int,
         extract(epoch from (now() - s.last_heartbeat_at))::int,
         (now() - s.last_heartbeat_at) > interval '2 minutes'
    from dialer_agent_sessions s
    left join profiles p on p.id = s.agent_id
    left join dialer_campaigns c on c.id = s.campaign_id
    left join dialer_agent_statuses st on st.code = s.agent_status
   where s.ended_at is null
     and now() - s.last_heartbeat_at < interval '15 minutes'
     and (is_admin() or role_can_manage_dialer() or role_can_review_calls())
   order by (now() - s.last_heartbeat_at), s.agent_status_since desc;
$$;

revoke all on function dialer_live_floor() from public;
grant execute on function dialer_live_floor() to authenticated, service_role;

-- -------------------------------------------------------------- verified --
--   open sessions   133 -> 33   (100 reaped; the 33 left are under a day old)
--   over a day old  100 -> 0
--   admin calling dialer_live_floor()  -> 0 rows
--
-- Zero is the CORRECT answer and the point of the change: nobody is actually
-- on the floor, and the old view would have shown fifty rows saying otherwise.
--
-- The security gate was checked rather than assumed. role_can_review_calls()
-- is not what its name suggests -- it is
--   is_admin() OR r.can_review_calls OR r.can_manage_dialer
-- so owner and admin pass it despite both having can_review_calls = false in
-- the roles table. Confirmed by impersonation: an admin and a team leader
-- both saw the same 133 rows before the change.
