-- =========================================================================
-- v552: inbound queue hours need a time zone
-- =========================================================================
--
-- APPLIED LIVE 2026-09-06 via apply_migration (v552_inbound_queue_timezone).
--
-- v549 said the hours were "the office's own clock". They were not: the
-- comparison ran on now()::time, and the database's TimeZone is UTC, so an
-- admin typing 09:00-19:00 meaning their working day actually got 09:00-19:00
-- UTC. Caught on the first configured queue -- at 01:21 UTC on a Monday the
-- day test passed and the time test failed, so the queue reported closed in
-- the middle of a US working afternoon.
--
-- This is worse than a wrong number in a report. A closed queue does not fail
-- loudly: the caller hears the closed-hours message and is hung up on, and
-- nothing anywhere records that a real seller was turned away.
--
-- Default is UTC purely so this migration changes no existing behaviour on the
-- way in. It is the WRONG value for anybody, and the admin screen now makes it
-- a visible, required-looking choice rather than an invisible assumption.

alter table dialer_inbound_queues
  add column if not exists timezone text not null default 'UTC';

comment on column dialer_inbound_queues.timezone is
  'IANA zone the open/close times are read in -- the OFFICE''s clock, since '
  'inbound hours are about when staff are on shift. This is the opposite of '
  'outbound calling hours (dialer_campaigns), which follow the number being '
  'dialled, because there the callee chose nothing and the law follows them.';

-- Reject a zone Postgres does not know, rather than silently falling back and
-- opening the queue at the wrong time.
alter table dialer_inbound_queues
  drop constraint if exists dialer_inbound_queues_timezone_valid;
alter table dialer_inbound_queues
  add constraint dialer_inbound_queues_timezone_valid
  check (timezone in (select name from pg_timezone_names)) not valid;

create or replace function dialer_queue_is_open(p_queue uuid, p_at timestamptz default now())
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((
    select extract(isodow from (p_at at time zone q.timezone))::smallint = any(q.open_days)
       and (p_at at time zone q.timezone)::time >= q.open_time
       and (p_at at time zone q.timezone)::time <  q.close_time
      from dialer_inbound_queues q
     where q.id = p_queue and q.is_active
  ), false);
$$;

grant execute on function dialer_queue_is_open(uuid, timestamptz) to authenticated, service_role;
