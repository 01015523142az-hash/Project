-- =========================================================================
-- v525: In-portal dialer — per-agent Telnyx telephony credentials
-- =========================================================================
--
-- Companion to v523/v524. One row per agent, holding the id of that agent's
-- Telnyx Telephony Credential.
--
-- WHY PER-AGENT rather than one shared credential: the credential is the
-- SIP identity the agent's browser registers as. Sharing one across four
-- agents makes every leg indistinguishable at the carrier — you could not
-- route a call to a specific agent, and dialer_attempts.agent_id would be a
-- guess rather than a fact. Since dialer_attempts is the compliance record,
-- it has to be a fact.
--
-- WHAT IS AND ISN'T STORED HERE: only the credential's ID and its SIP
-- username. The SIP password and the short-lived JWT the browser actually
-- logs in with are NEVER stored — the dialer-telnyx-token function mints a
-- fresh token per session and hands it straight to that agent's browser,
-- the same shape as cloudflare-turn-credentials. Nothing in this table is
-- a secret on its own.
--
-- Apply AFTER v523. Idempotent.
-- =========================================================================

create table if not exists dialer_agent_credentials (
  agent_id uuid primary key references profiles(id) on delete cascade,

  -- Telnyx's id for the Telephony Credential (its `data.id`).
  telnyx_credential_id text not null unique,
  -- The SIP user this credential registers as. Useful for reconciling
  -- against Telnyx's own call logs, and for addressing the agent leg when
  -- the engine originates to them.
  sip_username text,
  -- Which Credential Connection the credential was created under. Recorded
  -- so a later connection change is detectable rather than silently
  -- producing tokens that register against the wrong connection.
  telnyx_connection_id text,

  -- Set when an agent leaves or their access is revoked; the token function
  -- refuses to mint for a revoked row rather than deleting history.
  revoked_at timestamptz,

  created_at timestamptz not null default now(),
  last_token_issued_at timestamptz
);

create index if not exists dialer_agent_credentials_active_idx
  on dialer_agent_credentials(agent_id) where revoked_at is null;

alter table dialer_agent_credentials enable row level security;

-- An agent may see that they have a credential (the console shows dialer
-- readiness), but only ever their own row. Creation and revocation are
-- service_role only — the token Edge Function does both, using the Telnyx
-- API key that must never reach a browser.
drop policy if exists "dialer_agent_credentials: own select" on dialer_agent_credentials;
create policy "dialer_agent_credentials: own select" on dialer_agent_credentials
  for select using ((select auth.uid()) = agent_id or is_admin());

grant select on dialer_agent_credentials to authenticated;
grant select, insert, update, delete on dialer_agent_credentials to service_role;
