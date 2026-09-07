-- =========================================================================
-- v569: a gate on manual dial
-- =========================================================================
--
-- APPLIED LIVE 2026-09-07 via apply_migration (v569_gate_manual_dial).
--
-- manual_dial is the widest door in the dialer, and its own header in
-- dialer-call-control says why, deliberately:
--
--   internal DNC   ENFORCED, absolutely
--   calling hours  NOT checked -- hours_checked=false, the agent acknowledges
--   list scrub     SKIPPED    -- is_manual records the exception
--   assignment     NOT checked
--
-- Every one of those is a defensible policy for a human choosing to ring one
-- specific person back. Together they mean that ANY session which can reach
-- this action can reach ANY non-DNC US number -- and until now every account
-- with can_use_dialer had it, with no ceiling.
--
-- That matters more than it looks because the dialer shares an ORIGIN, and
-- therefore a sessionStorage, with the staff portal. dashboard.html is 2.3MB
-- and 37k lines on that same origin. One XSS anywhere in it yields a session
-- that can place calls on a live carrier account. Separating the origins is
-- the structural fix and is a separate piece of work; this narrows the door
-- in the meantime.
--
-- TWO CONTROLS, because they stop different things.
--
--   can_manual_dial        decides WHO holds the capability. Seeded true for
--                          every role that already had can_use_dialer, so
--                          this migration changed nobody's day -- it made the
--                          capability revocable, per role, instead of an
--                          accident of having the dialer at all.
--
--   manual_dial_daily_cap  bounds a STOLEN session, which a role check cannot,
--                          because the thief holds the role. 50 is generous
--                          for real callbacks and still a hard ceiling. Counted
--                          from dialer_attempts.is_manual, which v527 records
--                          precisely so calls that went out without a scrub can
--                          be found.
--
-- The count is deliberately taken from the CDR rather than a counter column:
-- a counter can drift, and the CDR is the thing a compliance review reads.

alter table roles add column if not exists can_manual_dial boolean not null default false;
alter table roles add column if not exists manual_dial_daily_cap smallint not null default 50;

update roles set can_manual_dial = true where can_use_dialer;

comment on column roles.can_manual_dial is
  'May type a number that is in no queue. This is the widest door in the '
  'dialer: manual_dial enforces internal DNC absolutely, but by deliberate '
  'policy it does NOT check calling hours (hours_checked=false, the agent '
  'acknowledges), does NOT apply a list scrub (is_manual records it), and '
  'does NOT check campaign assignment. So a session that can manual-dial can '
  'reach any non-DNC US number. Seeded true for every role that already had '
  'can_use_dialer, so v569 changed nobody''s day -- it made the capability '
  'revocable.';

comment on column roles.manual_dial_daily_cap is
  'Manual dials per agent per UTC day. This is the control that actually '
  'bounds a STOLEN session, which a role check does not: the thief holds the '
  'role. 50 is generous for real callbacks and still a hard ceiling on abuse. '
  'Counted from dialer_attempts.is_manual, which v527 records precisely so '
  'calls that went out without a scrub can be found.';

create or replace function dialer_manual_dial_allowed(p_agent uuid)
returns table (allowed boolean, reason text, used integer, cap integer)
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_can  boolean;
  v_cap  smallint;
  v_used integer;
begin
  select r.can_manual_dial, r.manual_dial_daily_cap
    into v_can, v_cap
    from profiles p join roles r on r.name = p.role
   where p.id = p_agent;

  if v_can is null then
    return query select false, 'no_profile'::text, 0, 0; return;
  end if;
  if not v_can then
    return query select false, 'not_permitted'::text, 0, v_cap::integer; return;
  end if;

  select count(*)::integer into v_used
    from dialer_attempts a
   where a.agent_id = p_agent
     and a.is_manual
     and a.initiated_at >= date_trunc('day', now());

  if v_used >= v_cap then
    return query select false, 'daily_cap'::text, v_used, v_cap::integer; return;
  end if;

  return query select true, null::text, v_used, v_cap::integer;
end;
$fn$;

comment on function dialer_manual_dial_allowed(uuid) is
  'The manual-dial gate, in one place so dialer-call-control asks rather than '
  'reimplements. Returns the reason and the numbers so the console can say '
  '"38 of 50 used today" instead of a bare refusal.';

revoke all on function dialer_manual_dial_allowed(uuid) from public;
grant execute on function dialer_manual_dial_allowed(uuid) to authenticated, service_role;

-- -------------------------------------------------------------- verified --
-- Seeding, immediately after applying:
--
--   agent, sales, team leader   can_manual_dial = true   (unchanged behaviour)
--   admin, owner, quality, recruiter            = false  (they cannot dial anyway)
--   every role                  cap = 50
--
-- All four branches, in rolled-back transactions against a real agent:
--
--   permitted, nothing used      -> allowed,  used 0  cap 50
--   can_manual_dial revoked      -> refused,  not_permitted
--   cap set to 0                 -> refused,  daily_cap
--   cap 2 with TWO real is_manual attempts inserted for today
--                                -> refused,  daily_cap, used 2 cap 2
--   unknown user id              -> refused,  no_profile
--
-- The fourth case is the one worth having: it proves the refusal comes from
-- COUNTING the CDR, not merely from reading the configured number.
--
-- DEPLOYED 2026-09-07 as dialer-call-control v10, verify_jwt=true preserved.
-- Verified three ways, because that file is 809 lines and authorises every
-- dial: the deployed source was fetched back and compared against local; a
-- POST carrying a valid JWT reached OUR code and returned {"ok":false,
-- "error":"Not signed in"}, which only happens after the module has loaded,
-- the import resolved and auth.getUser() run; and local fingerprints matched
-- (809 lines, 20 refuse() calls, 6 gate markers, 4 action branches, 5 rpc
-- calls, 1 console.warn).
--
-- dialer-call-control calls this first in the manual_dial branch, before the
-- DNC lookup -- cheapest refusal, and somebody who may not manual-dial should
-- not be able to use the endpoint to probe whether a number is on our DNC
-- list. It fails CLOSED: if the gate cannot be evaluated the dial is refused,
-- because guessing "yes" on the one action that reaches arbitrary numbers is
-- the wrong way to be wrong.
