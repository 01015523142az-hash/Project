// supabase/functions/dialer-fs-route/index.ts
//
// The authority boundary: turns an attempt id into a real phone number (v554).
//
// The browser dials "atmpt-<uuid>", never a phone number. FreeSWITCH asks
// this function for the dialplan and gets back XML with the number already
// resolved, validated and baked into the bridge string.
//
// WHY THE CLIENT IS NOT TRUSTED WITH THE NUMBER. dialer-call-control applies
// every rule that matters -- campaign assignment, per-agent caps, internal
// DNC, calling hours in the CONTACT's zone, area-code preference, and the
// v548 multi-number order -- and only then opens the attempt row. If the
// browser sent a destination, a tampered or replayed session could dial
// something none of those rules ever approved. Sending an id instead means
// the worst a stolen session can do is re-dial work already authorised for
// that same agent, exactly once.
//
// WHY XML AND NOT THE curl DIALPLAN APP. The curl app drops its body into
// ${curl_response_data} for the dialplan to pick apart, which puts string
// parsing between the answer and the call. mod_xml_curl hands FreeSWITCH a
// finished dialplan: nothing to parse, and the only number that can appear
// in a bridge string is one this function validated.
//
// Deploy:
//   supabase functions deploy dialer-fs-route --no-verify-jwt

import { createClient } from 'jsr:@supabase/supabase-js@2';

const NOT_FOUND = `<?xml version="1.0" encoding="UTF-8"?>
<document type="freeswitch/xml">
  <section name="result">
    <result status="not found"/>
  </section>
</document>`;

// Destination must be exactly our attempt scheme. Anything else -- including
// the inbound leg Telnyx sends when an agent is offered a queued call -- gets
// "not found" so FreeSWITCH falls through to its static dialplan.
const ATTEMPT_RE = /^atmpt-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

// North American numbers only. We have no legitimate international traffic,
// so the switch should not be capable of placing an international call at
// all. This runs even though the number came out of our own database: the
// cost of being wrong here is a premium-rate bill, and the check is free.
const NANP_RE = /^\+1[2-9]\d{9}$/;

// Single-quoted on purpose. ${uuid} here is a FREESWITCH variable the switch
// expands at call time, not a JS template hole -- writing it inside a
// template literal would need a backslash escape that is easy to lose in a
// copy, and losing it would silently record every call over one filename.
const RECORDING_PATH = '/var/lib/freeswitch/recordings/${uuid}.wav';

function xml(body: string, status = 200) {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/xml; charset=utf-8' },
  });
}

function esc(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

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

// An explicit rejection rather than "not found": the agent's console should
// see the call fail immediately with a cause somebody can explain, instead of
// sitting on silence until something times out.
function reject(reason: string) {
  console.warn(`dialer-fs-route: rejecting -- ${reason}`);
  return xml(`<?xml version="1.0" encoding="UTF-8"?>
<document type="freeswitch/xml">
  <section name="dialplan">
    <context name="dialer">
      <extension name="dialer_refused">
        <condition>
          <action application="log" data="WARNING dialer-fs-route refused: ${esc(reason)}"/>
          <action application="respond" data="603 Declined"/>
        </condition>
      </extension>
    </context>
  </section>
</document>`);
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return xml(NOT_FOUND, 405);

  const SECRET = Deno.env.get('FS_XML_SECRET');
  // Fail CLOSED. An unset secret must never mean "let everyone in" on the
  // one endpoint that decides what number the switch is allowed to dial.
  if (!SECRET) {
    console.error('dialer-fs-route: FS_XML_SECRET is not set; refusing all requests');
    return xml(NOT_FOUND, 503);
  }
  if (!secretOk(presentedSecret(req), SECRET)) {
    console.warn('dialer-fs-route: bad or missing secret');
    return xml(NOT_FOUND, 401);
  }

  try {
    const form = new URLSearchParams(await req.text());
    if ((form.get('section') || '') !== 'dialplan') return xml(NOT_FOUND);

    const destination = form.get('Caller-Destination-Number') || '';
    const m = ATTEMPT_RE.exec(destination);
    // Not one of ours. Inbound legs land here too; let the static dialplan
    // have them.
    if (!m) return xml(NOT_FOUND);

    const attemptId = m[1].toLowerCase();
    const sipUser = form.get('variable_sip_from_user') || form.get('Caller-Username') || '';
    const channelUuid = form.get('Unique-ID') || form.get('Channel-Call-UUID') || '';

    if (!sipUser) return reject('no authenticated SIP user on the channel');
    if (!channelUuid) return reject('no channel uuid');

    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      { auth: { persistSession: false } },
    );

    // One atomic claim. Raises if the attempt is not this agent's, is not
    // outbound, has already been dialled, or if the SIP user is revoked.
    const { data, error } = await admin.rpc('dialer_fs_resolve_attempt', {
      p_attempt: attemptId,
      p_sip_user: sipUser,
      p_channel_uuid: channelUuid,
    });

    if (error) return reject(`resolve failed for ${sipUser}: ${error.message}`);
    const row = Array.isArray(data) ? data[0] : data;
    if (!row?.to_number) return reject('resolve returned no number');

    const to = String(row.to_number);
    const from = String(row.from_number || '');
    if (!NANP_RE.test(to)) return reject(`resolved number is not NANP: ${to}`);
    if (from && !NANP_RE.test(from)) return reject(`caller id is not NANP: ${from}`);

    // hangup_after_bridge stops the agent's leg outliving the far end.
    // absolute_codec_string pins the trunk leg to G.711 so the carrier cannot
    // negotiate something we would then transcode twice.
    // The | in the bridge string is GATEWAY FAILOVER, not a second dial --
    // trunk-backup is only tried if the primary refuses the call outright.
    return xml(`<?xml version="1.0" encoding="UTF-8"?>
<document type="freeswitch/xml">
  <section name="dialplan">
    <context name="dialer">
      <extension name="dialer_attempt">
        <condition>
          <action application="set" data="dialer_attempt_id=${esc(attemptId)}"/>
          <action application="set" data="effective_caller_id_number=${esc(from)}"/>
          <action application="set" data="effective_caller_id_name=${esc(from)}"/>
          <action application="set" data="hangup_after_bridge=true"/>
          <action application="set" data="continue_on_fail=false"/>
          <action application="set" data="ignore_early_media=false"/>
          <action application="set" data="call_timeout=45"/>
          <action application="set" data="absolute_codec_string=PCMU,PCMA"/>
          <action application="set" data="RECORD_STEREO=true"/>
          <action application="set" data="recording_follow_transfer=true"/>
          <action application="record_session" data="${RECORDING_PATH}"/>
          <action application="bridge" data="sofia/gateway/trunk-primary/${esc(to)}|sofia/gateway/trunk-backup/${esc(to)}"/>
        </condition>
      </extension>
    </context>
  </section>
</document>`);
  } catch (e) {
    console.error('dialer-fs-route: unhandled', e instanceof Error ? e.message : String(e));
    return reject('internal error');
  }
});
