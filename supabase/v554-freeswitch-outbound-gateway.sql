-- =========================================================================
-- v554: FreeSWITCH outbound gateway -- schema and the authority boundary
-- =========================================================================
--
-- APPLIED LIVE 2026-09-07 via apply_migration (v554_freeswitch_outbound_gateway).
--
-- Everything here is INERT until an agent's transport is switched to
-- 'freeswitch'. The default is 'telnyx', so applying this migration changes
-- the behaviour of exactly nothing.
--
-- Background: Telnyx bills 60/60 and our outbound calls average 18 seconds,
-- so we pay for 60 and use 18 -- an effective $0.0167/min against a $0.005
-- sticker. The fix is a self-hosted switch over a per-second SIP trunk.
-- Inbound stays on Telnyx Call Control, where the queueing lives and where
-- rounding barely registers because the calls are long.
--
-- Two things in here matter more than the columns.
--
-- 1. PASSWORD MATERIAL GETS ITS OWN TABLE.
--    dialer_agent_credentials has an "own select" policy -- an agent can
--    read their own row. A FreeSWITCH a1-hash is md5(user:domain:password)
--    and is password-EQUIVALENT: anyone holding it can register as that
--    agent and place calls. It therefore cannot live in a table the agent
--    can read. dialer_fs_credentials has RLS on and NO policies at all, so
--    only the service role reaches it, the same way the Telnyx API key is
--    only ever seen by an edge function.
--
-- 2. THE CLIENT NEVER NAMES A NUMBER.
--    The browser sends an attempt id as the dial string; the dialplan calls
--    dialer_fs_resolve_attempt() to turn it into a real number. So a stolen
--    agent session can only re-dial work already authorised for that agent
--    -- DNC, calling hours, area code, caps and multi-number order have all
--    been applied by dialer-call-control before the attempt row existed.
--    This is the whole toll-fraud model. The dialplan's NANP regex is the
--    second line, not the first.

-- ------------------------------------------------- transport selection --
alter table dialer_agent_credentials
  add column if not exists transport text not null default 'telnyx';

alter table dialer_agent_credentials
  drop constraint if exists dialer_agent_credentials_transport_check;
alter table dialer_agent_credentials
  add constraint dialer_agent_credentials_transport_check
  check (transport in ('telnyx', 'freeswitch'));

comment on column dialer_agent_credentials.transport is
  'Which switch this agent''s browser registers to for OUTBOUND. Default '
  '''telnyx'' so the column is inert on arrival. Flipping one agent to '
  '''freeswitch'' is the pilot; flipping everyone back is the rollback, and '
  'it needs no deploy -- the console reads this at sign-in.';

-- ------------------------------------------------- SIP auth (secret!) --
create table if not exists dialer_fs_credentials (
  agent_id      uuid primary key references profiles(id) on delete cascade,
  sip_username  text not null unique,
  sip_uri       text not null,
  a1_hash       text not null,
  created_at    timestamptz not null default now(),
  revoked_at    timestamptz
);

comment on table dialer_fs_credentials is
  'FreeSWITCH SIP auth, served to the switch by dialer-fs-directory over '
  'mod_xml_curl. RLS is ON and there are deliberately NO policies: nothing '
  'holding a user JWT may read this table, because a1_hash is password '
  'material. Only the service role gets in.';

comment on column dialer_fs_credentials.sip_uri is
  'The complete sip:user@host the inbound leg is dialled at. Stored whole '
  'rather than assembled from a global setting, because the host is '
  'deployment config and a GUC an edge function cannot reliably set is a '
  'worse place for it than a column somebody can read and check.';

comment on column dialer_fs_credentials.a1_hash is
  'md5(sip_username:domain:password). The plaintext password is generated '
  'at provisioning, handed to the browser once, and never stored anywhere.';

alter table dialer_fs_credentials enable row level security;
-- No policies. This is intentional -- see the table comment.

-- --------------------------------------------------- the resolve gate --
-- Called by the FreeSWITCH dialplan, through dialer-fs-route, on every
-- outbound call. It is the point where an untrusted dial string becomes a
-- real phone number, so it does all of its checking in ONE atomic update
-- rather than a select followed by an update:
--
--   * the attempt must exist, be outbound, and still be 'initiated'
--   * it must belong to the agent that this SIP username maps to
--   * that credential must not be revoked
--   * provider_call_id must still be null -- which is what makes an attempt
--     id SINGLE USE. Replaying a captured id gets nothing, because the
--     first call already claimed it.
--
-- The v551 unique partial index on provider_call_id is the backstop: even
-- if two calls raced past the null check, only one could commit.
create or replace function dialer_fs_resolve_attempt(
  p_attempt      uuid,
  p_sip_user     text,
  p_channel_uuid text
)
returns table (to_number text, from_number text)
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_agent uuid;
begin
  select c.agent_id into v_agent
    from dialer_fs_credentials c
   where c.sip_username = p_sip_user
     and c.revoked_at is null;

  if v_agent is null then
    raise exception 'unknown or revoked sip user';
  end if;

  return query
  update dialer_attempts a
     set provider_call_id = p_channel_uuid,
         status           = 'ringing'
   where a.id               = p_attempt
     and a.agent_id         = v_agent
     and a.direction        = 'outbound'
     and a.status           = 'initiated'
     and a.provider_call_id is null
  returning a.to_number, a.from_number;

  if not found then
    raise exception 'attempt not resolvable for this agent';
  end if;
end;
$$;

comment on function dialer_fs_resolve_attempt(uuid, text, text) is
  'Attempt id -> real number, for the FreeSWITCH dialplan. Single use: the '
  'first call claims the row by writing provider_call_id, so a replayed id '
  'resolves to nothing.';

-- Deliberately NOT granted to authenticated. The browser has no business
-- calling this -- it reaches the switch, and the switch reaches here
-- through an edge function on the service role.
revoke all on function dialer_fs_resolve_attempt(uuid, text, text) from public;
grant execute on function dialer_fs_resolve_attempt(uuid, text, text) to service_role;

-- ------------------------------------------------- inbound leg target --
-- dialer-inbound dials the agent's SIP URI to offer them a queued call.
-- With outbound on FreeSWITCH the agent is registered THERE, not to Telnyx,
-- so the inbound leg has to follow them. One expression, both cases, so the
-- inbound function stays a one-line change and the rollback flag governs
-- inbound and outbound together rather than leaving them out of step.
create or replace function dialer_agent_sip_uri(p_agent uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case
    when ac.transport = 'freeswitch' and fc.sip_uri is not null then fc.sip_uri
    else 'sip:' || ac.sip_username || '@sip.telnyx.com'
  end
  from dialer_agent_credentials ac
  left join dialer_fs_credentials fc
    on fc.agent_id = ac.agent_id and fc.revoked_at is null
  where ac.agent_id = p_agent and ac.revoked_at is null;
$$;

grant execute on function dialer_agent_sip_uri(uuid) to service_role;

-- -------------------------------------------------------------- verified --
-- In rolled-back transactions, with two real agents each given a test
-- FreeSWITCH credential and one authorised outbound attempt belonging to
-- the first:
--
--   correct agent resolves      OK -> to=+13055551234 from=+13074415766
--   replay of the same id       REFUSED: attempt not resolvable for this agent
--   a different agent's user    REFUSED: attempt not resolvable for this agent
--   unknown sip user            REFUSED: unknown or revoked sip user
--
-- The replay case is the one that matters: the first call claimed the row by
-- writing provider_call_id, so the id is spent. That is what stops a captured
-- dial string being reused.
--
-- Transport selection, same agent, both ways:
--   transport = 'telnyx'      -> sip:gencred...@sip.telnyx.com
--   transport = 'freeswitch'  -> sip:ola_t@fs.example.com
--
-- And the secret stays secret. Impersonating the agent who OWNS the row:
--   select a1_hash from dialer_fs_credentials where agent_id = <self>
--     -> no rows visible
--
-- CORRECTED BY v556. That check passed, but on one layer rather than two.
-- The table's PRIVILEGES were left to schema defaults, and the defaults came
-- out backwards: authenticated held SELECT/INSERT/UPDATE/DELETE while
-- service_role held no SELECT at all. RLS-with-no-policies was the only
-- thing making the line above true, and the claim above it -- "only the
-- service role reaches it" -- was simply wrong. v556 states the grants
-- explicitly; the same probe now returns a hard permission error instead of
-- an empty result.
