-- =========================================================================
-- v559: the agent console's Property line, which never once worked
-- =========================================================================
--
-- APPLIED LIVE 2026-09-07 via apply_migration (v559_dialer_property_for_contact).
--
-- Found during the v557 grant audit. dialer/index.html's loadProperty() had
-- THREE independent faults, and each one on its own was invisible:
--
--   1. it selected a column named `address`. properties has address_line1.
--      That alone makes the query an error, not an empty result.
--   2. properties has RLS enabled with NO policies, so a user JWT could
--      never read it regardless -- and v557 then revoked the direct grant.
--   3. it only ran when contact.property_id was set, and NOTHING populates
--      that column: dialer-list-import never writes it. So in practice the
--      function never ran at all.
--
-- None of that surfaced, because the call destructured only `data` and
-- ignored `error`. All three failures therefore rendered as the same em dash
-- that legitimately means "this contact has no property attached". A silent
-- failure and a correct empty state looked identical, which is why it
-- survived this long.
--
-- WHY A FUNCTION RATHER THAN A POLICY ON properties. The obvious fix is an
-- RLS policy, but properties holds 2,376,449 rows and the predicate would
-- have to be an EXISTS back into dialer_contacts evaluated per row. A
-- SECURITY DEFINER function pinned to ONE contact does the same job with an
-- index lookup, and it also narrows what an agent can ask for: the argument
-- is the CONTACT id, not a property id, so there is no way to spell "show me
-- an arbitrary property". An agent sees the property behind work they are
-- assigned, and nothing else.
--
-- The predicate is copied deliberately, not invented: it is the same one
-- dialer_contacts and dialer_lists already use, so all three answer "which
-- campaigns is this agent on" identically.

create or replace function dialer_property_for_contact(p_contact uuid)
returns table (address_line1 text, city text, state text, zip text)
language sql
stable
security definer
set search_path = public
as $$
  select p.address_line1, p.city, p.state, p.zip
    from dialer_contacts c
    join properties p on p.id = c.property_id
   where c.id = p_contact
     and (
       is_admin()
       or role_can_manage_dialer()
       or role_can_review_calls()
       or (role_can_use_dialer() and dialer_agent_assigned(c.campaign_id))
     );
$$;

comment on function dialer_property_for_contact(uuid) is
  'The property behind ONE contact, for the agent console screen pop. Takes '
  'the CONTACT id, never a property id: an agent may see the property '
  'attached to work they are assigned, not look up arbitrary rows in a '
  '2.4M-row table. The predicate is the same one dialer_contacts and '
  'dialer_lists already use. SECURITY DEFINER because properties has RLS on '
  'with no policies and v557 revoked the direct grants -- this function is '
  'the only route in for a user JWT, which is the point.';

revoke all on function dialer_property_for_contact(uuid) from public;
grant execute on function dialer_property_for_contact(uuid) to authenticated, service_role;

-- -------------------------------------------------------------- verified --
-- In rolled-back transactions, impersonating a real agent (Ola), with a
-- property and a contact staged to point at it:
--
--   own assigned contact              -> '12 Test Street, Batavia IL 60510'
--   unknown contact id                -> nothing
--   contact in an UNASSIGNED campaign -> nothing
--   direct read of properties         -> ERROR 42501 permission denied
--
-- The third case is the one that matters: staging a whole second campaign,
-- list and contact that Ola is not assigned to still yields nothing, so the
-- function is gated on assignment rather than merely on the contact existing.
--
-- STILL BLANK IN PRACTICE, and this migration does not change that. Nothing
-- populates dialer_contacts.property_id, and dialer-list-import does not
-- write dialer_contacts.address either -- it puts the entire CSV row in
-- source_row as jsonb. So for imported contacts the address IS in the
-- database, just not in either column the Property line reads.
--
-- Three ways to actually fill it, none of them this migration's business:
--   * map the file's address column in the admin field defs, which surfaces
--     it in the profile panel today with no code change at all -- probably
--     the right answer for imported lists;
--   * have dialer-list-import copy an address column into
--     dialer_contacts.address, which the console now renders directly;
--   * link contacts to properties on import and populate property_id, which
--     is what v524 meant by "provenance back into existing data, for the
--     screen pop" -- the largest of the three and the only one this function
--     was written for.
