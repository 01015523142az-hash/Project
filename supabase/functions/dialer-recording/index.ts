// supabase/functions/dialer-recording/index.ts
//
// Hands the browser a PLAYABLE url for one call recording, minted at the
// moment someone presses play.
//
// WHY THIS FUNCTION EXISTS AT ALL:
//   dialer_attempts.recording_path looks like a permanent link but is not.
//   Telnyx sends recording_urls.mp3 on call.recording.saved as a presigned
//   S3 link with X-Amz-Expires=600 — ten minutes, then 403 forever. Storing
//   it and rendering it in a table produces a page of dead links that looks
//   fine until someone actually clicks one. So nothing renders the stored
//   url; the recordings screen calls this instead, and Telnyx signs a fresh
//   one per request.
//
//   The Telnyx API key is what does that signing, so this has to be a
//   function — same reason dialer-telnyx-token exists rather than the
//   browser talking to Telnyx directly.
//
// RESOLUTION ORDER (first hit wins, and the answer is cached back):
//   1. dialer_attempts.recording_id      — set by dialer-telnyx-webhook
//   2. provider_leg_id  -> filter[call_leg_id]
//   3. raw call_session_id -> filter[call_session_id]
//   Rows written before v530 have no recording_id, which is exactly why 2
//   and 3 exist: the two recordings that already existed when this was
//   written are only reachable that way.
//
// ACCESS: a recording is a conversation with a member of the public. Owner
// and admin may hear any of them, and so may a role holding can_review_calls
// or can_manage_dialer (Quality, team leads) -- reviewing calls is the whole
// point of that permission. Everyone else may only hear calls they personally
// placed. This mirrors dialer_attempts' own select policy (v531) rather than
// inventing a second, looser rule for audio: if someone can see the row in
// the Recordings tab, they can play it, and if they cannot, they cannot.
//
// Deploy with:
//   supabase functions deploy dialer-recording
// Requires the TELNYX_API_KEY secret that dialer-telnyx-token already uses.

import { createClient } from 'jsr:@supabase/supabase-js@2';

// Origin allowlist for this project's own frontends. Duplicated in every
// function that needs it (not imported from a shared file) because
// Supabase's per-function deploy only bundles each function's own
// directory -- a cross-function relative import to _shared/ fails at
// deploy time, same reason readymode-api/readymode-email-import
// duplicate their CSV-parsing code instead of sharing it.
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
    status,
    headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
  });
}

const TELNYX_API = 'https://api.telnyx.com/v2';

// Telnyx returns the playable links under download_urls on a recording
// object; older shapes used recording_urls. Accept either, prefer mp3 for
// size (these are dual-channel recordings and wav is several times larger).
function pickUrl(rec: Record<string, any> | null | undefined): string | null {
  if (!rec) return null;
  const d = rec.download_urls || rec.recording_urls || rec.public_recording_urls || {};
  return d.mp3 || d.wav || null;
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
    const { data: userRes, error: getUserErr } = await callerClient.auth.getUser();
    const caller = userRes?.user;
    if (!caller) {
      console.error('dialer-recording: getUser() found no caller', getUserErr?.message || '');
      return json(req, { ok: false, error: 'Not signed in' }, 401);
    }

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE);
    const { data: profile } = await admin
      .from('profiles').select('role').eq('id', caller.id).maybeSingle();
    if (!profile) return json(req, { ok: false, error: 'Only staff accounts can use the dialer' }, 403);

    // Resolved here with the service-role client rather than trusted from the
    // caller: same reasoning dialer-call-control gives for its own gate. The
    // set of roles is kept identical to role_can_review_calls() (v531), which
    // is what governs whether the row was visible in the first place.
    const isOwnerAdmin = profile.role === 'owner' || profile.role === 'admin';
    let mayReviewAny = isOwnerAdmin;
    if (!mayReviewAny) {
      const { data: roleRow } = await admin
        .from('roles').select('can_review_calls, can_manage_dialer')
        .eq('name', profile.role).maybeSingle();
      mayReviewAny = !!(roleRow?.can_review_calls || roleRow?.can_manage_dialer);
    }

    const body = await req.json().catch(() => ({}));
    const attemptId = body?.attempt_id ? String(body.attempt_id) : null;
    if (!attemptId) return json(req, { ok: false, error: 'attempt_id is required' }, 400);

    const { data: attempt } = await admin
      .from('dialer_attempts')
      .select('id, agent_id, recording_id, recording_path, provider_leg_id, raw')
      .eq('id', attemptId)
      .maybeSingle();
    if (!attempt) return json(req, { ok: false, error: 'Call not found' }, 404);

    // See ACCESS in the header. Matches v531's select policy exactly, so a
    // row that showed up in the Recordings tab is always playable and one
    // that did not never is.
    if (!mayReviewAny && attempt.agent_id !== caller.id) {
      return json(req, { ok: false, error: 'You can only play back your own calls.' }, 403);
    }

    if (!TELNYX_API_KEY) {
      return json(req, {
        ok: true, url: null, reason: 'not_configured',
        detail: 'TELNYX_API_KEY is not set on this project.',
      });
    }
    const headers = { Authorization: `Bearer ${TELNYX_API_KEY}` };

    // ---- 1. the durable id, when the webhook already stored one -----------
    if (attempt.recording_id) {
      const r = await fetch(`${TELNYX_API}/recordings/${attempt.recording_id}`, { headers });
      const b = await r.json().catch(() => null);
      const url = pickUrl(b?.data);
      if (url) return json(req, { ok: true, url, source: 'recording_id' });
      console.warn('dialer-recording: stored recording_id did not resolve', attempt.recording_id, r.status);
    }

    // ---- 2/3. fall back to the call's own carrier ids ---------------------
    // Pre-v530 rows have no recording_id. Both of these are recorded by
    // dialer-telnyx-webhook on call.initiated / call.hangup, so every
    // historical recorded call is still reachable.
    const sessionId = attempt.raw?.data?.payload?.call_session_id || null;
    const attempts: Array<[string, string]> = [];
    if (attempt.provider_leg_id) attempts.push(['call_leg_id', attempt.provider_leg_id]);
    if (sessionId) attempts.push(['call_session_id', sessionId]);

    for (const [filterName, value] of attempts) {
      const qs = new URLSearchParams({ [`filter[${filterName}]`]: value, 'page[size]': '5' });
      const r = await fetch(`${TELNYX_API}/recordings?${qs.toString()}`, { headers });
      const b = await r.json().catch(() => null);
      const rec = Array.isArray(b?.data) ? b.data[0] : null;
      const url = pickUrl(rec);
      if (url) {
        // Cache the id so the next play is a single lookup rather than a
        // filtered search, and so this keeps working if Telnyx ever tightens
        // those filters.
        if (rec?.id && rec.id !== attempt.recording_id) {
          await admin.from('dialer_attempts')
            .update({ recording_id: rec.id }).eq('id', attempt.id);
        }
        return json(req, { ok: true, url, source: filterName });
      }
    }

    return json(req, {
      ok: false,
      error: 'No recording is available from the carrier for this call.',
    }, 404);
  } catch (e) {
    console.error('dialer-recording: unhandled', e);
    return json(req, { ok: false, error: e instanceof Error ? e.message : 'Unexpected error' }, 500);
  }
});
