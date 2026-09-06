-- =========================================================================
-- v545: thread SMS on a normalised phone key
-- =========================================================================
--
-- ghl_messages stores whatever the GHL workflow sends, which is the contact's
-- DISPLAY format -- live rows contain '(518) 722-9911'. The dialer stores
-- E.164, '+15187229911'. Same person, two strings, so plain equality matched
-- neither the thread grouping nor the dialer-engagement scoping: an inbound
-- reply could arrive and simply never appear in the inbox.
--
-- Confirmed on live data: after this change one contact's thread went from
-- 1 message to 5, because four older display-format rows finally joined the
-- E.164 one.
--
-- Normalised in the RPCs rather than by rewriting stored values, because
-- ghl_messages predates the dialer and is shared with client chat, whose code
-- reads those columns as they are. Doing it here also repairs history rather
-- than only new rows.
--
-- Also widens "engaged": a number an agent has TEXTED from the dialer now
-- counts, not only one that was dialled. Without that the compose box could
-- open a conversation the inbox then refused to list.
--
-- Applied live 2026-09-05.
-- =========================================================================

create or replace function dialer_phone_key(p text)
returns text language sql immutable set search_path = public as $$
  select nullif(right(regexp_replace(coalesce(p, ''), '\D', '', 'g'), 10), '');
$$;

revoke all on function dialer_phone_key(text) from public;
grant execute on function dialer_phone_key(text) to authenticated, service_role;

-- dialer_sms_threads() and dialer_sms_thread(text) are recreated to group and
-- match on dialer_phone_key(). See the applied migration for the full bodies;
-- the only change from v544 is the key and the widened engaged set, plus
-- preferring an E.164 spelling for display when any row in a thread has one.
