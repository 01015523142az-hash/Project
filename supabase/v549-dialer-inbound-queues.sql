-- =========================================================================
-- v549: inbound queues
-- =========================================================================
--
-- The dialer has been outbound-only. The `Inbound only` agent status shipped
-- in v537 has been a label with nothing behind it since the day it was added.
--
-- WHY THIS DOES NOT TOUCH THE OUTBOUND PATH AT ALL:
-- our outbound calls are originated by the agent's browser over a Telnyx
-- Credential Connection, and a leg created that way is not under Call Control.
-- Making it controllable needs `Park Outbound Calls`, which stops outbound
-- calls proceeding until our backend answers them -- Telnyx returns SIP 180
-- and the call "awaits further orders", indefinitely if nothing comes. That
-- flip is a separate, reversible change for later.
--
-- Inbound needs none of it. A call arriving at a Call Control Application is
-- under control from its first event, so everything here is additive and the
-- working dialer cannot regress.
--
-- Inbound calls are recorded in dialer_attempts, NOT a parallel table, so they
-- land in the existing Call log, recordings and reporting for free.

-- -------------------------------------------------------------------------
-- 1. The queues
-- -------------------------------------------------------------------------
create table if not exists dialer_inbound_queues (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  description   text,

  greeting_text text not null default 'Thank you for calling. Please hold and the next available agent will be with you.',
  hold_music_url text,

  -- How long ONE agent's phone rings before we give up and offer the call to
  -- the next agent.
  ring_timeout_seconds  smallint not null default 20
                        check (ring_timeout_seconds between 5 and 120),
  -- How long the caller waits overall before being offered voicemail.
  queue_timeout_seconds smallint not null default 90
                        check (queue_timeout_seconds between 10 and 900),
  voicemail_prompt_text text not null default 'Sorry, nobody is available right now. Please leave a message after the tone.',

  -- longest_idle spreads the work; rank always tries the same people first.
  strategy      text not null default 'longest_idle'
                check (strategy in ('longest_idle', 'rank')),

  -- Business hours, in the SAME shape as dialer_campaigns so there is one
  -- convention to learn. calling_days is ISO: Monday is 1 and SUNDAY IS 7,
  -- never 0 -- a getDay()-style 0 silently means "never Sunday", which has
  -- already cost us once (see docs/DIALER-PLAN.md).
  open_time     time not null default '09:00',
  close_time    time not null default '19:00',
  open_days     smallint[] not null default '{1,2,3,4,5}',
  closed_message text not null default 'Thank you for calling. Our office is closed right now. Please call back during business hours.',

  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table dialer_inbound_queues is
  'Inbound call queues. Hours use the same ISO calling_days convention as '
  'dialer_campaigns -- Monday is 1 and Sunday is 7.';

alter table dialer_inbound_queues enable row level security;

drop policy if exists "dialer_inbound_queues: staff select" on dialer_inbound_queues;
create policy "dialer_inbound_queues: staff select" on dialer_inbound_queues
  for select using (role_can_use_dialer() or role_can_review_calls());

drop policy if exists "dialer_inbound_queues: manager manage" on dialer_inbound_queues;
create policy "dialer_inbound_queues: manager manage" on dialer_inbound_queues
  for all using (is_admin() or role_can_manage_dialer())
  with check (is_admin() or role_can_manage_dialer());

grant select, insert, update, delete on dialer_inbound_queues to authenticated;
grant all on dialer_inbound_queues to service_role;

-- -------------------------------------------------------------------------
-- 2. Who answers which queue. Same shape and rules as dialer_campaign_agents.
-- -------------------------------------------------------------------------
create table if not exists dialer_queue_agents (
  queue_id   uuid not null references dialer_inbound_queues(id) on delete cascade,
  agent_id   uuid not null references profiles(id) on delete cascade,
  -- Only consulted when strategy = 'rank'; lower is tried first.
  priority   smallint not null default 100,
  is_active  boolean not null default true,
  assigned_by uuid references profiles(id),
  assigned_at timestamptz not null default now(),
  primary key (queue_id, agent_id)
);

create index if not exists dialer_queue_agents_agent_idx
  on dialer_queue_agents (agent_id) where is_active;

alter table dialer_queue_agents enable row level security;

drop policy if exists "dialer_queue_agents: own select" on dialer_queue_agents;
create policy "dialer_queue_agents: own select" on dialer_queue_agents
  for select using (
    (select auth.uid()) = agent_id
    or is_admin() or role_can_manage_dialer() or role_can_review_calls()
  );

drop policy if exists "dialer_queue_agents: manager manage" on dialer_queue_agents;
create policy "dialer_queue_agents: manager manage" on dialer_queue_agents
  for all using (is_admin() or role_can_manage_dialer())
  with check (is_admin() or role_can_manage_dialer());

grant select, insert, update, delete on dialer_queue_agents to authenticated;
grant all on dialer_queue_agents to service_role;

-- -------------------------------------------------------------------------
-- 3. The missing half of allows_dialing
--
-- allows_dialing answers "does the outbound queue keep feeding this agent".
-- It cannot answer "may an inbound call ring them", which is a different
-- question with a different answer for exactly the status that needed it:
-- Inbound only takes calls but must never dial out.
-- -------------------------------------------------------------------------
alter table dialer_agent_statuses
  add column if not exists takes_inbound boolean not null default false;

comment on column dialer_agent_statuses.takes_inbound is
  'May an inbound queue call ring an agent in this status. Independent of '
  'allows_dialing: Inbound only takes calls but never dials out.';

update dialer_agent_statuses set takes_inbound = true
 where code in ('ready', 'inbound_only');

-- -------------------------------------------------------------------------
-- 4. Inbound state on the CDR
-- -------------------------------------------------------------------------
alter table dialer_attempts
  add column if not exists queue_id uuid references dialer_inbound_queues(id),
  add column if not exists enqueued_at timestamptz,
  add column if not exists left_voicemail boolean not null default false;

create index if not exists dialer_attempts_queue_waiting_idx
  on dialer_attempts (queue_id, enqueued_at)
  where direction = 'inbound' and answered_at is null and ended_at is null;

comment on column dialer_attempts.queue_id is
  'Inbound only: which queue the call arrived on. direction, answered_at and '
  'was_abandoned already carried the rest.';

-- Every time we ring an agent for a waiting caller. Stops the same agent being
-- offered one call twice, and gives the floor a real per-agent answer rate
-- rather than a guess.
create table if not exists dialer_inbound_offers (
  id              uuid primary key default gen_random_uuid(),
  attempt_id      uuid not null references dialer_attempts(id) on delete cascade,
  agent_id        uuid not null references profiles(id) on delete cascade,
  call_control_id text,
  offered_at      timestamptz not null default now(),
  settled_at      timestamptz,
  result          text check (result in ('answered', 'timeout', 'rejected', 'failed'))
);

create index if not exists dialer_inbound_offers_attempt_idx
  on dialer_inbound_offers (attempt_id, offered_at desc);

alter table dialer_inbound_offers enable row level security;

drop policy if exists "dialer_inbound_offers: staff select" on dialer_inbound_offers;
create policy "dialer_inbound_offers: staff select" on dialer_inbound_offers
  for select using (
    (select auth.uid()) = agent_id
    or is_admin() or role_can_manage_dialer() or role_can_review_calls()
  );

grant select on dialer_inbound_offers to authenticated;
grant all on dialer_inbound_offers to service_role;

-- -------------------------------------------------------------------------
-- 5. Who can take a call right now
--
-- SECURITY DEFINER: dialer-inbound calls this as the service role, and it
-- reads sessions and credentials across every agent, which no individual
-- agent may do.
--
-- A session with a stale heartbeat is a crashed tab, not an available agent.
-- Two minutes matches the cap dialer_status_usage_today already uses, so there
-- is one definition of "this session is alive" rather than two that drift.
-- -------------------------------------------------------------------------
create or replace function dialer_available_agents(p_queue uuid)
returns table (agent_id uuid, sip_username text, priority smallint,
               last_call_ended_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select s.agent_id,
         cr.sip_username,
         qa.priority,
         (select max(a.ended_at) from dialer_attempts a where a.agent_id = s.agent_id)
    from dialer_agent_sessions s
    join dialer_queue_agents qa
      on qa.agent_id = s.agent_id and qa.queue_id = p_queue and qa.is_active
    join dialer_agent_statuses st
      on st.code = s.agent_status and st.is_active and st.takes_inbound
    join dialer_agent_credentials cr
      on cr.agent_id = s.agent_id and cr.revoked_at is null
   where s.ended_at is null
     and s.last_heartbeat_at > now() - interval '2 minutes'
     and s.status <> 'on_call'
     and cr.sip_username is not null
   order by
     -- 'rank' trusts the floor's ordering; 'longest_idle' spreads the work,
     -- with never-called agents (null) first.
     case when (select strategy from dialer_inbound_queues where id = p_queue) = 'rank'
          then qa.priority else 0 end,
     (select max(a.ended_at) from dialer_attempts a where a.agent_id = s.agent_id)
       asc nulls first;
$$;

grant execute on function dialer_available_agents(uuid) to service_role;

-- -------------------------------------------------------------------------
-- 6. What the console polls while the agent sits idle
--
-- Deliberately scoped to the CALLER's own queues: an agent should not see, or
-- be able to count, work they cannot take.
-- -------------------------------------------------------------------------
create or replace function dialer_inbound_waiting()
returns table (attempt_id uuid, queue_id uuid, queue_name text,
               from_number text, enqueued_at timestamptz, waiting_seconds integer)
language sql
stable
security invoker
set search_path = public
as $$
  select a.id, a.queue_id, q.name, a.from_number, a.enqueued_at,
         extract(epoch from (now() - a.enqueued_at))::int
    from dialer_attempts a
    join dialer_inbound_queues q on q.id = a.queue_id
    join dialer_queue_agents qa
      on qa.queue_id = a.queue_id and qa.agent_id = auth.uid() and qa.is_active
   where a.direction = 'inbound'
     and a.answered_at is null
     and a.ended_at is null
     and a.enqueued_at is not null
   order by a.enqueued_at;
$$;

grant execute on function dialer_inbound_waiting() to authenticated;

-- -------------------------------------------------------------------------
-- 7. Is the queue open right now?
--
-- In the CALLER's local time we cannot know, so this is the office's own
-- clock -- unlike outbound calling hours, which follow the called number.
-- Inbound is the reverse case: the caller chose when to ring us.
-- -------------------------------------------------------------------------
create or replace function dialer_queue_is_open(p_queue uuid, p_at timestamptz default now())
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((
    select extract(isodow from p_at)::smallint = any(q.open_days)
       and p_at::time >= q.open_time
       and p_at::time <  q.close_time
      from dialer_inbound_queues q
     where q.id = p_queue and q.is_active
  ), false);
$$;

grant execute on function dialer_queue_is_open(uuid, timestamptz) to authenticated, service_role;
