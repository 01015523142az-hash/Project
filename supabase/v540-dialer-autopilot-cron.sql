-- =========================================================================
-- v540: schedule the DID autopilot
-- =========================================================================
--
-- DAILY, not hourly. Reputation moves over days, not minutes: a number's
-- answer rate needs a real sample before it means anything, and running more
-- often would only churn statuses on noise. 05:10 UTC is before the US
-- calling day, so a quarantine or rotation lands before agents start rather
-- than pulling a caller ID out from under someone mid-shift.
--
-- Same net.http_post + vault service_role_key pattern as every other job in
-- cron.job here (auto-close-stale-entries, list-builder-maintenance, ...).
--
-- To tune thresholds without a deploy, put them in the body:
--   body:='{"config":{"quarantine_ratio":0.5,"min_active":5}}'::jsonb
-- To see what it WOULD do without doing it:
--   body:='{"dry_run":true}'::jsonb
--
-- Applied live 2026-09-05.
-- =========================================================================

select cron.unschedule('dialer-autopilot-daily')
where exists (select 1 from cron.job where jobname = 'dialer-autopilot-daily');

select cron.schedule(
  'dialer-autopilot-daily',
  '10 5 * * *',
  $job$
  select net.http_post(
      url:='https://kqfoniinytvuddxiwvkc.functions.supabase.co/dialer-autopilot',
      headers:=jsonb_build_object(
        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key'),
        'Content-Type', 'application/json'
      ),
      body:='{}'::jsonb,
      timeout_milliseconds:=30000
  );
  $job$
);
