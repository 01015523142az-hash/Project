// supabase/functions/dialer-fs-directory/index.ts
//
// Serves the FreeSWITCH user directory over mod_xml_curl (v554, v555).
//
// FreeSWITCH asks this on every agent registration and on every SIP auth
// challenge: "who is ola_t, and what is their password hash?" Answering it
// from Supabase rather than from a static XML file means revoking an agent
// is a database update that takes effect on their next registration, with
// no config deploy and no ssh.
//
// WHAT THIS RETURNS IS PASSWORD MATERIAL. a1-hash is md5(user:domain:pass)
// and anyone holding it can register as that agent and place calls on our
// carrier account. Hence:
//   * dialer_fs_credentials has RLS on and NO policies -- only the service
//     role reads it, and this function is the only thing that does.
//   * the hash is EPHEMERAL (v555): dialer-fs-token mints one per sign-in
//     with an expiry, and this refuses it afterwards.
//   * the request must carry the shared secret. mod_xml_curl sends it as
//     HTTP Basic via its gateway-credentials param.
//   * deployed with --no-verify-jwt, because the caller is a switch and not
//     a signed-in person. The secret IS the authentication; if FS_XML_SECRET
//     is unset this function refuses every request rather than opening up.
//
// Deploy:
//   supabase functions deploy dialer-fs-directory --no-verify-jwt

import { createClient } from 'jsr:@supabase/supabase-js@2';

// FreeSWITCH expects this exact document when the answer is "I don't know",
// and treats anything else as a hard error. Returning it lets the switch
// fall through to its static XML instead of failing the registration.
const NOT_FOUND = `<?xml version="1.0" encoding="UTF-8"?>
<document type="freeswitch/xml">
  <section name="result">
    <result status="not found"/>
  </section>
</document>`;

// Single-quoted on purpose. These are FREESWITCH variables the switch
// expands itself, not JS template holes -- inside a template literal each
// would need a backslash escape that is easy to lose in a copy.
const DIAL_STRING =
  '{presence_id=${dialed_user}@${dialed_domain}}' +
  '${sofia_contact(${dialed_user}@${dialed_domain})}';

function xml(body: string, status = 200) {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/xml; charset=utf-8' },
  });
}

// XML escaping is not optional here: a1-hash is hex and sip_username is
// generated, but neither fact is enforced by a constraint, and a stray
// ampersand would produce a document FreeSWITCH silently refuses to parse.
function esc(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// Constant-time-ish comparison. The secret is long and random so a timing
// attack is not the realistic threat, but there is no reason to leak length.
function secretOk(given: string, expected: string): boolean {
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

function presentedSecret(req: Request): string {
  // mod_xml_curl's gateway-credentials arrive as HTTP Basic "user:secret".
  const auth = req.headers.get('authorization') || '';
  if (auth.toLowerCase().startsWith('basic ')) {
    try {
      const decoded = atob(auth.slice(6).trim());
      const idx = decoded.indexOf(':');
      return idx === -1 ? decoded : decoded.slice(idx + 1);
    } catch { /* fall through to the header form */ }
  }
  return req.headers.get('x-fs-secret') || '';
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return xml(NOT_FOUND, 405);

  const SECRET = Deno.env.get('FS_XML_SECRET');
  // Fail CLOSED. An unset secret must never mean "let everyone in" on a
  // function whose whole job is handing out password hashes.
  if (!SECRET) {
    console.error('dialer-fs-directory: FS_XML_SECRET is not set; refusing all requests');
    return xml(NOT_FOUND, 503);
  }
  if (!secretOk(presentedSecret(req), SECRET)) {
    console.warn('dialer-fs-directory: bad or missing secret');
    return xml(NOT_FOUND, 401);
  }

  try {
    // mod_xml_curl posts application/x-www-form-urlencoded.
    const form = new URLSearchParams(await req.text());
    const section = form.get('section') || '';
    const user = form.get('user') || '';
    const domain = form.get('domain') || form.get('key_value') || '';

    if (section !== 'directory' || !user) return xml(NOT_FOUND);

    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      { auth: { persistSession: false } },
    );

    const { data: cred, error } = await admin
      .from('dialer_fs_credentials')
      .select('agent_id, sip_username, a1_hash, a1_expires_at, revoked_at')
      .eq('sip_username', user)
      .maybeSingle();

    if (error) {
      console.error('dialer-fs-directory: lookup failed', error.message);
      return xml(NOT_FOUND, 500);
    }

    // Every refusal below returns the SAME "not found" the switch gets for a
    // username that never existed. A probe therefore cannot tell a revoked
    // agent from an off-shift one from a typo, which is the point.
    //
    // The expiry check is what makes the session secret ephemeral in fact
    // rather than in intention: dialer-fs-token sets a1_expires_at, and this
    // is the only place it is ever enforced. Without it the "ephemeral"
    // password would be permanent and nobody would notice.
    const expired = !cred?.a1_expires_at || new Date(cred.a1_expires_at) <= new Date();
    if (!cred || cred.revoked_at || !cred.a1_hash || expired) {
      console.log(`dialer-fs-directory: refusing ${user} (${
        !cred ? 'unknown' : cred.revoked_at ? 'revoked' : !cred.a1_hash ? 'no session secret' : 'secret expired'
      })`);
      return xml(NOT_FOUND);
    }

    // The agent id rides along as a channel variable so the dialplan and the
    // CDR both know who placed the call without another round trip.
    return xml(`<?xml version="1.0" encoding="UTF-8"?>
<document type="freeswitch/xml">
  <section name="directory">
    <domain name="${esc(domain)}">
      <params>
        <param name="dial-string" value="${DIAL_STRING}"/>
      </params>
      <user id="${esc(cred.sip_username)}">
        <params>
          <param name="a1-hash" value="${esc(cred.a1_hash)}"/>
        </params>
        <variables>
          <variable name="dialer_agent_id" value="${esc(cred.agent_id)}"/>
          <variable name="user_context" value="dialer"/>
        </variables>
      </user>
    </domain>
  </section>
</document>`);
  } catch (e) {
    console.error('dialer-fs-directory: unhandled', e instanceof Error ? e.message : String(e));
    return xml(NOT_FOUND, 500);
  }
});
