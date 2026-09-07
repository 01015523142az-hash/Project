-- =========================================================================
-- v565: two dispositions that meant nothing
-- =========================================================================
--
-- APPLIED LIVE 2026-09-07 via apply_migration (v565_dispositions_that_meant_nothing).
--
-- Found by auditing which active dispositions carry no consequence flags at
-- all. Eight did. Six of them SHOULD -- no_answer, busy, voicemail,
-- dead_call, early_hangup and not_available are all category 'no_contact',
-- and v562 defines exactly those as trials: silence, worth another go.
--
-- The other two were category 'contacted', and that is the bug:
--
--   spanish_speaker    somebody answered and we could not proceed
--   transfer_agent     somebody answered and was handed to another agent
--
-- dialer-call-control derives terminal-for-line as
--
--     marks_invalid OR adds_to_dnc OR code = 'wrong_person'
--
-- and neither qualified, and neither retired the contact. So both were
-- counted as SILENCE, indistinguishable from a phone ringing out. A Spanish
-- speaker was re-dialled three times on that number, then three times on
-- every alternate, then recycled thirty days later and worked again -- up to
-- max_attempts. Same for a contact already sitting with another agent, who
-- would be called by the person who transferred them away.
--
-- retires_contact is the right flag rather than adds_to_dnc: this is not a
-- request never to be contacted, it is us having nothing more to do on this
-- pass. dialer-call-control writes retired_reason = the disposition code, so
-- the outcome stays legible and one query reverses it --
--
--     select * from dialer_contacts where retired_reason = 'spanish_speaker'
--
-- which is what a Spanish-speaking campaign would run to claim them.

update dialer_dispositions
   set retires_contact = true
 where code in ('spanish_speaker', 'transfer_agent')
   and is_active;

comment on column dialer_dispositions.retires_contact is
  'Stops this contact being dialled again, recording retired_reason = the '
  'disposition code (dialer-call-control ~line 652). It is legible and '
  'reversible: a later campaign can select on retired_reason and re-queue. '
  'Set on spanish_speaker and transfer_agent in v565 -- both mean CONTACTED, '
  'both previously carried no flags at all, and dialer-call-control derives '
  'terminal-for-line as marks_invalid OR adds_to_dnc OR wrong_person, so '
  'neither qualified. They were therefore counted as SILENCE, exactly like '
  'no_answer: a Spanish speaker, or someone already handed to another agent, '
  'was re-dialled three times on that number, then on every alternate, then '
  'recycled. The other flagless dispositions -- no_answer, busy, voicemail, '
  'dead_call, early_hangup, not_available -- are correctly flagless, because '
  'they really are trials.';

-- -------------------------------------------------------------- verified --
-- Before: eight active dispositions with no flags, two of them 'contacted'.
-- After:  six, ALL of them category 'no_contact'.
--
-- That is the invariant worth keeping and worth re-checking after any change
-- to the catalogue: no disposition meaning CONTACTED may be flagless, because
-- flagless is indistinguishable from a phone ringing out.
--
--   select code, category from dialer_dispositions
--    where is_active and not retires_contact and not schedules_callback
--      and not creates_lead and not adds_to_dnc and not marks_invalid;
--
-- Anything with category <> 'no_contact' in that result is this bug again.
