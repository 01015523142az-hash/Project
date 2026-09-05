-- =========================================================================
-- v528: dialer_coverage_gaps() -- where the queue is vs where we own numbers
-- =========================================================================
--
-- Applied live 2026-09-05 with the dialer admin screen. Recorded here so the
-- repo matches the database.
--
-- Nationwide dialing makes DID buying a guessing game otherwise: you cannot
-- eyeball which area codes a queue of 100k contacts concentrates in. This
-- turns it into a ranked list -- "37 area codes queued, 12 covered, 4,200
-- contacts with no local caller ID" -- so the ordering screen can sort by
-- how many calls each purchase would make local.
--
-- IN POSTGRES, NOT THE BROWSER, on purpose: counting NPAs client-side would
-- mean paginating the whole contacts table, and any Supabase read over ~1000
-- rows truncates silently rather than erroring. Aggregating here returns one
-- row per area code regardless of queue size.
--
-- security definer because the admin screen calls it through an Edge
-- Function using the caller's JWT; the function itself gates on owner/admin
-- before invoking. Execute is revoked from public accordingly.
-- =========================================================================

create or replace function dialer_coverage_gaps()
returns table(area_code text, contacts bigint, active_dids bigint)
language sql
stable
security definer
set search_path = public
as $$
  with c as (
    select substring(phone_e164 from 3 for 3) as npa, count(*) as n
    from dialer_contacts
    where status in ('new', 'queued')
      and phone_e164 like '+1%'
    group by 1
  ), d as (
    select area_code as npa, count(*) as n
    from dialer_dids
    where status = 'active' and area_code is not null
    group by 1
  )
  select c.npa, c.n, coalesce(d.n, 0)
  from c left join d on d.npa = c.npa
  order by c.n desc;
$$;

revoke all on function dialer_coverage_gaps() from public;
grant execute on function dialer_coverage_gaps() to authenticated;
grant execute on function dialer_coverage_gaps() to service_role;
