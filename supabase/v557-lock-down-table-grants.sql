-- =========================================================================
-- v557: the same grant problem, everywhere else it existed
-- =========================================================================
--
-- APPLIED LIVE 2026-09-07 via apply_migration (v557_lock_down_table_grants).
--
-- v556 fixed dialer_fs_credentials, whose privileges had been left to schema
-- defaults and came out backwards. That was never going to be the only one,
-- so this is the audit of every table in public.
--
-- WHAT IS NOT IN HERE, because it is not a problem: roughly sixty tables
-- where anon and authenticated hold grants and RLS is on WITH POLICIES doing
-- the work -- leads, profiles, tasks, chat_*, client_*, every dialer_* table.
-- That is how Supabase is meant to work. Grants are the wrong layer to read
-- those at, and revoking them would break the product.
--
-- Two groups did need fixing.
--
-- GROUP 1 -- RLS WAS OFF ENTIRELY. Any signed-in user could read AND WRITE
-- these directly through PostgREST. The stored data is near-empty, so the
-- read side was not much of a leak; the write side was the problem.
-- readymode_channel_hours_adjustments feeds client-reports, so an agent
-- could have inserted rows and changed what a client saw in their report.
-- The three underscore-prefixed tables are leftover backfill scratch and
-- service_role could not even read them -- the same defaults bug again.
--
-- GROUP 2 -- ONE LAYER ONLY. RLS on, zero policies, so nothing gets through
-- today. But the grants were never revoked, which is exactly the shape v556
-- found: the table is safe because of RLS alone, while the comments around
-- it assume it is unreachable. One permissive policy added later by somebody
-- who reasonably assumed the grants were sane, and OAuth tokens, API
-- credentials and password-reset codes become readable. Three of them --
-- ghl_connections, readymode_connections, client_password_reset_codes --
-- had SELECT granted to ANON.
--
-- Both groups are inert to change. No browser code calls any of these
-- tables except dialer/index.html reading properties, and that read already
-- returns nothing (RLS deny-all) and ignores its error, so it renders the
-- same em dash either way. Everything else reaches them through an edge
-- function on the service role, which bypasses RLS and keeps its grants.
--
-- The dashboard already documents this pattern deliberately -- see
-- dashboard.html around line 16852, which notes ghl_connections has RLS with
-- no policies and routes through an edge function instead of reading it.
-- This migration makes the privileges match that intent.

do $$
declare
  -- RLS was OFF. Turn it on, then revoke, so both layers hold.
  group1 text[] := array[
    'readymode_channel_hours_adjustments',
    '_cook_absentee_backfill_progress',
    '_owner_portfolio_batch',
    '_owner_portfolio_progress'
  ];
  -- RLS already on with zero policies. Grants were the missing half.
  group2 text[] := array[
    'client_campaign_subscription_locks',
    'client_delivered_properties',
    'client_password_reset_codes',
    'ghl_connections',
    'ghl_oauth_states',
    'gmail_connections',
    'gmail_oauth_states',
    'list_builder_backfill_areas',
    'list_builder_demand_reports',
    'properties',
    'public_endpoint_rate_limits',
    'readymode_connections',
    'skip_trace_connections',
    'skip_trace_results'
  ];
  t text;
begin
  foreach t in array group1 loop
    execute format('alter table public.%I enable row level security', t);
  end loop;

  foreach t in array (group1 || group2) loop
    execute format('revoke all on table public.%I from anon', t);
    execute format('revoke all on table public.%I from authenticated', t);
    execute format('revoke all on table public.%I from public', t);
    -- Explicit, not inherited. The whole reason this migration exists is
    -- that inherited privileges came out backwards on three of these and
    -- left service_role unable to read its own tables.
    execute format(
      'grant select, insert, update, delete on table public.%I to service_role', t);
  end loop;
end $$;

comment on table readymode_channel_hours_adjustments is
  'Manual hour adjustments feeding client-reports. RLS on with no policies '
  'and grants revoked from anon/authenticated: reached only by edge '
  'functions on the service role. Before v557 RLS was off entirely and any '
  'signed-in user could have written rows here, which would have changed '
  'what a client saw in their report.';

-- -------------------------------------------------------------- verified --
-- The audit query that found all of this, re-run after applying, returns no
-- rows in either failing category:
--
--   RLS off + authenticated SELECT      0 tables   (was 4)
--   RLS on, 0 policies, grants intact   0 tables   (was 14)
--   service_role cannot read            0 tables   (was 3)
--
-- And spot-checked by impersonation on the two that matter most:
--   authenticated -> readymode_channel_hours_adjustments  permission denied
--   anon          -> client_password_reset_codes          permission denied
--
-- The legitimate path was checked too, because a lockdown that also locks
-- out the only real reader is not a fix. As service_role, all eighteen
-- tables still read: ghl_connections 1, gmail_connections 4,
-- readymode_connections 1, client_password_reset_codes 2, ghl_oauth_states
-- 42, list_builder_backfill_areas 43, client_delivered_properties 1000,
-- public_endpoint_rate_limits 181, properties 2,376,449, and the rest 0-1.
--
-- CHECKED AFTERWARDS, and it should have been checked BEFORE applying:
-- enabling RLS on the group 1 tables could have broken the cron jobs that
-- write them. It did not -- pg_cron runs as a role that bypasses RLS -- and
-- cron.job_run_details confirms it empirically: job 35
-- (owner-portfolio-backfill-step, every 2 minutes) has 90 runs in the three
-- hours spanning this migration, all succeeded, and job 30 succeeded at
-- 18:00. Zero failures either side. See v558 for what those tables actually
-- are; "leftover backfill scratch" in the note above was wrong.
--
-- SEPARATELY, and not fixed here: properties has RLS on with no policies, so
-- dialer/index.html:1363 loadProperty() has never been able to read it and
-- the console's property line always renders an em dash. That is a real bug
-- but it is a missing POLICY, not a grant, and guessing at who should see
-- which property is not something to slip into a permissions migration.
--
-- ALSO NOT DONE: the three _-prefixed backfill tables are almost certainly
-- finished scratch and should probably be dropped. Locked down here rather
-- than dropped, because confirming a backfill is complete is the owner's
-- call and a dropped table is not recoverable from a migration.
