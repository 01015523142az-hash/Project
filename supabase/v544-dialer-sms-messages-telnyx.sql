-- =========================================================================
-- v544: provider-agnostic SMS store, so Telnyx can run alongside GHL
-- =========================================================================
--
-- ghl_messages stays where it is: it predates the dialer, is written by
-- ghl-webhook, and is shared with client chat. Repointing it at Telnyx would
-- break those. Telnyx traffic lands in dialer_sms_messages instead, and the
-- inbox RPCs UNION the two -- otherwise a contact texted on one provider and
-- replying on the other would appear as two unrelated conversations.
--
-- contact_phone is the OTHER party in BOTH tables, whichever direction a
-- message went. That is the column that makes the union thread correctly.
--
-- Applied live 2026-09-05.
-- =========================================================================

create table if not exists dialer_sms_messages (
  id uuid primary key default gen_random_uuid(),
  provider text not null default 'telnyx',
  -- Telnyx's own message id. UNIQUE so a webhook retry updates rather than
  -- duplicating -- Telnyx retries anything not acked within two seconds.
  provider_message_id text unique,
  direction text not null check (direction in ('inbound', 'outbound')),
  from_number text,
  to_number text,
  -- Inbound: the sender. Outbound: the recipient. Always the other party.
  contact_phone text not null,
  contact_name text,
  body text,
  -- Our agent, for outbound. Null on inbound -- nobody here sent it.
  user_id uuid references profiles(id) on delete set null,
  message_at timestamptz not null default now(),
  -- Carrier verdict from message.sent / message.finalized.
  delivery_status text,
  raw jsonb,
  created_at timestamptz not null default now()
);

create index if not exists dialer_sms_messages_phone_at_idx
  on dialer_sms_messages(contact_phone, message_at desc);
create index if not exists dialer_sms_messages_user_idx
  on dialer_sms_messages(user_id) where user_id is not null;

alter table dialer_sms_messages enable row level security;
-- Reads go through the RPCs below, which carry the visibility rule. Direct
-- select is reviewer-only so nothing can be read around them.
drop policy if exists "dialer_sms_messages: reviewer select" on dialer_sms_messages;
create policy "dialer_sms_messages: reviewer select" on dialer_sms_messages
  for select using (role_can_review_calls());
grant select on dialer_sms_messages to authenticated;
grant select, insert, update, delete on dialer_sms_messages to service_role;


-- ---- inbox RPCs, now unioned across both providers ---------------------
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
  ), all_msgs as (
    select m.contact_phone, m.contact_name, m.body, m.message_at, m.direction, m.user_id
    from ghl_messages m where m.contact_phone is not null
    union all
    select t.contact_phone, t.contact_name, t.body, t.message_at, t.direction, t.user_id
    from dialer_sms_messages t
  ), msgs as (
    select a.* from all_msgs a join engaged e on e.ph = a.contact_phone
  ), scoped as (
    select * from msgs
    where role_can_review_calls()
       or contact_phone in (select contact_phone from msgs where user_id = auth.uid())
  )
  select s.contact_phone, max(s.contact_name),
         (array_agg(s.body order by s.message_at desc))[1],
         max(s.message_at),
         (array_agg(s.direction order by s.message_at desc))[1],
         count(*)::bigint,
         count(*) filter (where s.direction = 'inbound')::bigint,
         bool_or(s.user_id = auth.uid())
  from scoped s group by s.contact_phone order by max(s.message_at) desc;
$$;

-- Dropped and recreated rather than replaced: the return type gained a
-- provider column, and Postgres refuses to change OUT parameters in place.
drop function if exists dialer_sms_thread(text);
create function dialer_sms_thread(p_phone text)
returns table(
  ghl_message_id text, direction text, body text,
  message_at timestamptz, agent_name text, contact_name text, provider text
)
language sql stable security definer set search_path = public
as $$
  with all_msgs as (
    select m.ghl_message_id as mid, m.direction, m.body, m.message_at,
           m.user_id, m.contact_name, m.contact_phone, 'ghl'::text as provider
    from ghl_messages m
    union all
    select t.provider_message_id, t.direction, t.body, t.message_at,
           t.user_id, t.contact_name, t.contact_phone, t.provider
    from dialer_sms_messages t
  )
  select a.mid, a.direction, a.body, a.message_at, p.full_name, a.contact_name, a.provider
  from all_msgs a
  left join profiles p on p.id = a.user_id
  where a.contact_phone = p_phone
    and (
      role_can_review_calls()
      or exists (select 1 from all_msgs x
                 where x.contact_phone = p_phone and x.user_id = auth.uid())
    )
  order by a.message_at;
$$;

revoke all on function dialer_sms_threads() from public;
revoke all on function dialer_sms_thread(text) from public;
grant execute on function dialer_sms_threads() to authenticated, service_role;
grant execute on function dialer_sms_thread(text) to authenticated, service_role;
