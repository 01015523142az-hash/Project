-- =========================================================================
-- v558: the _-prefixed tables are live cron state, not scratch
-- =========================================================================
--
-- APPLIED LIVE 2026-09-07 via apply_migration (v558_document_live_cron_state_tables).
--
-- Written because I nearly dropped all three.
--
-- During the v557 grant audit these looked exactly like finished backfill
-- scratch, on three independent signals, and every one of them was wrong:
--
--   the _ prefix          reads as "temporary". They are permanent.
--   0 references in the   the callers are database FUNCTIONS and CRON JOBS,
--   application repo      not application code, so grepping dashboard/,
--                         dialer/ and supabase/functions/ finds nothing.
--   0 and 1 rows          one row IS the whole table for the progress ones --
--                         they are singletons. And _owner_portfolio_batch is
--                         TRUNCATED at the top of every batch, so empty is
--                         its resting state between ticks, not disuse.
--
--   done = true           does not mean finished forever. The 6-hourly reset
--                         job sets done = false to start the next pass.
--
-- What they actually are: the state of a rolling recompute of owner
-- portfolio sizes across ~2.4M properties, driven by two ACTIVE cron jobs.
--
--   job 35  */2 * * * *   call backfill_owner_portfolio_sizes()
--   job 30  0 */6 * * *   select reset_owner_portfolio_pass()
--
-- Dropping _owner_portfolio_progress or _owner_portfolio_batch would have
-- broken a job that fires every two minutes, immediately and permanently.
--
-- So: comments, not drops. The point of this migration is that the next
-- person to audit the schema -- or the next model asked to tidy it -- reads
-- the table and is told, in the table itself, that it is load-bearing.
--
-- No behaviour change. Three comments.

comment on table _owner_portfolio_progress is
  'LIVE CRON STATE -- DO NOT DROP. Single-row cursor for the rolling '
  'recompute of properties.owner_portfolio_size across ~2.4M rows. Written '
  'by backfill_owner_portfolio_sizes() (cron job 35, every 2 minutes), '
  're-armed by reset_owner_portfolio_pass() (cron job 30, every 6 hours), '
  'and read by recompute_owner_portfolio_sizes(), which is behind a manual '
  '"the numbers look stale" button. done = true means the CURRENT pass '
  'finished, not that the mechanism is retired -- job 30 sets it false '
  'again. The _ prefix is historical and misleading.';

comment on table _owner_portfolio_batch is
  'LIVE CRON STATE -- DO NOT DROP. Working set for one batch of '
  'backfill_owner_portfolio_sizes(), which TRUNCATEs it at the top of every '
  'iteration (truncate rather than delete because this database loads '
  'safeupdate, which rejects an unqualified DELETE). It is therefore EMPTY '
  'between ticks by design; zero rows is not evidence it is unused. Also '
  'read by recompute_owner_portfolio_sizes().';

comment on table _cook_absentee_backfill_progress is
  'Single-row cursor for backfill_cook_absentee_owner(). Currently dormant '
  '-- done = true since 2026-08-29, 560,411 rows updated, and no cron job '
  'calls it -- but the procedure still reads this table, so dropping it '
  'plants a failure for whoever next runs that backfill rather than '
  'removing dead weight. If the procedure is ever retired, retire the two '
  'together.';

-- -------------------------------------------------------------- verified --
-- Comments change no behaviour, but the surrounding claims were checked.
-- All three comments read back via obj_description(). RLS is still on from
-- v557 on all three. Cron jobs 30 and 35 are still active, and
-- cron.job_run_details shows job 35 with 90 runs in three hours, all
-- succeeded, latest 18:18 -- so v557 enabling RLS on tables this job writes
-- broke nothing, which is the thing that most deserved checking here.
