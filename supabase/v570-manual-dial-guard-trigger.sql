-- =========================================================================
-- v570: enforce the manual-dial gate on the insert, not only in the caller
-- =========================================================================
--
-- APPLIED LIVE 2026-09-07 via apply_migration (v570_manual_dial_guard_trigger).
--
-- v569 added the rule and the function. dialer-call-control was edited to ask
-- it, and gives a far better message than a database error -- but that file is
-- 809 lines and every deploy of it is a full hand re-transcription of the one
-- function that authorises every dial. Leaving the gate unenforced until that
-- deploy happened would have meant a rule that existed on paper.
--
-- So the enforcement lives here, at the last possible moment: on the insert
-- itself. That is stronger than the caller-side check in three ways --
--
--   it cannot be skipped by a SECOND caller written later,
--   it cannot be skipped by anything holding the service role,
--   and it is already true, before the edge function ships.
--
-- The caller-side check is not redundant. It refuses BEFORE the DNC lookup,
-- so somebody who may not manual-dial cannot use the endpoint to probe
-- whether a number is on our list, and it returns "38 of 50 used today"
-- instead of an exception. Belt and braces, each doing what the other cannot.
--
-- WHY A SEPARATE TRIGGER rather than extending dialer_attempt_assignment_guard:
-- that guard returns early on is_manual, deliberately -- manual dial is the
-- explicit human exception to campaign assignment. The two cover DISJOINT
-- cases and neither should second-guess the other. Extending it would have
-- meant editing a working guard to add an unrelated rule.
--
-- OWNER AND ADMIN ARE NOT EXEMPT, unlike in the assignment guard. An
-- exemption buried in trigger source is invisible from the roles table, and a
-- capability should be readable where it is configured. If they need it, set
-- can_manual_dial on their role -- which is the whole point of v569.

create or replace function dialer_manual_dial_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  g record;
begin
  if not coalesce(new.is_manual, false) or new.agent_id is null then
    return new;
  end if;

  select * into g from dialer_manual_dial_allowed(new.agent_id);

  if g.allowed then
    return new;
  end if;

  if g.reason = 'daily_cap' then
    raise exception 'Manual dial limit reached: % of % today.', g.used, g.cap
      using errcode = 'check_violation';
  else
    raise exception 'Your role cannot dial numbers outside a queue.'
      using errcode = 'insufficient_privilege';
  end if;
end;
$fn$;

comment on function dialer_manual_dial_guard() is
  'Enforces v569''s manual-dial gate at the last possible moment, on the '
  'insert itself. dialer-call-control checks the same rule and gives a much '
  'better message, but this is the one that cannot be skipped -- not by a '
  'future second caller, not by anything holding the service role, and not by '
  'a deploy that has not happened yet. Deliberately NOT exempting owner/admin: '
  'the exemption in dialer_attempt_assignment_guard is invisible from the '
  'roles table, and a capability should be readable where it is configured. '
  'If they need it, set can_manual_dial on their role.';

drop trigger if exists dialer_manual_dial_guard on dialer_attempts;
create trigger dialer_manual_dial_guard
  before insert on dialer_attempts
  for each row execute function dialer_manual_dial_guard();

-- -------------------------------------------------------------- verified --
-- Four cases, each in its own rolled-back transaction against a real agent:
--
--   permitted, under the cap        -> INSERTED
--   manual_dial_daily_cap = 0       -> refused, 23514
--                                      "Manual dial limit reached: 0 of 0 today."
--   can_manual_dial = false         -> refused, 42501
--                                      "Your role cannot dial numbers outside a queue."
--   QUEUE dial (is_manual = false),
--   with the capability revoked AND
--   the cap at 0                    -> INSERTED, untouched
--
-- The last one is the case worth having. It proves the two guards cover
-- disjoint sets: revoking manual dial must not stop an agent working their
-- queue, and it does not.
