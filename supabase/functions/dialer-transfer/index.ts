// supabase/functions/dialer-transfer/index.ts
//
// Blind-transfers a live call to another agent or to an outside number (v550).
//
// ITS OWN FUNCTION, not another action on dialer-call-control: that file is
// 750+ lines and there is no partial deploy, so every change to it means
// re-sending the whole thing. A small function that touches one call command
// is far cheaper to change and much harder to break something else with.
//
// ONLY INBOUND CALLS CAN BE TRANSFERRED, and the refusal says so plainly.
// An outbound leg is originated by the agent's browser over a Credential
// Connection, so Telnyx has no handle on it -- the WebRTC SDK's own
// Call.transfer() logs "The call.transfer method is not currently implemented"
// before sending its message. Pretending otherwise would give agents a button
// that silently does nothing to a live customer call.
//
// Blind transfer only: the call is handed over and this agent drops out.
// Warm/consultative transfer needs a third leg and a conference and is
// deliberately separate work.
//
// Deploy WITH JWT verification -- this is called by the agent's browser:
//   supabase functions deploy dialer-transfer

import { createClient } from 'jsr:@supabase/supabase-js@2';

// Duplicated rather than imported: Supabase's per-function deploy only bundles
// each function's own directory, so a relative import from _shared/ fails at
// deploy time. Same reason dialer-call-control carries its own copy.
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

// A refusal is a normal outcome the console shows to the agent, not an error.
function refuse(req: Request, reason: string, detail: string) {
  return json(req, { ok: true, transferred: false, reason, detail });
}

function toE164(raw: string): string | null {
  const d = String(raw || '').replace(/\D/g, '');
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith('1')) return `+${d}`;
  return null;
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

    if (!TELNYX_API_KEY) {
      console.error('dialer-transfer: TELNYX_API_KEY not set');
      return json(req, { ok: false, error: 'Transfer is not configured.' }, 500);
    }

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
    const attemptId = body?.attempt_id ? String(body.attempt_id) : null;
    const toAgentId = body?.to_agent_id ? String(body.to_agent_id) : null;
    const toNumberRaw = body?.to_number ? String(body.to_number) : null;
    if (!attemptId) return json(req, { ok: false, error: 'attempt_id is required' }, 400);
    if (!toAgentId && !toNumberRaw) {
      return json(req, { ok: false, error: 'Pick an agent or enter a number.' }, 400);
    }

    const { data: attempt } = await admin
      .from('dialer_attempts')
      .select('id, agent_id, direction, queue_id, provider_call_id, from_number, '
            + 'to_number, answered_at, ended_at, transferred_at')
      .eq('id', attemptId).maybeSingle();
    if (!attempt) return json(req, { ok: false, error: 'Call not found' }, 404);

    // An agent may only transfer a call they are actually on. Owners/admins
    // are NOT exempt here: transferring someone else's live call out from
    // under them is not an administrative action, it is a dropped customer.
    if (attempt.agent_id !== caller.id) {
      return refuse(req, 'not_your_call', 'You can only transfer a call you are on.');
    }
    if (attempt.ended_at) return refuse(req, 'call_ended', 'That call has already ended.');
    if (!attempt.answered_at) return refuse(req, 'not_answered', 'Answer the call before transferring it.');
    if (attempt.transferred_at) return refuse(req, 'already_transferred', 'That call has already been transferred.');

    // The load-bearing check. See this file's header.
    if (attempt.direction !== 'inbound' || !attempt.queue_id) {
      return refuse(req, 'outbound_not_transferable',
        'Outbound calls cannot be transferred: your browser places them directly, '
        + 'so they are not under server-side call control. Inbound queue calls can be.');
    }
    if (!attempt.provider_call_id) {
      return refuse(req, 'no_call_handle', 'No call handle on record for that call yet.');
    }

    // ---- resolve the destination -------------------------------------------
    let destination: string;
    let toNumber: string | null = null;
    let targetAgent: string | null = null;

    if (toAgentId) {
      // Only someone who actually works this queue, and only via the same
      // availability rule the queue itself uses -- so a call is never handed
      // to a name that is on a break or has a dead tab.
      const { data: targets } = await callerClient
        .rpc('dialer_transfer_targets', { p_attempt: attemptId });
      const t = (targets || []).find((x: any) => x.agent_id === toAgentId);
      if (!t) return refuse(req, 'not_on_queue', 'That agent does not work this queue.');
      if (!t.is_available) return refuse(req, 'agent_unavailable', `${t.full_name} is not available right now.`);

      const { data: cred } = await admin
        .from('dialer_agent_credentials')
        .select('sip_username').eq('agent_id', toAgentId).is('revoked_at', null).maybeSingle();
      if (!cred?.sip_username) {
        return refuse(req, 'agent_no_sip', 'That agent has no softphone identity yet.');
      }
      destination = `sip:${cred.sip_username}@sip.telnyx.com`;
      targetAgent = toAgentId;
    } else {
      const e164 = toE164(toNumberRaw!);
      if (!e164) return json(req, { ok: false, error: 'Enter a valid 10-digit US number.' }, 400);

      // Someone who asked never to be called again is owed that however the
      // call reaches them -- including a transfer, which is still us dialling.
      const { count: dnc } = await admin
        .from('dialer_dnc').select('id', { count: 'exact', head: true }).eq('phone_e164', e164);
      if ((dnc ?? 0) > 0) {
        return refuse(req, 'dnc', 'That number is on the internal do-not-call list.');
      }
      destination = e164;
      toNumber = e164;
    }

    // ---- hand the call over -------------------------------------------------
    // Transfer the CALLER's leg. The agent's own leg drops as a consequence,
    // which is what a blind transfer is.
    const res = await fetch(
      `https://api.telnyx.com/v2/calls/${encodeURIComponent(attempt.provider_call_id)}/actions/transfer`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${TELNYX_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: destination,
          // Keep the original caller's number as the caller ID so the
          // receiving agent sees who is actually on the phone, not us.
          from: attempt.from_number,
        }),
      },
    );
    if (!res.ok) {
      const detail = await res.text();
      console.error('dialer-transfer: transfer failed', res.status, detail);
      return json(req, { ok: false, error: 'Telnyx refused the transfer.' }, 502);
    }

    await admin.from('dialer_attempts').update({
      transferred_at: new Date().toISOString(),
      transferred_by: caller.id,
      transferred_to_agent_id: targetAgent,
      transferred_to_number: toNumber,
    }).eq('id', attempt.id);

    return json(req, { ok: true, transferred: true, to: targetAgent ? 'agent' : 'number' });
  } catch (e) {
    console.error('dialer-transfer: unhandled', e);
    return json(req, { ok: false, error: e instanceof Error ? e.message : 'Unexpected error' }, 500);
  }
});
