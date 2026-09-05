-- =========================================================================
-- v527: manual-dial flags on the call-detail record
-- =========================================================================
--
-- Applied live 2026-09-05 alongside the manual_dial action in
-- dialer-call-control. Recorded here so the repo matches the database.
--
-- A manual dial is an agent typing a number that is in no queue. It skips
-- two things a queued dial does not, and both exceptions have to be visible
-- in the CDR rather than implied by the absence of a contact_id.
-- =========================================================================

-- SKIPPED GATE 1: the list scrub. A human deciding to call one specific
-- person -- a callback, an inbound follow-up -- is a different compliance
-- posture from working a cold list. But it means some calls go out with no
-- list scrub behind them, and a compliance review needs to find exactly
-- those. It also keeps manual calls out of campaign answer-rate figures,
-- which would otherwise be polluted by hand-dialled warm contacts.
alter table dialer_attempts add column if not exists is_manual boolean not null default false;

create index if not exists dialer_attempts_manual_idx
  on dialer_attempts(agent_id, initiated_at desc) where is_manual;


-- SKIPPED GATE 2: calling hours.
--
-- True for every queued dial: dialer-call-control resolves the contact's own
-- time zone (written by pre-dial validation from the NUMBER, not from any
-- address) and enforces the campaign window before authorising.
--
-- FALSE for manual dials. There is no contact row to read a time zone from,
-- and the decision was taken to let the agent judge local time rather than
-- resolve it inline. That is a legitimate choice -- but it moves a hard
-- 8am-9pm TSR limit from the system to a human, and the difference between
-- "we have controls plus an exception log" and "we have no idea" is exactly
-- this column. The console requires a per-call acknowledgement naming the
-- rule, so the judgement is deliberate rather than a button that looks like
-- every other button.
--
-- The compliance query is then trivial:
--   select initiated_at, agent_id, to_number
--   from dialer_attempts where not hours_checked order by initiated_at desc;
alter table dialer_attempts add column if not exists hours_checked boolean not null default true;

create index if not exists dialer_attempts_hours_unchecked_idx
  on dialer_attempts(initiated_at desc) where not hours_checked;
