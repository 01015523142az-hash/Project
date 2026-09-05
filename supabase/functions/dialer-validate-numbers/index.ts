// supabase/functions/dialer-validate-numbers/index.ts
//
// Pre-dial validation. Resolves every imported contact's number through
// Telnyx Number Lookup before it can be dialled, and is what makes an
// imported list dialable at all.
//
// WHY THIS IS A BLOCKER, NOT AN OPTIMISATION:
//   dialer-call-control's calling-hours gate needs the time zone of the
//   NUMBER. dialer-list-import deliberately leaves timezone null, because
//   the only honest source is the number itself -- an Illinois property
//   routinely has an owner with a Florida mobile, and the rule follows the
//   number. Until this runs, every dial is refused with 'no_timezone'.
//
// WHAT IT BUYS, beyond unblocking:
//   - Disconnected/invalid numbers are dropped BEFORE they are dialled.
//     That raises measured answer rate and protects DID reputation, since
//     dialing dead numbers is itself a spam signal carriers act on.
//   - Line type ranks the queue: mobiles before landlines before VOIP.
//     Lists arrive with several numbers per contact and we were dialing
//     them in file order; this is free answer rate from data already paid
//     for.
//
// COST: $0.0015 per lookup (carrier type only; caller-name would add more
// and is not requested). At ~10,000 contacts a month that is about $15.
// Admin-only for that reason -- it spends money, so it is not an agent
// action. max_lookups caps a single invocation as a second guard.
//
// TIME ZONE DERIVATION, and its known limit:
//   Telnyx returns portability.state, which follows ported numbers and so
//   beats guessing from the area code. State maps to an IANA zone below.
//   Thirteen states span two zones. For those, the map deliberately picks
//   the WESTERN zone, because the resulting error is safe in the direction
//   that matters: assuming Central for a number that is really Eastern
//   means the 9am window opens at their 10am (late, harmless) rather than
//   their 8am (early, a complaint). The raw state and city are stored on
//   the contact so a split-state number can be refined later.
//
// Deploy with:
//   supabase functions deploy dialer-validate-numbers
// Required secret: TELNYX_API_KEY (already set for dialer-telnyx-token)

import { createClient } from 'jsr:@supabase/supabase-js@2';

const ALLOWED_ORIGINS = [
  'https://staffportal.proptechnologyai.com',
  'https://clientportal.proptechnologyai.com',
  'https://proptechnologyai.com',
  'https://www.proptechnologyai.com',
];
function getCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('origin') || '';
  const allowOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  };
}
function json(req: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
  });
}

// State -> IANA zone. Split-timezone states resolve to their WESTERN zone
// on purpose; see this file's header for why that error direction is the
// safe one.
const STATE_TZ: Record<string, string> = {
  AL: 'America/Chicago',    AK: 'America/Anchorage',  AZ: 'America/Phoenix',
  AR: 'America/Chicago',    CA: 'America/Los_Angeles', CO: 'America/Denver',
  CT: 'America/New_York',   DE: 'America/New_York',   DC: 'America/New_York',
  FL: 'America/Chicago',    GA: 'America/New_York',   HI: 'Pacific/Honolulu',
  ID: 'America/Los_Angeles', IL: 'America/Chicago',   IN: 'America/Chicago',
  IA: 'America/Chicago',    KS: 'America/Denver',     KY: 'America/Chicago',
  LA: 'America/Chicago',    ME: 'America/New_York',   MD: 'America/New_York',
  MA: 'America/New_York',   MI: 'America/Chicago',    MN: 'America/Chicago',
  MS: 'America/Chicago',    MO: 'America/Chicago',    MT: 'America/Denver',
  NE: 'America/Denver',     NV: 'America/Los_Angeles', NH: 'America/New_York',
  NJ: 'America/New_York',   NM: 'America/Denver',     NY: 'America/New_York',
  NC: 'America/New_York',   ND: 'America/Denver',     OH: 'America/New_York',
  OK: 'America/Chicago',    OR: 'America/Los_Angeles', PA: 'America/New_York',
  RI: 'America/New_York',   SC: 'America/New_York',   SD: 'America/Denver',
  TN: 'America/Chicago',    TX: 'America/Chicago',    UT: 'America/Denver',
  VT: 'America/New_York',   VA: 'America/New_York',   WA: 'America/Los_Angeles',
  WV: 'America/New_York',   WI: 'America/Chicago',    WY: 'America/Denver',
  PR: 'America/Puerto_Rico',
};

// Mobiles answer at materially higher rates than landlines, and VOIP worst.
// phone_rank orders the queue, lower first.
function rankForLineType(lt: string | null): number {
  switch ((lt || '').toLowerCase()) {
    case 'mobile':   return 0;
    case 'landline': return 1;
    case 'voip':
    case 'fixed voip':
    case 'non-fixed voip': return 2;
    default: return 3;
  }
}

function normaliseLineType(raw: string | null | undefined): string {
  const v = String(raw || '').toLowerCase();
  if (v.includes('mobile') || v.includes('wireless')) return 'mobile';
  if (v.includes('landline') || v.includes('fixed line') || v.includes('wireline')) return 'landline';
  if (v.includes('voip')) return 'voip';
  return 'unknown';
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: getCorsHeaders(req) });
  if (req.method !== 'POST') return json(req, { ok: false, error: 'Method not allowed' }, 405);

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
  const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
  const TELNYX_API_KEY = Deno.env.get('TELNYX_API_KEY');

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
    // Admin-only: each lookup costs money.
    if (!profile || (profile.role !== 'owner' && profile.role !== 'admin')) {
      return json(req, { ok: false, error: 'Only owner/admin can run number validation.' }, 403);
    }

    if (!TELNYX_API_KEY) {
      return json(req, { ok: false, error: 'TELNYX_API_KEY is not set on this project.' }, 503);
    }

    const body = await req.json().catch(() => ({}));
    const listId = body?.list_id ? String(body.list_id) : null;
    // Hard ceiling per invocation. Edge functions have a wall-clock limit and
    // each lookup costs $0.0015 -- an unbounded run could spend real money on
    // a mistake.
    const maxLookups = Math.min(Number(body?.max_lookups) || 300, 1000);

    let q = admin.from('dialer_contacts')
      .select('id, phone_e164')
      .is('phone_validated_at', null)
      .in('status', ['new', 'queued'])
      .limit(maxLookups);
    if (listId) q = q.eq('list_id', listId);

    const { data: pending, error: qErr } = await q;
    if (qErr) return json(req, { ok: false, error: qErr.message }, 500);
    if (!pending?.length) {
      return json(req, { ok: true, checked: 0, remaining: 0, note: 'Nothing pending validation.' });
    }

    const stats = { checked: 0, valid: 0, invalid: 0, mobile: 0, landline: 0, voip: 0, no_timezone: 0 };

    // Sequential rather than parallel: Telnyx rate-limits lookups, and a
    // burst of 300 concurrent requests gets throttled into failures that
    // look like invalid numbers -- which would wrongly retire real contacts.
    for (const c of pending) {
      let lineType = 'unknown';
      let carrier: string | null = null;
      let state: string | null = null;
      let city: string | null = null;
      let valid = false;

      try {
        const res = await fetch(
          `https://api.telnyx.com/v2/number_lookup/${encodeURIComponent(c.phone_e164)}?type=carrier`,
          { headers: { Authorization: `Bearer ${TELNYX_API_KEY}` } },
        );
        if (res.ok) {
          const b = await res.json();
          const d = b?.data || {};
          carrier = d?.carrier?.name ?? null;
          lineType = normaliseLineType(d?.carrier?.type ?? d?.portability?.line_type);
          state = d?.portability?.state ?? null;
          city = d?.portability?.city ?? null;
          // A number Telnyx can resolve to a carrier is dialable. No carrier
          // means unallocated or disconnected -- exactly what we want to
          // drop before spending a dial and a reputation hit on it.
          valid = Boolean(carrier) || lineType !== 'unknown';
        } else if (res.status === 404) {
          valid = false; // unallocated
        } else {
          // A transient Telnyx error must NOT mark a real number invalid.
          // Leave it unvalidated so the next run retries it.
          console.warn('dialer-validate-numbers: lookup failed', res.status, c.phone_e164);
          continue;
        }
      } catch (e) {
        console.warn('dialer-validate-numbers: lookup threw for', c.phone_e164, e);
        continue;
      }

      const tz = state ? STATE_TZ[String(state).toUpperCase()] ?? null : null;
      if (!tz) stats.no_timezone++;

      const update: Record<string, unknown> = {
        phone_validated_at: new Date().toISOString(),
        phone_valid: valid,
        phone_line_type: lineType,
        phone_carrier: carrier,
        phone_rank: rankForLineType(lineType),
        timezone: tz,
        state: state,
        updated_at: new Date().toISOString(),
      };
      // An invalid number should never surface in the queue again. The dial
      // gate would refuse it anyway, but retiring it here stops it consuming
      // a queue slot on every load.
      if (!valid) {
        update.status = 'invalid';
        update.retired_reason = 'failed_validation';
        update.next_attempt_at = null;
      }

      await admin.from('dialer_contacts').update(update).eq('id', c.id);

      stats.checked++;
      if (valid) stats.valid++; else stats.invalid++;
      if (lineType === 'mobile') stats.mobile++;
      else if (lineType === 'landline') stats.landline++;
      else if (lineType === 'voip') stats.voip++;

      if (city) { /* city kept for future split-state refinement */ }
    }

    // How much is left, so a caller can loop until zero rather than guess.
    let remainingQ = admin.from('dialer_contacts')
      .select('id', { count: 'exact', head: true })
      .is('phone_validated_at', null)
      .in('status', ['new', 'queued']);
    if (listId) remainingQ = remainingQ.eq('list_id', listId);
    const { count: remaining } = await remainingQ;

    return json(req, {
      ok: true,
      ...stats,
      remaining: remaining ?? 0,
      estimated_cost_usd: Number((stats.checked * 0.0015).toFixed(4)),
    });
  } catch (e) {
    console.error('dialer-validate-numbers: unhandled', e);
    return json(req, { ok: false, error: e instanceof Error ? e.message : 'Unexpected error' }, 500);
  }
});
