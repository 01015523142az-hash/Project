// supabase/functions/dialer-call-control/index.ts
//
// The pre-dial gate for the portal dialer. Every outbound call is authorised
// here before the agent's browser is allowed to place it.
//
// WHY THE BROWSER PLACES THE CALL, NOT THIS FUNCTION:
//   At one line per agent (v524 constrains dial_mode to preview|power, never
//   predictive), the agent must already be on the line before the contact's
//   phone rings — that is what makes the structural abandonment rate zero.
//   The simplest way to guarantee that is for the agent's own WebRTC client
//   to originate the call: there is then no window in which a contact can
//   answer with nobody there, because the agent IS the originator.
//
//   So this function does not dial. It decides whether a dial is allowed,
//   picks which DID to use, opens the dialer_attempts row, and hands the
//   browser an approved caller ID. Server-side call origination and bridging
//   would be needed for predictive dialing; it is deliberately absent.
//
// ACTIONS:
//   authorize_dial  — run every gate, reserve a DID, open the CDR row,
//                     return { attempt_id, from_number }
//   attach_call_id  — the console reports the Telnyx call id the SDK gave
//                     it, so dialer-telnyx-webhook can correlate events
//   disposition     — record the outcome, advance the queue, and apply the
//                     disposition's consequences (retire / callback / lead /
//                     DNC / invalid)
//
// THE GATES, in order. Any one of them refuses the dial:
//   0. queue assignment    — the agent must be assigned to this campaign
//                            (v537), and under any per-agent cap on it
//   1. internal DNC        — dialer_dnc (v523), the master list for BOTH
//                            dialers while ReadyMode runs in parallel
//   2. list scrub          — the contact's list must be ReadyMode-scrubbed;
//                            v524 enforces this at status level, re-checked
//                            here because a list can be re-opened
//   3. calling hours       — the campaign window in the CALLED PARTY's time
//                            zone, derived from the number, never from the
//                            property address
//   4. number validity     — pre-dial validation must not have marked it bad
//   5. DID availability    — an active number, under its daily cap, matching
//                            the called area code where possible
//
// v548: a contact can have up to ten numbers (dialer_contact_phones). Gates 1,
// 3, 4 and 5 all apply to the NUMBER being dialled, not to the contact's
// primary — DNC, time zone and area code are properties of a phone line.
//
// Deploy with:
//   supabase functions deploy dialer-call-control
// No Telnyx secrets needed — this function never talks to Telnyx.

import { createClient } from 'jsr:@supabase/supabase-js@2';

// Origin allowlist for this project's own frontends. Duplicated in every
// function that needs it (not imported from a shared file) because
// Supabase's per-function deploy only bundles each function's own
// directory -- a cross-function relative import to _shared/ fails at
// deploy time, same reason readymode-api/readymode-email-import
// duplicate their CSV-parsing code instead of sharing it. Keep in sync
// with supabase/functions/_shared/cors.ts (reference copy) if it changes.
const ALLOWED_ORIGINS = [
  'https://staffportal.proptechnologyai.com',
  'https://clientportal.proptechnologyai.com',
  'https://proptechnologyai.com',
  'https://www.proptechnologyai.com',
  // The dialer consoles get their own ORIGINS so that a bug anywhere in the
  // 2.3MB dashboard cannot read the session that is allowed to place calls:
  // a separate origin is a separate sessionStorage. Both pages gained a
  // sign-in of their own for exactly this, since neither could authenticate
  // anybody before -- they read the portal's session off the shared origin.
  //
  // Additive and inert until those hostnames actually serve something. An
  // origin nobody requests from costs nothing; the reverse -- moving the
  // pages first and finding every function refuses them -- is a bad hour.
  'https://dialer.proptechnologyai.com',
  'https://admin.proptechnologyai.com',
];
function getCorsHeaders(req: Request, opts?: { headers?: string; methods?: string }): Record<string, string> {
  const origin = req.headers.get('origin') || '';
  const allowOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Headers': opts?.headers || 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': opts?.methods || 'POST, OPTIONS',
    'Vary': 'Origin',
  };
}

function json(req: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
  });
}

// A refusal is a normal outcome, not an error — the console shows the
// reason and moves to the next contact. HTTP 200 with allowed:false keeps
// that distinct from a genuine failure.
function refuse(req: Request, reason: string, detail: string) {
  return json(req, { ok: true, allowed: false, reason, detail });
}

const NANP_AREA_CODE = /^\+1(\d{3})/;
function areaCodeOf(e164: string): string | null {
  const m = NANP_AREA_CODE.exec(e164 || '');
  return m ? m[1] : null;
}

// Local time-of-day and ISO weekday for a contact, from an IANA zone.
// Intl is used rather than date arithmetic so DST is handled by the
// platform rather than by us.
function localTimeParts(tz: string): { minutes: number; isoDow: number } | null {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false,
    });
    const parts = fmt.formatToParts(new Date());
    const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? NaN);
    const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? NaN);
    const wd = parts.find((p) => p.type === 'weekday')?.value ?? '';
    const map: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
    if (!Number.isFinite(hour) || !Number.isFinite(minute) || !map[wd]) return null;
    return { minutes: hour * 60 + minute, isoDow: map[wd] };
  } catch {
    return null;
  }
}

function hhmmToMinutes(t: string): number {
  const [h, m] = String(t).split(':');
  return Number(h) * 60 + Number(m || 0);
}

// Manual dial accepts a typed number, so it needs normalising before it
// touches the DNC lookup or the CDR. Queued contacts are already E.164 from
// import, so this is only used on that path.
function toE164(raw: string): string | null {
  const d = String(raw || '').replace(/\D/g, '');
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith('1')) return `+${d}`;
  return null; // not NANP -- do not guess at an international format
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: getCorsHeaders(req) });
  if (req.method !== 'POST') return json(req, { ok: false, error: 'Method not allowed' }, 405);

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
  const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;

  try {
    const authHeader = req.headers.get('Authorization') || '';
    if (!authHeader.startsWith('Bearer ')) {
      return json(req, { ok: false, error: 'Missing Authorization header' }, 401);
    }

    const callerClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userRes } = await callerClient.auth.getUser();
    const caller = userRes?.user;
    if (!caller) return json(req, { ok: false, error: 'Not signed in' }, 401);

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE);

    const { data: profile } = await admin
      .from('profiles').select('role').eq('id', caller.id).maybeSingle();
    if (!profile) return json(req, { ok: false, error: 'Only staff accounts can use the dialer' }, 403);

    if (profile.role !== 'owner' && profile.role !== 'admin') {
      const { data: roleRow } = await admin
        .from('roles').select('can_use_dialer').eq('name', profile.role).maybeSingle();
      if (!roleRow?.can_use_dialer) {
        return json(req, { ok: false, error: "Your role doesn't have permission to use the dialer." }, 403);
      }
    }

    const body = await req.json().catch(() => ({}));
    const action = String(body?.action || '');
    const nowIso = new Date().toISOString();

    // =====================================================================
    // authorize_dial
    // =====================================================================
    if (action === 'authorize_dial') {
      const contactId = body?.contact_id ? String(body.contact_id) : null;
      const phoneIdIn = body?.phone_id ? String(body.phone_id) : null;
      if (!contactId) return json(req, { ok: false, error: 'contact_id is required' }, 400);

      const { data: contact } = await admin
        .from('dialer_contacts')
        // `state` is read by the same-state DID fallback below. It was missing
        // from this select while that fallback was live, so the middle step of
        // the chain could never fire -- every non-exact match fell straight
        // through to "any healthy number".
        .select('id, campaign_id, list_id, phone_e164, timezone, status, phone_valid, attempt_count, property_id, state')
        .eq('id', contactId)
        .maybeSingle();
      if (!contact) return json(req, { ok: false, error: 'Contact not found' }, 404);

      const { data: campaign } = await admin
        .from('dialer_campaigns')
        .select('id, status, dial_mode, calling_window_start, calling_window_end, calling_days, caller_id_strategy, fixed_did_id, max_attempts, fallback_timezone')
        .eq('id', contact.campaign_id)
        .maybeSingle();
      if (!campaign) return json(req, { ok: false, error: 'Campaign not found' }, 404);
      if (campaign.status !== 'active') {
        return refuse(req, 'campaign_inactive', `Campaign is ${campaign.status}.`);
      }

      // ---- gate 0: is this agent assigned to this queue, and under cap? --
      // RLS (v537) already stops an agent READING a queue they are not on.
      // This is the same rule on the write path: authorize_dial runs as the
      // service role, so without an explicit check here a crafted request
      // could open a CDR row and burn a DID slot against a queue the agent
      // has no business working. v538 repeats it as a trigger on the insert
      // itself, so it survives an edit to this file; this copy exists to
      // turn it into a sentence the agent can read instead of a 500.
      const { data: assignment } = await admin
        .from('dialer_campaign_agents')
        .select('is_active, max_calls_per_day, max_contacts')
        .eq('campaign_id', contact.campaign_id)
        .eq('agent_id', caller.id)
        .maybeSingle();

      const privileged = profile.role === 'owner' || profile.role === 'admin';
      if (!privileged && !assignment?.is_active) {
        return refuse(req, 'not_assigned',
          'You are not assigned to this queue. An admin assigns queues.');
      }

      if (assignment?.max_calls_per_day || assignment?.max_contacts) {
        // Counted from the CDR rather than a running total on the assignment
        // row: a counter would drift the first time a write failed, and this
        // is the number a compliance review would recompute anyway.
        const { data: usage } = await admin
          .rpc('dialer_queue_usage', { p_agent: caller.id, p_campaign: contact.campaign_id });
        const u = Array.isArray(usage) ? usage[0] : usage;

        if (assignment.max_calls_per_day && (u?.calls_today ?? 0) >= assignment.max_calls_per_day) {
          return refuse(req, 'agent_daily_cap',
            `You have reached your daily limit of ${assignment.max_calls_per_day} calls on this queue.`);
        }
        // Only bites on a contact this agent has not touched before, or the
        // cap would strand them mid-conversation on a callback.
        if (assignment.max_contacts && (u?.contacts_taken ?? 0) >= assignment.max_contacts) {
          const { count: seen } = await admin
            .from('dialer_attempts').select('id', { count: 'exact', head: true })
            .eq('agent_id', caller.id).eq('contact_id', contact.id);
          if ((seen ?? 0) === 0) {
            return refuse(req, 'agent_contact_cap',
              `You have reached your limit of ${assignment.max_contacts} contacts on this queue.`);
          }
        }
      }

      // ---- which NUMBER are we ringing? (v548) ---------------------------
      // A skip-traced seller has up to ten. The console reports which one it
      // means, but the choice is re-resolved here: a phone_id from the client
      // is a claim, and it must belong to this contact and still be dialable.
      // With no phone_id (an older console, or a contact with no phone rows)
      // this falls back to the contact's own primary number, so the function
      // keeps working exactly as it did before.
      let phoneRow: any = null;
      if (phoneIdIn) {
        const { data: p } = await admin
          .from('dialer_contact_phones')
          .select('id, rank, label, phone_e164, status, timezone, phone_valid, contact_id')
          .eq('id', phoneIdIn).eq('contact_id', contact.id).maybeSingle();
        if (!p) return refuse(req, 'phone_not_on_contact', 'That number does not belong to this contact.');
        phoneRow = p;
      } else {
        const { data: nx } = await admin
          .rpc('dialer_next_number', { p_contact: contact.id });
        const n = Array.isArray(nx) ? nx[0] : nx;
        if (n) {
          const { data: p } = await admin
            .from('dialer_contact_phones')
            .select('id, rank, label, phone_e164, status, timezone, phone_valid, contact_id')
            .eq('id', n.phone_id).maybeSingle();
          phoneRow = p ?? null;
        }
      }

      // Everything downstream gates on the number actually being dialled.
      const dialNumber: string = phoneRow?.phone_e164 ?? contact.phone_e164;
      // The chain, most specific first: this line's own zone, then the
      // contact's, then the campaign's fallback (v564) for an area code
      // v560's table could not place. The fallback is a campaign POLICY and
      // is never written onto the contact -- doing so would make a guess
      // look like a resolved fact and would survive a later real lookup.
      const resolvedTimezone: string | null = phoneRow?.timezone ?? contact.timezone;
      const usingFallback = !resolvedTimezone && Boolean(campaign.fallback_timezone);
      const dialTimezone: string | null =
        resolvedTimezone ?? (campaign.fallback_timezone as string | null) ?? null;

      if (phoneRow && ['exhausted', 'dnc', 'invalid', 'wrong_person'].includes(phoneRow.status)) {
        return refuse(req, 'number_' + phoneRow.status,
          `${phoneRow.label} is ${phoneRow.status.replace('_', ' ')}.`);
      }
      if (phoneRow && phoneRow.phone_valid === false) {
        return refuse(req, 'invalid_number', `${phoneRow.label} was marked invalid by validation.`);
      }

      // ---- gate 1: internal do-not-call ---------------------------------
      // Any row at all means suppressed. dialer_dnc is append-only evidence
      // and is the master list for both dialers — see v523's header.
      //
      // Checked against the NUMBER being dialled. Suppression attaches to a
      // phone line, not to a person: one of a seller's ten numbers being on
      // the list says nothing about the other nine, and blocking the contact
      // outright would be as wrong as ignoring it.
      const { count: dncCount } = await admin
        .from('dialer_dnc')
        .select('id', { count: 'exact', head: true })
        .eq('phone_e164', dialNumber);
      if ((dncCount ?? 0) > 0) {
        if (phoneRow) {
          // Retire the LINE, not the person. The other numbers stay workable,
          // and the console will move to the next rank on its own.
          await admin.from('dialer_contact_phones')
            .update({ status: 'dnc', next_attempt_at: null, updated_at: nowIso })
            .eq('id', phoneRow.id);
        } else {
          await admin.from('dialer_contacts')
            .update({ status: 'suppressed', retired_reason: 'internal_dnc', updated_at: nowIso })
            .eq('id', contact.id);
        }
        return refuse(req, 'dnc', 'That number is on the internal do-not-call list.');
      }

      // ---- gate 2: the list must have been scrubbed in ReadyMode --------
      const { data: list } = await admin
        .from('dialer_lists')
        .select('id, status, readymode_scrubbed_at')
        .eq('id', contact.list_id)
        .maybeSingle();
      if (!list?.readymode_scrubbed_at) {
        return refuse(req, 'list_not_scrubbed',
          'This list has no ReadyMode scrub on record and cannot be dialled.');
      }

      // ---- gate 3: calling hours, in the CALLED PARTY's zone ------------
      // Derived from the number's own zone. An Illinois property routinely
      // has an owner whose mobile is a Florida number, and the rule follows
      // the number.
      if (!dialTimezone) {
        return refuse(req, 'no_timezone',
          'No time zone resolved for this number, and this campaign has no fallback '
          + 'zone set, so calling hours cannot be checked.');
      }
      // Worth a log line rather than being silent: a campaign leaning on the
      // fallback for a large share of its dials means the area-code table is
      // missing something real, and that is a table to fix, not a setting to
      // keep relying on.
      if (usingFallback) {
        console.warn('dialer-call-control: dialing', dialNumber,
                     'on campaign fallback zone', dialTimezone,
                     '- no zone resolved from the number itself');
      }
      const local = localTimeParts(dialTimezone);
      if (!local) {
        return refuse(req, 'bad_timezone', `Unrecognised time zone "${dialTimezone}".`);
      }
      const days: number[] = Array.isArray(campaign.calling_days) ? campaign.calling_days : [];
      if (!days.includes(local.isoDow)) {
        return refuse(req, 'outside_calling_days', 'Outside this campaign\'s calling days for that number.');
      }
      const startMin = hhmmToMinutes(campaign.calling_window_start as string);
      const endMin = hhmmToMinutes(campaign.calling_window_end as string);
      if (local.minutes < startMin || local.minutes >= endMin) {
        return refuse(req, 'outside_calling_hours',
          `Local time for that number is outside ${campaign.calling_window_start}–${campaign.calling_window_end}.`);
      }

      // ---- gate 4: the number itself ------------------------------------
      // contact.phone_valid describes the PRIMARY number only. Once a contact
      // has alternates it must not gate them: a dead primary is the ordinary
      // reason to be ringing Ph#2 in the first place. The number actually
      // being dialled was validity-checked above, off phoneRow.
      if (!phoneRow && contact.phone_valid === false) {
        return refuse(req, 'invalid_number', 'Pre-dial validation marked this number invalid.');
      }
      if (contact.status === 'retired' || contact.status === 'suppressed' || contact.status === 'invalid') {
        return refuse(req, 'contact_' + contact.status, `Contact is ${contact.status}.`);
      }
      if ((contact.attempt_count ?? 0) >= (campaign.max_attempts ?? 6)) {
        await admin.from('dialer_contacts')
          .update({ status: 'retired', retired_reason: 'max_attempts', updated_at: nowIso })
          .eq('id', contact.id);
        return refuse(req, 'max_attempts', 'Maximum attempts reached for this contact.');
      }

      // ---- gate 5: pick a DID -------------------------------------------
      // Local presence first, then any healthy pool number. Daily caps are
      // enforced here rather than by a scheduled job, and dials_today is
      // reset lazily by comparing dials_today_date (v523).
      const today = nowIso.slice(0, 10);
      // Local presence matches the number being dialled, not the contact's
      // primary — a seller's second line is often in a different area code.
      const wantedAreaCode = areaCodeOf(dialNumber);

      let didQuery = admin.from('dialer_dids')
        .select('id, phone_e164, area_code, state, daily_cap, dials_today, dials_today_date')
        .eq('status', 'active');
      if (campaign.caller_id_strategy === 'fixed' && campaign.fixed_did_id) {
        didQuery = didQuery.eq('id', campaign.fixed_did_id);
      }
      const { data: dids } = await didQuery;

      const usable = (dids || []).filter((d: any) => {
        const used = d.dials_today_date === today ? (d.dials_today ?? 0) : 0;
        return used < (d.daily_cap ?? 80);
      });
      if (!usable.length) {
        return refuse(req, 'no_did_available',
          'No caller ID is available — the pool is exhausted, resting, or at its daily cap.');
      }

      // Nationwide fallback chain: exact area code, then same state, then any
      // healthy number. A sparse pool spread across the country makes the
      // middle step matter -- calling a 206 from a 425 reads local, from a
      // 305 it does not. contact.state is written by pre-dial validation.
      let chosen = usable[0];
      if (campaign.caller_id_strategy !== 'fixed') {
        const exact = wantedAreaCode ? usable.find((d: any) => d.area_code === wantedAreaCode) : null;
        const sameState = (contact as any).state
          ? usable.find((d: any) => d.state && d.state === (contact as any).state) : null;
        chosen = exact ?? sameState ?? usable[0];
      }

      // ---- open the CDR row ---------------------------------------------
      const { data: attempt, error: attErr } = await admin
        .from('dialer_attempts')
        .insert({
          campaign_id: contact.campaign_id,
          contact_id: contact.id,
          agent_id: caller.id,
          property_id: contact.property_id,
          from_did_id: chosen.id,
          from_number: chosen.phone_e164,
          to_number: dialNumber,
          phone_id: phoneRow?.id ?? null,
          direction: 'outbound',
          status: 'initiated',
        })
        .select('id')
        .single();
      if (attErr || !attempt) {
        console.error('dialer-call-control: could not open attempt row', attErr?.message);
        return json(req, { ok: false, error: 'Could not open a call record.' }, 500);
      }

      // Reserve the DID's capacity now, not on hangup — an authorised dial
      // consumes a slot even if the agent abandons before connecting, which
      // is the conservative direction for reputation.
      const usedToday = chosen.dials_today_date === today ? (chosen.dials_today ?? 0) : 0;
      await admin.from('dialer_dids')
        .update({ dials_today: usedToday + 1, dials_today_date: today, updated_at: nowIso })
        .eq('id', chosen.id);

      await admin.from('dialer_contacts')
        .update({
          status: 'in_progress',
          attempt_count: (contact.attempt_count ?? 0) + 1,
          last_attempt_at: nowIso,
          updated_at: nowIso,
        })
        .eq('id', contact.id);

      // The number's own counter moves HERE, at the moment the call is
      // authorised, for the same reason the contact's does: a call whose tab
      // died before wrap-up still consumed an attempt on that line, and
      // counting it at disposition time would silently miss exactly those.
      if (phoneRow) {
        await admin.rpc('dialer_bump_number_attempt', { p_phone: phoneRow.id });
      }

      return json(req, {
        ok: true,
        allowed: true,
        attempt_id: attempt.id,
        from_number: chosen.phone_e164,
        to_number: dialNumber,
        phone_id: phoneRow?.id ?? null,
        phone_label: phoneRow?.label ?? null,
      });
    }

    // =====================================================================
    // manual_dial — agent types a number that is not in any queue
    // =====================================================================
    // WHAT IS AND IS NOT ENFORCED, and why:
    //   internal DNC   ENFORCED, absolutely. Someone who told us never to
    //                  call again is owed that regardless of how the number
    //                  was reached.
    //   calling hours  NOT CHECKED — a deliberate policy decision. There is
    //                  no contact row to read a time zone from, and rather
    //                  than resolve one inline the agent judges local time.
    //                  This moves a hard 8am-9pm TSR limit from the system
    //                  to a human, so it is recorded rather than implied:
    //                  hours_checked is written false (v527b) and the
    //                  console makes the agent acknowledge it per call.
    //                  Every unchecked call is one index scan away.
    //   list scrub     SKIPPED, deliberately. A human deciding to call one
    //                  specific person — a callback, an inbound follow-up —
    //                  is a different posture from working a cold list.
    //                  dialer_attempts.is_manual (v527) records the
    //                  exception so a compliance review can find every call
    //                  that went out without a list scrub behind it.
    //   assignment     NOT CHECKED. Manual dial is the explicit human
    //                  exception; v538's trigger exempts it for the same
    //                  reason, and is_manual keeps it auditable.
    //   DID + caps     ENFORCED, same as any dial.
    if (action === 'manual_dial') {
      const raw = body?.to ? String(body.to) : '';
      const campaignId = body?.campaign_id ? String(body.campaign_id) : null;

      const to = toE164(raw);
      if (!to) return json(req, { ok: false, error: 'Enter a valid 10-digit US number.' }, 400);

      // ---- may this agent manual-dial at all, and how much? (v569) --------
      // FIRST, before the DNC lookup, for two reasons. It is the cheapest
      // refusal, and somebody who may not manual-dial should not be able to
      // use this endpoint to probe whether a given number is on our DNC list.
      //
      // Two controls, because they stop different things. can_manual_dial
      // decides who holds the widest door in the dialer -- this action skips
      // calling hours, the list scrub and campaign assignment by design, so a
      // session that has it can reach any non-DNC US number. The daily cap is
      // what bounds a STOLEN session, which a role check cannot: the thief
      // holds the role.
      const { data: gateRows, error: gateErr } = await admin
        .rpc('dialer_manual_dial_allowed', { p_agent: caller.id });
      const gate = Array.isArray(gateRows) ? gateRows[0] : gateRows;

      // Fail CLOSED. If the gate itself cannot be evaluated we do not know
      // whether this dial is allowed, and guessing "yes" on the one action
      // that reaches arbitrary numbers is the wrong way to be wrong.
      if (gateErr || !gate) {
        console.error('manual_dial: gate check failed', gateErr?.message);
        return json(req, { ok: false, error: 'Could not check your manual-dial permission.' }, 500);
      }
      if (!gate.allowed) {
        return refuse(req, gate.reason === 'daily_cap' ? 'manual_dial_cap' : 'manual_dial_denied',
          gate.reason === 'daily_cap'
            ? `Manual dial limit reached: ${gate.used} of ${gate.cap} today.`
            : 'Your role cannot dial numbers outside a queue.');
      }

      // ---- internal DNC --------------------------------------------------
      const { count: dncCount } = await admin
        .from('dialer_dnc').select('id', { count: 'exact', head: true }).eq('phone_e164', to);
      if ((dncCount ?? 0) > 0) {
        return refuse(req, 'dnc', 'This number is on the internal do-not-call list.');
      }

      // ---- calling hours: NOT checked, by policy -------------------------
      // See this action's header. The agent is acknowledging responsibility
      // for local time in the console; the exception is recorded on the CDR
      // below via hours_checked=false rather than left implicit.
      let campaignRow: any = null;
      if (campaignId) {
        const { data: c } = await admin.from('dialer_campaigns')
          .select('id, caller_id_strategy, fixed_did_id')
          .eq('id', campaignId).maybeSingle();
        campaignRow = c ?? null;
      }

      // ---- DID selection, same rules as a queued dial ---------------------
      const today = nowIso.slice(0, 10);
      const wantedAreaCode = areaCodeOf(to);
      let didQuery = admin.from('dialer_dids')
        .select('id, phone_e164, area_code, state, daily_cap, dials_today, dials_today_date')
        .eq('status', 'active');
      if (campaignRow?.caller_id_strategy === 'fixed' && campaignRow?.fixed_did_id) {
        didQuery = didQuery.eq('id', campaignRow.fixed_did_id);
      }
      const { data: dids } = await didQuery;
      const usable = (dids || []).filter((d: any) => {
        const used = d.dials_today_date === today ? (d.dials_today ?? 0) : 0;
        return used < (d.daily_cap ?? 80);
      });
      if (!usable.length) {
        return refuse(req, 'no_did_available', 'No caller ID is available right now.');
      }
      // Nationwide local presence: exact area code, else any healthy number.
      // Without a resolved state for the called party there is no same-state
      // middle step here, unlike a queued dial.
      const chosen = usable.find((d: any) => d.area_code === wantedAreaCode) ?? usable[0];

      const { data: attempt, error: attErr } = await admin.from('dialer_attempts').insert({
        campaign_id: campaignId,
        contact_id: null,
        agent_id: caller.id,
        from_did_id: chosen.id,
        from_number: chosen.phone_e164,
        to_number: to,
        direction: 'outbound',
        status: 'initiated',
        is_manual: true,
        // The whole point of v527b: an unchecked call must be findable.
        hours_checked: false,
      }).select('id').single();
      if (attErr || !attempt) {
        console.error('manual_dial: could not open attempt row', attErr?.message);
        return json(req, { ok: false, error: 'Could not open a call record.' }, 500);
      }

      const usedToday = chosen.dials_today_date === today ? (chosen.dials_today ?? 0) : 0;
      await admin.from('dialer_dids')
        .update({ dials_today: usedToday + 1, dials_today_date: today, updated_at: nowIso })
        .eq('id', chosen.id);

      return json(req, {
        ok: true, allowed: true,
        attempt_id: attempt.id,
        from_number: chosen.phone_e164,
        to_number: to,
        manual: true,
      });
    }

    // =====================================================================
    // attach_call_id — correlate the browser's call with the CDR row
    // =====================================================================
    // The SDK gives the console a Telnyx call id once the call is placed.
    // Reporting it here is what lets dialer-telnyx-webhook find the row.
    // If the console never reports (tab crashed mid-dial), the webhook
    // falls back to matching on to_number within a recent window.
    if (action === 'attach_call_id') {
      const attemptId = body?.attempt_id ? String(body.attempt_id) : null;
      const callId = body?.provider_call_id ? String(body.provider_call_id) : null;
      if (!attemptId || !callId) {
        return json(req, { ok: false, error: 'attempt_id and provider_call_id are required' }, 400);
      }

      const { error } = await admin
        .from('dialer_attempts')
        .update({ provider_call_id: callId })
        .eq('id', attemptId)
        .eq('agent_id', caller.id); // an agent may only annotate their own call
      if (error) return json(req, { ok: false, error: error.message }, 500);

      return json(req, { ok: true });
    }

    // =====================================================================
    // disposition — record the outcome and apply its consequences
    // =====================================================================
    if (action === 'disposition') {
      const attemptId = body?.attempt_id ? String(body.attempt_id) : null;
      const code = body?.code ? String(body.code) : null;
      const callbackAt = body?.callback_at ? String(body.callback_at) : null;
      const note = body?.note ? String(body.note) : null;
      if (!attemptId || !code) {
        return json(req, { ok: false, error: 'attempt_id and code are required' }, 400);
      }

      const { data: disp } = await admin
        .from('dialer_dispositions')
        .select('code, category, retires_contact, schedules_callback, creates_lead, adds_to_dnc, marks_invalid')
        .eq('code', code).eq('is_active', true)
        .maybeSingle();
      if (!disp) return json(req, { ok: false, error: `Unknown disposition "${code}"` }, 400);

      const { data: attempt } = await admin
        .from('dialer_attempts')
        .select('id, contact_id, campaign_id, to_number, agent_id, recording_path, property_id, phone_id')
        .eq('id', attemptId)
        .maybeSingle();
      if (!attempt) return json(req, { ok: false, error: 'Attempt not found' }, 404);

      await admin.from('dialer_attempts')
        .update({ disposition: disp.code }).eq('id', attempt.id);

      // ---- consequences --------------------------------------------------
      const contactUpdate: Record<string, unknown> = {
        last_outcome: disp.code,
        updated_at: nowIso,
      };

      if (disp.marks_invalid) {
        contactUpdate.status = 'invalid';
        contactUpdate.phone_valid = false;
        contactUpdate.retired_reason = 'invalid_number';
        contactUpdate.next_attempt_at = null;
      } else if (disp.adds_to_dnc) {
        contactUpdate.status = 'suppressed';
        contactUpdate.retired_reason = 'internal_dnc';
        contactUpdate.next_attempt_at = null;
      } else if (disp.retires_contact) {
        contactUpdate.status = 'retired';
        contactUpdate.retired_reason = disp.code;
        contactUpdate.next_attempt_at = null;
      } else if (disp.schedules_callback && callbackAt) {
        contactUpdate.status = 'queued';
        contactUpdate.next_attempt_at = callbackAt;
      } else {
        // No-contact outcomes go back in the queue on the campaign's own
        // cadence, offset so successive attempts do not all land at the same
        // hour of day (vary_time_of_day) — the cadence lever from the plan.
        const { data: camp } = await admin
          .from('dialer_campaigns')
          .select('min_hours_between_attempts, vary_time_of_day')
          .eq('id', attempt.campaign_id).maybeSingle();
        const gapHours = camp?.min_hours_between_attempts ?? 24;
        const jitterHours = camp?.vary_time_of_day ? (Math.random() * 6 - 3) : 0;
        contactUpdate.status = 'queued';
        contactUpdate.next_attempt_at =
          new Date(Date.now() + (gapHours + jitterHours) * 3600 * 1000).toISOString();
      }

      if (attempt.contact_id) {
        await admin.from('dialer_contacts').update(contactUpdate).eq('id', attempt.contact_id);
      }

      // v548: record the outcome against the NUMBER, and open the next-ranked
      // one. Which outcomes retire a line is deliberately narrower than which
      // retire a contact: marks_invalid and adds_to_dnc are facts about this
      // phone line, and 'wrong_person' means we reached someone else on it --
      // all three are terminal for the line. A retires_contact outcome (not
      // interested, do not call back) is a decision by the PERSON, so the
      // contact is retired above and the line does not need its own verdict.
      if (attempt.phone_id) {
        const terminalForLine = Boolean(
          disp.marks_invalid || disp.adds_to_dnc || disp.code === 'wrong_person');
        await admin.rpc('dialer_advance_number', {
          p_phone: attempt.phone_id,
          p_outcome: disp.code,
          p_terminal: terminalForLine,
        });
      }

      // Suppression is permanent evidence and applies to EVERY campaign,
      // unlike retiring which only stops this one. synced_to_readymode_at
      // stays null so it shows up on the manual export worklist — TPI posts
      // leads, not DNC entries, so there is no API to close this loop.
      if (disp.adds_to_dnc) {
        await admin.from('dialer_dnc').insert({
          phone_e164: attempt.to_number,
          source: 'portal_agent',
          reason: note || disp.code,
          suppressed_by: caller.id,
          attempt_id: attempt.id,
        });
      }

      // A disposition flagged creates_lead is the whole point of the call —
      // write it into the SAME `leads` table every other channel uses, so it
      // lands in the existing review workflow (status defaults to 'pending')
      // rather than in a parallel dialer-only world.
      //
      // Column conventions matched against live rows: seller_phone is the
      // formatted display string, seller_phone_norm is bare 10 digits (that
      // is what lookups join on), and provenance goes in extra_fields under
      // form_* keys. form_source distinguishes dialer leads from the
      // existing 'call-marketing' ones so reporting can separate them.
      let leadId: string | null = null;
      if (disp.creates_lead) {
        const digits = String(attempt.to_number || '').replace(/\D/g, '');
        const ten = digits.length > 10 ? digits.slice(-10) : digits;
        const pretty = ten.length === 10
          ? `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}`
          : attempt.to_number;

        let contactName: string | null = null;
        if (attempt.contact_id) {
          const { data: c } = await admin.from('dialer_contacts')
            .select('contact_name').eq('id', attempt.contact_id).maybeSingle();
          contactName = c?.contact_name ?? null;
        }

        const { data: lead, error: leadErr } = await admin.from('leads').insert({
          user_id: caller.id,
          seller_investor_name: contactName,
          seller_phone: pretty,
          seller_phone_norm: ten,
          extra_fields: {
            form_source: 'portal-dialer',
            form_conversation_notes: note || null,
            dialer_attempt_id: attempt.id,
            dialer_campaign_id: attempt.campaign_id,
            dialer_disposition: disp.code,
            property_id: attempt.property_id,
            record_link: attempt.recording_path || null,
          },
        }).select('id').single();

        if (leadErr) {
          // Do NOT fail the whole disposition: the call is over, the CDR and
          // queue state are already correct, and losing those to a lead
          // insert error would be worse. Surface it so the agent knows to
          // raise it rather than assuming the lead exists.
          console.error('dialer-call-control: lead insert failed', leadErr.message);
          return json(req, {
            ok: true,
            applied: disp.code,
            warning: 'Disposition saved, but the lead could not be created. Report this — the call is recorded but no lead exists.',
          });
        }
        leadId = lead?.id ?? null;

        // Link the contact back to the lead it produced, so re-work lists
        // and reporting can trace a lead to the call that made it.
        if (attempt.contact_id && leadId) {
          await admin.from('dialer_contacts')
            .update({ lead_id: leadId }).eq('id', attempt.contact_id);
        }
      }

      return json(req, { ok: true, applied: disp.code, lead_id: leadId });
    }

    return json(req, { ok: false, error: `Unknown action "${action}"` }, 400);
  } catch (e) {
    console.error('dialer-call-control: unhandled', e);
    return json(req, { ok: false, error: e instanceof Error ? e.message : 'Unexpected error' }, 500);
  }
});
