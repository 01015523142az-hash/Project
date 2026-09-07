-- =========================================================================
-- v550: call transfer
-- =========================================================================
--
-- APPLIED LIVE 2026-09-06 via apply_migration (v550_dialer_call_transfer).
--
-- Transfer only works on calls that are under Call Control, which today means
-- INBOUND calls (v549). An outbound leg is originated by the agent's browser
-- over a Credential Connection and Telnyx has no handle on it -- the SDK's own
-- Call.transfer() says as much, logging "not currently implemented" before it
-- sends. dialer-transfer therefore refuses an outbound attempt with a sentence
-- explaining why, rather than appearing to work and silently doing nothing.
--
-- Blind transfer only. Warm/consultative transfer needs a third leg and a
-- conference, and is deliberately a separate piece of work.

alter table dialer_attempts
  add column if not exists transferred_at timestamptz,
  add column if not exists transferred_by uuid references profiles(id),
  add column if not exists transferred_to_agent_id uuid references profiles(id),
  add column if not exists transferred_to_number text;

comment on column dialer_attempts.transferred_to_agent_id is
  'Blind transfer target when the call was passed to another agent. '
  'transferred_to_number is set instead when it went to an outside line.';

create index if not exists dialer_attempts_transferred_idx
  on dialer_attempts (transferred_at) where transferred_at is not null;

-- -------------------------------------------------------------------------
-- Who this agent may pass a call to.
--
-- Scoped to the queue the call arrived on: passing a seller to someone who
-- does not work that queue is how a caller ends up with a person who has no
-- idea why they are on the phone. Availability is the same predicate the
-- queue itself uses, so an agent on a break is never offered as a target.
--
-- SECURITY DEFINER because it reads other agents' sessions and credentials,
-- which no individual agent may do -- but it returns only names and ids, never
-- the SIP username, which stays server-side in dialer-transfer.
-- -------------------------------------------------------------------------
create or replace function dialer_transfer_targets(p_attempt uuid)
returns table (agent_id uuid, full_name text, is_available boolean)
language sql
stable
security definer
set search_path = public
as $$
  select p.id,
         p.full_name,
         exists (
           select 1
             from dialer_agent_sessions s
             join dialer_agent_statuses st
               on st.code = s.agent_status and st.is_active and st.takes_inbound
            where s.agent_id = p.id
              and s.ended_at is null
              and s.last_heartbeat_at > now() - interval '2 minutes'
              and s.status <> 'on_call'
         )
    from dialer_attempts a
    join dialer_queue_agents qa on qa.queue_id = a.queue_id and qa.is_active
    join profiles p on p.id = qa.agent_id
   where a.id = p_attempt
     -- never offer the agent themselves as a transfer target
     and p.id <> coalesce(auth.uid(), '00000000-0000-0000-0000-000000000000'::uuid)
   order by 3 desc, p.full_name;
$$;

grant execute on function dialer_transfer_targets(uuid) to authenticated;
