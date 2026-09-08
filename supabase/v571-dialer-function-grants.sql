-- =========================================================================
-- v571: the v556/v557 grant bug again, one layer down -- on FUNCTIONS
-- =========================================================================
--
-- APPLIED LIVE 2026-09-07 as three migrations:
--   v571_revoke_public_execute_on_dialer_functions
--   v571b_dialer_functions_service_role_only
--   v571c_close_the_last_anon_executable_dialer_functions
--
-- v556 found the grants on dialer_fs_credentials were backwards. v557 swept
-- all 130 tables for the same shape. Neither looked at FUNCTIONS, and
-- PostgreSQL grants EXECUTE to PUBLIC on every new function by default -- so
-- unless a migration said otherwise, every dialer RPC was callable by `anon`.
-- Most are SECURITY DEFINER, which means they do not merely bypass the
-- caller's RLS, they run as the owner.
--
-- The functions written with an explicit `revoke ... from public` (v569's
-- dialer_manual_dial_allowed, and dialer_live_floor, dialer_research_number)
-- were correctly closed. Eighteen others never got that line.
--
-- HOW IT WAS FOUND: smoke-testing the whole dialer. The tell was in the ACL
-- listing -- `=X/postgres` is PUBLIC holding EXECUTE -- but an ACL is a claim,
-- so every one was then called over PostgREST with the anon key. That key is
-- public; it ships in the page source. This is "anyone on the internet".
--
-- WHAT ACTUALLY ANSWERED, before the fix:
--
--   dialer_queue_for_number('+1555...')  -> 200, returning a REAL queue uuid.
--                                           Live data, from a phone number
--                                           alone, to a stranger.
--   dialer_next_number(contact)          -> 200  (a member of the public's
--                                           phone number, given a contact id)
--   dialer_available_agents(queue)       -> 200  (the staff roster)
--   dialer_agent_sip_uri(agent)          -> 200  (an agent's SIP identity)
--   dialer_inbound_waiting()             -> 200  (who is holding, right now)
--   dialer_transfer_targets(attempt)     -> 200
--   dialer_queue_usage(agent, campaign)  -> 200
--   dialer_bump_number_attempt(phone)    -> 204  A WRITE. IT EXECUTED.
--   dialer_advance_number(phone, ...)    -> 204  A WRITE. IT EXECUTED.
--   dialer_recycle_contact(contact)      -> anon-executable (write)
--
-- The three writes are the serious part. dialer_advance_number sets a phone
-- line's outcome and can mark it terminal, dialer_bump_number_attempt pushes
-- a line toward max_attempts, and dialer_recycle_contact puts retired
-- contacts back in the queue. Given contact-phone ids, an outsider could
-- retire the dialable numbers out of the contact database one at a time, and
-- it would read as ordinary dialing activity.
--
-- The ids are uuids and so not guessable. That is not a control; it is the
-- reason this is bad rather than catastrophic. dialer_queue_for_number hands
-- out a real one from a phone number alone.
--
-- WHO ACTUALLY CALLS WHAT, established by grepping the callers rather than
-- assumed -- the difference between a fix and an outage:
--
--   service_role only (edge functions, service-role client)
--     dialer_advance_number, dialer_bump_number_attempt, dialer_queue_usage
--                                             <- dialer-call-control
--     dialer_agent_sip_uri, dialer_available_agents,
--     dialer_queue_for_number, dialer_queue_is_open
--                                             <- dialer-inbound
--     dialer_recycle_contact                  <- SQL only (v562)
--
--   authenticated too (the agent console calls these from the browser)
--     dialer_inbound_waiting, dialer_set_agent_status,
--     dialer_status_usage_today               <- dialer/index.html
--     dialer_next_number                      <- console AND dialer-call-control
--     dialer_transfer_targets                 <- console, and dialer-transfer
--                                                calls it on the CALLER's
--                                                token, not the service role
--
-- revoke from PUBLIC, then grant explicitly. Revoking PUBLIC alone would also
-- take EXECUTE away from roles that only held it through PUBLIC, which is how
-- a lockdown becomes an outage.

-- ---- part 1: service_role only ------------------------------------------
revoke all on function dialer_advance_number(uuid, text, boolean) from public, anon;
grant execute on function dialer_advance_number(uuid, text, boolean) to service_role;

revoke all on function dialer_bump_number_attempt(uuid) from public, anon;
grant execute on function dialer_bump_number_attempt(uuid) to service_role;

revoke all on function dialer_queue_usage(uuid, uuid) from public, anon;
grant execute on function dialer_queue_usage(uuid, uuid) to service_role;

revoke all on function dialer_agent_sip_uri(uuid) from public, anon;
grant execute on function dialer_agent_sip_uri(uuid) to service_role;

revoke all on function dialer_available_agents(uuid) from public, anon;
grant execute on function dialer_available_agents(uuid) to service_role;

revoke all on function dialer_queue_for_number(text) from public, anon;
grant execute on function dialer_queue_for_number(text) to service_role;

revoke all on function dialer_queue_is_open(uuid, timestamptz) from public, anon;
grant execute on function dialer_queue_is_open(uuid, timestamptz) to service_role;

-- ---- part 1: the console calls these, so authenticated keeps them --------
revoke all on function dialer_inbound_waiting() from public, anon;
grant execute on function dialer_inbound_waiting() to authenticated, service_role;

revoke all on function dialer_next_number(uuid) from public, anon;
grant execute on function dialer_next_number(uuid) to authenticated, service_role;

revoke all on function dialer_transfer_targets(uuid) from public, anon;
grant execute on function dialer_transfer_targets(uuid) to authenticated, service_role;

revoke all on function dialer_set_agent_status(uuid, text) from public, anon;
grant execute on function dialer_set_agent_status(uuid, text) to authenticated, service_role;

revoke all on function dialer_status_usage_today() from public, anon;
grant execute on function dialer_status_usage_today() to authenticated, service_role;

-- ---- part 2 (v571b): four kept an EXPLICIT authenticated grant -----------
-- Revoking PUBLIC left it standing, so they were still reachable by any
-- signed-in staff account straight from the browser. Much narrower than the
-- anon hole and still wrong, for the reason part 1's own comment states:
-- the console reaches these through dialer-call-control, which authorises the
-- dial FIRST. Called directly they skip every gate -- DNC, calling hours, the
-- list scrub, the assignment check -- because those live in the edge function,
-- not in these. A comment describing a rule the database is not enforcing is
-- worse than no comment.
revoke execute on function dialer_advance_number(uuid, text, boolean) from authenticated;
revoke execute on function dialer_bump_number_attempt(uuid) from authenticated;
revoke execute on function dialer_queue_usage(uuid, uuid) from authenticated;
revoke execute on function dialer_queue_is_open(uuid, timestamptz) from authenticated;

-- ---- part 3 (v571c): six more, found by asserting over the whole set -----
-- Re-running the check across every function matching dialer\_% -- rather
-- than the list I had started from -- turned up six more. That is the whole
-- reason to assert over the set instead of the sample.
--
-- dialer_agent_assigned is load-bearing: SIX RLS policies call it. It keeps
-- its EXPLICIT authenticated grant, which is what those policies evaluate
-- under, so revoking PUBLIC does not touch them. Checked BEFORE revoking,
-- because taking EXECUTE off an RLS helper that only held it through PUBLIC
-- would deny every row to every user.
revoke all on function dialer_recycle_contact(uuid) from public, anon;
grant execute on function dialer_recycle_contact(uuid) to service_role;

revoke all on function dialer_timezone_for_number(text) from public, anon;
grant execute on function dialer_timezone_for_number(text) to authenticated, service_role;

revoke all on function dialer_agent_assigned(uuid) from public, anon;
grant execute on function dialer_agent_assigned(uuid) to authenticated, service_role;

-- The three TRIGGER functions. No explicit grants at all, only the PUBLIC
-- default. PostgREST cannot invoke a function returning `trigger`, so the
-- exposure is theoretical; they are included because "the default was never
-- revoked" is the actual bug, and leaving three examples of it invites the
-- next one.
--
-- EXECUTE on a trigger function is checked when the trigger is CREATED, not
-- each time it fires, so this does not disarm the guards. Asserted, not
-- trusted -- see the verification block below.
revoke all on function dialer_attempt_assignment_guard() from public, anon;
revoke all on function dialer_manual_dial_guard() from public, anon;
revoke all on function dialer_queue_timezone_guard() from public, anon;

comment on function dialer_advance_number(uuid, text, boolean) is
  'Records a call outcome against ONE phone line and opens the next-ranked '
  'number. SECURITY DEFINER and a write, so service_role only: until v571 it '
  'was executable by anon (PostgreSQL grants EXECUTE to PUBLIC by default and '
  'no migration had said otherwise), and a probe with the public anon key '
  'returned 204 -- it ran. Do not grant this to authenticated: the console '
  'reaches it through dialer-call-control, which authorises the dial first.';

comment on function dialer_bump_number_attempt(uuid) is
  'Increments a phone line''s attempt counter. service_role only for the same '
  'reason as dialer_advance_number -- it was anon-executable until v571, and '
  'pushing a line toward max_attempts is how you quietly retire a contact '
  'database.';

comment on function dialer_recycle_contact(uuid) is
  'Puts a retired contact back in the queue (v562). SECURITY DEFINER and a '
  'write, so service_role only. Was anon-executable until v571c: nothing in '
  'the application calls it by name, which is exactly why the first sweep '
  'missed it -- it is reached from SQL, and grep for callers found none.';

-- -------------------------------------------------------------- verified --
-- Re-probed over PostgREST with the anon key, the same twelve calls that had
-- answered 200/204 before: all twelve now 401, "permission denied for
-- function". Both writes included.
--
-- Then the regression check, which is the half that matters. Asserted per
-- function against its intended caller set:
--   anon          false on all 33 dialer functions (was 18)
--   service_role  true  on every one it calls
--   authenticated true  on exactly the five the console calls, false on the
--                 seven it does not
--
-- Then the trigger guards, fired for real against a live agent inside
-- plpgsql subtransactions that raise at the end so every write rolls back
-- while the result variable survives:
--   dialer_attempt_assignment_guard  refused: "agent is not assigned to this queue"
--   dialer_manual_dial_guard         refused: "Your role cannot dial numbers outside a queue."
-- So revoking EXECUTE did not disarm them, and v538/v570 both still work.
--
-- Left behind: nothing. 0 probe rows in dialer_attempts, roles still
-- agent/sales/team leader = can_manual_dial true, 5 campaign assignments
-- intact, 2 active DIDs untouched.
