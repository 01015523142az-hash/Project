// supabase/functions/dialer-pool/index.ts
//
// DID pool management: see where the queue actually is, search Telnyx for
// numbers in those area codes, buy them, and manage their status.
//
// ADMIN-ONLY, and not for the usual "admins configure things" reason --
// order_numbers SPENDS MONEY on a live carrier account. Every action here is
// gated on owner/admin, and ordering is additionally capped per call.
//
// ACTIONS:
//   coverage_gaps  — queued contacts per area code vs DIDs owned there.
//                    Turns nationwide DID buying from guesswork into a
//                    ranked list of what to buy next.
//   search_numbers — Telnyx availability for one area code
//   order_numbers  — buy specific numbers, attach them to the voice
//                    connection, and record them in dialer_dids
//   sync_dids      — reconcile dialer_dids against what Telnyx says we own
//   set_did_status — active / resting / quarantined / retired
//
// WHY sync_dids EXISTS: numbers can be bought or released in the Telnyx
// portal directly. If dialer_dids drifts, gate 5 either offers a caller ID
// we no longer own (calls fail) or ignores one we do (wasted rental). This
// is the reconciliation.
//
// Deploy with:
//   supabase functions deploy dialer-pool
// Required secrets: TELNYX_API_KEY, TELNYX_CREDENTIAL_CONNECTION_ID

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

const TELNYX_API = 'https://api.telnyx.com/v2';
const npaOf = (e164: string) => {
  const m = /^\+1(\d{3})/.exec(e164 || '');
  return m ? m[1] : null;
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: getCorsHeaders(req) });
  if (req.method !== 'POST') return json(req, { ok: false, error: 'Method not allowed' }, 405);

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
  const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
  const TELNYX_API_KEY = Deno.env.get('TELNYX_API_KEY');
  const CONNECTION_ID = Deno.env.get('TELNYX_CREDENTIAL_CONNECTION_ID');

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
    if (!profile) return json(req, { ok: false, error: 'Only staff accounts can use the dialer.' }, 403);

    // Three tiers (v529). The page hides buttons; THIS is the boundary.
    //   isOwnerAdmin — everything, including ordering, which charges a live
    //                  carrier account
    //   canManage    — runs the floor: search, sync, activate/rest. Never buys.
    //   canReview    — looks. Quality needs to see the pool and coverage
    //                  without any ability to change either.
    const isOwnerAdmin = profile.role === 'owner' || profile.role === 'admin';
    let canManage = isOwnerAdmin;
    let canReview = isOwnerAdmin;
    if (!isOwnerAdmin) {
      const { data: r } = await admin.from('roles')
        .select('can_manage_dialer, can_review_calls').eq('name', profile.role).maybeSingle();
      canManage = !!r?.can_manage_dialer;
      canReview = canManage || !!r?.can_review_calls;
    }
    if (!canReview) {
      return json(req, { ok: false, error: 'You do not have access to the dialer number pool.' }, 403);
    }

    const body = await req.json().catch(() => ({}));
    const action = String(body?.action || '');

    // Read-only actions are open to reviewers; everything that changes state
    // needs canManage; buying needs owner/admin. Enumerated rather than
    // inferred, so adding an action later fails closed instead of open.
    const READ_ONLY = new Set(['coverage_gaps', 'list_dids']);
    if (!READ_ONLY.has(action) && !canManage) {
      return json(req, { ok: false, error: 'Read-only access — you cannot change the number pool.' }, 403);
    }
    if (action === 'order_numbers' && !isOwnerAdmin) {
      return json(req, {
        ok: false,
        error: 'Ordering numbers is owner/admin only — it charges the carrier account.',
      }, 403);
    }
    const nowIso = new Date().toISOString();

    const telnyxHeaders = {
      Authorization: `Bearer ${TELNYX_API_KEY}`,
      'Content-Type': 'application/json',
    };
    const needTelnyx = () => {
      if (!TELNYX_API_KEY) {
        return json(req, { ok: false, error: 'TELNYX_API_KEY is not set on this project.' }, 503);
      }
      return null;
    };

    // ---------------------------------------------------------------- gaps
    if (action === 'coverage_gaps') {
      const { data, error } = await admin.rpc('dialer_coverage_gaps');
      if (error) return json(req, { ok: false, error: error.message }, 500);
      const rows = data || [];
      const uncovered = rows.filter((r: any) => Number(r.active_dids) === 0);
      return json(req, {
        ok: true,
        rows,
        summary: {
          area_codes: rows.length,
          covered: rows.length - uncovered.length,
          uncovered: uncovered.length,
          contacts_without_local_did: uncovered.reduce((s: number, r: any) => s + Number(r.contacts), 0),
        },
      });
    }

    // -------------------------------------------------------------- search
    if (action === 'search_numbers') {
      const guard = needTelnyx(); if (guard) return guard;
      const areaCode = String(body?.area_code || '').replace(/\D/g, '');
      if (areaCode.length !== 3) {
        return json(req, { ok: false, error: 'area_code must be 3 digits' }, 400);
      }
      const limit = Math.min(Number(body?.limit) || 10, 50);

      const url = `${TELNYX_API}/available_phone_numbers`
        + `?filter[national_destination_code][]=${areaCode}`
        + `&filter[country_code]=US&filter[features][]=voice`
        + `&filter[limit]=${limit}`;
      const res = await fetch(url, { headers: telnyxHeaders });
      const b = await res.json().catch(() => null);
      if (!res.ok) {
        console.error('dialer-pool: search failed', res.status, JSON.stringify(b));
        return json(req, { ok: false, error: 'Telnyx number search failed.', detail: b?.errors ?? null }, 502);
      }

      const numbers = (b?.data || []).map((n: any) => ({
        phone_number: n.phone_number,
        area_code: npaOf(n.phone_number),
        state: n?.region_information?.find((r: any) => r.region_type === 'state')?.region_name
            ?? n?.region_information?.[0]?.region_name ?? null,
        rate_center: n?.region_information?.find((r: any) => r.region_type === 'rate_center')?.region_name ?? null,
        upfront_cost: n?.cost_information?.upfront_cost ?? null,
        monthly_cost: n?.cost_information?.monthly_cost ?? null,
      }));
      return json(req, { ok: true, numbers });
    }

    // --------------------------------------------------------------- order
    if (action === 'order_numbers') {
      const guard = needTelnyx(); if (guard) return guard;
      if (!CONNECTION_ID) {
        return json(req, { ok: false, error: 'TELNYX_CREDENTIAL_CONNECTION_ID is not set.' }, 503);
      }
      const numbers: string[] = Array.isArray(body?.phone_numbers) ? body.phone_numbers : [];
      if (!numbers.length) return json(req, { ok: false, error: 'phone_numbers is required' }, 400);
      // A cap, not a limit of the API: this spends real money, and a runaway
      // client should not be able to buy hundreds of numbers in one request.
      if (numbers.length > 25) {
        return json(req, { ok: false, error: 'Order at most 25 numbers at a time.' }, 400);
      }

      const res = await fetch(`${TELNYX_API}/number_orders`, {
        method: 'POST',
        headers: telnyxHeaders,
        body: JSON.stringify({
          connection_id: CONNECTION_ID,
          phone_numbers: numbers.map((p) => ({ phone_number: p })),
        }),
      });
      const b = await res.json().catch(() => null);
      if (!res.ok) {
        console.error('dialer-pool: order failed', res.status, JSON.stringify(b));
        return json(req, { ok: false, error: 'Telnyx number order failed.', detail: b?.errors ?? null }, 502);
      }

      // Record what we ordered. Numbers are NOT set active here: a brand new
      // DID has no reputation history and should be warmed rather than thrown
      // straight into rotation at full volume. 'resting' keeps it out of gate
      // 5 until someone deliberately activates it.
      const rows = (b?.data?.phone_numbers || numbers.map((p: string) => ({ phone_number: p })))
        .map((n: any) => ({
          phone_e164: n.phone_number,
          area_code: npaOf(n.phone_number),
          state: body?.state ?? null,
          provider: 'telnyx',
          provider_id: n.id ?? null,
          telnyx_connection_id: undefined,
          status: 'resting',
          purchased_at: nowIso,
        }));
      // strip the undefined key -- dialer_dids has no such column
      rows.forEach((r: any) => delete r.telnyx_connection_id);

      const { error: insErr } = await admin.from('dialer_dids')
        .upsert(rows, { onConflict: 'phone_e164', ignoreDuplicates: true });
      if (insErr) {
        // The numbers ARE bought at this point. Say so plainly rather than
        // implying the order failed -- otherwise someone re-orders them.
        console.error('dialer-pool: ordered but failed to record', insErr.message);
        return json(req, {
          ok: false,
          error: `Numbers were ordered at Telnyx but could not be saved locally (${insErr.message}). ` +
                 `Run sync_dids to reconcile — do NOT re-order.`,
        }, 500);
      }

      return json(req, { ok: true, ordered: rows.length, order_id: b?.data?.id ?? null, status: 'resting' });
    }

    // ---------------------------------------------------------------- sync
    if (action === 'sync_dids') {
      const guard = needTelnyx(); if (guard) return guard;
      let page = 1;
      const owned: any[] = [];
      // Page explicitly; Telnyx defaults to a small page size and a silent
      // first-page-only sync is exactly the drift this action exists to fix.
      while (page <= 20) {
        const res = await fetch(
          `${TELNYX_API}/phone_numbers?page[number]=${page}&page[size]=250`,
          { headers: telnyxHeaders },
        );
        if (!res.ok) break;
        const b = await res.json();
        const batch = b?.data || [];
        owned.push(...batch);
        if (batch.length < 250) break;
        page++;
      }

      const rows = owned
        .filter((n: any) => typeof n.phone_number === 'string' && n.phone_number.startsWith('+1'))
        .map((n: any) => ({
          phone_e164: n.phone_number,
          area_code: npaOf(n.phone_number),
          provider: 'telnyx',
          provider_id: n.id ?? null,
        }));

      let added = 0;
      for (let i = 0; i < rows.length; i += 200) {
        const slice = rows.slice(i, i + 200);
        const { error } = await admin.from('dialer_dids')
          .upsert(slice, { onConflict: 'phone_e164', ignoreDuplicates: true });
        if (error) return json(req, { ok: false, error: error.message }, 500);
        added += slice.length;
      }

      // Anything we think is active but Telnyx no longer lists is a number we
      // do not own. Leaving it active means gate 5 hands agents a caller ID
      // that will be rejected at dial time.
      const ownedSet = new Set(rows.map((r) => r.phone_e164));
      const { data: local } = await admin.from('dialer_dids')
        .select('id, phone_e164').neq('status', 'retired');
      const orphans = (local || []).filter((d: any) => !ownedSet.has(d.phone_e164));
      if (orphans.length) {
        await admin.from('dialer_dids')
          .update({ status: 'retired', retired_at: nowIso, notes: 'Not present in Telnyx account at sync' })
          .in('id', orphans.map((o: any) => o.id));
      }

      return json(req, { ok: true, telnyx_numbers: rows.length, upserted: added, retired_orphans: orphans.length });
    }

    // -------------------------------------------------------------- status
    if (action === 'set_did_status') {
      const id = body?.did_id ? String(body.did_id) : null;
      const status = String(body?.status || '');
      if (!id || !['active', 'resting', 'quarantined', 'retired'].includes(status)) {
        return json(req, { ok: false, error: 'did_id and a valid status are required' }, 400);
      }
      const update: Record<string, unknown> = { status, updated_at: nowIso };
      if (status === 'active') update.activated_at = nowIso;
      if (status === 'resting') update.rested_at = nowIso;
      if (status === 'retired') update.retired_at = nowIso;
      if (body?.notes) update.notes = String(body.notes);

      const { error } = await admin.from('dialer_dids').update(update).eq('id', id);
      if (error) return json(req, { ok: false, error: error.message }, 500);
      return json(req, { ok: true });
    }

    // ---------------------------------------------------------------- list
    if (action === 'list_dids') {
      const { data, error } = await admin.from('dialer_dids')
        .select('id, phone_e164, area_code, state, status, daily_cap, dials_today, dials_today_date, ' +
                'answer_rate_7d, reputation_status, last_reputation_check_at, purchased_at, notes')
        .order('area_code', { ascending: true })
        .limit(1000);
      if (error) return json(req, { ok: false, error: error.message }, 500);
      return json(req, { ok: true, dids: data || [] });
    }

    return json(req, { ok: false, error: `Unknown action "${action}"` }, 400);
  } catch (e) {
    console.error('dialer-pool: unhandled', e);
    return json(req, { ok: false, error: e instanceof Error ? e.message : 'Unexpected error' }, 500);
  }
});
