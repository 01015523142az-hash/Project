-- =========================================================================
-- v542: two-way SMS inbox over ghl_messages
-- =========================================================================
--
-- NO NEW MESSAGE STORE. ghl-webhook already writes every SMS to ghl_messages
-- with contact_phone, direction, body, message_at, and a user_id resolved to
-- one of our agents (matched on GHL login email -- GHL exposes no {{user.id}}
-- merge field for message context). A parallel dialer_sms table would drift
-- from it within a week.
--
-- SCOPE. Threads are limited to numbers the DIALER has engaged: a
-- dialer_contacts row, or a dialer_attempts.to_number. ghl_messages also
-- carries client-notification traffic sent from the OTHER number
-- (+13072246526, CLIENT_SMS_FROM_NUMBER.notifications), which has no business
-- in a dialer inbox. The from-number is not stored on the row, so prior
-- dialer engagement is the only honest way to tell the two apart.
--
-- VISIBILITY, as agreed:
--   agent     -- threads they have personally sent into (user_id = them)
--   reviewer  -- every thread (role_can_review_calls: team leader, quality,
--                owner/admin)
-- security definer so the rule lives in one place rather than in three RLS
-- policies that would each have to agree with the others.
--
-- Applied live 2026-09-05.
-- =========================================================================

create or replace function dialer_sms_threads()
returns table(
  contact_phone text, contact_name text,
  last_body text, last_at timestamptz, last_direction text,
  messages bigint, inbound bigint, mine boolean
)
language sql stable security definer set search_path = public
as $$
  with engaged as (
    select distinct phone_e164 as ph from dialer_contacts
    union
    select distinct to_number from dialer_attempts where to_number is not null
  ), msgs as (
    select m.* from ghl_messages m
    join engaged e on e.ph = m.contact_phone
    where m.contact_phone is not null
  ), scoped as (
    select * from msgs
    where role_can_review_calls()
       or contact_phone in (select contact_phone from msgs where user_id = auth.uid())
  )
  select s.contact_phone,
         max(s.contact_name),
         (array_agg(s.body order by s.message_at desc))[1],
         max(s.message_at),
         (array_agg(s.direction order by s.message_at desc))[1],
         count(*)::bigint,
         count(*) filter (where s.direction = 'inbound')::bigint,
         bool_or(s.user_id = auth.uid())
  from scoped s
  group by s.contact_phone
  order by max(s.message_at) desc;
$$;

create or replace function dialer_sms_thread(p_phone text)
returns table(
  ghl_message_id text, direction text, body text,
  message_at timestamptz, agent_name text, contact_name text
)
language sql stable security definer set search_path = public
as $$
  select m.ghl_message_id, m.direction, m.body, m.message_at,
         p.full_name, m.contact_name
  from ghl_messages m
  left join profiles p on p.id = m.user_id
  where m.contact_phone = p_phone
    and (
      role_can_review_calls()
      or exists (
        select 1 from ghl_messages x
        where x.contact_phone = p_phone and x.user_id = auth.uid()
      )
    )
  order by m.message_at;
$$;

revoke all on function dialer_sms_threads() from public;
revoke all on function dialer_sms_thread(text) from public;
grant execute on function dialer_sms_threads() to authenticated, service_role;
grant execute on function dialer_sms_thread(text) to authenticated, service_role;

create index if not exists ghl_messages_phone_at_idx
  on ghl_messages(contact_phone, message_at desc);
create index if not exists ghl_messages_user_idx
  on ghl_messages(user_id) where user_id is not null;
