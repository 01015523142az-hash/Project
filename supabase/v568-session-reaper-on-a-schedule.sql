-- =========================================================================
-- v568: a session reaper, on a schedule
-- =========================================================================
--
-- APPLIED LIVE 2026-09-07 via apply_migration (v568_session_reaper_on_a_schedule).
--
-- v566 reaped the backlog by hand and said plainly that nothing stopped it
-- rebuilding. This is that reaper.
--
-- WHY THEY ACCUMULATE. A session is ended by a sendBeacon on tab close. That
-- is best-effort by definition, and it never fires on a crash, a killed
-- browser or a closed laptop. Nothing else ever closed one, so every session
-- ever opened stayed open: 133 from 3 agents at the audit, all with a dead
-- heartbeat, the oldest two days old.
--
-- WHY 30 MINUTES. The console heartbeats every 30 seconds, so 30 minutes is
-- SIXTY consecutive misses. That margin is not caution for its own sake --
-- the heartbeat does not filter on ended_at, so a session closed while its
-- tab is still open keeps heartbeating into a row that dialer_live_floor()
-- and dialer_available_agents() both ignore. The agent would stop being
-- offered inbound calls, for the rest of their shift, with nothing on screen
-- explaining it. The function floors the argument at 5 minutes so a caller
-- cannot ask for something reckless.
--
-- The other half of that safety is in dialer/index.html: the heartbeat now
-- CLEARS ended_at, so a session reaped in error repairs itself within 30
-- seconds. It cannot resurrect a properly closed one -- the tab is gone by
-- then, and the timer with it.
--
-- ended_at is the LAST MOMENT WE KNOW THEY WERE THERE, never now(). Using
-- now() would inflate every reaped session by however long it sat unnoticed,
-- and those lengths are what the shift reports are built on.

create or replace function dialer_reap_dead_sessions(p_idle_minutes integer default 30)
returns integer
language plpgsql
volatile
security definer
set search_path = public
as $fn$
declare
  v_closed integer;
begin
  update dialer_agent_sessions
     set ended_at = coalesce(last_heartbeat_at, started_at),
         status   = 'offline'
   where ended_at is null
     and coalesce(last_heartbeat_at, started_at)
         < now() - make_interval(mins => greatest(p_idle_minutes, 5));
  get diagnostics v_closed = row_count;

  if v_closed > 0 then
    raise log 'dialer_reap_dead_sessions: closed % session(s)', v_closed;
  end if;
  return v_closed;
end;
$fn$;

revoke all on function dialer_reap_dead_sessions(integer) from public;
grant execute on function dialer_reap_dead_sessions(integer) to service_role;

-- Every 10 minutes. Pure SQL, so it runs in-database like job 14
-- (refresh_list_builder_stats_snapshot) rather than paying for an edge
-- function round trip to do one UPDATE.
select cron.schedule(
  'dialer-reap-dead-sessions',
  '*/10 * * * *',
  $cron$select dialer_reap_dead_sessions(30);$cron$
);

-- -------------------------------------------------------------- verified --
-- Scheduled as jobid 38, '*/10 * * * *', active, running as postgres.
--
-- Behaviour, in a rolled-back transaction with three sessions staged on ONE
-- agent so the counts could not be confused with their existing rows:
--
--   heartbeat 20 seconds ago   -> still open   (a live agent is never touched)
--   heartbeat 9 minutes ago    -> still open   (a network blip is not death)
--   heartbeat 45 minutes ago   -> closed
--   ended_at = last_heartbeat_at, not now()    -> yes
--   floor holds when asked for 1 minute        -> yes
--
-- First real run closed the 33 sessions v566 had left as under-a-day. The
-- table now has 133 sessions and 0 of them open, which is correct: nobody is
-- signed in.
--
-- A NOTE ON READING THAT BACK. Checking the count in the same statement as
-- the call returns the PRE-update snapshot -- all subqueries in one statement
-- see one snapshot. It looked briefly like the reaper had closed 33 rows and
-- left 33 open. Query it separately.
