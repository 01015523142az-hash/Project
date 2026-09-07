// supabase/functions/dialer-fs-cdr/index.ts
//
// Ingests FreeSWITCH call detail records (v554).
//
// mod_json_cdr posts one document per finished channel. This closes the
// matching dialer_attempts row: outcome, timings, billed seconds and hangup
// cause -- the same columns dialer-telnyx-webhook fills for the Telnyx path,
// so the Call log and every report keep working unchanged.
//
// THE BILLING INCREMENT IS THE WHOLE POINT OF THIS PROJECT, so it is worth
// being explicit. dialer-telnyx-webhook hard-codes Telnyx's rule:
//
//     billed_seconds = Math.max(60, Math.ceil(talkSeconds / 60) * 60)
//
// 60/60 -- every call rounds up to a whole minute, minimum one. On an
// 18-second average that is what makes our effective rate 3.3x the sticker
// price. Here the increment comes from FS_BILLING_INCREMENT because it is a
// CONTRACT TERM, not a law of physics: the carrier's rate sheet decides it,
// and rate sheets get renegotiated. Baking 6 into the code would leave
// somebody hunting for it the day the contract changes.
//
// IDEMPOTENCY. FreeSWITCH retries a CDR it did not get a 2xx for, and a
// Supabase cold start can outrun the retry window. The row is found by
// provider_call_id -- the channel uuid, written at resolve time by
// dialer_fs_resolve_attempt and protected by the v551 unique index -- and
// only updated while ended_at is still null. A retry after a successful
// write is therefore a no-op rather than a second set of timings.
//
// Deploy:
//   supabase functions deploy dialer-fs-cdr --no-verify-jwt

import { createClient } from 'jsr:@supabase/supabase-js@2';

// FreeSWITCH hangup causes -> the v523 status vocabulary. Anything not named
// here is 'failed', which is the honest answer for a cause we have not seen
// before: it shows up in the Call log rather than silently looking normal.
const CAUSE_STATUS: Record<string, string> = {
  NORMAL_CLEARING:            'completed',
  USER_BUSY:                  'busy',
  NO_ANSWER:                  'no_answer',
  NO_USER_RESPONSE:           'no_answer',
  ALLOTTED_TIMEOUT:           'no_answer',
  SUBSCRIBER_ABSENT:          'no_answer',
  ORIGINATOR_CANCEL:          'canceled',
  LOSE_RACE:                  'canceled',
  CALL_REJECTED:              'failed',
  NORMAL_TEMPORARY_FAILURE:   'failed',
  RECOVERY_ON_TIMER_EXPIRE:   'failed',
  NETWORK_OUT_OF_ORDER:       'failed',
  DESTINATION_OUT_OF_ORDER:   'failed',
  INVALID_NUMBER_FORMAT:      'failed',
  UNALLOCATED_NUMBER:         'failed',
};

function secretOk(given: string, expected: string): boolean {
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

function presentedSecret(req: Request): string {
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

// FreeSWITCH timestamps are microseconds since epoch, as strings, and are
// "0" (not absent) for something that never happened -- an unanswered call
// has answer_stamp "0". Treat 0 as null or every missed call gets an
// answered_at of 1970.
function usecToIso(raw: unknown): string | null {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n / 1000).toISOString();
}

function intOf(raw: unknown): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('method not allowed', { status: 405 });
  }

  const SECRET = Deno.env.get('FS_XML_SECRET');
  if (!SECRET) {
    console.error('dialer-fs-cdr: FS_XML_SECRET is not set; refusing all requests');
    return new Response('not configured', { status: 503 });
  }
  if (!secretOk(presentedSecret(req), SECRET)) {
    console.warn('dialer-fs-cdr: bad or missing secret');
    return new Response('unauthorized', { status: 401 });
  }

  // A non-2xx makes FreeSWITCH queue and retry. That is right for a genuine
  // failure and wrong for a CDR we will never be able to use, so a record we
  // cannot parse or do not recognise is answered 200 and dropped.
  const INCREMENT = Math.max(1, intOf(Deno.env.get('FS_BILLING_INCREMENT')) || 6);

  try {
    const raw = await req.text();
    let doc: Record<string, unknown>;
    try {
      // mod_json_cdr posts the JSON as the body; some builds form-encode it
      // under cdr=. Accept both rather than depend on the build.
      doc = raw.trimStart().startsWith('{')
        ? JSON.parse(raw)
        : JSON.parse(new URLSearchParams(raw).get('cdr') || '{}');
    } catch {
      console.warn('dialer-fs-cdr: unparseable body, dropping');
      return new Response('ok', { status: 200 });
    }

    const v = (doc.variables ?? {}) as Record<string, unknown>;
    const uuid = String(v.uuid || v.call_uuid || '');
    const attemptId = String(v.dialer_attempt_id || '');

    if (!uuid) {
      console.warn('dialer-fs-cdr: no channel uuid, dropping');
      return new Response('ok', { status: 200 });
    }
    // Channels that are not dialer attempts reach here too -- the inbound leg
    // Telnyx sends us, for one. Nothing to close.
    if (!attemptId) return new Response('ok', { status: 200 });

    const billsec = intOf(v.billsec);
    const cause = String(v.hangup_cause || 'NORMAL_CLEARING');
    const answeredAt = usecToIso(v.answer_stamp);

    // A call that answered but hung up instantly still answered. Trust the
    // timestamp over the cause, because the cause of a two-second call and a
    // two-minute one is the same NORMAL_CLEARING.
    let status = CAUSE_STATUS[cause] ?? 'failed';
    if (status === 'completed' && !answeredAt) status = 'no_answer';

    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      { auth: { persistSession: false } },
    );

    const { data, error } = await admin
      .from('dialer_attempts')
      .update({
        status,
        answered_at: answeredAt,
        ended_at: usecToIso(v.end_stamp) ?? new Date().toISOString(),
        hangup_cause: cause,
        // Rounded on the TRUNK's increment. See the header: this is the
        // number the whole migration exists to change.
        billed_seconds: billsec > 0 ? Math.ceil(billsec / INCREMENT) * INCREMENT : 0,
      })
      .eq('provider_call_id', uuid)
      .is('ended_at', null)          // idempotency: a retry finds nothing
      .select('id, contact_id, to_number')
      .maybeSingle();

    if (error) {
      // A real failure -- let FreeSWITCH retry.
      console.error('dialer-fs-cdr: update failed', error.message);
      return new Response('retry', { status: 500 });
    }
    if (!data) {
      // Either already closed by an earlier delivery, or no such channel.
      // Both are terminal; do not make FreeSWITCH keep trying.
      console.log(`dialer-fs-cdr: no open row for ${uuid} (already closed or unknown)`);
      return new Response('ok', { status: 200 });
    }

    // A dead number, told to us by the carrier, for free. The same retirement
    // dialer-telnyx-webhook does on its own path -- this is what pre-dial
    // validation was mostly being paid for, learned one dial later instead of
    // one dial earlier. Retire the LINE where the contact has several, the
    // contact where it does not.
    if ((cause === 'UNALLOCATED_NUMBER' || cause === 'INVALID_NUMBER_FORMAT')
        && data.contact_id && data.to_number) {
      const nowIso = new Date().toISOString();
      const { data: line } = await admin.from('dialer_contact_phones')
        .update({
          status: 'invalid', phone_valid: false,
          next_attempt_at: null, last_outcome: cause.toLowerCase(),
          updated_at: nowIso,
        })
        .eq('contact_id', data.contact_id)
        .eq('phone_e164', data.to_number)
        .select('id');
      if (!line?.length) {
        await admin.from('dialer_contacts')
          .update({
            status: 'invalid', phone_valid: false,
            retired_reason: cause.toLowerCase(),
            next_attempt_at: null, updated_at: nowIso,
          })
          .eq('id', data.contact_id)
          .eq('phone_e164', data.to_number);
      }
    }

    console.log(`dialer-fs-cdr: closed ${data.id} ${status} billsec=${billsec} -> ${Math.ceil(billsec / INCREMENT) * INCREMENT}s`);
    return new Response('ok', { status: 200 });
  } catch (e) {
    console.error('dialer-fs-cdr: unhandled', e instanceof Error ? e.message : String(e));
    return new Response('retry', { status: 500 });
  }
});
