-- =========================================================================
-- v567: dialer_timezone_for_number() has no callers, and should not
-- =========================================================================
--
-- APPLIED LIVE 2026-09-07 via apply_migration (v567_document_timezone_for_number).
--
-- The 2026-09-07 audit flagged three functions with no callers. Two were
-- bugs: dialer_agent_sip_uri() was a latent break in the FreeSWITCH work, and
-- dialer_live_floor() had been left behind by a schema change (v566).
--
-- This one is neither, and the fix is to say so in the database rather than
-- leave the next audit to rediscover it and "fix" it by inventing a caller.
--
-- Wiring it into the dial path would be a NO-OP: dialer-list-import already
-- resolves the zone from the area code at insert, so a phone row with a null
-- timezone is one this table could not place -- and this function reads the
-- same table. The campaign fallback (v564) is the deliberate answer for those,
-- because it is a policy rather than a fact about the number.
--
-- Comment only. No behaviour change.

comment on function dialer_timezone_for_number(text) is
  'NPA -> IANA zone, reading dialer_npa_timezones. THIS HAS NO CALLERS AND '
  'THAT IS CORRECT -- it is not dead code, and a caller should not be '
  'invented for it.

  It exists because v560 inlined the area-code table into a migration and '
  'v563 needed it again; a third hand-placed copy is how a table like that '
  'drifts. So SQL has one authoritative copy here, and the two import paths '
  'keep their own inline copy on purpose, so making a list dialable never '
  'depends on a round trip.

  Wiring it into the dial path would be a NO-OP today. dialer-list-import '
  'already resolves the zone from the area code at insert, so a phone row '
  'with a null timezone is one this table could not place -- and this '
  'function reads the same table, so it would return null too. The campaign '
  'fallback (v564) is the answer for those, deliberately, because it is a '
  'policy rather than a fact about the number.

  Where it IS the right tool: a repair or verification query over rows loaded '
  'before v560, and any future third import path -- including the trigger '
  'that still does not exist for dialer_contact_phones. Use it there rather '
  'than pasting the table a fourth time.';
