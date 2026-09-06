-- =========================================================================
-- v539: dialer_did_health() -- the autopilot's early-warning signal
-- =========================================================================
--
-- THE PROBLEM THIS SOLVES. Caller-ID reputation is what determines answer
-- rate on outbound, and a flagged number is worthless within days. The
-- obvious trigger -- wait for a reputation vendor to report a spam flag --
-- is too slow: carriers start suppressing a number well before any
-- monitoring service says so, and by then it has burnt through days of
-- dials at a collapsed connect rate that nobody noticed.
--
-- THE SIGNAL. A number's own answer rate collapses immediately. So compare
-- each DID's answer rate against the MEDIAN of the pool over the same
-- window: same lists, same hours, same agents, so anything that moves one
-- number and not the others is the number itself. Median rather than mean
-- because one already-dead DID would drag a mean down and make the rest
-- look healthy by comparison.
--
-- WHY min_dials MATTERS. A DID with four dials and one answer reads as 25%
-- and is meaningless. Numbers below the threshold are reported but excluded
-- from the median and never auto-quarantined -- the autopilot must not
-- retire a healthy number for being new.
--
-- Applied live 2026-09-05.
-- =========================================================================

create or replace function dialer_did_health(
  window_days int default 7,
  min_dials int default 30
)
returns table(
  did_id uuid,
  phone_e164 text,
  status text,
  dials bigint,
  answers bigint,
  answer_rate numeric,
  pool_median numeric,
  ratio_to_median numeric,
  enough_data boolean
)
language sql
stable
security definer
set search_path = public
as $$
  with per_did as (
    select d.id,
           d.phone_e164,
           d.status,
           count(a.id) as dials,
           count(a.answered_at) as answers,
           case when count(a.id) > 0
                then round(count(a.answered_at)::numeric / count(a.id), 4)
                else null end as answer_rate
    from dialer_dids d
    left join dialer_attempts a
      on a.from_did_id = d.id
     and a.initiated_at >= now() - make_interval(days => window_days)
     -- Manual dials are excluded: they are hand-picked warm numbers with a
     -- far higher natural answer rate, and letting them into the comparison
     -- would flatter whichever DID happened to carry them.
     and coalesce(a.is_manual, false) = false
    where d.status in ('active', 'resting', 'quarantined')
    group by d.id, d.phone_e164, d.status
  ), med as (
    -- Cast to numeric: percentile_cont returns double precision, which has
    -- no two-argument round(). Casting here rather than at each use keeps
    -- every downstream expression on one numeric type.
    select percentile_cont(0.5) within group (order by answer_rate)::numeric as m
    from per_did
    where dials >= min_dials and answer_rate is not null
  )
  select p.id,
         p.phone_e164,
         p.status,
         p.dials,
         p.answers,
         p.answer_rate,
         round(med.m, 4) as pool_median,
         case when med.m is null or med.m = 0 or p.answer_rate is null then null
              else round(p.answer_rate / med.m, 3) end as ratio_to_median,
         (p.dials >= min_dials) as enough_data
  from per_did p cross join med
  order by p.dials desc;
$$;

revoke all on function dialer_did_health(int, int) from public;
grant execute on function dialer_did_health(int, int) to authenticated;
grant execute on function dialer_did_health(int, int) to service_role;


-- An audit trail for everything the autopilot does on its own. Without this,
-- a number silently changing status looks like someone did it by hand, and
-- there is no way to review whether the thresholds are behaving.
create table if not exists dialer_did_events (
  id uuid primary key default gen_random_uuid(),
  did_id uuid not null references dialer_dids(id) on delete cascade,
  event text not null,          -- quarantined | rested | activated | flagged | cleared
  reason text,
  -- The numbers behind the decision, so a threshold can be argued with later
  -- rather than guessed at.
  detail jsonb not null default '{}'::jsonb,
  -- Null for autopilot; set when a human changes status from the admin screen.
  actor_id uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists dialer_did_events_did_idx
  on dialer_did_events(did_id, created_at desc);
create index if not exists dialer_did_events_recent_idx
  on dialer_did_events(created_at desc);

alter table dialer_did_events enable row level security;

drop policy if exists "dialer_did_events: reviewer select" on dialer_did_events;
create policy "dialer_did_events: reviewer select" on dialer_did_events
  for select using (role_can_review_calls());

grant select on dialer_did_events to authenticated;
grant select, insert, update, delete on dialer_did_events to service_role;
