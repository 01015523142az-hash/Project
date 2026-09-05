-- =========================================================================
-- v526: dialer list import (ReadyMode scrub round-trip) + nationwide DIDs
-- =========================================================================
--
-- Three unrelated additions from the same working session. Apply after v525.
--
-- 1. LIST IMPORT PROVENANCE. Lists now arrive automatically: the portal
--    pushes leads into a ReadyMode Channel (readymode-api post_leads_batch,
--    already built), ReadyMode scrubs DNC, then a ReadyMode Automated Task
--    emails the scrubbed export to Mailgun, which POSTs it to the new
--    dialer-list-import function. These columns make that import auditable
--    and repeatable-safe.
--
-- 2. NATIONWIDE CALLER ID. The calling footprint is nationwide, not the
--    original IL/FL/SC/GA. Exact-area-code matching alone is too sparse at
--    that spread -- most calls would fall through to "any pool number",
--    which can present a wildly unrelated area code and reads worse than a
--    neutral one. dialer_dids.state enables an NPA -> same-state -> any
--    fallback chain in dialer-call-control's gate 5.
--
-- 3. REAL CARRIER COST. Telnyx already sends call.cost events (the
--    connection has "Enable Call Cost" on) and dialer-telnyx-webhook
--    currently discards them. Capturing the real charge beats the computed
--    billed_seconds estimate for cost reporting -- the two diverge because
--    of 60/60 rounding.
--
-- Idempotent -- safe to re-run.
-- =========================================================================


-- -------------------------------------------------------------------------
-- 1. List import provenance
-- -------------------------------------------------------------------------
-- The source file's own row, kept verbatim. Lists come from many different
-- vendors (DealMachine and others), so the lead columns vary while only
-- ReadyMode's appended columns are a fixed contract. Rather than force every
-- source into one schema, the recognised fields are mapped onto real columns
-- and the whole original row is kept here for anything we did not anticipate.
alter table dialer_contacts add column if not exists source_row jsonb not null default '{}'::jsonb;

-- ReadyMode's own scrub verdict for this record, from its appended columns.
-- Stored rather than merely filtered on, because "we did not dial this
-- because ReadyMode marked it DNC" is exactly the evidence a compliance
-- review asks for. NOTE the distinction from an uploaded file's own DNC
-- column: a DealMachine flag is stale and must be ignored (see the standing
-- rule on that), but ReadyMode's is their scrub result and IS authoritative.
alter table dialer_contacts add column if not exists readymode_dnc text;
alter table dialer_contacts add column if not exists readymode_status text;
-- Reassigned Numbers Database result. A number reassigned to a new
-- subscriber breaks prior-consent claims, so this is a TCPA signal, not
-- trivia. 'N/A' simply means ReadyMode did not run the check.
alter table dialer_contacts add column if not exists readymode_rnd_result text;

-- Idempotency for the email pipeline. Mailgun retries deliveries, and a
-- ReadyMode Automated Task can legitimately re-send the same export -- a
-- 9,117-lead push has already been accidentally double-submitted once in
-- this system's history. Keying the list on the source message means a
-- repeat delivery updates rather than clones.
alter table dialer_lists add column if not exists import_message_id text;
alter table dialer_lists add column if not exists import_channel_name text;
alter table dialer_lists add column if not exists import_stats jsonb not null default '{}'::jsonb;

create unique index if not exists dialer_lists_import_message_uniq
  on dialer_lists(import_message_id) where import_message_id is not null;

-- v524 constrains source_type; automated ReadyMode imports are their own
-- provenance and must be distinguishable from a hand-uploaded CSV.
do $$
begin
  alter table dialer_lists drop constraint if exists dialer_lists_source_type_check;
  alter table dialer_lists add constraint dialer_lists_source_type_check
    check (source_type in ('list_builder', 'csv_upload', 'leads_rework', 'manual', 'readymode_import'));
end $$;


-- -------------------------------------------------------------------------
-- 2. Nationwide caller-ID selection
-- -------------------------------------------------------------------------
-- Two-letter state for the DID's area code. Populated at purchase time from
-- Telnyx's own number metadata, so it stays correct for overlay area codes
-- where an NPA-to-state guess would be wrong.
alter table dialer_dids add column if not exists state text;
-- Coarser grouping for the last fallback step before "any number" --
-- calling a 206 from a 425 reads local; from a 305 it does not.
alter table dialer_dids add column if not exists region text;

create index if not exists dialer_dids_state_idx
  on dialer_dids(state, status) where status = 'active';


-- -------------------------------------------------------------------------
-- 3. Real carrier cost
-- -------------------------------------------------------------------------
-- What Telnyx actually charged, from the call.cost webhook. Kept alongside
-- (not instead of) billed_seconds: billed_seconds explains WHY the cost is
-- what it is -- 60/60 rounding turns a 10-second voicemail into a full
-- billed minute -- while this is the figure that reconciles to the invoice.
alter table dialer_attempts add column if not exists provider_cost_usd numeric(10,6);
alter table dialer_attempts add column if not exists provider_cost_currency text;
