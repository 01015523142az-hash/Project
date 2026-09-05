// supabase/functions/dialer-telnyx-webhook/index.ts
//
// Receives Telnyx Call Control webhooks and writes the call-detail record
// into dialer_attempts (v523). This function is the ONLY writer of that
// table — dialer_attempts is the compliance record, so its RLS grants
// insert/update to service_role only and no browser can author or amend a
// row. See v523's header.
//
// AUTHENTICATION — Ed25519, not a shared secret:
//   Telnyx signs every delivery with two headers:
//     telnyx-signature-ed25519 : base64 Ed25519 signature
//     telnyx-timestamp         : unix seconds
//   The signed message is `${timestamp}|${raw body}` — the timestamp IS
//   part of the payload. (Several third-party guides show verifying the
//   body alone; that is wrong and rejects every valid delivery.) The public
//   key is your account's, from Mission Control -> Account Settings ->
//   Keys & Credentials -> Public Key, base64.
//
//   Verification MUST use the exact bytes received. Do not JSON.parse and
//   re-serialise before verifying — key order and whitespace are not
//   preserved and the signature will never match.
//
// Deploy WITHOUT JWT verification, since Telnyx cannot send a Supabase auth
// token — this function authenticates the request itself via the signature,
// exactly as readymode-email-import does with its Mailgun HMAC:
//   supabase functions deploy dialer-telnyx-webhook --no-verify-jwt
//
// Required secrets:
//   supabase secrets set TELNYX_PUBLIC_KEY=<base64 public key>
//
// EVENTS HANDLED (Call Control):
//   call.initiated                 -> upsert the attempt row, status ringing
//   call.answered                  -> answered_at, status answered
//   call.machine.detection.ended   -> amd_result
//   call.hangup                    -> final status, timings, billed seconds
//   call.recording.saved           -> recording_path
// Anything else is acknowledged and ignored — Telnyx retries non-2xx, so an
// unknown event type must still return 200 or it retries forever.

import { createClient } from 'jsr:@supabase/supabase-js@2';

// No CORS block here on purpose: this endpoint is called server-to-server
// by Telnyx, never from a browser. Adding permissive CORS would only widen
// the surface.

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Telnyx signs `${timestamp}|${rawBody}` with Ed25519. Deno's Web Crypto
// supports Ed25519 natively, so no third-party crypto dependency.
async function verifyTelnyxSignature(
  rawBody: string,
  signatureB64: string,
  timestamp: string,
  publicKeyB64: string,
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
    console.error('dialer-telnyx-webhook: signature verification threw:', e);
    return false;
  }
}

// A valid signature never expires on its own, so a captured delivery could
// be replayed forever. Telnyx documents a 5-minute tolerance; same reasoning
// (and same window) as readymode-email-import's Mailgun timestamp check.
const TIMESTAMP_MAX_SKEW_SECONDS = 5 * 60;
function isTimestampFresh(timestamp: string): boolean {
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  return Math.abs(Date.now() / 1000 - ts) <= TIMESTAMP_MAX_SKEW_SECONDS;
}

// Telnyx hangup causes -> our dialer_attempts.status vocabulary (v523).
function statusFromHangupCause(cause: string | null | undefined): string {
  switch ((cause || '').toLowerCase()) {
    case 'normal_clearing':
    case 'originator_cancel':   return 'completed';
    case 'user_busy':           return 'busy';
    case 'no_answer':
    case 'timeout':
    case 'unallocated_number':  return 'no_answer';
    case 'call_rejected':       return 'no_answer';
    default:                    return 'failed';
  }
}

// Telnyx AMD verdicts -> our amd_result check constraint (v523).
function normaliseAmd(result: string | null | undefined): string | null {
  switch ((result || '').toLowerCase()) {
    case 'human':     return 'human';
    case 'machine':   return 'machine';
    case 'not_sure':  return 'not_sure';
    case 'silence':   return 'silence';
    default:          return result ? 'unknown' : null;
  }
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405);

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
  const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const TELNYX_PUBLIC_KEY = Deno.env.get('TELNYX_PUBLIC_KEY');

  // Refuse everything until the key is configured. An unauthenticated
  // webhook that writes the compliance record is worse than a broken one.
  if (!TELNYX_PUBLIC_KEY) {
    console.error('dialer-telnyx-webhook: TELNYX_PUBLIC_KEY is not set — refusing all requests until it is.');
    return json({ ok: false, error: 'Webhook not configured' }, 503);
  }

  // Read the body ONCE, as text, and verify those exact bytes.
  const rawBody = await req.text();

  const signature = req.headers.get('telnyx-signature-ed25519')
    || req.headers.get('Telnyx-Signature-Ed25519');
  const timestamp = req.headers.get('telnyx-timestamp')
    || req.headers.get('Telnyx-Timestamp');

  if (!signature || !timestamp) {
    return json({ ok: false, error: 'Missing Telnyx signature headers' }, 401);
  }
  if (!isTimestampFresh(timestamp)) {
    console.warn('dialer-telnyx-webhook: stale timestamp', timestamp);
    return json({ ok: false, error: 'Stale webhook timestamp' }, 401);
  }
  if (!await verifyTelnyxSignature(rawBody, signature, timestamp, TELNYX_PUBLIC_KEY)) {
    console.warn('dialer-telnyx-webhook: signature verification failed');
    return json({ ok: false, error: 'Invalid signature' }, 401);
  }

  let payload: any;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return json({ ok: false, error: 'Body is not JSON' }, 400);
  }

  const eventType: string = payload?.data?.event_type || '';
  const p = payload?.data?.payload || {};
  const callControlId: string | null = p.call_control_id ?? null;

  if (!callControlId) {
    // Nothing we can correlate. Ack so Telnyx stops retrying.
    console.warn('dialer-telnyx-webhook: no call_control_id on', eventType);
    return json({ ok: true, ignored: eventType });
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE);
  const nowIso = new Date().toISOString();

  try {
    // The dial is created by dialer-call-control, which writes the
    // dialer_attempts row up front with provider_call_id set. Every event
    // here therefore updates an existing row; a miss means the row was
    // never written (a call placed outside the portal, or a race with the
    // dial insert), which is worth logging rather than silently creating a
    // half-populated CDR.
    let { data: attempt } = await admin
      .from('dialer_attempts')
      .select('id, from_did_id, answered_at, initiated_at')
      .eq('provider_call_id', callControlId)
      .maybeSingle();

    // PRIMARY correlation path, not a fallback. The console cannot tell us
    // the call_control_id: the WebRTC SDK only exposes its own client-side
    // UUID, which is a different identifier entirely. (The console used to
    // report that UUID here; it matched nothing, and worse, writing it made
    // provider_call_id non-null which disabled this path too.) So we match
    // on the newest uncorrelated attempt to this number within two minutes,
    // then backfill the real Telnyx id below so every later event on the
    // same call matches directly.
    if (!attempt) {
      // Two-minute window rather than ten. At one line per agent a second
      // legitimate call to the same number inside two minutes cannot happen,
      // so the newest uncorrelated attempt is unambiguous — while a ten
      // minute window during repeat testing genuinely was ambiguous, and the
      // old "exactly one candidate" rule then matched nothing at all.
      const since = new Date(Date.now() - 2 * 60 * 1000).toISOString();
      const candidateNumber = p.to || p.from || null;
      if (candidateNumber) {
        // "Uncorrelated" means null OR a value that cannot possibly be a
        // Telnyx id. A real call_control_id always starts `v3:` (confirmed
        // live: v3:BgPe22NPcYjb...). Anything else is the WebRTC SDK's own
        // client-side UUID, written by a stale cached copy of the console.
        // Treating those as uncorrelated makes the pipeline self-healing:
        // a browser still running pre-fix JS no longer silently breaks the
        // compliance record, it just gets corrected here.
        const { data: candidates } = await admin
          .from('dialer_attempts')
          .select('id, from_did_id, answered_at, initiated_at')
          .eq('to_number', candidateNumber)
          .or('provider_call_id.is.null,provider_call_id.not.like.v3:*')
          .gte('initiated_at', since)
          .order('initiated_at', { ascending: false })
          .limit(1);

        if (candidates && candidates.length === 1) {
          attempt = candidates[0];
          // Backfill the REAL Telnyx id so every subsequent event on this
          // call matches directly and never re-enters this fallback.
          await admin.from('dialer_attempts')
            .update({ provider_call_id: callControlId }).eq('id', attempt.id);
          console.warn('dialer-telnyx-webhook: correlated', callControlId,
                       'to attempt', attempt.id, 'by fallback match');
        }
      }
    }

    if (!attempt) {
      console.warn('dialer-telnyx-webhook: no dialer_attempts row for call', callControlId, 'event', eventType);
      return json({ ok: true, unmatched: callControlId });
    }

    const update: Record<string, unknown> = {};

    switch (eventType) {
      case 'call.initiated':
        update.status = 'ringing';
        update.provider_leg_id = p.call_leg_id ?? null;
        break;

      case 'call.answered':
        update.status = 'answered';
        update.answered_at = nowIso;
        break;

      case 'call.machine.detection.ended':
        update.amd_result = normaliseAmd(p.result);
        break;

      case 'call.recording.saved': {
        // Telnyx offers several formats; prefer mp3 for size, fall back to wav.
        const urls = p.recording_urls || p.public_recording_urls || {};
        update.recording_path = urls.mp3 || urls.wav || null;
        break;
      }

      case 'call.hangup': {
        const endedAtIso = nowIso;
        update.status = statusFromHangupCause(p.hangup_cause);
        update.ended_at = endedAtIso;
        update.hangup_cause = p.hangup_cause ?? null;

        // Talk time is answer -> hangup. Billed time is what the carrier
        // charges: whole minutes rounded UP, minimum one, and only on calls
        // that actually answered. The two diverge sharply here — a
        // 15-second voicemail leg is 60 billed seconds — which is exactly
        // why v523 stores them separately.
        if (attempt.answered_at) {
          const talkSeconds = Math.max(
            0,
            Math.round((Date.parse(endedAtIso) - Date.parse(attempt.answered_at as string)) / 1000),
          );
          update.talk_seconds = talkSeconds;
          update.billed_seconds = Math.max(60, Math.ceil(talkSeconds / 60) * 60);
        } else {
          update.talk_seconds = 0;
          update.billed_seconds = 0;
        }

        // ABANDONMENT. At one line per agent this must always be false: the
        // agent is bridged before the contact's phone rings, so a live
        // answer with nobody there cannot occur by design. The residual
        // case is the agent's leg dying while the contact leg is still up —
        // detected here as "the contact answered, and the reason we hung up
        // was not a normal clearing". Written from the actual outcome,
        // never inferred later, per v523.
        //
        // If this column ever starts reading true in production, something
        // is broken in the bridge path — treat it as an incident, not as a
        // pacing figure to tune.
        if (p.hangup_source === 'callee' || !attempt.answered_at) {
          update.was_abandoned = false;
        } else {
          const cause = (p.hangup_cause || '').toLowerCase();
          update.was_abandoned = Boolean(attempt.answered_at) && cause !== 'normal_clearing';
        }
        break;
      }

      default:
        // Ack unknown events. Telnyx retries anything non-2xx, so returning
        // an error here would loop forever on an event we simply don't use.
        return json({ ok: true, ignored: eventType });
    }

    // Keep the raw payload of the terminal event for debugging a call whose
    // mapped columns look wrong — same reasoning skip_trace_results.raw has.
    if (eventType === 'call.hangup') update.raw = payload;

    const { error: upErr } = await admin
      .from('dialer_attempts').update(update).eq('id', attempt.id);

    if (upErr) {
      // Return 500 so Telnyx retries — losing a hangup event means losing
      // the billed duration and the abandonment record for that call.
      console.error('dialer-telnyx-webhook: update failed', eventType, upErr.message);
      return json({ ok: false, error: 'Failed to record call event' }, 500);
    }

    // Per-DID answer counters feed the autopilot's early-warning signal
    // (Phase 1.3): a number whose answer rate falls well below the pool
    // median is almost certainly flagged before any monitoring vendor says
    // so. Recomputed from dialer_attempts rather than incremented here, so
    // a missed webhook cannot permanently skew the figure.

    return json({ ok: true, event: eventType });
  } catch (e) {
    console.error('dialer-telnyx-webhook: unhandled', e);
    return json({ ok: false, error: e instanceof Error ? e.message : 'Unexpected error' }, 500);
  }
});
