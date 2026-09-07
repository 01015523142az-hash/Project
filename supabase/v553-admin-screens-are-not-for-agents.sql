-- =========================================================================
-- v553: the admin screens are not for agents
-- =========================================================================
--
-- APPLIED LIVE 2026-09-06 via apply_migration (v553_admin_screens_not_for_agents).
--
-- An agent opened /dialer/admin.html and got the console. The page did check
-- their role -- but it revealed the body FIRST and checked several awaits
-- later, so the whole screen rendered, tab handlers and all, next to a
-- message saying they had no access. dialer/index.html also linked them
-- straight to it from the side nav, which is how they found it.
--
-- Both of those are fixed in the two html files. Neither is a boundary.
-- Hiding a screen decides what someone is SHOWN; RLS decides what they can
-- READ, and a page that renders for the wrong person is a good moment to
-- check that the reads underneath it were ever right. Three were not:
--
--   dialer_lists          role_can_use_dialer()                -> EVERY list
--   dialer_inbound_queues role_can_use_dialer() or reviewer    -> EVERY queue
--   dialer_dnc            role_can_use_dialer()                -> EVERY number
--
-- With one campaign and one list on the account today, "every list" and
-- "their list" return the same row, which is exactly why this went unnoticed.
-- It stops being the same row on the second campaign.
--
-- Scoping, not blanket denial: an agent still reads the list NAME behind the
-- contact in front of them (dialer/index.html line ~1070 shows it as the
-- origin file), because that list belongs to a campaign they are assigned.
-- The queue config and the DNC register are admin data with no console
-- reader at all -- every dial-time DNC check runs in an edge function on the
-- service role, which RLS does not apply to.

-- ---------------------------------------------------------------- lists --
-- Same shape as dialer_campaigns and dialer_contacts already use, so all
-- three now answer "which campaigns is this agent on" identically.
drop policy if exists "dialer_lists: dialer staff select" on dialer_lists;
create policy "dialer_lists: dialer staff select" on dialer_lists
  for select to authenticated
  using (
    is_admin() or role_can_manage_dialer() or role_can_review_calls()
    or (role_can_use_dialer() and dialer_agent_assigned(campaign_id))
  );

-- -------------------------------------------------------- inbound queues --
-- Greeting text, hold music, voicemail prompt, timeouts, opening hours: the
-- floor's configuration. The console never reads this table -- it gets the
-- queue name from dialer_inbound_waiting, which is why that function has to
-- change below before this policy can tighten.
drop policy if exists "dialer_inbound_queues: staff select" on dialer_inbound_queues;
create policy "dialer_inbound_queues: staff select" on dialer_inbound_queues
  for select to authenticated
  using (is_admin() or role_can_manage_dialer() or role_can_review_calls());

-- ------------------------------------------------------------------ dnc --
-- A register of people who asked us to stop calling: their phone numbers,
-- and the fact that each one complained. No client page reads it.
drop policy if exists "dialer_dnc: dialer staff select" on dialer_dnc;
create policy "dialer_dnc: dialer staff select" on dialer_dnc
  for select to authenticated
  using (is_admin() or role_can_manage_dialer() or role_can_review_calls());

-- --------------------------------------------------- dialer_inbound_waiting --
-- This was SECURITY INVOKER, and it reads two tables the caller cannot see
-- through: dialer_attempts (own calls only -- and a call still waiting in a
-- queue has no agent_id yet, so it is nobody's) and dialer_inbound_queues.
-- It therefore returned an empty set to every agent it exists for. Nobody
-- noticed because inbound has not completed a call end to end yet.
--
-- Its visibility rule was never RLS: it is the qa join, active membership of
-- the queue the call is waiting in. Making it DEFINER is what lets that rule
-- be the rule, and what keeps it working now the queue table is locked down.
create or replace function dialer_inbound_waiting()
returns table(attempt_id uuid, queue_id uuid, queue_name text, from_number text,
              enqueued_at timestamptz, waiting_seconds integer)
language sql
stable
security definer
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

grant execute on function dialer_inbound_waiting() to authenticated, service_role;

-- -------------------------------------------------------------- verified --
-- All of this in rolled-back transactions, impersonating a real agent (Ola,
-- role 'agent') and a real team leader (Mariam):
--
--   agent, before -> lists 1, inbound_queues 1, dnc 1
--   agent, after  -> lists 1, inbound_queues 0, dnc 0
--                    campaigns 1 and dispositions 19 both unchanged, i.e. the
--                    console's own reads are untouched
--   team leader   -> lists 1, inbound_queues 1, dnc 1 (unchanged)
--
-- The list the agent still sees is the one behind their assigned campaign,
-- which is the point.
--
-- And for the function, with a call staged as waiting in the queue and the
-- agent an active member of it:
--
--   select count(*) from dialer_attempts where enqueued_at is not null
--     and answered_at is null                         -> 0 rows as the agent
--   select * from dialer_inbound_waiting()            -> the call, 12s waited
--
-- The first line is why the old INVOKER version was returning nothing: the
-- agent cannot see the attempt row it is built from. The second is the fix.
