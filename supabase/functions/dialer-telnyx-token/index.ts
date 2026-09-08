// supabase/functions/dialer-telnyx-token/index.ts
//
// Mints a short-lived Telnyx WebRTC login token for one signed-in agent's
// browser, so the dialer console can register a softphone WITHOUT the
// Telnyx API key ever reaching the client.
//
// Same shape and reasoning as cloudflare-turn-credentials: the long-lived
// secret (there a TURN key pair, here the Telnyx API key) stays a function
// secret; this function calls the vendor on the caller's behalf and returns
// only the short-lived credential the browser needs.
//
// FLOW:
//   1. Verify the caller is signed-in staff AND has the can_use_dialer role
//      permission (v523). Checked here with the service-role client, not
//      trusted from the UI — same reasoning ghl-api gives for its own
//      can_text_clients gate.
//   2. Look up (or create, once) that agent's Telnyx Telephony Credential
//      and remember its id in dialer_agent_credentials (v525).
//   3. Mint a fresh JWT from that credential and return it.
//
// WHY A CREDENTIAL PER AGENT: the credential is the SIP identity the
// browser registers as. One shared credential would make every leg
// indistinguishable at the carrier, so dialer_attempts.agent_id — a
// compliance record — would be a guess. See v525's header.
//
// Deploy with:
//   supabase functions deploy dialer-telnyx-token
//
// Required secrets:
//   supabase secrets set TELNYX_API_KEY=KEYxxxxxxxx
//   supabase secrets set TELNYX_CREDENTIAL_CONNECTION_ID=xxxxxxxx
//
// TELNYX_CREDENTIAL_CONNECTION_ID is the *Credential Connection* the
// WebRTC clients register against (Mission Control -> Voice -> Credential
// Connections), NOT the Call Control Application used for dialing. They are
// different objects with different ids; using one where the other belongs
// fails in a confusing way (tokens mint fine, registration then fails).
//
// If either secret is missing this returns { ok:true, token:null } rather
// than an error, so the console can render a clear "dialer not configured
// yet" state instead of a stack trace — same graceful-degrade choice
// cloudflare-turn-credentials makes.

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

const TELNYX_API = 'https://api.telnyx.com/v2';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: getCorsHeaders(req) });
  if (req.method !== 'POST') return json(req, { ok: false, error: 'Method not allowed' }, 405);

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
  const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
  const TELNYX_API_KEY = Deno.env.get('TELNYX_API_KEY');
  const CONNECTION_ID = Deno.env.get('TELNYX_CREDENTIAL_CONNECTION_ID');

  try {
    // ---- 1. who is calling -------------------------------------------------
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
      .from('profiles').select('role, full_name').eq('id', caller.id).maybeSingle();
    if (!profile) return json(req, { ok: false, error: 'Only staff accounts can use the dialer' }, 403);

    const isOwnerAdmin = profile.role === 'owner' || profile.role === 'admin';
    if (!isOwnerAdmin) {
      const { data: roleRow } = await admin
        .from('roles').select('can_use_dialer').eq('name', profile.role).maybeSingle();
      if (!roleRow?.can_use_dialer) {
        return json(req, { ok: false, error: "Your role doesn't have permission to use the dialer." }, 403);
      }
    }

    // ---- 2. not configured yet is a state, not an error ---------------------
    if (!TELNYX_API_KEY || !CONNECTION_ID) {
      console.warn('dialer-telnyx-token: TELNYX_API_KEY / TELNYX_CREDENTIAL_CONNECTION_ID not set');
      return json(req, {
        ok: true,
        token: null,
        reason: 'not_configured',
        detail: 'Telnyx secrets are not set on this project yet.',
      });
    }

    const telnyxHeaders = {
      'Authorization': `Bearer ${TELNYX_API_KEY}`,
      'Content-Type': 'application/json',
    };

    // ---- 3. this agent's telephony credential -------------------------------
    const { data: existing } = await admin
      .from('dialer_agent_credentials')
      .select('telnyx_credential_id, sip_username, telnyx_connection_id, revoked_at')
      .eq('agent_id', caller.id)
      .maybeSingle();

    if (existing?.revoked_at) {
      return json(req, { ok: false, error: 'This agent\'s dialer credential has been revoked.' }, 403);
    }

    let credentialId = existing?.telnyx_credential_id || null;
    let sipUsername = existing?.sip_username || null;

    // A stored credential created under a DIFFERENT connection would mint
    // tokens that register against the wrong connection — fail loudly rather
    // than hand back a token that mysteriously cannot place calls.
    if (credentialId && existing?.telnyx_connection_id && existing.telnyx_connection_id !== CONNECTION_ID) {
      return json(req, {
        ok: false,
        error: 'Stored dialer credential belongs to a different Telnyx connection. ' +
               'Revoke the dialer_agent_credentials row for this agent and re-issue.',
      }, 409);
    }

    if (!credentialId) {
      const createRes = await fetch(`${TELNYX_API}/telephony_credentials`, {
        method: 'POST',
        headers: telnyxHeaders,
        body: JSON.stringify({
          connection_id: CONNECTION_ID,
          name: `portal-dialer-${caller.id}`,
        }),
      });
      const createBody = await createRes.json().catch(() => null);
      if (!createRes.ok || !createBody?.data?.id) {
        console.error('dialer-telnyx-token: credential create failed', createRes.status, JSON.stringify(createBody));
        return json(req, {
          ok: false,
          error: 'Could not create a Telnyx credential for this agent.',
          detail: createBody?.errors ?? null,
        }, 502);
      }

      credentialId = createBody.data.id as string;
      sipUsername = (createBody.data.sip_username as string) ?? null;

      const { error: insErr } = await admin.from('dialer_agent_credentials').insert({
        agent_id: caller.id,
        telnyx_credential_id: credentialId,
        sip_username: sipUsername,
        telnyx_connection_id: CONNECTION_ID,
      });
      if (insErr) {
        // The credential exists at Telnyx but we failed to remember it. Say
        // so plainly — a silent retry next time would orphan credentials at
        // the carrier, one per token request.
        console.error('dialer-telnyx-token: created Telnyx credential', credentialId,
                      'but failed to store it:', insErr.message);
        return json(req, {
          ok: false,
          error: 'Created a Telnyx credential but could not save it. Retry once; ' +
                 `if this repeats, delete orphaned credential ${credentialId} in Telnyx first.`,
        }, 500);
      }
    }

    // ---- 4. mint the short-lived login token --------------------------------
    const tokenRes = await fetch(`${TELNYX_API}/telephony_credentials/${credentialId}/token`, {
      method: 'POST',
      headers: telnyxHeaders,
    });

    if (!tokenRes.ok) {
      const errBody = await tokenRes.text().catch(() => '');
      console.error('dialer-telnyx-token: token mint failed', tokenRes.status, errBody);
      return json(req, { ok: false, error: 'Could not mint a Telnyx login token.' }, 502);
    }

    // This endpoint returns the raw JWT as text/plain, not JSON — but be
    // tolerant, since a JSON-wrapped { data: { token } } shape would
    // otherwise be handed to the SDK verbatim and fail at registration with
    // a useless error.
    const rawToken = (await tokenRes.text()).trim();
    let loginToken = rawToken;
    if (rawToken.startsWith('{')) {
      try {
        const parsed = JSON.parse(rawToken);
        loginToken = parsed?.data?.token ?? parsed?.data ?? parsed?.token ?? rawToken;
      } catch { /* keep rawToken */ }
    }
    if (typeof loginToken !== 'string' || !loginToken) {
      console.error('dialer-telnyx-token: unrecognised token response shape:', rawToken.slice(0, 200));
      return json(req, { ok: false, error: 'Telnyx returned an unrecognised token response.' }, 502);
    }

    await admin.from('dialer_agent_credentials')
      .update({ last_token_issued_at: new Date().toISOString() })
      .eq('agent_id', caller.id);

    return json(req, {
      ok: true,
      token: loginToken,
      sip_username: sipUsername,
      // Telnyx JWTs are valid for 24h. The console should re-request on
      // registration failure rather than caching this across days.
      expires_in_seconds: 24 * 60 * 60,
    });
  } catch (e) {
    console.error('dialer-telnyx-token: unhandled', e);
    return json(req, { ok: false, error: e instanceof Error ? e.message : 'Unexpected error' }, 500);
  }
});
