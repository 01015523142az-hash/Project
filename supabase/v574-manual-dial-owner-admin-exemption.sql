-- =========================================================================
-- v574: owner and admin could dial a queue but not type a number
-- =========================================================================
--
-- APPLIED LIVE 2026-09-08 as v574_manual_dial_owner_admin_exemption.
--
-- Reported from the floor: the owner signed in, tried a manual dial, and got
-- "Your role cannot dial numbers outside a queue."
--
-- v569 was wrong, and its own header says so out loud:
--
--     admin, owner, quality, recruiter = false  (they cannot dial anyway)
--
-- That parenthesis is false for owner and admin. dialer-call-control's top
-- gate reads:
--
--     if (profile.role !== 'owner' && profile.role !== 'admin') {
--       ...require can_use_dialer...
--     }
--
-- so owner and admin are EXEMPT there and can dial perfectly well. v569 then
-- seeded `can_manual_dial = true where can_use_dialer`, and because owner and
-- admin carry can_use_dialer = false they were seeded false -- and
-- dialer_manual_dial_allowed() had no exemption of its own. Two gates in the
-- same request path, disagreeing about who the privileged roles are.
--
-- The failure was invisible in v569's own verification because that tested
-- the roles it expected to dial. It never asked whether the roles it had
-- written off as "cannot dial anyway" actually could.
--
-- FIXED IN THE FUNCTION, NOT BY FLIPPING THE FLAG. Setting can_manual_dial =
-- true on owner/admin would leave a row reading "cannot use the dialer, may
-- dial numbers outside a queue", which is incoherent -- the roles table would
-- be documenting a rule that is not the rule. The exemption belongs in the
-- same place as the exemption it has to agree with, phrased the same way, so
-- the next person changing one of them sees the other.
--
-- THE CAP STILL APPLIES TO THEM. can_manual_dial answers "who holds this
-- capability"; the daily cap answers "how much damage can a STOLEN session
-- do", and that question does not care about the role of whoever was robbed.
-- An owner's session is the most valuable one to steal, so exempting it from
-- the ceiling would be exactly backwards.
--
-- Quality and recruiter are unaffected and still refused -- correctly, and
-- earlier: they are not exempt in the top gate either, so they never reach
-- this function. They are turned away by "Your role doesn't have permission
-- to use the dialer."
--
-- NOTHING NEEDED REDEPLOYING. v570's trigger calls this function rather than
-- reimplementing the rule, and dialer-call-control calls it too, so both
-- enforcement points picked the fix up from one migration. That is the
-- payoff for v569 putting the gate in one place.

create or replace function dialer_manual_dial_allowed(p_agent uuid)
returns table (allowed boolean, reason text, used integer, cap integer)
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_role text;
  v_can  boolean;
  v_cap  smallint;
  v_used integer;
begin
  select p.role, r.can_manual_dial, r.manual_dial_daily_cap
    into v_role, v_can, v_cap
    from profiles p join roles r on r.name = p.role
   where p.id = p_agent;

  if v_role is null then
    return query select false, 'no_profile'::text, 0, 0; return;
  end if;

  -- Must match dialer-call-control's own top gate, which exempts these two
  -- roles from can_use_dialer. Kept as an explicit line rather than folded
  -- into the select so it is visible to anyone reading either gate.
  if v_role in ('owner', 'admin') then
    v_can := true;
  end if;

  if not coalesce(v_can, false) then
    return query select false, 'not_permitted'::text, 0, coalesce(v_cap, 0)::integer; return;
  end if;

  select count(*)::integer into v_used
    from dialer_attempts a
   where a.agent_id = p_agent
     and a.is_manual
     and a.initiated_at >= date_trunc('day', now());

  -- The cap applies to owner and admin too. It bounds a stolen session, and
  -- an owner's session is the most valuable one to steal.
  if v_used >= coalesce(v_cap, 50) then
    return query select false, 'daily_cap'::text, v_used, coalesce(v_cap, 50)::integer; return;
  end if;

  return query select true, null::text, v_used, coalesce(v_cap, 50)::integer;
end;
$fn$;

comment on function dialer_manual_dial_allowed(uuid) is
  'The manual-dial gate, in one place so dialer-call-control asks rather than '
  'reimplements. Owner and admin are exempt from can_manual_dial because '
  'dialer-call-control''s top gate already exempts them from can_use_dialer -- '
  'v569 missed that and locked the owner out of manual dial on their own '
  'system (v574). The daily cap still applies to them: it bounds a stolen '
  'session, and an owner''s is the most valuable one to steal.';

revoke all on function dialer_manual_dial_allowed(uuid) from public, anon;
grant execute on function dialer_manual_dial_allowed(uuid) to authenticated, service_role;

-- -------------------------------------------------------------- verified --
-- Through the real gate, against a real person in each role:
--   owner (Daniel)        allowed        <- was refused, this is the report
--   admin (AI Assistant)  allowed        <- same latent bug
--   agent / sales / team leader          allowed, unchanged
--   quality / recruiter   not_permitted  <- correct, and they never reach
--                                           here anyway: the top gate turns
--                                           them away first
--
-- Then through the TRIGGER, with real inserts in rolled-back subtransactions,
-- because the function returning true proves nothing if v570 disagrees:
--   owner manual dial                ACCEPTED      (the reported failure)
--   owner with the cap set to 0      refused: "Manual dial limit reached:
--                                    0 of 0 today."   <- exemption does NOT
--                                    bypass the ceiling
--   quality manual dial              refused: "Your role cannot dial numbers
--                                    outside a queue."
--   agent manual dial                ACCEPTED      (unchanged)
--
-- Left behind: nothing. 0 probe rows, every manual_dial_daily_cap back at 50.
