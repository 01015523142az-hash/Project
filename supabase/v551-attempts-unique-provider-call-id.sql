-- =========================================================================
-- v551: one call leg, one CDR row
-- =========================================================================
--
-- APPLIED LIVE 2026-09-06 via apply_migration (v551_attempts_unique_provider_call_id).
--
-- Telnyx retries any webhook delivery it does not get a 2xx for inside the
-- connection's webhook timeout, and a Supabase cold start can outrun a short
-- one. dialer-inbound's call.initiated handler opened a dialer_attempts row
-- unconditionally, so a retry did not just double-count a call:
--
--   * it answered the same call twice, and
--   * it handed the RETRY's attempt id to every later event via client_state,
--     orphaning the first row -- the one already carrying the call's history.
--
-- The handler now looks for an existing row by call_control_id first. That is
-- still check-then-insert across two statements, though, and two retries
-- arriving together can both pass the check. This index is what actually makes
-- it true.
--
-- Partial, because provider_call_id is null on every attempt opened before the
-- browser reports its call id, and those are emphatically not duplicates of
-- one another.
--
-- Verified before applying: 8 rows carried a call id, 8 distinct, 0 duplicated.
-- Verified after, in a rolled-back transaction: a second insert with the same
-- call id is refused, two rows with a null call id are still allowed, and one
-- row survives per leg.

create unique index if not exists dialer_attempts_provider_call_id_uniq
  on dialer_attempts (provider_call_id)
  where provider_call_id is not null;
