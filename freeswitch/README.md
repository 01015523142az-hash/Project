# FreeSWITCH outbound gateway

Config for the self-hosted switch that carries **outbound** dialler traffic.
Inbound stays on Telnyx Call Control — see `docs/DIALER-PLAN.md`, Phase 8.

Everything here is **inert until an agent's `transport` is set to
`freeswitch`**. The column defaults to `telnyx`, so none of this changes
behaviour for anyone until somebody switches one agent deliberately.

## Why this exists

Telnyx bills 60/60 — minimum one minute, then whole minutes. Our outbound
calls average **18 seconds**, so we pay for 60 and use 18. That makes the
effective rate `$0.0167/min` against a `$0.005` sticker: 3.3× on every call.
The fix is a per-second (or 6/6) SIP trunk, and reaching one means owning the
switch that talks to it, because SIP trunks come with no browser SDK.

Inbound is deliberately untouched: those calls are long, so rounding barely
registers, and the queueing, hold music, voicemail and transfer already work.

## What is in here

| Path | Purpose |
|---|---|
| `autoload_configs/xml_curl.conf.xml` | Points the directory and dialplan bindings at Supabase edge functions |
| `autoload_configs/verto.conf.xml` | Agent WebRTC profile, bound to localhost behind nginx |
| `autoload_configs/json_cdr.conf.xml` | Posts each finished call to `dialer-fs-cdr` |
| `autoload_configs/acl.conf.xml` | Deny-by-default list; the carrier's IPs are the only SIP allowed in |
| `dialplan/dialer.xml` | Static fallback only — inbound leg, echo test, and refuse everything else |
| `sip_profiles/external/trunk-*.xml` | Primary carrier and the Telnyx failover leg |
| `nginx/fs-wss.conf` | TLS termination on 443 for agent signalling |
| `bin/provision-agent.sh` | Creates one agent's durable SIP identity |
| `bin/verto-shim.ts` | Translates the Telnyx SDK's method prefix to Verto's |
| `systemd/verto-shim.service` | Runs the shim; a dead shim means every agent offline |
| `test/reprefix.test.mjs` | 35 checks on the shim's rewrite. `node test/reprefix.test.mjs bin/verto-shim.ts` |

## Secrets

Files here carry `__PLACEHOLDER__` tokens. **Nothing in this directory may
contain a real secret** — it is a public GitHub repository.

| Placeholder | Value |
|---|---|
| `__FS_XML_SECRET__` | Shared secret; must equal the `FS_XML_SECRET` set on the Supabase functions |
| `__FS_DOMAIN__` | e.g. `fs.staffportal.proptechnologyai.com` — **must equal `FS_DOMAIN`** below |
| `__PUBLIC_IP__` | The host's public IPv4 |
| `__TRUNK_PRIMARY_HOST__` | The carrier's SIP proxy hostname |

Substitute at deploy time, from a secret store or an untracked
`/etc/freeswitch/.env`, never by editing and committing.

Set the matching Supabase secrets before the switch will get any answer but
`503`:

```bash
supabase secrets set FS_XML_SECRET="$(head -c 32 /dev/urandom | base64)"
supabase secrets set FS_BILLING_INCREMENT=6
supabase secrets set FS_DOMAIN=fs.staffportal.proptechnologyai.com
supabase secrets set FS_WS_URL=wss://fs.staffportal.proptechnologyai.com/verto
supabase secrets set FS_SECRET_TTL_HOURS=12
```

**`FS_DOMAIN` must exactly equal `force-register-domain` in
`verto.conf.xml`.** It is the SIP digest realm, so if the two disagree every
a1-hash we compute is wrong and registration fails as *"bad password"* —
sending whoever debugs it to look in entirely the wrong place.

`FS_BILLING_INCREMENT` is the trunk's billing increment and belongs in
config, not code — it is a contract term, and contract terms get
renegotiated. Set it to what the carrier's rate sheet actually says.

## The console keeps its existing softphone

`@telnyx/webrtc` is FreeSWITCH's Verto protocol with the method prefix
renamed. Verified against the published bundle at 2.21.1: JSON-RPC 2.0 over
WebSocket, call methods `telnyx_rtc.invite/.answer/.bye/.attach/.subscribe/
.broadcast/.modify/.media/.info/.display/.ping/.punt/.clientReady` matching
Verto's set one for one, internal symbols still named `vertoSubscribe`,
`vertoBroadcast` and `Verto.newCall`, and `host` a plain option defaulting to
`wss://rtc.telnyx.com`.

**`login` is not prefixed on either side** — both use the bare method with
`{login, passwd, sessid, userVariables}` — so authentication passes straight
through and only the call methods need rewriting. `bin/verto-shim.ts` does
that in about sixty lines, and `test/reprefix.test.mjs` covers it.

So the console change is a host and a credential, not a rewrite. The call
state machine, DTMF, hold, mute, the keypad, the synthesised ringtone and the
identity-based inbound detection are all shared between both transports —
which matters, because each of those was debugged against real calls and
would have to be rediscovered in an unfamiliar library.

The shim carries signalling only; media (SRTP) goes browser ↔ FreeSWITCH RTP
ports directly, so it is not on the audio path and cannot degrade call
quality.

## Credentials are ephemeral

mod_verto authenticates with SIP digest, so the browser must present a
plaintext password. A long-lived one would therefore have to be recoverable
from somewhere — which is exactly what we refused to store.

Instead `dialer-fs-token` mints a password per sign-in, stores only its md5
with an expiry, and hands the plaintext to the browser once.
`dialer-fs-directory` serves that hash until `a1_expires_at` passes, and that
check is **the only place expiry is enforced** — without it the "ephemeral"
secret would be permanent and nothing would look wrong.

`provision-agent.sh` therefore creates the durable *identity* only. The
`sip_username` outlives every secret, because the static dialplan routes
inbound legs to `agent_*` and `dialer_agent_sip_uri()` hands that name to
Telnyx.

## The security model, in one paragraph

**The browser never names a phone number.** It dials `atmpt-<uuid>`;
`dialer-fs-route` resolves that to a real number server-side, having checked
the attempt belongs to that SIP user, is outbound, is still unstarted, and
has not already been dialled. Every rule that matters — DNC, calling hours in
the contact's zone, per-agent caps, area code, the v548 number order — was
applied by `dialer-call-control` before the attempt row existed. So the worst
a stolen agent session can do is re-dial work already authorised for that
same agent, exactly once. The NANP regex in `dialer-fs-route` and the
deny-by-default ACL are the second and third lines, not the first.

Two consequences worth stating plainly:

- **Port 5060 is never opened.** Agents arrive over WSS on 443; the carrier
  reaches 5061/TLS and only from ACL'd IPs.
- **The functions fail closed.** With `FS_XML_SECRET` unset they refuse every
  request with `503` rather than defaulting to open. Verified live.

## Bring-up order

Riskiest assumption first, nothing irreversible until the end.

1. **Host.** VPS with a static public IP, DNS A record, Let's Encrypt cert.
   4 vCPU / 8 GB handles roughly 50 concurrent transcoded calls; concurrency
   equals headcount, because it is one line per agent.
2. **Echo test.** Register a test user, dial `9196`, and listen. Proves
   media, NAT and codecs before any money is spent.
3. **Trunk.** Point `trunk-primary` at the carrier, whitelist the host IP
   with them, fill in `acl.conf.xml`. Confirm **A-level STIR/SHAKEN
   attestation in writing** first — see below.
4. **Wire Supabase.** Set the secrets, substitute the placeholders, restart.
   `dialer-fs-directory` should start answering registrations.
5. **Provision one agent**, flip only them to `freeswitch`, and dial.
6. **Pilot on answer rate.** Two agents here, the rest on Telnyx, same lists
   and hours.

## The failure that will actually happen

**The TLS certificate expires and every agent goes offline at once**, with no
warning and no obvious cause — the console just looks disconnected for
everybody simultaneously. Automate renewal *and* alert at 14 days. This is
the most likely total outage and the cheapest one to prevent.

Others worth wiring alerts for:

- `/var/log/freeswitch/cdr-failed` non-empty — calls happened that no report
  will ever show.
- Repeated `603 Declined` from `refuse_everything_else` — either xml_curl is
  down or somebody is probing.
- Disk above 70% — recordings accumulate at roughly 17.6 GB/month.

## Rollback

Per agent, no deploy, effective on their next sign-in:

```sql
update dialer_agent_credentials set transport = 'telnyx' where agent_id = '...';
```

Keep the Telnyx credential connection provisioned. It costs nothing while
idle and it is the only thing standing between a bad night and a floor that
cannot dial.

## What this does not fix

**Attestation.** The *carrier* signs calls under STIR/SHAKEN, not this
switch. Cheap wholesale routes often deliver B or C-level attestation and
downstream carriers spam-label accordingly. At 244,000 dials, going from an
8% to a 6% answer rate costs ~4,900 conversations a month — far more than the
~$1,400 this project saves. Get A-level confirmed in writing, and make answer
rate the pass/fail metric of the pilot.
