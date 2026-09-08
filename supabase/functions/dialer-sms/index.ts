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
//   send         -- text an arbitrary E.164 from the two-way number
//   sync_thread  -- pull a conversation from GHL's API into local storage
//
// Listing threads is NOT here: dialer_sms_threads() / dialer_sms_thread()
// (v542, v545) are called straight from the page over PostgREST, because
// they are pure reads with the visibility rule baked in.
//
// sync_thread exists because inbound SMS only reaches ghl_messages when a GHL
// WORKFLOW fires a Custom Webhook at ghl-webhook. Where that workflow does not
// cover the number a reply landed on, the message is visible in GHL and
// invisible here. Polling the API the way the staff chat panel already does
// removes that dependency entirely.
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
    const action = String(body?.action || 'send');
    if (action !== 'send' && action !== 'sync_thread') {
      return json(req, { ok: false, error: 'Unknown action' }, 400);
    }

    // ---- sync_thread ------------------------------------------------------
    // Pulls a conversation from GHL's API and stores it locally.
    //
    // WHY THIS EXISTS: inbound SMS only reaches ghl_messages when a GHL
    // WORKFLOW fires a Custom Webhook at ghl-webhook. If that workflow does
    // not exist, or does not cover the number a reply landed on, the reply is
    // visible in GHL and invisible here -- which is exactly what happened.
    // The staff chat panel never had that problem because it polls
    // conversations/search + conversations/{id}/messages on demand rather
    // than waiting to be pushed. This does the same for the dialer inbox, so
    // it works regardless of workflow configuration and regardless of WHICH
    // of the location's numbers the conversation is bound to.
    if (action === 'sync_thread') {
      const phone = toE164(body?.to || '');
      if (!phone) return json(req, { ok: false, error: 'A valid 10-digit US number is required.' }, 400);

      const { data: conns0 } = await admin.from('ghl_connections')
        .select('location_id, access_token, refresh_token, expires_at');
      if (!conns0?.length) return json(req, { ok: false, error: 'No GoHighLevel location is connected.' }, 503);
      const c0 = conns0[0];
      const tok = await getValidAccessToken(admin, c0);
      if (!tok) return json(req, { ok: false, error: 'Could not obtain a GoHighLevel access token.' }, 502);
      const h = { Authorization: `Bearer ${tok}`, Accept: 'application/json', Version: '2021-07-28' };

      // Resolve the contact. upsert rather than search: it returns the id for
      // an existing contact and creates nothing new for one we already have.
      const cRes = await fetch('https://services.leadconnectorhq.com/contacts/upsert', {
        method: 'POST',
        headers: { ...h, 'Content-Type': 'application/json' },
        body: JSON.stringify({ locationId: c0.location_id, phone }),
      });
      const cBody = await cRes.json().catch(() => null);
      const cid = cBody?.contact?.id || cBody?.id || null;
      if (!cid) return json(req, { ok: true, synced: 0, note: 'No GoHighLevel contact for that number.' });

      const convRes = await fetch(
        `https://services.leadconnectorhq.com/conversations/search?locationId=${encodeURIComponent(c0.location_id)}&contactId=${encodeURIComponent(cid)}&limit=1`,
        { headers: h });
      const convBody = await convRes.json().catch(() => null);
      const convId = (convBody?.conversations || convBody?.data || [])[0]?.id;
      if (!convId) return json(req, { ok: true, synced: 0, note: 'No conversation yet.' });

      const mRes = await fetch(
        `https://services.leadconnectorhq.com/conversations/${encodeURIComponent(convId)}/messages?limit=100`,
        { headers: h });
      const mBody = await mRes.json().catch(() => null);
      // GHL nests this as { messages: { messages: [...] } } on some
      // deliveries and flat { messages: [...] } on others -- the same
      // inconsistency ghl-api's lookup_contact_activity already handles.
      const list = mBody?.messages?.messages || mBody?.messages || mBody?.data || [];

      // Skip anything ghl_messages already has: a message sent from here is
      // already recorded with the agent's user_id, and re-storing it without
      // that attribution would show the same text twice and lose who sent it.
      const ids = list.map((m: any) => m.id).filter(Boolean);
      const { data: known } = ids.length
        ? await admin.from('ghl_messages').select('ghl_message_id').in('ghl_message_id', ids)
        : { data: [] as any[] };
      const knownSet = new Set((known || []).map((k: any) => k.ghl_message_id));

      const rows = list
        .filter((m: any) => m.id && !knownSet.has(m.id))
        .filter((m: any) => (m.body ?? m.message ?? '').toString().trim() !== '')
        .map((m: any) => ({
          provider: 'ghl',
          provider_message_id: m.id,
          direction: String(m.direction || '').toLowerCase() === 'inbound' ? 'inbound' : 'outbound',
          contact_phone: phone,
          body: (m.body ?? m.message ?? '').toString(),
          // Left null deliberately: GHL does not tell us which of OUR users
          // sent an outbound it pulled back. Attribution for anything sent
          // from here already lives on the ghl_messages row.
          user_id: null,
          message_at: m.dateAdded || m.dateUpdated || new Date().toISOString(),
          raw: m,
        }));

      if (rows.length) {
        const { error: upErr } = await admin.from('dialer_sms_messages')
          .upsert(rows, { onConflict: 'provider_message_id' });
        if (upErr) return json(req, { ok: false, error: upErr.message }, 500);
      }
      return json(req, { ok: true, synced: rows.length, conversation_id: convId });
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
