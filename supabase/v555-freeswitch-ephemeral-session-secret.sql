-- =========================================================================
-- v555: the FreeSWITCH password has to be ephemeral
-- =========================================================================
--
-- APPLIED LIVE 2026-09-07 via apply_migration (v555_freeswitch_ephemeral_session_secret).
--
-- v554 stored one long-lived a1_hash per agent, provisioned by
-- freeswitch/bin/provision-agent.sh, and said the plaintext password was
-- "never stored anywhere". Writing the console half showed that could not
-- hold: mod_verto authenticates with SIP digest, so the BROWSER has to
-- present the plaintext on every registration. A long-lived password
-- therefore has to be recoverable from somewhere -- which is precisely what
-- we refused to store, so the design contradicted itself.
--
-- The fix is the pattern dialer-telnyx-token already uses: mint a short
-- credential per sign-in and keep nothing durable. dialer-fs-token generates
-- a password, stores only md5(user:realm:password) with an expiry, and hands
-- the plaintext to the browser once. Nothing long-lived exists, so there is
-- no password in the database to leak, and a credential that does leak dies
-- at the end of the shift it was issued for.
--
-- What stays durable is the IDENTITY -- sip_username and sip_uri. It has to:
-- the static dialplan routes inbound legs to agent_*, and
-- dialer_agent_sip_uri() hands that name to Telnyx so a queued call can find
-- the agent. Rotating a secret must never rotate the name.

alter table dialer_fs_credentials alter column a1_hash drop not null;
alter table dialer_fs_credentials add column if not exists a1_expires_at timestamptz;

comment on column dialer_fs_credentials.a1_hash is
  'md5(sip_username:domain:password) for the CURRENT SESSION only, minted by '
  'dialer-fs-token at sign-in and valid until a1_expires_at. Null between '
  'shifts. The plaintext is handed to the browser once and stored nowhere -- '
  'so there is no long-lived password to leak, and a stolen one dies at the '
  'end of the shift it was issued for.';

comment on column dialer_fs_credentials.a1_expires_at is
  'When the current session secret stops being accepted. dialer-fs-directory '
  'checks this on every registration, so expiry is enforced at the switch, '
  'not merely hoped for.';

comment on column dialer_fs_credentials.sip_username is
  'The DURABLE identity -- it outlives every session secret, because the '
  'static dialplan routes inbound legs to agent_* and dialer_agent_sip_uri() '
  'hands that name to Telnyx. Rotating a secret must never rotate this.';

-- The directory lookup runs on every registration and every SIP auth
-- challenge, which is the hottest read on this table by a wide margin.
create index if not exists dialer_fs_credentials_active_idx
  on dialer_fs_credentials (sip_username)
  where revoked_at is null and a1_hash is not null;

-- -------------------------------------------------------------- verified --
-- The expiry is enforced in dialer-fs-directory, and it is the only place it
-- is enforced -- without that check the "ephemeral" secret would be
-- permanent and nothing would look wrong. Every refusal there returns the
-- same "not found" document the switch gets for a username that never
-- existed, so a probe cannot tell a revoked agent from an off-shift one from
-- a typo.
--
-- Checked in a rolled-back transaction, one agent walked through four states:
--
--   fresh secret, expires in 12h   -> served
--   a1_expires_at in the past      -> refused: secret expired
--   a1_hash null (between shifts)  -> refused: no session secret
--   revoked_at set                 -> refused: revoked
--
-- BE PRECISE ABOUT WHAT THAT PROVED. The four decisions were reproduced in
-- SQL against the real rows; the edge function itself was not executed,
-- because it refuses everything until FS_XML_SECRET is set and that secret
-- is the operator's to choose. So this establishes that the DATA drives the
-- four outcomes correctly, not that the TypeScript agrees with it. Re-run
-- the same four states through a real registration during bring-up step 4
-- before trusting expiry in production.
