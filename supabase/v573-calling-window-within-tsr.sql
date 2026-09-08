-- =========================================================================
-- v573: a campaign cannot be configured to dial outside 8am-9pm
-- =========================================================================
--
-- APPLIED LIVE 2026-09-08 as v573_calling_window_cannot_exceed_tsr_hours.
--
-- The only active campaign had calling_window 00:00:00-23:59:00 across all
-- seven days. dialer-call-control's gate 3 does exactly what it is told: it
-- compares the called party's local time against that window, so with that
-- window it never refuses anything. The dialer was configured to be willing
-- to ring a stranger at 3am.
--
-- Nothing had gone out at 3am -- the campaign is named "Test Campaign --
-- Manual QA" and the window was almost certainly widened so somebody could
-- test at an odd hour. That is exactly how it happens: a QA convenience that
-- nobody remembers to narrow, on the one campaign that later gets real
-- contacts loaded into it.
--
-- 47 U.S.C. 227 / 16 CFR 310.4(c) put the limit at 8am-9pm in the CALLED
-- PARTY's local time, which is the time gate 3 already computes -- it derives
-- the zone from the number's area code, never from the property address, for
-- precisely this reason. So the gate was right and its configuration was not.
--
-- A CHECK CONSTRAINT rather than a default, a trigger, or a note in the admin
-- UI. A default only helps the next campaign. A UI check is bypassed by
-- PostgREST, which is how the admin console writes this row anyway. The
-- constraint is the only version that is true of every row however it was
-- written, including by hand in the SQL editor at midnight.
--
-- Narrower windows stay legal: this is a ceiling, not a fixed schedule. A
-- campaign may run 09:00-17:00 if it wants. It may not run 07:00-22:00.
--
-- Not constrained here: calling_days. The federal rule is about hours, not
-- days, and some states restrict Sundays while others do not -- encoding a
-- guess about that would be worse than leaving it to whoever sets the
-- campaign up.

-- Fix the data first: a CHECK cannot be added while a row violates it, and
-- 21:00 is the legal maximum rather than an opinion about when to stop.
update dialer_campaigns
   set calling_window_start = greatest(calling_window_start, time '08:00'),
       calling_window_end   = least(calling_window_end,   time '21:00')
 where calling_window_start < time '08:00'
    or calling_window_end   > time '21:00';

alter table dialer_campaigns
  add constraint dialer_campaigns_calling_window_within_tsr
  check (calling_window_start >= time '08:00'
     and calling_window_end   <= time '21:00'
     and calling_window_start <  calling_window_end);

comment on constraint dialer_campaigns_calling_window_within_tsr on dialer_campaigns is
  'The TSR limit (16 CFR 310.4(c)): no telemarketing call before 8am or after '
  '9pm in the CALLED PARTY''s local time -- which is the time dialer-call-'
  'control gate 3 computes, from the number''s area code rather than the '
  'property address. A ceiling, not a schedule: narrower windows are fine. '
  'Added in v573 after the only active campaign was found configured '
  '00:00-23:59, which made gate 3 unable to refuse anything.';

-- -------------------------------------------------------------- verified --
-- The row, after: 08:00:00-21:00:00, days [1..7] unchanged.
--
-- The constraint, exercised in rolled-back subtransactions:
--   widen to 00:00-23:59        refused by constraint
--   start at 07:00 (before 8am) refused by constraint
--   end at 22:00 (after 9pm)    refused by constraint
--   inverted 20:00-09:00        refused by constraint
--   narrow to 09:00-17:00       ACCEPTED -- correct, a ceiling not a schedule
--
-- And end to end, which is the one that shows it does something real. A
-- simulated freshly-imported Chicago contact, run through gate 3's own logic
-- at 06:32 America/Chicago:
--
--   contact local time 06:32, campaign window 08:00-21:00 -> refused
--
-- Under the old 00:00-23:59 window that same call was dialable. This is the
-- difference the constraint makes, on a real row, at a real time of day.
