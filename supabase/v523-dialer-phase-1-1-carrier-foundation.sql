-- =========================================================================
-- v523: In-portal dialer — Phase 1.1, carrier foundation
-- =========================================================================
--
-- CONTEXT / WHY THIS SHAPE:
--   The portal is getting its own dialer, running ALONGSIDE ReadyMode
--   rather than replacing it. ReadyMode keeps the high-volume cold calling
--   (~44,000 dials/month, predictive, multi-line) along with its number
--   pool and its own reputation management. The portal dialer takes WARM
--   traffic only — iSpeedToLead callbacks, inbound-lead follow-up,
--   high-intent skip-traced segments, client calls — at roughly 3,000
--   dials/month, ONE LINE PER AGENT (preview + power, never predictive).
--
--   That one-line constraint is why there is no pacing/ratio state in this
--   schema: with the agent already on the call before the contact's phone
--   rings, there is no predictive pacing to govern and the structural
--   abandonment rate is zero. dialer_attempts.was_abandoned still exists
--   because it is the compliance RECORD (and the safety net for an agent's
--   browser dropping mid-ring) — see its own comment below.
--
-- WHAT'S IN THIS FILE (Phase 1.1 only):
--   roles.can_use_dialer   — new per-role permission, same pattern as
--                            can_text_clients (v??? / schema.sql:5562)
--   dialer_dids            — the outbound number pool + autopilot state
--   dialer_attempts        — the call-detail record; this is what replaces
--                            readymode_calls for portal-placed traffic
--   dialer_agent_sessions  — agent login / ready / pause intervals
--   dialer_dnc             — internal do-not-call, master list for BOTH
--                            dialers while they run in parallel
--
-- NOT in this file — Phase 1.2 lands dialer_campaigns / dialer_lists /
--   dialer_contacts / dialer_dispositions. dialer_attempts.campaign_id and
--   .contact_id are deliberately plain nullable uuid columns here with NO
--   foreign key, so 1.1 can log a manual/preview dial that belongs to no
--   campaign yet. v524 adds the FK constraints once those tables exist.
--
-- CARRIER: Telnyx. Chosen over Twilio on cost (roughly half at this
--   traffic shape — Twilio's per-call AMD charge alone is ~4x Telnyx's,
--   and Twilio meters the agent's browser leg separately while Telnyx does
--   not). Both bill 60/60, whole minutes rounded up.
--
-- Apply with: psql / Supabase SQL editor. Idempotent — safe to re-run.
-- =========================================================================


-- -------------------------------------------------------------------------
-- Permission: who may use the dialer at all
-- -------------------------------------------------------------------------
-- Deliberately its own permission rather than reusing can_text_clients:
-- placing outbound calls on company DIDs carries TCPA exposure that sending
-- a text to an existing client does not. Owner/Admin always have it via
-- is_admin(); every other role must be granted it explicitly. Enforced
-- server-side in the dialer Edge Functions, never only hidden in the UI —
-- same reasoning send-client-sms gives for its own check.
alter table roles add column if not exists can_use_dialer boolean not null default false;

create or replace function role_can_use_dialer()
returns boolean as $$
  select coalesce((
    select is_admin() or r.can_use_dialer
    from profiles p join roles r on r.name = p.role
    where p.id = auth.uid()
  ), false);
$$ language sql security definer stable set search_path = public;


-- -------------------------------------------------------------------------
-- dialer_dids — the outbound number pool
-- -------------------------------------------------------------------------
-- Phase 1.1 buys ~40 numbers. The autopilot columns below are populated
-- from Phase 1.3 onward, but they live here from the start so the pool has
-- somewhere to record state the moment the first number is purchased.
--
-- ON THE AUTOPILOT TRIGGER: the primary quarantine signal is
-- answer_rate_7d falling well below the pool median, NOT reputation_status
-- flipping to 'flagged'. A monitoring service reports a spam flag days
-- after carriers start suppressing the number; the number's own answer rate
-- collapses immediately. reputation_status confirms or clears what the
-- answer rate already suggested.
create table if not exists dialer_dids (
  id uuid primary key default gen_random_uuid(),
  phone_e164 text not null unique,
  -- Stored rather than derived: NANP area code is a substring of E.164
  -- here, but keeping it a real column lets local-presence selection use a
  -- plain btree index instead of an expression index.
  area_code text,
  provider text not null default 'telnyx',
  -- The carrier's own identifier for this number, so a release/repurchase
  -- can be reconciled without matching on the phone string alone.
  provider_id text,

  -- active      — in rotation, may be selected for a dial
  -- resting     — deliberately idle to recover reputation; never selected
  -- quarantined — suspected or confirmed flagged; never selected
  -- retired     — released back to the carrier; kept for CDR history only
  status text not null default 'active'
    check (status in ('active', 'resting', 'quarantined', 'retired')),

  -- Per-number daily dial cap, enforced at dial time. 80 is a deliberately
  -- conservative default for warm traffic; at ~3,000 dials/month across 40
  -- numbers the pool sits far under this, which is the point — headroom
  -- means numbers can always be resting.
  daily_cap integer not null default 80,
  dials_today integer not null default 0,
  -- The date dials_today refers to, so the counter can be reset lazily on
  -- first use each day rather than needing a scheduled job.
  dials_today_date date,

  -- Autopilot signal columns (Phase 1.3)
  answer_rate_7d numeric(5,4),
  answer_rate_computed_at timestamptz,
  reputation_status text not null default 'unknown'
    check (reputation_status in ('unknown', 'clean', 'flagged', 'remediating')),
  reputation_detail jsonb,
  last_reputation_check_at timestamptz,
  remediation_filed_at timestamptz,
  remediation_cleared_at timestamptz,

  -- Registration hygiene: a number must be known to the analytics engines
  -- before it takes its first call — unknown numbers are treated worse than
  -- registered ones.
  cnam_registered boolean not null default false,
  caller_registry_registered boolean not null default false,

  purchased_at timestamptz,
  activated_at timestamptz,
  rested_at timestamptz,
  retired_at timestamptz,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Local-presence selection: "an active number in this area code that is
-- under its cap today".
create index if not exists dialer_dids_selection_idx
  on dialer_dids(area_code, status) where status = 'active';
create index if not exists dialer_dids_status_idx on dialer_dids(status);

alter table dialer_dids enable row level security;

-- The pool is operational configuration, not agent-facing data — agents
-- never choose their own caller ID, the engine does. Admin-only.
drop policy if exists "dialer_dids: admin manage" on dialer_dids;
create policy "dialer_dids: admin manage" on dialer_dids
  for all using (is_admin()) with check (is_admin());

grant select, insert, update, delete on dialer_dids to authenticated;
grant select, insert, update, delete on dialer_dids to service_role;


-- -------------------------------------------------------------------------
-- dialer_attempts — the call-detail record
-- -------------------------------------------------------------------------
-- This is the table every portal-side report is eventually built on, and
-- the replacement for readymode_calls for traffic the portal places. It is
-- written by the dialer Edge Functions from Telnyx call-control webhooks,
-- never by the browser.
create table if not exists dialer_attempts (
  id uuid primary key default gen_random_uuid(),

  -- Phase 1.2 forward-compatibility: plain uuid, no FK yet. A 1.1 preview
  -- dial straight from a property record belongs to no campaign or contact
  -- row. v524 adds the FK constraints once those tables exist.
  campaign_id uuid,
  contact_id uuid,

  agent_id uuid references profiles(id) on delete set null,
  -- Screen-pop context: which List Builder property this number came from,
  -- when it came from one at all.
  property_id uuid references properties(id) on delete set null,

  from_did_id uuid references dialer_dids(id) on delete set null,
  -- Denormalised deliberately: the CDR must stay truthful about which
  -- number was actually used even after that DID is retired and deleted.
  from_number text,
  to_number text not null,
  direction text not null default 'outbound' check (direction in ('outbound', 'inbound')),

  -- Telnyx call-control identifiers, for reconciling against their logs.
  provider_call_id text,
  provider_leg_id text,

  status text not null default 'initiated'
    check (status in ('initiated', 'ringing', 'answered', 'completed',
                      'busy', 'no_answer', 'failed', 'canceled')),

  -- Telnyx AMD verdict. Null until detection resolves, and on calls where
  -- detection was not requested at all.
  amd_result text check (amd_result in ('human', 'machine', 'not_sure', 'silence', 'unknown')),

  -- THE COMPLIANCE RECORD. At one line per agent this should always be
  -- false — the agent is already connected before the contact's phone
  -- rings, so there is no window for a live answer with nobody there. It
  -- exists because (a) a residual surface remains (agent's browser drops
  -- mid-ring, agent hangs up during ring), (b) regulators expect the
  -- record, and (c) it is the prerequisite for ever running a second line.
  -- MUST be written by the engine from the actual call outcome, never
  -- inferred later from timestamps.
  was_abandoned boolean not null default false,

  initiated_at timestamptz not null default now(),
  answered_at timestamptz,
  ended_at timestamptz,
  -- What the carrier bills: whole minutes rounded up, so a 15-second
  -- voicemail leg is 60 here. Stored separately from talk_seconds because
  -- the two diverge badly at this traffic shape and cost reporting needs
  -- the billed figure, not the real one.
  billed_seconds integer,
  talk_seconds integer,

  disposition text,
  hangup_cause text,
  recording_path text,
  error text,
  -- Full provider payload, for debugging a call whose mapped columns look
  -- wrong — same reasoning skip_trace_results.raw exists.
  raw jsonb,

  created_at timestamptz not null default now()
);

create index if not exists dialer_attempts_agent_idx on dialer_attempts(agent_id, initiated_at desc);
create index if not exists dialer_attempts_campaign_idx on dialer_attempts(campaign_id, initiated_at desc);
create index if not exists dialer_attempts_contact_idx on dialer_attempts(contact_id, initiated_at desc);
create index if not exists dialer_attempts_to_number_idx on dialer_attempts(to_number, initiated_at desc);
create index if not exists dialer_attempts_provider_call_idx on dialer_attempts(provider_call_id);
-- Answer-rate-per-DID, the autopilot's primary signal (Phase 1.3).
create index if not exists dialer_attempts_did_idx on dialer_attempts(from_did_id, initiated_at desc);
-- Rolling abandonment rate, kept cheap by only indexing the rare true rows.
create index if not exists dialer_attempts_abandoned_idx
  on dialer_attempts(campaign_id, initiated_at desc) where was_abandoned;

alter table dialer_attempts enable row level security;

-- An agent sees their own calls; admins see everything. Writes are
-- service_role only (the Edge Function acting on carrier webhooks) — a
-- browser must never be able to author or amend a CDR row, since this is
-- the compliance record.
drop policy if exists "dialer_attempts: own or admin select" on dialer_attempts;
create policy "dialer_attempts: own or admin select" on dialer_attempts
  for select using ((select auth.uid()) = agent_id or is_admin());

grant select on dialer_attempts to authenticated;
grant select, insert, update, delete on dialer_attempts to service_role;


-- -------------------------------------------------------------------------
-- dialer_agent_sessions — login / ready / pause intervals
-- -------------------------------------------------------------------------
-- The portal-side replacement for readymode_productivity_daily, and the
-- table that reconciles dialer time against the Chrome extension's own
-- timesheets. One row per dialer login; current state is updated in place.
create table if not exists dialer_agent_sessions (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references profiles(id) on delete cascade,
  campaign_id uuid,

  status text not null default 'ready'
    check (status in ('ready', 'on_call', 'wrap_up', 'paused', 'offline')),
  pause_reason text,

  started_at timestamptz not null default now(),
  ended_at timestamptz,
  -- Written by the console every ~30s. A session with a stale heartbeat and
  -- no ended_at was a crashed tab, not a logout — the same distinction the
  -- extension's heartbeat_stale_minutes handling already makes (v513).
  last_heartbeat_at timestamptz not null default now(),

  created_at timestamptz not null default now()
);

create index if not exists dialer_agent_sessions_agent_idx
  on dialer_agent_sessions(agent_id, started_at desc);
-- "Who is live right now" — the supervisor view and the stale-session sweep.
create index if not exists dialer_agent_sessions_open_idx
  on dialer_agent_sessions(last_heartbeat_at) where ended_at is null;

alter table dialer_agent_sessions enable row level security;

drop policy if exists "dialer_agent_sessions: own or admin select" on dialer_agent_sessions;
create policy "dialer_agent_sessions: own or admin select" on dialer_agent_sessions
  for select using ((select auth.uid()) = agent_id or is_admin());

-- The agent's own console opens/updates its own session row; the status and
-- heartbeat changes are high-frequency and not worth a round trip through
-- an Edge Function.
drop policy if exists "dialer_agent_sessions: own insert" on dialer_agent_sessions;
create policy "dialer_agent_sessions: own insert" on dialer_agent_sessions
  for insert with check ((select auth.uid()) = agent_id and role_can_use_dialer());

drop policy if exists "dialer_agent_sessions: own update" on dialer_agent_sessions;
create policy "dialer_agent_sessions: own update" on dialer_agent_sessions
  for update using ((select auth.uid()) = agent_id or is_admin());

grant select, insert, update on dialer_agent_sessions to authenticated;
grant select, insert, update, delete on dialer_agent_sessions to service_role;


-- -------------------------------------------------------------------------
-- dialer_dnc — internal do-not-call
-- -------------------------------------------------------------------------
-- MASTER LIST FOR BOTH DIALERS while ReadyMode runs in parallel.
--
-- Scope note: national/state/litigator DNC scrubbing is NOT done here. Every
-- list is loaded into ReadyMode first, where its Risk Management App scrubs
-- on upload against your own FTC SAN (the SAN is the seller's, i.e. ours —
-- ReadyMode requires customers to supply their own, so it already covers
-- portal-placed calls at no extra registry fee). Only scrubbed lists reach
-- the portal. What this table holds is the INTERNAL list — someone telling
-- one of our agents, on one of our calls, not to call again.
--
-- Sync: ReadyMode -> portal arrives through the existing
-- readymode-email-import route (a ReadyMode Automated Task emails the DNC
-- report to Mailgun, which POSTs it to that function; add the header
-- signature there and it lands here as source='readymode_import').
-- Portal -> ReadyMode has NO API — TPI/Channel posts leads, not DNC entries
-- — so synced_to_readymode_at tracks what still needs a manual export.
--
-- Append-only by design: this is evidence. "Suppressed" means ANY row
-- exists for the number, so nothing is ever deleted to un-suppress. Retain
-- five years.
create table if not exists dialer_dnc (
  id uuid primary key default gen_random_uuid(),
  phone_e164 text not null,
  source text not null default 'portal_agent'
    check (source in ('portal_agent', 'readymode_import', 'client_request', 'manual')),
  reason text,
  suppressed_by uuid references profiles(id) on delete set null,
  -- The call this came from, when it came from one.
  attempt_id uuid references dialer_attempts(id) on delete set null,
  -- Null means "still needs pushing to ReadyMode". Irrelevant for rows that
  -- came FROM ReadyMode in the first place.
  synced_to_readymode_at timestamptz,
  created_at timestamptz not null default now()
);

-- The dial-time gate: "does any row exist for this number".
create index if not exists dialer_dnc_phone_idx on dialer_dnc(phone_e164);
-- The manual-export worklist.
create index if not exists dialer_dnc_unsynced_idx on dialer_dnc(created_at)
  where synced_to_readymode_at is null and source <> 'readymode_import';

alter table dialer_dnc enable row level security;

-- Any staff member who can use the dialer needs to see suppressions (and
-- add one mid-call). Deletion is admin-only and should effectively never
-- happen — see the append-only note above.
drop policy if exists "dialer_dnc: dialer staff select" on dialer_dnc;
create policy "dialer_dnc: dialer staff select" on dialer_dnc
  for select using (role_can_use_dialer());

drop policy if exists "dialer_dnc: dialer staff insert" on dialer_dnc;
create policy "dialer_dnc: dialer staff insert" on dialer_dnc
  for insert with check (role_can_use_dialer());

drop policy if exists "dialer_dnc: admin delete" on dialer_dnc;
create policy "dialer_dnc: admin delete" on dialer_dnc
  for delete using (is_admin());

grant select, insert on dialer_dnc to authenticated;
grant delete on dialer_dnc to authenticated;
grant select, insert, update, delete on dialer_dnc to service_role;
