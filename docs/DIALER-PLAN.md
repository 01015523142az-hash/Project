# Dialer — plan and current state

Working document for the portal dialer. There was no plan file before this one;
the history lived in commit messages and migration headers. This pulls it into
one place so the next person does not have to reconstruct it from `git log`.

**State verified against the live database and the live site on 2026-09-06.**
Everything under "Shipped" was checked, not assumed — the method is at the end
so you can re-run it rather than trusting this file's date.

---

## Status at a glance

| | |
|---|---|
| Migrations v523–v553 | all applied live |
| `dialer/index.html`, `dialer/admin.html` | live copies identical to the repo |
| Dialer edge functions | 11 deployed and ACTIVE |
| Uncommitted dialer work | none |
| Committed locally but never pushed | none — all pushed 2026-09-06 |

---

## Shipped

### Phase 1 — carrier foundation (v523–v529)

DID pool with daily caps and lazy per-day reset; campaigns, lists and contacts;
per-agent SIP credentials; CSV/Mailgun list import; manual-dial flags; coverage
gaps; role-based access (`can_use_dialer`, `can_manage_dialer`, `can_review_calls`).

The architectural decision that shapes everything else: **the agent's browser
originates the call**, and `dialer-call-control` only authorises it. One line per
agent, no predictive pacing, so the abandonment rate is structurally zero rather
than managed. Server-side origination is deliberately absent — adding it means
adding a pacing governor.

### Phase 2 — call handling and QA (v530–v536)

Durable `recording_id` (stored playback URLs expire — `dialer-recording` mints
fresh ones on demand); reviewer access to the calls they review; call-log and
number-research RPCs; the full ReadyMode disposition vocabulary with a
multi-select filter; and the field-mapping catalogue (`dialer_field_defs`, 62
fields, 7 required) that lets an import name its own columns.

Mapping is lossy by design, so `source_row` keeps the untouched original row.

### Phase 3 — floor control (v537–v538)

Queues are assigned by an admin, not chosen by the agent. Assignment is enforced
in **three** places, because a gate in one place is one edit away from gone:

1. RLS on `dialer_campaigns` / `dialer_contacts` — an unassigned agent cannot
   read the queue, so the console's list *is* the assignment
2. a `BEFORE INSERT` trigger on `dialer_attempts` — `dialer-call-control` runs as
   the service role, where RLS does not apply
3. `dialer-call-control` gate 0 — only so the agent reads a sentence instead of
   "Could not open a call record."

Pause became a status (`dialer_agent_statuses`, a table the floor owns): Prep
work, Ready, Break, Meeting, Last call, Inbound only, Lead, Coaching, Azan. Ready
and Last call dial; the rest hold the queue. Time in status is recorded as
events; daily caps warn rather than logging anyone out.

### Phase 4 — DID health and reporting (v539–v541)

Answer-rate quarantine, rotation and capacity warnings via `dialer-autopilot`
(cron job `dialer-autopilot-daily`); `dialer_did_health`, `dialer_agent_stats`,
`dialer_campaign_stats`, `dialer_live_floor`. Reports live as a tab inside Dialer
Admin, not a separate page.

### Phase 5 — two-way SMS (v542–v545)

`dialer_sms_messages` as a provider-agnostic store, Telnyx inbound webhook, GHL
thread pull, an inbox tab in admin and a Messages view in the agent console, and
SMS fallback on unanswered manual dials with an editable template.

### Adjacent (v546–v547)

primehomebuyers.casa consent capture, SMS STOP honoured for calls, email-only
guide requests.

### Phase 6 — every number a contact has (v548)

Imports had carried up to ten numbers per seller since the mapping screen
landed, and the dialer only ever rang the first. `dialer_contact_phones` works
them in rank order, mirroring ReadyMode's Phone Number / Ph#2…Ph#10 and its
paid Skip Tracer behaviour.

Validity, line type, time zone, DNC and attempt count are properties of a
NUMBER, so every gate now follows the number being rung: DNC retires the LINE
rather than the person, calling hours read that number's zone, and a dead
primary no longer blocks a good Ph#2. `alt_phone_delay_minutes` (default 60)
sets how soon the next line opens — deliberately not zero, because ringing ten
numbers at one household inside ten minutes is how a complaint gets filed.

### Phase 7 — inbound queues and transfer (v549–v552)

Stage A of the contact-centre work, and it touches nothing on the outbound
path. `dialer-inbound` is a Telnyx Call Control webhook: answer, greet, queue,
ring an available agent, bridge, and fall through to voicemail. Every deadline
is driven by a webhook event — the hold music doubles as the queue clock — so
there is no cron and no scheduler.

`takes_inbound` on `dialer_agent_statuses` is the missing half of
`allows_dialing`, and `Inbound only` is where the two diverge. `dialer-transfer`
does blind transfer to an agent or an outside line. The admin Inbound tab owns
the queues; the console answers, rings audibly and transfers.

**Transfer works on inbound calls only.** An outbound leg is originated by the
browser over a Credential Connection and is not under Call Control — the SDK's
own `Call.transfer()` says "not currently implemented". Changing that is Stage B
below.

### Phase 8 — the admin screens are not for agents (v553)

Reported by the floor: an agent could open the dialer admin console and see it.
Three separate things had to be true for that, and all three were.

1. **`dialer/index.html` linked them to it.** The side nav's *Go to → Dialer
   Admin* was unconditional. It is now hidden unless the role passes the same
   test the admin page applies to itself, so a plain agent is not shown a door
   they get refused at. The staff portal was never part of this — its
   `dialer_admin` tab key is correctly granted to Quality and team leaders only.
2. **`dialer/admin.html` revealed itself before checking.**
   `document.body.classList.add('authed')` ran the moment a session existed,
   several awaits before the `canReview` test, so the whole console rendered —
   every tab, every button, tab handlers live — beside a message saying they had
   no access. The reveal now happens after the check, and a refusal is shown on
   the signed-out card, which is the only element outside `.app-body`.
3. **Three RLS policies were wider than the screens they fed** — a page
   rendering for the wrong person is a good moment to ask whether the reads
   underneath it were ever right:

   | table | was | now |
   |---|---|---|
   | `dialer_lists` | every list, to anyone who can dial | scoped to assigned campaigns, like `dialer_campaigns` and `dialer_contacts` |
   | `dialer_inbound_queues` | every queue's config | admin / manager / reviewer |
   | `dialer_dnc` | every number on the register | admin / manager / reviewer |

   With one campaign and one list on the account, "every list" and "their list"
   return the same row — which is exactly why it went unnoticed.

`dialer_inbound_waiting()` had to change with them, and the change found a real
bug. It was `SECURITY INVOKER` and joins two tables the caller cannot see
through: `dialer_attempts` (own calls only — and a call still waiting in a queue
has no `agent_id`, so it is nobody's) and `dialer_inbound_queues`. **It was
returning an empty set to every agent it exists for**, so the console's
waiting-call poll has never worked. Nobody noticed because inbound has not
completed a call end to end. It is `SECURITY DEFINER` now; its visibility rule
was never RLS but the `dialer_queue_agents` join — active membership of the
queue the call is waiting in.

---

## Open items

### 1. ~~Four commits exist only on this machine~~ — FIXED 2026-09-06

Four commits had been made locally and never pushed to `origin`, so they existed
on one laptop only:

```
5d96fc1  Dialer: show only a sign-in card when there is no session
e49dac6  Portal: idle sign-out after 4 hours instead of 1
0d597c8  v547: accept email-only guide requests from the site popup
1a38f01  v546: primehomebuyers.casa consent capture, and honour SMS STOP for calls
```

All the corresponding content was already deployed — the dialer pages and
`dashboard.html` match the live site, v546/v547 are applied, and
`site-lead-submit` / `site-opt-out` are ACTIVE — so this was a history and
backup risk, never an outage. Pushed, along with this file.

Worth watching: this repo pushes to **two** remotes and it is the `origin`
(mirror) push that is easy to forget, because the site keeps working without it.

### 2. ~~The migration ledger has three duplicate names~~ — FIXED 2026-09-06

`v539`/`v540`/`v541` were renumbered in the repo to clear a collision, but they
had already been applied under their original names, so the ledger carried two
different migrations for each of three numbers:

| Repo file | Was recorded as | Which collided with |
|---|---|---|
| `v539-dialer-did-health.sql` | `v530_dialer_did_health` | `v530_dialer_attempts_recording_id` |
| `v540-dialer-autopilot-cron.sql` | `v531_dialer_autopilot_cron` | `v531_dialer_attempts_reviewer_select` |
| `v541-dialer-reporting-rpcs.sql` | `v532_dialer_reporting_rpcs` | `v532_dialer_call_log_and_research_rpcs` |

Only the labelling was ever wrong; all three had applied cleanly. The rows were
relabelled to match the repo filenames — a metadata `update` on `name` only, no
schema change, each row targeted by its unique `version` timestamp and matched to
its file by content fingerprint first (answer-rate/reputation, `cron.schedule`,
`dialer_agent_stats`) so the right row got the right name.

Verified after: **no duplicate names anywhere in the ledger** (256 migrations),
and v533–v547 all present exactly once.

### 3. Two temporary edge functions are still deployed

`tmp-recording-probe` (a debug stub that now returns a hard 410) and
`tmp-motivated-export`. Neither has a caller. They need deleting from the
Supabase dashboard — there is no delete-function tool over MCP.

### 4. Uncommitted deletions in the working tree

`portal/dashboard/` (CNAME, dashboard.html, index.html, sw.js) deleted and
`portal/index.html` modified, none of it staged. Not dialer work, but it will
ride along with the next `git add -A`. Decide it deliberately.

### 5. ~~`dashboard/index.html` was a stale twin of `dashboard/dashboard.html`~~ — FIXED 2026-09-06

The two are byte-identical mirrors and are meant to stay that way. They had
drifted: `index.html` was ~56 lines behind and missing the v529 dialer work —
the Dialer Admin tab key, and opening the dialer in a **new tab** (the console
picks up the portal's login from `sessionStorage`, and an agent mid-call should
not lose the portal by navigating away).

Cause: two commits, `a88e747` and `62a1cf6`, edited `dashboard.html` only. Every
neighbouring commit touched both files. Production was never affected —
`dashboard.html` is the copy that deploys — but `index.html` was a live trap:
editing it did nothing, and deploying it would have regressed the dialer nav.

Restored by copying `dashboard.html` over it; verified byte-identical, carrying
all three v529 pieces, and still matching the live `/index.html`.

**The rule this file exists to record: a change to one of these must be made to
both, in the same commit.** Nothing enforces it, and the drift is invisible
until someone reads the two side by side. (`portal/index.html` was historically
a third mirror — see `AUDIT-AND-CHANGELOG.md` — but is mid-surgery in the
working tree and was deliberately left alone here.)

Note the path mapping while checking this sort of thing: the live site serves
the portal at `/index.html`, **not** `/dashboard/…` — that path 404s, and a
naive curl comparison silently diffs your file against the 404 page and reports
a difference that is not real.

### 6. Inbound has not completed a call end to end yet

The pipeline is proven as far as ringing an agent — live calls have matched a
queue, played the greeting, enqueued, created the agent leg and timed out
correctly. What has not happened yet is an agent ANSWERING one, so bridge,
talk path, hold-music-to-voicemail and transfer are all still unproven against
a real call.

Four bugs were found by those first live tests and fixed, all in the console:
the incoming panel never appeared (the SDK sets `direction` one line AFTER it
dispatches the ringing notification, so it was undefined exactly when we read
it — detection now uses object identity); it never rang (the SDK only plays a
ringtone if the client is given a `ringtoneFile`, so the ring is synthesised in
WebAudio like the DTMF tones); dispositioning an inbound call failed because
`attemptId` was only ever set on the outbound dial paths; and queue hours were
being evaluated in UTC.

A fifth was found by inspection rather than by a call: `dialer_inbound_waiting()`
was `SECURITY INVOKER` over two tables the agent cannot read, so the console's
"calls waiting" poll returned nothing to anybody, ever. Fixed in v553 — see
Phase 8. It is untested against a real queued call for the same reason
everything else here is.

**Watch the 10-minute cache when retesting.** `dialer/index.html` is served
with `Cache-Control: max-age=600`, so a soft refresh can run code up to ten
minutes old. Hard-reload, and confirm a string from the newest change is
actually in the page before concluding anything.

### 7. Disposition consequence flags need a floor review

The v534 vocabulary set `retires_contact` / `schedules_callback` / `creates_lead`
/ `adds_to_dnc` / `marks_invalid` per code from first principles. Whoever runs
the floor should confirm them — these decide whether a contact is ever called
again, so a wrong flag is silent and permanent. Flagged in the v534 header too.

---

## Not built

**The agent screen.** Partly replicated; still missing:

- the colour-coded disposition button grid ("Step 1. Select a call result")
- "Step 2. Confirm follow-up settings" — Save in / Callback time / Use calendar /
  Submit call log
- the script tab with merged contact fields (a `script` column exists and
  renders as plain text)

**Ruled out permanently**, because all three need the SERVER to originate the
call and that would end the one-line-per-agent guarantee that makes the
abandonment rate structurally zero: predictive dialling, answering-machine
detection, voicemail drop. The `amd_enabled` and `recording_enabled` campaign
toggles are disabled in the admin screen for exactly this reason — nothing
reads them.

**From ReadyMode's feature list, still absent:** conference calling,
extensions, forwarding, inbound-agent intercept, appointment calendars, and
supervisor listen / whisper / barge. Warm (consultative) transfer is absent
too — it needs a third leg and a conference, so it is its own piece of work
rather than an extension of the blind transfer that exists.

---

## Traps for whoever works on this next

- **Two repos.** `origin` = `proptechai` (mirror/source). `live` = `Project`,
  which serves `staffportal.proptechnologyai.com` and contains only CNAME,
  `dialer/`, `index.html`, `supabase/`, `sw.js`. Comparing the two with `git log`
  is meaningless; they are different trees. Deploying means pushing to **both**.
- **`.gitignore` is a whitelist** (`/*` then `!/dir/`). A new top-level directory
  is invisible to git until it is added there. This cost a full debugging session
  once.
- **The repo copy of an edge function may be behind live.** Always fetch and diff
  before editing — this has bitten twice, once hiding a same-state DID fallback
  that existed only in production.
- **Deploys are transcription.** There is no Supabase CLI auth on this machine, so
  functions deploy by sending the file through the API. Verify after; don't assume.
- **`calling_days` is ISO**: Monday is 1 and **Sunday is 7**, not 0. A
  `getDay()`-style 0 silently means "never Sunday".
- **The console shares its session with the portal** via `sessionStorage`
  (per-tab) and `flowType: 'implicit'`. It must match the portal's client config
  exactly, or the agent is told they are not signed in.
- **GitHub Pages lags ~40s** behind a push. A "it didn't deploy" report inside a
  minute is usually just cache.

---

## How this file was verified

Re-run these rather than trusting the date at the top.

```bash
git log --oneline origin/main..HEAD

curl -s https://staffportal.proptechnologyai.com/dialer/index.html | tr -d '\r' | md5sum
tr -d '\r' < dialer/index.html | md5sum
```

```sql
select version, name from supabase_migrations.schema_migrations
where name ~* 'dialer' order by version desc;

select proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and proname like 'dialer%' order by 1;
```
