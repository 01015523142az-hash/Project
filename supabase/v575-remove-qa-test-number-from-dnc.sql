-- =========================================================================
-- v575: remove one QA test number from the internal DNC list
-- =========================================================================
--
-- APPLIED LIVE 2026-09-08 as v575_remove_qa_test_number_from_dnc.
--
-- dialer_dnc is append-only evidence. Deleting from it is not a normal
-- operation and should not become one, so this migration exists to keep the
-- record of BOTH the opt-out and its removal even though the live row is
-- gone. If you are reading this because you are about to delete another row:
-- do it this way, or do not do it.
--
-- THE ROW BEING REMOVED, in full, so nothing is lost by the delete:
--
--   id           e1d844de-819e-4bee-8c07-b38f082ed31e
--   phone_e164   +15187229911
--   source       client_request
--   reason       Self-service opt-out via primehomebuyers.casa
--   created_at   2026-09-06 20:52
--   suppressed_by  (null -- came from the public opt-out form, not an agent)
--   attempt_id     (null)
--
-- WHY IT IS BEING REMOVED. It is a QA test number belonging to the team, not
-- a member of the public. Removal was requested by the owner, and the claim
-- was checked against the data before acting rather than taken on trust:
--
--   dialer_contacts.contact_name  "QA test contact (agent's own number)"
--   dialer_lists.name             "Test List -- Manual QA"
--   state                         NY, matching the 518 area code
--   18 attempts against it, and the only contact in the database
--
-- So the sequence was: the team used their own number to test the dialer,
-- then used it again to test the public opt-out form on primehomebuyers.casa,
-- which worked correctly and suppressed them -- and that suppression then
-- blocked further dialer testing. The opt-out flow is not at fault and is not
-- being changed; it did exactly what it should.
--
-- WHAT IS NOT BEING TOUCHED: nothing else. This is the only row on the list,
-- and the delete is pinned to the id, not the phone number, so a re-run
-- cannot widen. A genuine opt-out that later reused this number would have a
-- different id and survive.

delete from dialer_dnc
 where id = 'e1d844de-819e-4bee-8c07-b38f082ed31e'
   and phone_e164 = '+15187229911'
   and source = 'client_request';

-- -------------------------------------------------------------- verified --
-- dialer_dnc is now empty (0 rows); the number is no longer suppressed.
--
-- Manual dial to it will now pass the DNC gate. The QUEUE path will still
-- refuse it, and deliberately so -- that is separate state this migration
-- does not touch:
--   dialer_contacts.status        retired / interested   -> gate 4 refuses
--   dialer_contact_phones.status  exhausted              -> dialer_next_number
--                                                          will not offer it
-- Resetting those is a testing decision, not a compliance one, so it is left
-- to whoever is running the test.
