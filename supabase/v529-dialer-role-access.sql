-- =========================================================================
-- v529: dialer access by role
-- =========================================================================
--
-- Applied live 2026-09-05. Recorded here so the repo matches the database.
--
-- can_use_dialer alone was too blunt: it is either "can make calls" or
-- nothing, with no place for a team leader who runs the floor but should not
-- be buying phone numbers, or a QA reviewer who must never dial at all.
-- Two further permissions, deliberately kept separate rather than folded
-- into one "dialer manager" flag.
-- =========================================================================

-- Campaigns, lists, validation, DID activate/rest. NOT number ordering --
-- that charges a live carrier account and stays owner/admin only, because a
-- team leader with a "buy 25 numbers" button is a mistake waiting to happen.
alter table roles add column if not exists can_manage_dialer boolean not null default false;

-- Read call records and recordings. Deliberately NOT paired with dialing:
-- collapsing the two would hand QA the ability to place calls, which is a
-- different job and a different risk.
alter table roles add column if not exists can_review_calls boolean not null default false;

create or replace function role_can_manage_dialer()
returns boolean as $$
  select coalesce((
    select is_admin() or r.can_manage_dialer
    from profiles p join roles r on r.name = p.role
    where p.id = auth.uid()
  ), false);
$$ language sql security definer stable set search_path = public;

-- Managing implies reviewing -- someone who can change a campaign can
-- obviously look at its calls -- so this deliberately ORs in
-- can_manage_dialer rather than requiring both flags to be ticked.
create or replace function role_can_review_calls()
returns boolean as $$
  select coalesce((
    select is_admin() or r.can_review_calls or r.can_manage_dialer
    from profiles p join roles r on r.name = p.role
    where p.id = auth.uid()
  ), false);
$$ language sql security definer stable set search_path = public;

-- The agreed matrix. Roles not listed keep every dialer permission off.
update roles set can_use_dialer = true    where name in ('agent', 'team leader', 'sales');
update roles set can_manage_dialer = true where name = 'team leader';
update roles set can_review_calls = true  where name in ('team leader', 'quality');

-- A reviewer needs to see EVERY call, not just their own. Added as separate
-- policies alongside the existing own-or-admin ones rather than widening
-- those, so revoking review access is one flag rather than an edit to the
-- rule that agents depend on.
drop policy if exists "dialer_attempts: reviewer select" on dialer_attempts;
create policy "dialer_attempts: reviewer select" on dialer_attempts
  for select using (role_can_review_calls());

drop policy if exists "dialer_agent_sessions: reviewer select" on dialer_agent_sessions;
create policy "dialer_agent_sessions: reviewer select" on dialer_agent_sessions
  for select using (role_can_review_calls());

-- Recordings live in the private dialer-recordings bucket. Without this a
-- reviewer sees a recording path in the CDR that they cannot play, which is
-- worse than no access at all -- it looks like a broken link rather than a
-- permission boundary.
drop policy if exists "dialer-recordings: reviewer read" on storage.objects;
create policy "dialer-recordings: reviewer read" on storage.objects
  for select using (bucket_id = 'dialer-recordings' and role_can_review_calls());
