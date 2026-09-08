-- =========================================================================
-- v572: close CDR rows that no carrier event ever closed
-- =========================================================================
--
-- APPLIED LIVE 2026-09-08 as v572_reap_stuck_attempts.
--
-- v568 reaps dead SESSIONS. Nothing reaped dead ATTEMPTS, and the full sweep
-- found ten: status 'failed', ended_at null, sixty-odd hours old, no
-- provider_call_id. The browser never obtained a Telnyx call id, so
-- attach_call_id never ran, so dialer-telnyx-webhook could not correlate a
-- call.hangup -- which is the only thing that sets ended_at on the outbound
-- path.
--
-- WHY IT IS NOT URGENT, stated so nobody panics reading this later: every
-- read of `ended_at is null` on dialer_attempts is scoped to
-- direction='inbound' (dialer_inbound_waiting, and the transfer/floor
-- helpers), and agent-busy is decided from dialer_agent_sessions.status, not
-- from open attempts. So these rows blocked nothing. This is reporting debt,
-- and it compounds: every future query that asks "what is still open" without
-- remembering to scope to inbound gets a wrong answer, and duration maths on
-- a row with no ended_at silently produces null.
--
-- WHAT ended_at IS SET TO, and why not now(). now() would invent an
-- hours-long call out of a dial that never connected, and that number would
-- then appear in reporting as talk time. coalesce(answered_at, initiated_at)
-- is the last moment we actually observed, so the row's duration becomes zero
-- rather than fabricated. Zero is wrong too, but it is wrong in a way that
-- reads as "we do not know" instead of "this agent was on a 62-hour call".
--
-- hangup_cause is stamped 'reaped_no_carrier_event' so a reaped row can never
-- be mistaken for one the carrier actually reported on. Nothing else in the
-- system emits that value.
--
-- THE WINDOW IS DELIBERATELY WIDE. A live call has ended_at null too, and
-- closing one out from under an agent mid-conversation would be far worse
-- than leaving a stale row for another hour. Four hours is longer than any
-- real call on a dialer whose average is eighteen seconds, and the reaper
-- runs hourly, so the worst case is a stale row living about five hours.

create or replace function dialer_reap_stuck_attempts(p_stale_hours integer default 4)
returns table (reaped integer, oldest_hours numeric)
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_cut timestamptz := now() - make_interval(hours => greatest(1, p_stale_hours));
  v_n   integer;
  v_old numeric;
begin
  select count(*), max(round(extract(epoch from (now() - initiated_at))/3600, 1))
    into v_n, v_old
    from dialer_attempts
   where ended_at is null and initiated_at < v_cut;

  update dialer_attempts
     set ended_at     = coalesce(answered_at, initiated_at),
         -- Only relabel a row that never reached a terminal status. One
         -- already marked 'failed' or 'no_answer' keeps that: the console or
         -- the webhook knew something, and overwriting it would lose it.
         status       = case when status in ('initiated', 'ringing', 'in_progress')
                             then 'failed' else status end,
         hangup_cause = coalesce(hangup_cause, 'reaped_no_carrier_event'),
         -- v577: zero, not null. This reaper originally set ended_at and
         -- status and left the billing columns alone, which swapped one
         -- silent gap for another -- the row stopped reading as open but
         -- still contributed nothing to SUM(billed_seconds) and nothing said
         -- why. ended_at is answered_at (or initiated_at), so the arithmetic
         -- is 0 by construction; it is written explicitly so the column says
         -- "known to be nothing" rather than "never written".
         --
         -- For a reaped row that DID answer, 0 is honest rather than
         -- accurate: the carrier charged for something we never learned.
         -- `where hangup_cause = 'reaped_no_carrier_event' and
         -- provider_cost_usd is null` is the exact list of those.
         talk_seconds = coalesce(talk_seconds,
           greatest(0, round(extract(epoch from
             (coalesce(answered_at, initiated_at) - coalesce(answered_at, initiated_at))))::int)),
         billed_seconds = coalesce(billed_seconds, 0)
   where ended_at is null
     and initiated_at < v_cut;

  return query select coalesce(v_n, 0), v_old;
end;
$fn$;

comment on function dialer_reap_stuck_attempts(integer) is
  'Closes dialer_attempts rows that no call.hangup ever closed -- the outbound '
  'path only gets ended_at from dialer-telnyx-webhook, and that needs a '
  'provider_call_id the console sometimes never obtains. ended_at is set to '
  'the last observed moment (answered_at, else initiated_at), never now(), so '
  'a dial that never connected does not become an hours-long call in '
  'reporting. hangup_cause is stamped reaped_no_carrier_event so a reaped row '
  'is never mistaken for a carrier-reported one. Four hours by default because '
  'a LIVE call also has ended_at null and must not be closed under the agent.';

revoke all on function dialer_reap_stuck_attempts(integer) from public, anon;
grant execute on function dialer_reap_stuck_attempts(integer) to service_role;

-- Hourly. Cheap (one indexed range scan) and bounded: nothing to do is the
-- normal case. Same direct-SQL cron shape as v568's session reaper -- no HTTP,
-- so no key to rotate and nothing to authenticate.
select cron.unschedule('dialer-reap-stuck-attempts')
 where exists (select 1 from cron.job where jobname = 'dialer-reap-stuck-attempts');

select cron.schedule('dialer-reap-stuck-attempts', '5 * * * *',
                     $cron$select dialer_reap_stuck_attempts(4);$cron$);

-- -------------------------------------------------------------- verified --
-- First run, against the ten real rows:
--   reaped 10, oldest 65.1 hours
--
-- After:
--   still_open                0
--   reaped_marked             10
--   max_reaped_duration_secs  0        <- not 65 hours. Nothing fabricated.
--   reaped_by_status          {failed: 10}    <- 'failed' PRESERVED, not
--                                                overwritten
--   untouched_by_status       {completed: 11, no_answer: 6}
--                                             <- the seventeen real calls,
--                                                with their real durations
--   cron job                  dialer-reap-stuck-attempts @ 5 * * * *
