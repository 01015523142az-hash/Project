-- =========================================================================
-- v548: more than one dialable number per contact
-- =========================================================================
--
-- APPLIED LIVE 2026-09-06 via apply_migration (v548_dialer_multi_number_per_contact).
--
-- v536 already imports up to ten numbers per seller into contact_fields as
-- phone_2..phone_10 -- and then the dialer only ever rang phone_e164. We were
-- paying to skip-trace ten numbers and calling one.
--
-- This is exactly ReadyMode's split, and the vocabulary is deliberately theirs
-- so the two systems can be talked about in one sentence while both are
-- running:
--   * their "Phone Number" field is the only one their dialer rings
--   * their "Alt. Phone" is manual-dial only
--   * their "Any Phone" spreads a lead's numbers into Phone Number + Ph#2,
--     Ph#3 ... which is where our phone_2..phone_10 keys and labels came from
--   * and dialling past the first number is their Skip Tracer add-on
-- What follows is that add-on's behaviour, without the add-on.
--
-- WHY A TABLE RATHER THAN MORE JSON:
-- validity, line type, time zone, DNC status and attempt count are properties
-- of a NUMBER, not of a person. They sit on dialer_contacts today only because
-- a contact used to have exactly one number. Ten numbers means ten different
-- time zones and ten different DNC answers, and the calling-hours gate has to
-- read the one being dialled -- a jsonb blob cannot carry that or be indexed
-- for the queue query.
--
-- dialer_contacts.phone_e164 STAYS as the primary and display number. The call
-- log, research screen and every existing query keep working unchanged.

create table if not exists dialer_contact_phones (
  id           uuid primary key default gen_random_uuid(),
  contact_id   uuid not null references dialer_contacts(id) on delete cascade,
  -- 1 is the primary, mirroring dialer_contacts.phone_e164. 2..10 are the
  -- Ph#2..Ph#10 columns from the import mapping.
  rank         smallint not null check (rank between 1 and 10),
  label        text not null default 'Phone number',
  phone_e164   text not null,

  -- Per-number state. 'exhausted' is this number specifically being done with,
  -- which is not the same as the contact being done with.
  status       text not null default 'new'
               check (status in ('new','queued','exhausted','invalid','dnc','wrong_person')),
  attempt_count integer not null default 0,
  last_attempt_at timestamptz,
  last_outcome text,
  next_attempt_at timestamptz,

  -- Written by pre-dial validation, per number. The calling-hours gate reads
  -- the timezone of the number being dialled, never the contact's.
  phone_valid     boolean,
  phone_line_type text,
  timezone        text,
  state           text,

  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  -- The same number twice on one contact is a skip-trace artefact, not two
  -- ways to reach them.
  unique (contact_id, phone_e164)
);

create index if not exists dialer_contact_phones_contact_rank_idx
  on dialer_contact_phones (contact_id, rank);
-- The queue query: the next dialable number, cheapest first.
create index if not exists dialer_contact_phones_due_idx
  on dialer_contact_phones (contact_id, status, next_attempt_at, rank)
  where status in ('new','queued');

comment on table dialer_contact_phones is
  'One row per dialable number for a contact. rank 1 mirrors '
  'dialer_contacts.phone_e164; 2..10 are the Ph#2..Ph#10 import columns. '
  'Validity, line type, time zone and DNC are per NUMBER, not per person.';

alter table dialer_contact_phones enable row level security;

-- Same visibility rule as the contact it belongs to (v537): an agent who is
-- not assigned to the queue cannot see its numbers either.
drop policy if exists "dialer_contact_phones: dialer staff select" on dialer_contact_phones;
create policy "dialer_contact_phones: dialer staff select" on dialer_contact_phones
  for select using (
    is_admin() or role_can_manage_dialer() or role_can_review_calls()
    or (role_can_use_dialer() and exists (
          select 1 from dialer_contacts c
           where c.id = contact_id and dialer_agent_assigned(c.campaign_id)))
  );

drop policy if exists "dialer_contact_phones: dialer staff update" on dialer_contact_phones;
create policy "dialer_contact_phones: dialer staff update" on dialer_contact_phones
  for update using (
    is_admin() or role_can_manage_dialer()
    or (role_can_use_dialer() and exists (
          select 1 from dialer_contacts c
           where c.id = contact_id and dialer_agent_assigned(c.campaign_id)))
  ) with check (
    is_admin() or role_can_manage_dialer()
    or (role_can_use_dialer() and exists (
          select 1 from dialer_contacts c
           where c.id = contact_id and dialer_agent_assigned(c.campaign_id)))
  );

drop policy if exists "dialer_contact_phones: admin manage" on dialer_contact_phones;
create policy "dialer_contact_phones: admin manage" on dialer_contact_phones
  for all using (is_admin() or role_can_manage_dialer())
  with check (is_admin() or role_can_manage_dialer());

grant select, insert, update, delete on dialer_contact_phones to authenticated;
grant all on dialer_contact_phones to service_role;

-- -------------------------------------------------------------------------
-- How soon the NEXT number becomes dialable after a no-contact outcome
--
-- Not the same lever as min_hours_between_attempts, which is about calling one
-- person back. This is about trying a different line for someone you have not
-- reached at all, so it wants a much shorter gap -- but not zero by default.
-- Ringing ten numbers for the same household inside ten minutes is how a
-- complaint gets filed, so the default is an hour and going to 0 is a
-- deliberate act by whoever runs the floor.
-- -------------------------------------------------------------------------
alter table dialer_campaigns
  add column if not exists alt_phone_delay_minutes smallint not null default 60
    check (alt_phone_delay_minutes between 0 and 1440);

comment on column dialer_campaigns.alt_phone_delay_minutes is
  'Minutes before the next-ranked number for the same contact becomes dialable '
  'after a no-contact outcome. 0 dials the next number straight away.';

-- -------------------------------------------------------------------------
-- Backfill: every existing contact gets its primary as rank 1, plus whatever
-- phone_2..phone_10 the import mapped.
-- -------------------------------------------------------------------------
insert into dialer_contact_phones
  (contact_id, rank, label, phone_e164, status, attempt_count, last_attempt_at,
   last_outcome, next_attempt_at, phone_valid, phone_line_type, timezone, state)
select c.id, 1, 'Phone number', c.phone_e164,
       case when c.status in ('retired','suppressed','invalid') then 'exhausted' else 'new' end,
       coalesce(c.attempt_count, 0), c.last_attempt_at, c.last_outcome,
       c.next_attempt_at, c.phone_valid, c.phone_line_type, c.timezone, c.state
  from dialer_contacts c
 where c.phone_e164 is not null
on conflict (contact_id, phone_e164) do nothing;

-- Ranks 2..10 from the mapped fields. Only NANP digits are taken; anything the
-- importer could not normalise is left out rather than guessed at, and stays
-- visible in contact_fields either way.
insert into dialer_contact_phones (contact_id, rank, label, phone_e164)
select c.id,
       (regexp_replace(k, '\D', '', 'g'))::smallint as rank,
       'Ph#' || regexp_replace(k, '\D', '', 'g') as label,
       case when length(regexp_replace(c.contact_fields ->> k, '\D', '', 'g')) = 10
              then '+1' || regexp_replace(c.contact_fields ->> k, '\D', '', 'g')
            when length(regexp_replace(c.contact_fields ->> k, '\D', '', 'g')) = 11
             and left(regexp_replace(c.contact_fields ->> k, '\D', '', 'g'), 1) = '1'
              then '+' || regexp_replace(c.contact_fields ->> k, '\D', '', 'g')
       end as phone_e164
  from dialer_contacts c
  cross join lateral jsonb_object_keys(c.contact_fields) k
 where k ~ '^phone_([2-9]|10)$'
   and coalesce(c.contact_fields ->> k, '') <> ''
   and length(regexp_replace(c.contact_fields ->> k, '\D', '', 'g')) in (10, 11)
on conflict (contact_id, phone_e164) do nothing;

-- -------------------------------------------------------------------------
-- The queue's unit of work is now a NUMBER, not a contact.
--
-- SECURITY DEFINER so the calling-hours and DNC facts it reads cannot be
-- narrowed by the agent's own row visibility; the campaign assignment is still
-- checked explicitly, so this cannot be used to reach an unassigned queue.
-- -------------------------------------------------------------------------
create or replace function dialer_next_number(p_contact uuid)
returns table (phone_id uuid, rank smallint, label text, phone_e164 text,
               phone_line_type text, timezone text, attempt_count integer)
language sql
stable
security definer
set search_path = public
as $$
  select p.id, p.rank, p.label, p.phone_e164, p.phone_line_type,
         p.timezone, p.attempt_count
    from dialer_contact_phones p
    join dialer_contacts c on c.id = p.contact_id
   where p.contact_id = p_contact
     and p.status in ('new', 'queued')
     and coalesce(p.phone_valid, true)                    -- unvalidated is dialable
     and (p.next_attempt_at is null or p.next_attempt_at <= now())
     -- A number on the internal DNC is never dialable, whatever its row says.
     and not exists (select 1 from dialer_dnc d where d.phone_e164 = p.phone_e164)
     -- service_role is dialer-call-control, where auth.uid() is null and every
     -- role_can_* helper is false. Without this clause the function returned
     -- nothing for the one caller that most needs it (v548b).
     and (auth.role() = 'service_role'
          or is_admin() or role_can_manage_dialer()
          or dialer_agent_assigned(c.campaign_id))
   order by p.rank
   limit 1;
$$;

grant execute on function dialer_next_number(uuid) to authenticated, service_role;

-- Marks the number just worked, then decides when the NEXT one opens up.
-- Called by dialer-call-control after a disposition, so the rule lives in one
-- place rather than in the console and the function separately.
create or replace function dialer_advance_number(
  p_phone uuid, p_outcome text, p_terminal boolean default false)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_contact  uuid;
  v_campaign uuid;
  v_delay    smallint;
  v_gap      smallint;
begin
  select contact_id into v_contact from dialer_contact_phones where id = p_phone;
  if v_contact is null then return; end if;

  select c.campaign_id into v_campaign from dialer_contacts c where c.id = v_contact;
  select coalesce(alt_phone_delay_minutes, 60), coalesce(min_hours_between_attempts, 24)
    into v_delay, v_gap
    from dialer_campaigns where id = v_campaign;

  -- v548c: the worked number MUST be given a rest. The first cut cleared
  -- next_attempt_at here, and dialer_next_number reads null as "due now", so
  -- the number just dialled came straight back to the top of the queue and the
  -- alternates were never reached -- the exact failure this file exists to fix.
  -- It rests for min_hours_between_attempts (how soon may I call this line
  -- again); the NEXT-ranked number opens after alt_phone_delay_minutes (how
  -- soon may I try a different line for someone I have not reached at all).
  update dialer_contact_phones
     set attempt_count   = attempt_count + 1,
         last_attempt_at = now(),
         last_outcome    = p_outcome,
         -- A terminal outcome retires THIS number only. Reaching the person on
         -- their brother's phone says nothing about their own.
         status          = case when p_terminal then 'exhausted' else 'queued' end,
         next_attempt_at = case when p_terminal then null
                                else now() + make_interval(hours => v_gap) end,
         updated_at      = now()
   where id = p_phone;

  -- Open the next-ranked number, subject to the campaign's own delay.
  update dialer_contact_phones
     set next_attempt_at = now() + make_interval(mins => v_delay),
         updated_at = now()
   where contact_id = v_contact
     and status in ('new', 'queued')
     and id <> p_phone
     and next_attempt_at is null;
end;
$$;

grant execute on function dialer_advance_number(uuid, text, boolean) to authenticated, service_role;
