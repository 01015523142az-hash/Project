// supabase/functions/dialer-sms/index.ts
//
// Outbound leg of the dialer's two-way SMS. Sends from the SAME GoHighLevel
// two-way number the client-SMS path already uses (+1 307-441-5766), which is
// already 10DLC-registered -- see CLIENT_SMS_FROM_NUMBER.twoWay in
// send-client-sms.
//
// WHY NOT JUST REUSE send-client-sms: that function is client-scoped. It
// takes a clientId, reads client_accounts.phone, and applies notification
// templates and quotas. Dialer SMS goes to a seller who is not a client and
// has no client_accounts row, so the two paths share a number and an
// integration but not a contract.
//
// WHY GHL AND NOT TELNYX: Telnyx SMS is roughly 45% cheaper per segment
// ($0.007-0.010 all-in vs $0.013-0.018), but the number lives in GHL and is
// already 10DLC-registered there. Moving it means porting (days to weeks, and
// it stops working in GHL meanwhile) plus a fresh Telnyx 10DLC brand and
// campaign approval. At manual-dial volume the difference is a few dollars a
// month. Revisit if volume ever reaches thousands of segments.
//
// ACTIONS:
//   send  -- text an arbitrary E.164 from the two-way number
//
// Reading threads is NOT here: dialer_sms_threads() / dialer_sms_thread()
// (v542) are called straight from the page over PostgREST, because they are
// pure reads over ghl_messages with the visibility rule baked in.
//
// Deploy with:
//   supabase functions deploy dialer-sms
// Requires the same GHL_CLIENT_ID / GHL_CLIENT_SECRET as send-client-sms.

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

// Kept in sync with send-client-sms's CLIENT_SMS_FROM_NUMBER.twoWay. Both
// functions duplicate rather than share, for the same reason every function
// here duplicates its CORS block: Supabase's per-function deploy does not
// bundle sibling directories.
const TWO_WAY_FROM = '+13074415766';

function toE164(raw: string): string | null {
  const d = String(raw || '').replace(/\D/g, '');
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith('1')) return `+${d}`;
  return null;
}

// Same token-refresh contract as ghl-api: GHL rotates the refresh token on
// every use, so BOTH tokens must be written back or the connection strands
// after the next refresh.
async function getValidAccessToken(admin: any, conn: any): Promise<string | null> {
  if (conn.access_token && conn.expires_at && new Date(conn.expires_at) > new Date(Date.now() + 60000)) {
    return conn.access_token;
  }
  if (!conn.refresh_token) return conn.access_token || null;

  const res = await fetch('https://services.leadconnectorhq.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: Deno.env.get('GHL_CLIENT_ID') || '',
      client_secret: Deno.env.get('GHL_CLIENT_SECRET') || '',
      grant_type: 'refresh_token',
      refresh_token: conn.refresh_token,
      user_type: 'Location',
    }),
  });
  const b = await res.json().catch(() => null);
  if (!res.ok || !b?.access_token || !b?.refresh_token) {
    console.error('dialer-sms: token refresh failed', res.status, JSON.stringify(b));
    return null;
  }
  await admin.from('ghl_connections').update({
    access_token: b.access_token,
    refresh_token: b.refresh_token,
    expires_at: new Date(Date.now() + (Number(b.expires_in) || 86399) * 1000).toISOString(),
  }).eq('location_id', conn.location_id);
  return b.access_token;
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
      .from('profiles').select('role, full_name').eq('id', caller.id).maybeSingle();
    if (!profile) return json(req, { ok: false, error: 'Only staff accounts can send dialer SMS.' }, 403);

    // Anyone who may dial may text: an SMS after a no-answer is the same
    // conversation by another channel, not a privileged operation.
    let allowed = profile.role === 'owner' || profile.role === 'admin';
    if (!allowed) {
      const { data: r } = await admin.from('roles')
        .select('can_use_dialer').eq('name', profile.role).maybeSingle();
      allowed = !!r?.can_use_dialer;
    }
    if (!allowed) return json(req, { ok: false, error: "Your role doesn't have permission to use the dialer." }, 403);

    const body = await req.json().catch(() => ({}));
    if (String(body?.action || 'send') !== 'send') {
      return json(req, { ok: false, error: 'Unknown action' }, 400);
    }

    const to = toE164(body?.to || '');
    const text = String(body?.body || '').trim();
    if (!to) return json(req, { ok: false, error: 'A valid 10-digit US number is required.' }, 400);
    if (!text) return json(req, { ok: false, error: 'Message body is required.' }, 400);
    // One segment is 160 characters; a single emoji drops that to 70. Cap
    // rather than let someone send a nine-segment message by accident.
    if (text.length > 480) {
      return json(req, { ok: false, error: 'Message is too long (480 characters max).' }, 400);
    }

    // ---- do not text a suppressed number ---------------------------------
    // The internal do-not-call list is channel-agnostic: somebody who said
    // never contact me again is owed that by SMS as much as by phone.
    const { count: dncCount } = await admin
      .from('dialer_dnc').select('id', { count: 'exact', head: true }).eq('phone_e164', to);
    if ((dncCount ?? 0) > 0) {
      return json(req, { ok: true, sent: false, reason: 'dnc',
        detail: 'This number is on the internal do-not-call list.' });
    }

    // ---- GHL location -----------------------------------------------------
    const { data: conns } = await admin.from('ghl_connections')
      .select('location_id, access_token, refresh_token, expires_at');
    if (!conns?.length) {
      return json(req, { ok: false, error: 'No GoHighLevel location is connected.' }, 503);
    }
    const conn = conns[0];
    const token = await getValidAccessToken(admin, conn);
    if (!token) return json(req, { ok: false, error: 'Could not obtain a GoHighLevel access token.' }, 502);

    const ghlHeaders = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Version: '2021-07-28',
    };

    // ---- find or create the contact ---------------------------------------
    // GHL addresses conversations by contactId, not by raw number, so a
    // contact has to exist before a message can be sent.
    const upsertRes = await fetch('https://services.leadconnectorhq.com/contacts/upsert', {
      method: 'POST',
      headers: ghlHeaders,
      body: JSON.stringify({
        locationId: conn.location_id,
        phone: to,
        name: body?.name || undefined,
      }),
    });
    const upsertBody = await upsertRes.json().catch(() => null);
    const contactId = upsertBody?.contact?.id || upsertBody?.id || null;
    if (!upsertRes.ok || !contactId) {
      console.error('dialer-sms: contact upsert failed', upsertRes.status, JSON.stringify(upsertBody));
      return json(req, { ok: false, error: 'Could not resolve a GoHighLevel contact for that number.' }, 502);
    }

    // ---- send -------------------------------------------------------------
    const sendRes = await fetch('https://services.leadconnectorhq.com/conversations/messages', {
      method: 'POST',
      headers: ghlHeaders,
      body: JSON.stringify({
        type: 'SMS',
        contactId,
        message: text,
        fromNumber: TWO_WAY_FROM,
      }),
    });
    const sendBody = await sendRes.json().catch(() => null);
    if (!sendRes.ok) {
      console.error('dialer-sms: send failed', sendRes.status, JSON.stringify(sendBody));
      return json(req, { ok: false, error: 'GoHighLevel refused the message.',
        detail: sendBody?.message ?? null }, 502);
    }

    // ---- record it ourselves ----------------------------------------------
    // ghl-webhook only writes what the GHL workflow fires at us, and that
    // workflow may or may not trigger on outbound. Writing the row here means
    // the thread shows the message immediately instead of appearing to have
    // swallowed it; the upsert on ghl_message_id makes a later webhook
    // delivery of the same message idempotent rather than a duplicate.
    const messageId = sendBody?.messageId || sendBody?.id
      || `portal-${caller.id}-${Date.now()}`;
    await admin.from('ghl_messages').upsert({
      location_id: conn.location_id,
      ghl_message_id: messageId,
      user_id: caller.id,
      contact_id: contactId,
      contact_name: body?.name || null,
      contact_phone: to,
      direction: 'outbound',
      body: text,
      message_at: new Date().toISOString(),
      raw: { source: 'dialer-sms', from: TWO_WAY_FROM, response: sendBody },
    }, { onConflict: 'ghl_message_id' });

    return json(req, { ok: true, sent: true, message_id: messageId, from: TWO_WAY_FROM, to });
  } catch (e) {
    console.error('dialer-sms: unhandled', e);
    return json(req, { ok: false, error: e instanceof Error ? e.message : 'Unexpected error' }, 500);
  }
});
