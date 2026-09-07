-- =========================================================================
-- v556: dialer_fs_credentials had its grants backwards
-- =========================================================================
--
-- APPLIED LIVE 2026-09-07 via apply_migration (v556_fs_credentials_grants).
--
-- Found by the first end-to-end probe of dialer-fs-directory with a correct
-- FS_XML_SECRET. It returned 500, and the log said:
--
--     dialer-fs-directory: lookup failed permission denied for table
--     dialer_fs_credentials
--
-- v554 created the table, enabled RLS, wrote no policies, and left the
-- privileges to whatever the schema defaults produced. What they produced
-- was the exact opposite of the intent:
--
--     service_role    REFERENCES, TRIGGER, TRUNCATE          -- no SELECT
--     authenticated   SELECT, INSERT, UPDATE, DELETE, ...    -- everything
--
-- So two things were wrong at once, and only the first was visible.
--
-- 1. The one legitimate reader could not read. dialer-fs-directory is the
--    only thing that ever touches this table and it was locked out, which
--    would have looked like a FreeSWITCH problem at bring-up rather than a
--    grant problem here.
--
-- 2. Anything holding a user JWT had SELECT, INSERT, UPDATE and DELETE on
--    the table that stores SIP password hashes. RLS-with-no-policies was
--    blocking it in practice, so the v554 verification -- "the a1-hash is
--    invisible even to the agent who owns it" -- passed. But it passed on
--    ONE layer, while v554's own comment claimed "only the service role
--    reaches it". That was not true, and a single permissive policy added
--    later by somebody who assumed the grants were sane would have made an
--    agent able to read, and REWRITE, every agent's registration hash.
--
-- Never leave privileges on a table like this to defaults. State them.
--
-- Verified after applying, impersonating the agent who owns the row:
--
--   select from dialer_fs_credentials -> ERROR 42501 permission denied
--   update dialer_fs_credentials      -> ERROR 42501 permission denied
--
-- Note that is a hard permission error now, not "0 rows" -- the difference
-- between two layers of defence and one. And the function itself:
--
--   correct secret, unknown user -> 200 + <result status="not found"/>
--   wrong secret                 -> 401
--
-- Grants afterwards are postgres and service_role only.

revoke all on table dialer_fs_credentials from anon;
revoke all on table dialer_fs_credentials from authenticated;
revoke all on table dialer_fs_credentials from public;

grant select, insert, update, delete on table dialer_fs_credentials to service_role;

comment on table dialer_fs_credentials is
  'FreeSWITCH SIP auth, served to the switch by dialer-fs-directory over '
  'mod_xml_curl. Locked down at BOTH layers, because v554 only did one: RLS '
  'is on with deliberately no policies, AND the table privileges are revoked '
  'from anon, authenticated and public so nothing holding a user JWT can '
  'reach it even if a policy is ever added by mistake. Only service_role is '
  'granted. a1_hash is password material.';
