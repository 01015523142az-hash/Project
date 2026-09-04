-- Backfill: tag historical leads with the "PrimeHome Buyers" campaign
-- (lead_submission_forms.name), so the "Campaign Name" column in
-- Leads Queue Review — PrimeHome Buyers shows correctly for leads that
-- predate the CSV/Excel importer's automatic default.
--
-- Context: the dashboard's "Upload CSV / Excel" importer (Leads Queue
-- Review — PrimeHome Buyers -> Upload CSV / Excel) already tags every NEW
-- row it creates with the "PrimeHome Buyers" campaign (submission_form_id)
-- going forward. This script is the one-time catch-up for rows that were
-- imported (or sent) before that default existed, or by any path that
-- doesn't set it (e.g. a lead matched-and-merged onto an existing lead
-- whose campaign was never set, or a send made directly through the
-- ispeedtolead-submit Edge Function rather than the dashboard's own
-- "Send to PrimeHome Buyers" button).
--
-- Safe to run more than once — every step is idempotent.

-- ---------------------------------------------------------------------
-- OPTIONAL — preview how many historical rows this will touch before
-- running the UPDATE below. Nothing is changed by this query.
-- ---------------------------------------------------------------------
-- select count(*) as leads_to_backfill
-- from leads
-- where submission_form_id is null
--   and (
--     imported = true
--     or id in (select lead_id from ispeedtolead_submissions where success = true)
--   );

begin;

-- 1. Make sure the "PrimeHome Buyers" campaign exists (same name the
--    dashboard's own getIspdDefaultCampaignFormId() looks for / creates).
insert into lead_submission_forms (name)
select 'PrimeHome Buyers'
where not exists (
  select 1 from lead_submission_forms where name = 'PrimeHome Buyers'
);

-- 2. Backfill every historical, still-untagged lead that actually belongs
--    to PrimeHome Buyers:
--      a) imported = true  -> created by the CSV/Excel importer (the only
--         place in the app that sets leads.imported = true)
--      b) has a successful ispeedtolead_submissions row -> was genuinely
--         sent to PrimeHome Buyers even though nothing tagged it
--    A lead that already has a campaign (submission_form_id is not null)
--    is left untouched — this never overwrites a real, existing campaign.
with phb as (
  select id from lead_submission_forms where name = 'PrimeHome Buyers' limit 1
)
update leads
set submission_form_id = (select id from phb)
where submission_form_id is null
  and (
    imported = true
    or id in (select lead_id from ispeedtolead_submissions where success = true)
  );

commit;
