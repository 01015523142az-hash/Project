// supabase/functions/dialer-fs-token/index.ts
//
// Mints one agent's ephemeral FreeSWITCH session secret (v555).
//
// Same shape and reasoning as dialer-telnyx-token: the browser needs a
// credential to register with, and the long-lived one never leaves the
// server. Here that is sharper than usual, because mod_verto authenticates
// with SIP digest -- the browser must present a PLAINTEXT password, so a
// long-lived password would have to be recoverable, which is exactly what we
// refused to store.
//
// So nothing long-lived exists. At sign-in this generates a fresh password,
// derives md5(user:realm:password), writes only the hash with an expiry, and
// returns the plaintext once. dialer-fs-directory serves that hash to the
// switch until a1_expires_at passes. A leaked credential dies at the end of
// the shift it was issued for, and there is never a password in the database
// to leak in the first place.
//
// It is also the console's single source of truth for WHICH SWITCH an agent
// is on. The answer is transport:'telnyx' unless everything is in place --
// the agent is flagged for FreeSWITCH, has been provisioned, and the host is
// configured. Any gap and the agent keeps dialling on Telnyx rather than
// finding themselves unable to work.
//
// Deploy WITH JWT verification -- this is called by the agent's browser:
//   supabase functions deploy dialer-fs-token

import { createClient } from 'jsr:@supabase/supabase-js@2';
// Deno's Web Crypto deliberately omits MD5. SIP digest requires it, so this
// is std's extended digest rather than a hand-rolled implementation.
import { crypto } from 'jsr:@std/crypto/crypto';

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

// Stay on Telnyx. Every "we cannot do FreeSWITCH right now" path ends here,
// because an agent who cannot register anywhere cannot work, and the Telnyx
// connection is provisioned and paid for precisely so this is always safe.
function stayOnTelnyx(req: Request, why: string) {
  console.log(`dialer-fs-token: transport=telnyx (${why})`);
  return json(req, { ok: true, transport: 'telnyx' });
}

async function md5Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('MD5', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// 32 chars of url-safe randomness. The digest realm is the weak link long
// before this is.
function newPassword(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/[+/=]/g, '').slice(0, 32);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: getCorsHeaders(req) });
  if (req.method !== 'POST') return json(req, { ok: false, error: 'Method not allowed' }, 405);

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
  const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;

  // The realm MUST match force-register-domain in verto.conf.xml. If they
  // disagree, every a1-hash we compute is wrong and registration fails with
  // "bad password" -- which sends whoever debugs it looking in entirely the
  // wrong place. Same reason dialer-telnyx-token refuses a credential from a
  // different connection rather than handing back a token that cannot dial.
  const FS_DOMAIN = Deno.env.get('FS_DOMAIN');
  const FS_WS_URL = Deno.env.get('FS_WS_URL');
  const TTL_HOURS = Math.min(24, Math.max(1, Number(Deno.env.get('FS_SECRET_TTL_HOURS')) || 12));

  try {
    const authHeader = req.headers.get('Authorization') || '';
    if (!authHeader.startsWith('Bearer ')) {
      return json(req, { ok: false, error: 'Missing Authorization header' }, 401);
    }

    const callerClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false },
    });
    const { data: { user }, error: userErr } = await callerClient.auth.getUser();
    if (userErr || !user) return json(req, { ok: false, error: 'Not signed in' }, 401);

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

    // Must actually be a dialler user. Checked here as well as by RLS,
    // because this hands out a credential that places calls on a live
    // carrier account -- the same reason dialer-pool re-checks server-side
    // rather than trusting a hidden button.
    const { data: profile } = await admin
      .from('profiles').select('role').eq('id', user.id).maybeSingle();
    if (!profile) return json(req, { ok: false, error: 'No staff profile' }, 403);

    const { data: roleRow } = await admin
      .from('roles').select('can_use_dialer').eq('name', profile.role).maybeSingle();
    if (!roleRow?.can_use_dialer) {
      return json(req, { ok: false, error: 'This role cannot use the dialer.' }, 403);
    }

    const { data: ac } = await admin
      .from('dialer_agent_credentials')
      .select('transport, revoked_at')
      .eq('agent_id', user.id)
      .maybeSingle();
    if (!ac || ac.revoked_at) {
      return json(req, { ok: false, error: 'This agent\'s dialer credential has been revoked.' }, 403);
    }
    if (ac.transport !== 'freeswitch') return stayOnTelnyx(req, 'agent is flagged for telnyx');

    // Flagged for FreeSWITCH but the deployment is not ready. Log loudly and
    // keep them working.
    if (!FS_DOMAIN || !FS_WS_URL) {
      console.warn('dialer-fs-token: FS_DOMAIN / FS_WS_URL not set but agent is flagged freeswitch');
      return stayOnTelnyx(req, 'host not configured');
    }

    const { data: cred } = await admin
      .from('dialer_fs_credentials')
      .select('sip_username, revoked_at')
      .eq('agent_id', user.id)
      .maybeSingle();
    if (!cred || cred.revoked_at) {
      console.warn(`dialer-fs-token: ${user.id} flagged freeswitch but not provisioned`);
      return stayOnTelnyx(req, 'agent not provisioned on the switch');
    }

    const passwd = newPassword();
    const a1Hash = await md5Hex(`${cred.sip_username}:${FS_DOMAIN}:${passwd}`);
    const expiresAt = new Date(Date.now() + TTL_HOURS * 3600_000).toISOString();

    // Rotating on every sign-in means the previous secret stops working the
    // moment a new one is issued. An agent with two tabs open will find the
    // older one unable to re-register -- acceptable, and much better than
    // secrets that accumulate.
    const { error: upErr } = await admin
      .from('dialer_fs_credentials')
      .update({ a1_hash: a1Hash, a1_expires_at: expiresAt })
      .eq('agent_id', user.id);
    if (upErr) {
      console.error('dialer-fs-token: could not store session secret', upErr.message);
      return stayOnTelnyx(req, 'could not store session secret');
    }

    // The plaintext appears here and nowhere else, ever.
    return json(req, {
      ok: true,
      transport: 'freeswitch',
      ws_url: FS_WS_URL,
      login: cred.sip_username,
      passwd,
      expires_at: expiresAt,
    });
  } catch (e) {
    console.error('dialer-fs-token: unhandled', e instanceof Error ? e.message : String(e));
    return stayOnTelnyx(req, 'unhandled error');
  }
});
