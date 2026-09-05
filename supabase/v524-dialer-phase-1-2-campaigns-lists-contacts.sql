-- =========================================================================
-- v524: In-portal dialer — Phase 1.2, campaigns / lists / contacts
-- =========================================================================
--
-- Builds on v523 (dialer_dids / dialer_attempts / dialer_agent_sessions /
-- dialer_dnc). Read that file's header first — it explains the split-traffic
-- decision this whole design rests on: ReadyMode keeps the ~44,000/month
-- cold volume and its predictive pacing; the portal dialer takes ~3,000
-- warm dials a month at ONE LINE PER AGENT.
--
-- WHAT'S IN THIS FILE:
--   dialer_campaigns    — dial config, calling window, cadence, caller-ID
--                         strategy. Tunable without a deploy, by design.
--   dialer_lists        — a loaded list + its ReadyMode scrub provenance
--   dialer_contacts     — one row per dialable number; ALSO the dial queue
--   dialer_dispositions — outcome codes and what each one does
--   + the FK constraints v523 deferred on dialer_attempts
--
-- TWO CONSTRAINTS HERE ARE LOAD-BEARING, not bookkeeping:
--
--   1. dialer_campaigns.dial_mode admits only 'preview' and 'power'. There
--      is deliberately no 'predictive' value. One line per agent means the
--      agent is already connected before the contact's phone rings, so the
--      structural abandonment rate is zero and no pacing governor exists in
--      this system to keep it there. Adding predictive is not a config
--      change — it needs the governor, the disclosure message, and the
--      rolling-rate machinery from Phase 3. The constraint is what stops
--      that from being switched on by accident.
--
--   2. dialer_lists cannot reach status 'ready' without readymode_scrubbed_at
--      set. National/state/litigator DNC scrubbing is NOT performed in the
--      portal — every list goes into ReadyMode first, where its Risk
--      Management App scrubs on upload against our own FTC SAN. This check
--      is the enforcement of "only scrubbed lists are dialable"; without it
--      that rule is a habit, and habits fail quietly.
--
-- Apply AFTER v523. Idempotent — safe to re-run.
-- =========================================================================


-- -------------------------------------------------------------------------
-- dialer_campaigns
-- -------------------------------------------------------------------------
create table if not exists dialer_campaigns (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,

  status text not null default 'draft'
    check (status in ('draft', 'active', 'paused', 'completed', 'archived')),

  -- preview — the record is shown, the agent chooses to dial
  -- power   — auto-dials the next contact when the agent finishes wrap-up
  -- See constraint note 1 in this file's header: 'predictive' is absent on
  -- purpose and must not be added without the Phase 3 governor.
  dial_mode text not null default 'preview'
    check (dial_mode in ('preview', 'power')),

  -- ---- calling window (in the CALLED PARTY's time zone, never ours) ----
  -- Derived per contact from NPA/NXX, not from the property address — an
  -- Illinois property routinely has an owner whose mobile is a Florida
  -- number, and the number is what the rule follows.
  calling_window_start time not null default '09:00',
  calling_window_end   time not null default '19:00',
  -- ISO day-of-week, 1 = Monday. Default Mon–Fri.
  calling_days smallint[] not null default '{1,2,3,4,5}',

  -- ---- caller ID ----
  -- local_presence — match the DID's area code to the called NPA (default)
  -- fixed          — always dial from fixed_did_id
  -- pool           — any healthy DID, ignoring geography
  caller_id_strategy text not null default 'local_presence'
    check (caller_id_strategy in ('local_presence', 'fixed', 'pool')),
  fixed_did_id uuid references dialer_dids(id) on delete set null,

  -- ---- attempt cadence ----
  -- Cadence is an answer-rate lever, not just politeness: spacing attempts
  -- and moving them around the clock raises cumulative contact rate, and
  -- repeatedly hammering one number is both wasteful and an exposure.
  max_attempts smallint not null default 6 check (max_attempts between 1 and 30),
  min_hours_between_attempts smallint not null default 24
    check (min_hours_between_attempts between 1 and 720),
  -- When true, successive attempts on the same contact are pushed into a
  -- different part of the calling window rather than repeating at the same
  -- hour each time.
  vary_time_of_day boolean not null default true,
  -- Long enough for a real pickup. Trimming rings to save minutes costs
  -- answers, and there is a four-ring/15-second floor to respect anyway.
  ring_seconds smallint not null default 30 check (ring_seconds between 15 and 60),

  -- ---- call handling ----
  amd_enabled boolean not null default true,
  voicemail_drop_enabled boolean not null default false,
  voicemail_drop_path text,
  recording_enabled boolean not null default true,
  -- GHL workflow fired when an attempt ends with no human contact. This is
  -- the SMS-fallback lever from the plan, and it costs nothing extra — the
  -- send-client-sms/GHL integration already exists.
  sms_fallback_workflow_id text,

  script text,

  created_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists dialer_campaigns_status_idx on dialer_campaigns(status);

alter table dialer_campaigns enable row level security;

-- Campaign configuration decides who gets called and when — admin-only to
-- change. Any dialer-permitted agent may read it, because the console needs
-- the script, the dial mode and the calling window to function.
drop policy if exists "dialer_campaigns: dialer staff select" on dialer_campaigns;
create policy "dialer_campaigns: dialer staff select" on dialer_campaigns
  for select using (role_can_use_dialer());

drop policy if exists "dialer_campaigns: admin manage" on dialer_campaigns;
create policy "dialer_campaigns: admin manage" on dialer_campaigns
  for all using (is_admin()) with check (is_admin());

grant select, insert, update, delete on dialer_campaigns to authenticated;
grant select, insert, update, delete on dialer_campaigns to service_role;


-- -------------------------------------------------------------------------
-- dialer_lists
-- -------------------------------------------------------------------------
-- A list is the unit of scrub provenance. Everything dialable traces back to
-- one, and every one of them carries proof of when ReadyMode scrubbed it.
create table if not exists dialer_lists (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references dialer_campaigns(id) on delete cascade,
  name text not null,

  -- list_builder — a saved filter snapshot against `properties`
  -- csv_upload   — a file, typically exported from ReadyMode post-scrub
  -- leads_rework — re-working existing rows in `leads`
  source_type text not null
    check (source_type in ('list_builder', 'csv_upload', 'leads_rework', 'manual')),
  -- For 'list_builder': the exact filter set used, so the list is
  -- reproducible and auditable later. Mirrors how
  -- list_builder_saved_filters stores its own filters blob.
  source_filters jsonb,
  source_file_path text,

  -- ---- scrub provenance: see constraint note 2 in the header ----
  -- Null = not yet scrubbed in ReadyMode = not dialable.
  readymode_scrubbed_at timestamptz,
  -- Free text for who ran it and against which lists (national, state,
  -- litigator), since ReadyMode gives us no machine-readable receipt.
  readymode_scrub_note text,

  status text not null default 'pending_scrub'
    check (status in ('pending_scrub', 'loading', 'ready', 'exhausted', 'archived')),

  total_rows integer not null default 0,
  loaded_rows integer not null default 0,
  skipped_rows integer not null default 0,

  loaded_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- THE GATE. A list cannot be marked ready (and therefore cannot be
  -- dialed) unless a scrub timestamp exists. Enforced in the database, not
  -- in the UI, because this is the single rule the whole portal-side DNC
  -- position depends on.
  constraint dialer_lists_ready_requires_scrub
    check (status <> 'ready' or readymode_scrubbed_at is not null)
);

create index if not exists dialer_lists_campaign_idx on dialer_lists(campaign_id, created_at desc);
create index if not exists dialer_lists_status_idx on dialer_lists(status);

alter table dialer_lists enable row level security;

drop policy if exists "dialer_lists: dialer staff select" on dialer_lists;
create policy "dialer_lists: dialer staff select" on dialer_lists
  for select using (role_can_use_dialer());

drop policy if exists "dialer_lists: admin manage" on dialer_lists;
create policy "dialer_lists: admin manage" on dialer_lists
  for all using (is_admin()) with check (is_admin());

grant select, insert, update, delete on dialer_lists to authenticated;
grant select, insert, update, delete on dialer_lists to service_role;


-- -------------------------------------------------------------------------
-- dialer_contacts — one dialable number, and the dial queue itself
-- -------------------------------------------------------------------------
-- There is no separate queue table. next_attempt_at plus a partial index IS
-- the queue: "the earliest due contact in this campaign whose status is
-- still dialable". A second table would need to be kept in sync with this
-- one and would drift.
create table if not exists dialer_contacts (
  id uuid primary key default gen_random_uuid(),
  list_id uuid not null references dialer_lists(id) on delete cascade,
  -- Denormalised from the list so the queue query never has to join. The
  -- queue is the hottest read in the system.
  campaign_id uuid not null references dialer_campaigns(id) on delete cascade,

  -- Provenance back into existing data, for the screen pop and for writing
  -- results home.
  property_id uuid references properties(id) on delete set null,
  lead_id uuid references leads(id) on delete set null,

  phone_e164 text not null,
  contact_name text,

  -- ---- pre-dial validation (Telnyx Number Lookup, ~$0.0015/lookup) ----
  -- Cheap, and it does double duty: it stops us dialing disconnected
  -- numbers, which both depresses measured answer rate and is itself a
  -- reputation signal that gets DIDs flagged.
  phone_line_type text
    check (phone_line_type in ('mobile', 'landline', 'voip', 'unknown')),
  phone_carrier text,
  phone_valid boolean,
  phone_validated_at timestamptz,
  -- Position of this number within the source's phone array
  -- (skip_trace_results.phones is an array — we have been taking [0]).
  -- Lower dials first, and line type reorders it: mobiles before landlines
  -- before VOIP. Free answer rate from data already paid for.
  phone_rank smallint not null default 0,

  -- Calling-hours inputs, derived from the NUMBER's NPA/NXX rather than any
  -- address on the property record.
  timezone text,
  state text,

  -- ---- queue state ----
  status text not null default 'new'
    check (status in ('new', 'queued', 'in_progress', 'contacted',
                      'retired', 'suppressed', 'invalid')),
  attempt_count smallint not null default 0,
  last_attempt_at timestamptz,
  last_outcome text,
  -- Null means "not currently due". The cadence engine sets this after each
  -- attempt from the campaign's min_hours_between_attempts and
  -- vary_time_of_day settings.
  next_attempt_at timestamptz,
  retired_reason text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- THE QUEUE INDEX. Partial, so it only ever covers rows that could actually
-- be dialed — at 3,000 dials/month against a list that may hold hundreds of
-- thousands of rows, this is the difference between a queue pop being an
-- index seek and a sequential scan.
create index if not exists dialer_contacts_queue_idx
  on dialer_contacts(campaign_id, next_attempt_at)
  where status in ('new', 'queued') and next_attempt_at is not null;

create index if not exists dialer_contacts_list_idx on dialer_contacts(list_id, status);
create index if not exists dialer_contacts_phone_idx on dialer_contacts(phone_e164);
create index if not exists dialer_contacts_property_idx on dialer_contacts(property_id);
-- The pre-dial validation worklist: everything not yet looked up.
create index if not exists dialer_contacts_unvalidated_idx
  on dialer_contacts(list_id) where phone_validated_at is null;

-- One row per number per list. Re-loading a list must not duplicate the
-- queue; the same number legitimately appears in two different lists.
create unique index if not exists dialer_contacts_list_phone_uniq
  on dialer_contacts(list_id, phone_e164);

alter table dialer_contacts enable row level security;

drop policy if exists "dialer_contacts: dialer staff select" on dialer_contacts;
create policy "dialer_contacts: dialer staff select" on dialer_contacts
  for select using (role_can_use_dialer());

-- Agents update queue state as they dispose calls; loading and deleting are
-- admin/service-role operations.
drop policy if exists "dialer_contacts: dialer staff update" on dialer_contacts;
create policy "dialer_contacts: dialer staff update" on dialer_contacts
  for update using (role_can_use_dialer()) with check (role_can_use_dialer());

drop policy if exists "dialer_contacts: admin manage" on dialer_contacts;
create policy "dialer_contacts: admin manage" on dialer_contacts
  for all using (is_admin()) with check (is_admin());

grant select, insert, update, delete on dialer_contacts to authenticated;
grant select, insert, update, delete on dialer_contacts to service_role;


-- -------------------------------------------------------------------------
-- dialer_dispositions — outcome codes and their consequences
-- -------------------------------------------------------------------------
-- Global rather than per-campaign. ReadyMode scopes these per campaign, but
-- at four seats and one warm campaign that is complexity with no payoff, and
-- a shared vocabulary keeps reporting comparable across campaigns. If
-- per-campaign sets are ever needed, add a nullable campaign_id where null
-- means "global default".
--
-- The boolean columns are what make a disposition DO something rather than
-- just label a call: the console reads them to decide whether to retire the
-- contact, schedule a callback, write a row into `leads`, or suppress the
-- number in dialer_dnc.
create table if not exists dialer_dispositions (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  label text not null,
  category text not null
    check (category in ('contacted', 'no_contact', 'callback', 'dnc', 'converted', 'invalid')),

  -- Stop dialing this contact entirely.
  retires_contact boolean not null default false,
  -- Agent supplies a datetime; the console writes it to next_attempt_at.
  schedules_callback boolean not null default false,
  -- Write a row into `leads`, i.e. this call produced something.
  creates_lead boolean not null default false,
  -- Write a row into dialer_dnc. Distinct from retires_contact: retiring
  -- stops THIS campaign calling them, suppression stops EVERY campaign
  -- calling them and is permanent evidence.
  adds_to_dnc boolean not null default false,
  -- Mark the number bad so validation never re-queues it.
  marks_invalid boolean not null default false,

  sort_order smallint not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create index if not exists dialer_dispositions_active_idx
  on dialer_dispositions(sort_order) where is_active;

alter table dialer_dispositions enable row level security;

drop policy if exists "dialer_dispositions: dialer staff select" on dialer_dispositions;
create policy "dialer_dispositions: dialer staff select" on dialer_dispositions
  for select using (role_can_use_dialer());

drop policy if exists "dialer_dispositions: admin manage" on dialer_dispositions;
create policy "dialer_dispositions: admin manage" on dialer_dispositions
  for all using (is_admin()) with check (is_admin());

grant select, insert, update, delete on dialer_dispositions to authenticated;
grant select, insert, update, delete on dialer_dispositions to service_role;

-- Starting vocabulary. Deliberately small — dispositions proliferate and
-- then nobody uses them consistently, which ruins the reporting they exist
-- for. Add codes when a real gap shows up, not preemptively.
-- on conflict do nothing so re-running this file never clobbers edits made
-- in the UI afterwards.
insert into dialer_dispositions (code, label, category, retires_contact, schedules_callback, creates_lead, adds_to_dnc, marks_invalid, sort_order) values
  ('interested',      'Interested — lead created', 'converted',  true,  false, true,  false, false, 10),
  ('callback',        'Callback scheduled',        'callback',   false, true,  false, false, false, 20),
  ('not_interested',  'Not interested',            'contacted',  true,  false, false, false, false, 30),
  ('do_not_call',     'Do not call — suppressed',  'dnc',        true,  false, false, true,  false, 40),
  ('wrong_number',    'Wrong number',              'invalid',    true,  false, false, false, true,  50),
  ('no_answer',       'No answer',                 'no_contact', false, false, false, false, false, 60),
  ('voicemail',       'Reached voicemail',         'no_contact', false, false, false, false, false, 70),
  ('busy',            'Busy',                      'no_contact', false, false, false, false, false, 80),
  ('disconnected',    'Disconnected / invalid',    'invalid',    true,  false, false, false, true,  90)
on conflict (code) do nothing;


-- -------------------------------------------------------------------------
-- Close the loop on v523's deferred foreign keys
-- -------------------------------------------------------------------------
-- v523 created dialer_attempts.campaign_id / .contact_id as plain nullable
-- uuids because the referenced tables did not exist yet. They exist now.
-- Still nullable: a Phase 1.1 preview dial placed straight from a property
-- record legitimately belongs to no campaign and no contact row.
--
-- on delete set null, not cascade — deleting a campaign must never destroy
-- call-detail records. The CDR is the compliance record and outlives
-- whatever configuration produced it.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'dialer_attempts_campaign_id_fkey'
  ) then
    alter table dialer_attempts
      add constraint dialer_attempts_campaign_id_fkey
      foreign key (campaign_id) references dialer_campaigns(id) on delete set null;
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'dialer_attempts_contact_id_fkey'
  ) then
    alter table dialer_attempts
      add constraint dialer_attempts_contact_id_fkey
      foreign key (contact_id) references dialer_contacts(id) on delete set null;
  end if;
end $$;

-- Same reasoning for dialer_agent_sessions.campaign_id.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'dialer_agent_sessions_campaign_id_fkey'
  ) then
    alter table dialer_agent_sessions
      add constraint dialer_agent_sessions_campaign_id_fkey
      foreign key (campaign_id) references dialer_campaigns(id) on delete set null;
  end if;
end $$;

-- NOTE on dialer_attempts.disposition: it stays a plain text column, NOT a
-- foreign key to dialer_dispositions.code. A disposition code can be
-- renamed or deactivated years after a call; the CDR must keep saying what
-- the agent actually chose at the time.
