-- v564: a campaign-level fallback zone for numbers the area code cannot place
--
-- THE GAP THIS CLOSES
--   v560 resolves the calling-hours zone from the area code, free, for every
--   NANP number in the table. What it cannot place -- a new area code, a
--   Canadian number, anything malformed enough to survive import -- keeps a
--   null timezone, and dialer-call-control refuses those with 'no_timezone'.
--   That is the correct conservative default and it is also a dead end: the
--   only way out was to pay for a lookup on each one.
--
--   This gives the campaign a zone to fall back on. Null stays the default,
--   so nothing changes for an existing campaign until somebody chooses one.
--
-- WHY IT IS ONLY EVER READ AT DIAL TIME, never written onto the contact:
--   the contact's timezone column means "this number's real zone, as
--   resolved". Writing a guess into it would make an unknown look resolved,
--   would survive a later real resolution, and would quietly corrupt the
--   'No time zone' count the Lists tab reports. The fallback is a campaign
--   policy, not a fact about the number, so it lives on the campaign and is
--   applied as the last link of the chain:
--       phone row's zone -> contact's zone -> campaign's fallback -> refuse
--
-- CHOOSE THE WESTERNMOST ZONE YOU CALL, and the reason is the same one the
-- split-area-code rule turns on. Gating an unknown number on a zone WEST of
-- its real one opens the window late -- Pacific 9am is Eastern noon, which
-- is harmless. Gating it on a zone EAST of its real one opens the window
-- early: Eastern 9am is Pacific 6am, which is a complaint and worse. For a
-- continental US list America/Los_Angeles is therefore the safe answer, and
-- the admin screen says so rather than leaving it to be worked out.

alter table dialer_campaigns
  add column if not exists fallback_timezone text
    check (fallback_timezone is null or fallback_timezone ~ '^[A-Za-z]+/[A-Za-z_+-]+$');

comment on column dialer_campaigns.fallback_timezone is
  'IANA zone used for the calling-hours gate when neither the phone row nor the contact has one -- an area code v560 could not place. Null refuses the dial instead, which is the default. Read at dial time only and never written onto the contact: it is a campaign policy, not a fact about the number. Pick the westernmost zone you call, so the error opens the window late rather than early.';
