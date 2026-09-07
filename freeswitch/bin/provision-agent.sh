#!/usr/bin/env bash
#
# Provision one agent's FreeSWITCH SIP credential (v554).
#
#   ./provision-agent.sh <agent-uuid> <full-name-for-the-username>
#
# Generates a random password, derives the a1-hash FreeSWITCH authenticates
# against, writes the hash to Supabase, and prints the plaintext password
# ONCE. The plaintext is never stored anywhere -- not in the database, not in
# a file, not in this script's output beyond that one line. If it is lost,
# re-run this and the old one stops working.
#
# WHY A HASH AND NOT A PASSWORD. a1-hash is md5(user:realm:password), which
# is what SIP digest authentication actually compares. Storing it means the
# database never holds a password we could accidentally log, and an attacker
# who reads the table still cannot authenticate anywhere else with it. It is
# still password-EQUIVALENT for THIS switch, which is why
# dialer_fs_credentials has RLS on with no policies at all.
#
# Requires: SUPABASE_SERVICE_ROLE_KEY and FS_DOMAIN in the environment.

set -euo pipefail

AGENT_ID="${1:-}"
LABEL="${2:-}"
SUPABASE_URL="${SUPABASE_URL:-https://kqfoniinytvuddxiwvkc.supabase.co}"

if [[ -z "$AGENT_ID" || -z "$LABEL" ]]; then
  echo "usage: $0 <agent-uuid> <label>" >&2
  exit 64
fi
if [[ -z "${SUPABASE_SERVICE_ROLE_KEY:-}" ]]; then
  echo "SUPABASE_SERVICE_ROLE_KEY is not set" >&2
  exit 78
fi
if [[ -z "${FS_DOMAIN:-}" ]]; then
  echo "FS_DOMAIN is not set (e.g. fs.staffportal.proptechnologyai.com)" >&2
  exit 78
fi

# The username is derived, not chosen, so it always matches the static
# dialplan's ^(agent_[a-zA-Z0-9_]+)$ pattern -- that is what lets an inbound
# leg from Telnyx find the agent.
SLUG=$(printf '%s' "$LABEL" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9' | cut -c1-16)
SUFFIX=$(head -c 4 /dev/urandom | od -An -tx1 | tr -d ' \n')
SIP_USER="agent_${SLUG}_${SUFFIX}"

# 32 bytes of urandom, base64, stripped to url-safe. Long enough that the
# digest realm is the weakest link, not this.
PASSWORD=$(head -c 32 /dev/urandom | base64 | tr -d '=+/\n' | cut -c1-32)

A1_HASH=$(printf '%s:%s:%s' "$SIP_USER" "$FS_DOMAIN" "$PASSWORD" | md5sum | cut -d' ' -f1)
SIP_URI="sip:${SIP_USER}@${FS_DOMAIN}"

# Upsert: re-running for the same agent rotates their credential rather than
# failing on the primary key. That is the intended way to revoke-and-reissue.
HTTP=$(curl -s -o /tmp/prov.out -w '%{http_code}' \
  -X POST "${SUPABASE_URL}/rest/v1/dialer_fs_credentials?on_conflict=agent_id" \
  -H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" \
  -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}" \
  -H 'Content-Type: application/json' \
  -H 'Prefer: resolution=merge-duplicates,return=minimal' \
  -d "{\"agent_id\":\"${AGENT_ID}\",\"sip_username\":\"${SIP_USER}\",\"sip_uri\":\"${SIP_URI}\",\"a1_hash\":\"${A1_HASH}\",\"revoked_at\":null}")

if [[ "$HTTP" != "20"* ]]; then
  echo "provisioning failed (HTTP $HTTP):" >&2
  cat /tmp/prov.out >&2
  rm -f /tmp/prov.out
  exit 1
fi
rm -f /tmp/prov.out

cat <<REPORT

  Provisioned ${LABEL}

    agent id   ${AGENT_ID}
    sip user   ${SIP_USER}
    sip uri    ${SIP_URI}
    password   ${PASSWORD}

  The password is shown ONCE and is not recoverable. Hand it to the agent's
  console over a channel you would be willing to send a password over, then
  clear your scrollback.

  This agent is still on Telnyx until somebody sets transport explicitly:

    update dialer_agent_credentials set transport = 'freeswitch'
     where agent_id = '${AGENT_ID}';

  And back again, which is the rollback:

    update dialer_agent_credentials set transport = 'telnyx'
     where agent_id = '${AGENT_ID}';

REPORT
