-- =========================================================================
-- v576 + v577: billed_seconds was null on inbound, then on reaped rows
-- =========================================================================
--
-- APPLIED LIVE 2026-09-08 as v576_backfill_inbound_billed_seconds and
-- v577_reaper_must_zero_the_billing_columns.
--
-- Outbound gets talk_seconds and billed_seconds from dialer-telnyx-webhook's
-- call.hangup handler. Inbound is handled by dialer-inbound, which set
-- ended_at, status and was_abandoned and never computed either -- so every
-- inbound row carried billed_seconds null, and any billed-minute total across
-- both directions silently counted only the outbound half.
--
-- v577 exists because fixing v576 revealed the same shape one layer over: the
-- "still null" count moved from inbound to outbound, and the ten rows left
-- were exactly the ten v572's reaper had closed. That reaper set ended_at and
-- status and never touched the billing columns, so it had swapped one silent
-- gap for another.
--
-- ZERO, NOT NULL, and the difference is the point. A call that never answered
-- has no billable duration -- that is a fact, not a guess. Writing 0 says "we
-- know it was nothing"; leaving null says "nobody ever wrote this", and a
-- reconciliation has to be able to tell those apart.
--
-- THE INBOUND INCREMENT IS AN ESTIMATE AND IS LABELLED AS ONE. Outbound on
-- the Voice API is demonstrably 60/60: a 44-second call billed exactly
-- $0.0120, which is one minute at $0.0120/min. Inbound on this same account
-- does NOT behave that way -- three legs of 3s, 17s and 19s cost $0.0003,
-- $0.0012 and $0.0015, and under 60/60 all three would have cost the same.
-- Inbound is therefore charged at a finer granularity that three data points
-- do not pin down.
--
-- So 60 is used as the CONSERVATIVE direction: it over-states, which surfaces
-- as a discrepancy during reconciliation rather than as a shortfall that
-- hides. provider_cost_usd, straight from Telnyx's call.cost event, remains
-- the authoritative figure; billed_seconds only ever explains its shape.
-- When Telnyx confirms the real inbound increment, set
-- TELNYX_INBOUND_BILLING_INCREMENT on dialer-inbound and re-run the first
-- update below with that number.

-- ---- v576: the inbound backfill -----------------------------------------
update dialer_attempts
   set talk_seconds   = greatest(0, round(extract(epoch from (ended_at - answered_at)))::int),
       billed_seconds = case
         when answered_at is null then 0
         when round(extract(epoch from (ended_at - answered_at))) <= 0 then 0
         else ceil(extract(epoch from (ended_at - answered_at)) / 60.0)::int * 60
       end
 where direction = 'inbound'
   and ended_at is not null
   and billed_seconds is null;

-- ---- v577: the reaper must zero them too --------------------------------
-- The function body is in v572's file, amended there. This is the backfill
-- for the ten rows it had already closed.
update dialer_attempts
   set talk_seconds   = coalesce(talk_seconds, 0),
       billed_seconds = 0
 where hangup_cause = 'reaped_no_carrier_event'
   and billed_seconds is null;

comment on column dialer_attempts.billed_seconds is
  'What the carrier charges for, as opposed to talk_seconds which is what '
  'actually happened. Outbound via the Telnyx Voice API is 60/60 -- confirmed '
  'against a real invoice line, a 44s call billing exactly $0.0120 = one '
  'minute at $0.0120/min. Inbound is NOT 60/60 on the same account (3s/17s/19s '
  'legs cost $0.0003/$0.0012/$0.0015, which would be identical under 60/60) '
  'but the real increment is unconfirmed, so inbound is estimated at 60 -- the '
  'over-stating direction, so reconciliation surfaces it. provider_cost_usd is '
  'the authoritative charge; this column explains its shape. Was null on every '
  'inbound row until v576.';

-- -------------------------------------------------------------- verified --
--                  calls  null  talk_s  billed_s  billed/talk
--   outbound          19     0     133       420        3.16
--   inbound            9     0      39       180        4.62
--   ALL               28     0     172       600        3.49
--
-- 3.49x is the 60/60 tax measured on real traffic rather than estimated: the
-- earlier 3.3x projection came from ReadyMode's 18-second average, and this
-- is the same effect showing up in an actual invoice.
--
-- Ten rows are knowingly incomplete and findable rather than silently wrong:
--   where hangup_cause = 'reaped_no_carrier_event' and provider_cost_usd is null
-- is the exact list of calls whose real cost was never reported to us.
