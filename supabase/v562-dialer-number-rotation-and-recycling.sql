-- v562: work a number three times, then the next one, then recycle
--
-- WHAT WAS WRONG
--   dialer_advance_number opened the NEXT-ranked number after a single
--   no-contact outcome. One unanswered ring and the engine moved on, so a
--   seller who simply did not pick up got one attempt on their best number
--   and then a march through their worst ones. Nobody works a list that way.
--
-- WHAT IT DOES NOW
--   A line is tried attempts_per_number times (default 3) before it is
--   spent. Only then does the next-ranked line open. When every line is
--   spent the contact is recycled -- it goes quiet for recycle_after_days,
--   then reopens at Ph#1 with the counters cleared -- up to max_recycles
--   times, and is retired for good after that.
--
--   A "trial" is a no-contact outcome: no answer, busy, voicemail, a dead
--   call. Outcomes that are FACTS ABOUT THE LINE are still terminal on the
--   first occurrence and are never recycled: a number on the DNC, a wrong
--   number, a disconnected line, or reaching someone else entirely. Three
--   tries is a rule about silence, not about being told no.
--
-- THE ORDERING FIX THAT MAKES IT WORK
--   dialer_next_number used to take the lowest-ranked line that was DUE.
--   That silently defeats a per-line trial count: Ph#1 resting for four
--   hours is not due, Ph#2 has a null next_attempt_at which reads as "due
--   now", so the engine would jump to Ph#2 the moment Ph#1 was resting --
--   exactly the behaviour this migration exists to stop. It now takes the
--   lowest-ranked OPEN line and dials it only if that line is due. While
--   Ph#1 has trials left, Ph#2 is unreachable rather than merely later.
--
-- Depends on: v548 (dialer_contact_phones), v524 (dialer_campaigns).

-- -------------------------------------------------------------------------
-- 1. The settings, all campaign-level and all editable in the dialer admin.
-- -------------------------------------------------------------------------
alter table dialer_campaigns
  add column if not exists attempts_per_number smallint not null default 3
    check (attempts_per_number between 1 and 10),
  add column if not exists recycle_enabled boolean not null default true,
  add column if not exists recycle_after_days smallint not null default 30
    check (recycle_after_days between 1 and 365),
  add column if not exists max_recycles smallint not null default 2
    check (max_recycles between 0 and 10);

comment on column dialer_campaigns.attempts_per_number is
  'No-contact trials on ONE line before the next-ranked line opens. Terminal outcomes (DNC, wrong number, disconnected, wrong person) retire the line on the first occurrence regardless of this.';
comment on column dialer_campaigns.recycle_after_days is
  'Days a contact rests after every one of its numbers is spent, before it reopens at Ph#1. The callback interval for a contact nobody could reach.';
comment on column dialer_campaigns.max_recycles is
  'How many times a contact may be recycled before it is retired for good. 0 disables recycling as surely as recycle_enabled=false.';

-- How many times this contact has been round the loop. It is never reset:
-- it is the record of how hard this contact has already been worked.
alter table dialer_contacts
  add column if not exists recycle_count smallint not null default 0;

-- -------------------------------------------------------------------------
-- 2. Lowest-ranked OPEN line, dialled only when that line is due.
--    See the header: taking the lowest-ranked DUE line is what let the
--    engine skip ahead to Ph#2 while Ph#1 was merely resting.
-- -------------------------------------------------------------------------
create or replace function dialer_next_number(p_contact uuid)
returns table (phone_id uuid, rank smallint, label text, phone_e164 text,
               phone_line_type text, timezone text, attempt_count integer)
language sql
stable
security definer
set search_path = public
as $fn$
  with candidate as (
    select p.id, p.rank, p.label, p.phone_e164, p.phone_line_type,
           p.timezone, p.attempt_count, p.next_attempt_at
      from dialer_contact_phones p
      join dialer_contacts c on c.id = p.contact_id
     where p.contact_id = p_contact
       and p.status in ('new', 'queued')
       and coalesce(p.phone_valid, true)                  -- unvalidated is dialable
       -- A number on the internal DNC is never dialable, whatever its row says.
       and not exists (select 1 from dialer_dnc d where d.phone_e164 = p.phone_e164)
       -- service_role is dialer-call-control, where auth.uid() is null and every
       -- role_can_* helper is false. Without this clause the function returned
       -- nothing for the one caller that most needs it (v548b).
       and (auth.role() = 'service_role'
            or is_admin() or role_can_manage_dialer()
            or dialer_agent_assigned(c.campaign_id))
     order by p.rank
     limit 1
  )
  select id, rank, label, phone_e164, phone_line_type, timezone, attempt_count
    from candidate
   where next_attempt_at is null or next_attempt_at <= now();
$fn$;

grant execute on function dialer_next_number(uuid) to authenticated, service_role;

-- -------------------------------------------------------------------------
-- 3. Recycle, or retire for good.
--    Called by dialer_advance_number once nothing dialable is left, so the
--    decision lives beside the rule that creates it rather than in the
--    console and the edge function separately.
-- -------------------------------------------------------------------------
create or replace function dialer_recycle_contact(p_contact uuid)
returns text
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_campaign  uuid;
  v_enabled   boolean;
  v_days      smallint;
  v_max       smallint;
  v_count     smallint;
  v_open      integer;
begin
  -- Anything still workable means this is not the end of the road.
  select count(*) into v_open
    from dialer_contact_phones
   where contact_id = p_contact and status in ('new', 'queued');
  if v_open > 0 then return 'still_open'; end if;

  select c.campaign_id, coalesce(c.recycle_count, 0)
    into v_campaign, v_count
    from dialer_contacts c where c.id = p_contact;
  if v_campaign is null then return 'no_contact'; end if;

  select coalesce(recycle_enabled, true), coalesce(recycle_after_days, 30),
         coalesce(max_recycles, 2)
    into v_enabled, v_days, v_max
    from dialer_campaigns where id = v_campaign;

  if not v_enabled or v_count >= v_max then
    update dialer_contacts
       set status = 'retired',
           retired_reason = 'all_numbers_exhausted',
           next_attempt_at = null,
           updated_at = now()
     where id = p_contact;
    return 'retired';
  end if;

  -- Only lines spent by SILENCE come back. 'dnc', 'invalid' and
  -- 'wrong_person' are findings about the line itself and survive a recycle
  -- -- a number on the do-not-call list must never be reopened by a cadence
  -- rule, which is the whole reason those statuses are distinct.
  update dialer_contact_phones
     set status = 'new',
         attempt_count = 0,
         next_attempt_at = now() + make_interval(days => v_days),
         updated_at = now()
   where contact_id = p_contact
     and status = 'exhausted';

  update dialer_contacts
     set status = 'queued',
         attempt_count = 0,
         recycle_count = v_count + 1,
         retired_reason = null,
         next_attempt_at = now() + make_interval(days => v_days),
         updated_at = now()
   where id = p_contact;

  return 'recycled';
end;
$fn$;

grant execute on function dialer_recycle_contact(uuid) to authenticated, service_role;

-- -------------------------------------------------------------------------
-- 4. Advance: count the trial, spend the line only when the count is met,
--    and recycle when nothing is left.
-- -------------------------------------------------------------------------
create or replace function dialer_advance_number(
  p_phone uuid, p_outcome text, p_terminal boolean default false)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_contact   uuid;
  v_campaign  uuid;
  v_delay     smallint;
  v_gap       smallint;
  v_per       smallint;
  v_attempts  integer;
  v_status    text;
  v_open      integer;
begin
  select contact_id into v_contact from dialer_contact_phones where id = p_phone;
  if v_contact is null then return; end if;

  select c.campaign_id into v_campaign from dialer_contacts c where c.id = v_contact;
  select coalesce(alt_phone_delay_minutes, 60), coalesce(min_hours_between_attempts, 24),
         coalesce(attempts_per_number, 3)
    into v_delay, v_gap, v_per
    from dialer_campaigns where id = v_campaign;

  -- The trial that just happened.
  update dialer_contact_phones
     set attempt_count   = attempt_count + 1,
         last_attempt_at = now(),
         last_outcome    = p_outcome,
         updated_at      = now()
   where id = p_phone
  returning attempt_count into v_attempts;

  if p_terminal then
    -- Record WHICH terminal finding it was, not merely that there was one.
    -- dialer_recycle_contact reopens 'exhausted' lines and must never reopen
    -- these, so collapsing them all to 'exhausted' would quietly put a
    -- do-not-call number back in the queue a month later.
    select case
             when d.adds_to_dnc then 'dnc'
             when d.marks_invalid then 'invalid'
             when p_outcome = 'wrong_person' then 'wrong_person'
             else 'exhausted'
           end
      into v_status
      from dialer_dispositions d where d.code = p_outcome;
    v_status := coalesce(v_status, 'exhausted');

    update dialer_contact_phones
       set status = v_status, next_attempt_at = null, updated_at = now()
     where id = p_phone;

  elsif v_attempts >= v_per then
    -- The line is spent. Retire it and open the next one, subject to the
    -- campaign's own delay -- how soon may I try a different line for
    -- somebody I have not reached at all.
    update dialer_contact_phones
       set status = 'exhausted', next_attempt_at = null, updated_at = now()
     where id = p_phone;

    update dialer_contact_phones
       set next_attempt_at = now() + make_interval(mins => v_delay),
           updated_at = now()
     where contact_id = v_contact
       and status in ('new', 'queued')
       and id <> p_phone
       and next_attempt_at is null;

  else
    -- Trials left on this line. It rests for min_hours_between_attempts --
    -- how soon may I call THIS line again -- and stays the lowest-ranked
    -- open line, so dialer_next_number will come back to it and to nothing
    -- else in the meantime.
    update dialer_contact_phones
       set status = 'queued',
           next_attempt_at = now() + make_interval(hours => v_gap),
           updated_at = now()
     where id = p_phone;
  end if;

  -- Nothing workable left? Recycle the contact, or retire it for good.
  select count(*) into v_open
    from dialer_contact_phones
   where contact_id = v_contact and status in ('new', 'queued');
  if v_open = 0 then
    perform dialer_recycle_contact(v_contact);
  end if;
end;
$fn$;

grant execute on function dialer_advance_number(uuid, text, boolean) to authenticated, service_role;
