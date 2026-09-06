// supabase/functions/telnyx-sms-webhook/index.ts
//
// Inbound SMS/MMS and delivery receipts from Telnyx, so Telnyx messaging can
// run alongside the GHL number rather than replacing it.
//
// WEBHOOK URL to set on the Telnyx Messaging Profile:
//   https://<project-ref>.supabase.co/functions/v1/telnyx-sms-webhook
//
// Deploy WITHOUT JWT verification -- Telnyx cannot send a Supabase token; this
// function authenticates the request itself via Telnyx's Ed25519 signature,
// exactly as dialer-telnyx-webhook does for voice:
//   supabase functions deploy telnyx-sms-webhook --no-verify-jwt
//
// Uses the SAME TELNYX_PUBLIC_KEY secret as the voice webhook -- the key is
// per account, not per product.
//
// SIGNATURE: the signed message is `${timestamp}|${raw body}`, base64
// Ed25519, 5-minute replay window. The timestamp IS part of the payload;
// several third-party guides show verifying the body alone, which rejects
// every valid delivery.
//
// TWO-SECOND RULE: Telnyx expects a 2xx within two seconds and retries
// otherwise. So this function does one insert and returns -- no lookups, no
// enrichment. provider_message_id is unique, so a retry updates rather than
// duplicating.
//
// EVENTS:
//   message.received   -> an inbound text; the one that matters
//   message.sent       -> outbound accepted by the carrier
//   message.finalized  -> final delivery state (delivered / delivery_failed)
//
// WHY A SEPARATE TABLE FROM ghl_messages: that table predates the dialer, is
// written by ghl-webhook, and is shared with client chat. Repointing it would
// break those. Telnyx lands in dialer_sms_messages instead, and v544's inbox
// RPCs union the two -- otherwise a contact texted on one provider and
// replying on the other would show as two unrelated conversations.

import { createClient } from 'jsr:@supabase/supabase-js@2';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}

async function verifyTelnyxSignature(
  rawBody: string, signatureB64: string, timestamp: string, publicKeyB64: string,
): Promise<boolean> {
  try {
    const keyBytes = Uint8Array.from(atob(publicKeyB64), (c) => c.charCodeAt(0));
    const sigBytes = Uint8Array.from(atob(signatureB64), (c) => c.charCodeAt(0));
    const key = await crypto.subtle.importKey(
      'raw', keyBytes, { name: 'Ed25519' }, false, ['verify'],
    );
    const signed = new TextEncoder().encode(`${timestamp}|${rawBody}`);
    return await crypto.subtle.verify({ name: 'Ed25519' }, key, sigBytes, signed);
  } catch (e) {
    console.error('telnyx-sms-webhook: signature verification threw:', e);
    return false;
  }
}

const TIMESTAMP_MAX_SKEW_SECONDS = 5 * 60;
function isTimestampFresh(timestamp: string): boolean {
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  return Math.abs(Date.now() / 1000 - ts) <= TIMESTAMP_MAX_SKEW_SECONDS;
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405);

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
  const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const TELNYX_PUBLIC_KEY = Deno.env.get('TELNYX_PUBLIC_KEY');

  // Refuse everything until the key is set. An unauthenticated writer to a
  // message store is worse than a broken one.
  if (!TELNYX_PUBLIC_KEY) {
    console.error('telnyx-sms-webhook: TELNYX_PUBLIC_KEY is not set — refusing all requests.');
    return json({ ok: false, error: 'Webhook not configured' }, 503);
  }

  // Read the body ONCE as text and verify those exact bytes. Do not parse and
  // re-serialise first: key order and whitespace are not preserved and the
  // signature will never match.
  const rawBody = await req.text();
  const signature = req.headers.get('telnyx-signature-ed25519')
    || req.headers.get('Telnyx-Signature-Ed25519');
  const timestamp = req.headers.get('telnyx-timestamp')
    || req.headers.get('Telnyx-Timestamp');

  if (!signature || !timestamp) {
    return json({ ok: false, error: 'Missing Telnyx signature headers' }, 401);
  }
  if (!isTimestampFresh(timestamp)) {
    console.warn('telnyx-sms-webhook: stale timestamp', timestamp);
    return json({ ok: false, error: 'Stale webhook timestamp' }, 401);
  }
  if (!await verifyTelnyxSignature(rawBody, signature, timestamp, TELNYX_PUBLIC_KEY)) {
    console.warn('telnyx-sms-webhook: signature verification failed');
    return json({ ok: false, error: 'Invalid signature' }, 401);
  }

  let payload: any;
  try { payload = JSON.parse(rawBody); }
  catch { return json({ ok: false, error: 'Body is not JSON' }, 400); }

  const eventType: string = payload?.data?.event_type || '';
  const p = payload?.data?.payload || {};
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE);

  try {
    // ---- delivery receipts -------------------------------------------------
    // Outbound rows are written by whatever sent them; these only stamp the
    // carrier's verdict onto an existing row. A receipt for a message we have
    // no row for is not an error -- it may predate this webhook.
    if (eventType === 'message.sent' || eventType === 'message.finalized') {
      const id = p.id ?? null;
      if (id) {
        await admin.from('dialer_sms_messages')
          .update({ delivery_status: p.to?.[0]?.status ?? eventType.split('.')[1] })
          .eq('provider_message_id', id);
      }
      return json({ ok: true, event: eventType });
    }

    if (eventType !== 'message.received') {
      // Ack anything else. Telnyx retries non-2xx, so an unknown event type
      // must still return 200 or it retries forever.
      return json({ ok: true, ignored: eventType });
    }

    // ---- inbound -----------------------------------------------------------
    const from = p.from?.phone_number ?? null;
    const to = Array.isArray(p.to) ? (p.to[0]?.phone_number ?? null) : null;
    if (!from) {
      console.warn('telnyx-sms-webhook: message.received with no from number');
      return json({ ok: true, ignored: 'no from' });
    }

    // MMS arrives with text empty and the content in media[]. Recording that
    // as a blank message would make a real inbound look like nothing was sent.
    const mediaCount = Array.isArray(p.media) ? p.media.length : 0;
    const body = (p.text && p.text.trim())
      || (mediaCount ? `[${mediaCount} attachment${mediaCount === 1 ? '' : 's'}]` : '');

    const { error } = await admin.from('dialer_sms_messages').upsert({
      provider: 'telnyx',
      provider_message_id: p.id ?? null,
      direction: 'inbound',
      from_number: from,
      to_number: to,
      // contact_phone is always the OTHER party, whichever way the message
      // went. That is what lets v544's RPCs thread GHL and Telnyx together.
      contact_phone: from,
      body,
      // user_id stays null: nobody here sent it. The thread still reaches the
      // right agent, because visibility is decided by whether they have sent
      // into that conversation, not by who owns each individual message.
      user_id: null,
      message_at: payload?.data?.occurred_at || new Date().toISOString(),
      raw: payload,
    }, { onConflict: 'provider_message_id' });

    if (error) {
      // 500 so Telnyx retries -- a dropped inbound message is a customer
      // reply nobody ever sees.
      console.error('telnyx-sms-webhook: insert failed', error.message);
      return json({ ok: false, error: 'Failed to record message' }, 500);
    }

    return json({ ok: true, event: eventType, from });
  } catch (e) {
    console.error('telnyx-sms-webhook: unhandled', e);
    return json({ ok: false, error: e instanceof Error ? e.message : 'Unexpected error' }, 500);
  }
});
