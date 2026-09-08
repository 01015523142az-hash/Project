// supabase/functions/dialer-inbound/index.ts
//
// Inbound call handling for the portal dialer (v549). Telnyx Call Control
// webhook: answers the caller, greets them, finds an agent, bridges the two
// legs, and falls through to voicemail when nobody picks up.
//
// WHY THIS IS A SEPARATE FUNCTION FROM dialer-telnyx-webhook:
//   that one is a RECORDER -- it writes call-detail rows and never talks back
//   to Telnyx. This one is a CONTROLLER: nearly every event it receives is
//   answered with a command. Mixing the two would put the compliance record
//   and the live call flow in one file where a bug in either takes out both.
//
// WHY IT DOES NOT TOUCH OUTBOUND:
//   outbound calls are originated by the agent's browser over a Credential
//   Connection and are not under Call Control at all. Making them
//   controllable needs `Park Outbound Calls`, which stops outbound calls
//   proceeding until a backend answers them -- Telnyx returns SIP 180 and the
//   call "awaits further orders", indefinitely if nothing comes. That flip is
//   deliberately not part of this. Nothing here can regress the working
//   dialer, because nothing here is on its path.
//
// AUTHENTICATION -- Ed25519, same as dialer-telnyx-webhook. The signed message
// is `${timestamp}|${raw body}`: the timestamp IS part of the payload, and the
// exact bytes received must be verified, so never JSON.parse and re-serialise
// before checking.
//
// Deploy WITHOUT JWT verification -- Telnyx cannot send a Supabase token:
//   supabase functions deploy dialer-inbound --no-verify-jwt
//
// Required secrets:
//   TELNYX_API_KEY               (already set, shared with dialer-telnyx-token)
//   TELNYX_PUBLIC_KEY            (already set, shared with the webhook)
//   TELNYX_CALL_CONTROL_APP_ID   NEW -- the Call Control Application's
//                                connection id, used to originate the agent leg
//
// THE CLOCK IS THE HOLD MUSIC. There is no cron and no server-side timer here:
// hold music is played in short loops, and each `call.playback.ended` is a tick
// on which we re-check for a free agent and compare elapsed time against the
// queue timeout. Every deadline in this file is therefore driven by an event
// Telnyx sends us, which is the only kind of timer a webhook function can
// actually rely on.

import { createClient } from 'jsr:@supabase/supabase-js@2';

// No CORS: Telnyx calls this server-to-server, never a browser.
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
    console.error('dialer-inbound: signature verification threw:', e);
    return false;
  }
}

const TIMESTAMP_MAX_SKEW_SECONDS = 5 * 60;
function isTimestampFresh(timestamp: string): boolean {
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  return Math.abs(Date.now() / 1000 - ts) <= TIMESTAMP_MAX_SKEW_SECONDS;
}

// ---------------------------------------------------------------------------
// client_state travels with the call and comes back on every event for that
// leg. Carrying our own ids in it is what lets an agent-leg event know which
// caller it belongs to without a lookup, and -- more importantly -- what tells
// the two legs apart, since both arrive on the same webhook.
// ---------------------------------------------------------------------------
// `m` is what we most recently asked this leg to do. Telnyx hands it back on
// the completion event, so `speak.ended` knows whether it just finished the
// greeting, the closed-hours line or the voicemail prompt -- three things that
// need three different next steps. Inferring it from database state instead
// would be guessing at which of several columns happened to be set.
type LegMode = 'greet' | 'closed' | 'hold' | 'vm';
type LegState = { r: 'caller' | 'agent'; a: string; q: string; o?: string; m?: LegMode };

function encodeState(s: LegState): string {
  return btoa(JSON.stringify(s));
}
function decodeState(raw: string | null | undefined): LegState | null {
  if (!raw) return null;
  try { return JSON.parse(atob(raw)); } catch { return null; }
}

// ---------------------------------------------------------------------------
// Call Control commands. Every one returns rather than throws: a failed
// command must not take down the webhook, because Telnyx retries non-2xx
// deliveries and a retry storm on a live call is worse than a dropped command.
// ---------------------------------------------------------------------------
async function cmd(apiKey: string, callControlId: string, action: string, body: unknown = {}) {
  try {
    const res = await fetch(
      `https://api.telnyx.com/v2/calls/${encodeURIComponent(callControlId)}/actions/${action}`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
    if (!res.ok) {
      console.error(`dialer-inbound: ${action} failed`, res.status, await res.text());
      return null;
    }
    return await res.json().catch(() => ({}));
  } catch (e) {
    console.error(`dialer-inbound: ${action} threw`, e);
    return null;
  }
}

async function dialAgent(
  apiKey: string, appId: string, to: string, from: string,
  timeoutSecs: number, state: LegState,
) {
  try {
    const res = await fetch('https://api.telnyx.com/v2/calls', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        connection_id: appId,
        to, from,
        timeout_secs: timeoutSecs,
        client_state: encodeState(state),
      }),
    });
    if (!res.ok) {
      console.error('dialer-inbound: dial agent failed', res.status, await res.text());
      return null;
    }
    const body = await res.json();
    return body?.data?.call_control_id ?? null;
  } catch (e) {
    console.error('dialer-inbound: dial agent threw', e);
    return null;
  }
}

const SPEAK = { voice: 'female', language: 'en-US' } as const;

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405);

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
  const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const TELNYX_API_KEY = Deno.env.get('TELNYX_API_KEY');
  const TELNYX_PUBLIC_KEY = Deno.env.get('TELNYX_PUBLIC_KEY');
  const APP_ID = Deno.env.get('TELNYX_CALL_CONTROL_APP_ID');

  const rawBody = await req.text();

  // ---- authenticate the delivery -----------------------------------------
  const sig = req.headers.get('telnyx-signature-ed25519') || '';
  const ts = req.headers.get('telnyx-timestamp') || '';
  if (!TELNYX_PUBLIC_KEY) {
    console.error('dialer-inbound: TELNYX_PUBLIC_KEY not set; refusing to trust the delivery');
    return json({ ok: false }, 500);
  }
  if (!isTimestampFresh(ts)) return json({ ok: false, error: 'stale timestamp' }, 401);
  if (!await verifyTelnyxSignature(rawBody, sig, ts, TELNYX_PUBLIC_KEY)) {
    return json({ ok: false, error: 'bad signature' }, 401);
  }

  const payload = JSON.parse(rawBody);
  const eventType: string = payload?.data?.event_type || '';
  const p = payload?.data?.payload || {};
  const ccId: string = p?.call_control_id || '';
  const state = decodeState(p?.client_state);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE);

  if (!TELNYX_API_KEY || !APP_ID) {
    console.error('dialer-inbound: TELNYX_API_KEY / TELNYX_CALL_CONTROL_APP_ID not set');
    // Still 200: an unacknowledged delivery is retried forever.
    return json({ ok: true, ignored: 'not configured' });
  }

  // -------------------------------------------------------------------------
  // Ring the next agent who can take this call, or start hold music.
  // Agents already offered THIS call are excluded, so a queue of three does
  // not ring the same person three times while two others sit idle.
  // -------------------------------------------------------------------------
  async function offerToNextAgent(attemptId: string, queue: any, callerCcId: string, fromNumber: string) {
    const { data: agents } = await admin.rpc('dialer_available_agents', { p_queue: queue.id });
    const { data: already } = await admin
      .from('dialer_inbound_offers').select('agent_id').eq('attempt_id', attemptId);
    const tried = new Set((already || []).map((o: any) => o.agent_id));
    const next = (agents || []).find((a: any) => !tried.has(a.agent_id));

    if (!next) {
      await startHold(attemptId, queue, callerCcId);
      return;
    }

    const { data: offer } = await admin.from('dialer_inbound_offers')
      .insert({ attempt_id: attemptId, agent_id: next.agent_id })
      .select('id').single();

    // WHICH SWITCH this agent is registered on is theirs, not ours to assume.
    // dialer_agent_sip_uri() (v554) returns the Telnyx URI while their
    // transport is 'telnyx' and the FreeSWITCH one once it is flipped.
    //
    // Hard-coding sip.telnyx.com here was a latent break in the FreeSWITCH
    // work: the moment anyone set transport='freeswitch', that agent's
    // OUTBOUND would work while their INBOUND rang a registration that no
    // longer existed. No error anywhere -- the leg would simply never be
    // answered, look like a timeout, and move to the next agent.
    const { data: agentUri } = await admin
      .rpc('dialer_agent_sip_uri', { p_agent: next.agent_id });

    if (!agentUri) {
      // Revoked credential, or none provisioned. Same treatment as a leg we
      // could not place: settle the offer and move on, rather than leaving
      // the caller waiting on an event that will never arrive.
      console.error('dialer-inbound: no SIP URI for agent', next.agent_id, '-- skipping');
      await admin.from('dialer_inbound_offers')
        .update({ result: 'failed', settled_at: new Date().toISOString() })
        .eq('id', offer?.id);
      await offerToNextAgent(attemptId, queue, callerCcId, fromNumber);
      return;
    }

    const agentCcId = await dialAgent(
      TELNYX_API_KEY!, APP_ID!,
      agentUri,
      fromNumber,
      queue.ring_timeout_seconds,
      { r: 'agent', a: attemptId, q: queue.id, o: offer?.id },
    );

    if (!agentCcId) {
      // Could not even place the leg -- do not leave the caller in silence
      // waiting for an event that will never arrive.
      await admin.from('dialer_inbound_offers')
        .update({ result: 'failed', settled_at: new Date().toISOString() })
        .eq('id', offer?.id);
      await offerToNextAgent(attemptId, queue, callerCcId, fromNumber);
      return;
    }
    await admin.from('dialer_inbound_offers')
      .update({ call_control_id: agentCcId }).eq('id', offer?.id);
  }

  // Hold music doubles as the queue clock -- see the header.
  async function startHold(attemptId: string, queue: any, callerCcId: string) {
    const st = encodeState({ r: 'caller', a: attemptId, q: queue.id, m: 'hold' });
    if (queue.hold_music_url) {
      await cmd(TELNYX_API_KEY!, callerCcId, 'playback_start', {
        audio_url: queue.hold_music_url, client_state: st,
      });
    } else {
      // No hold music configured: speak a short line instead, so the tick
      // still arrives and the caller is not left in silence wondering.
      await cmd(TELNYX_API_KEY!, callerCcId, 'speak', {
        ...SPEAK, payload: 'Please continue to hold.', client_state: st,
      });
    }
  }

  async function toVoicemail(attemptId: string, queue: any, callerCcId: string) {
    await admin.from('dialer_attempts')
      .update({ left_voicemail: true }).eq('id', attemptId);
    await cmd(TELNYX_API_KEY!, callerCcId, 'speak', {
      ...SPEAK, payload: queue.voicemail_prompt_text,
      client_state: encodeState({ r: 'caller', a: attemptId, q: queue.id, m: 'vm' }),
    });
  }

  async function loadQueue(id: string) {
    const { data } = await admin.from('dialer_inbound_queues')
      .select('*').eq('id', id).maybeSingle();
    return data;
  }

  try {
    switch (eventType) {
      // ---------------------------------------------------------------------
      case 'call.initiated': {
        // Only inbound legs we did not originate. The agent leg we dial also
        // produces call.initiated, and it carries our client_state.
        if (state?.r === 'agent') break;
        if ((p.direction || '') !== 'incoming') break;

        const { data: queueId } = await admin
          .rpc('dialer_queue_for_number', { p_to: p.to });
        if (!queueId) {
          console.error('dialer-inbound: no queue for', p.to, '-- rejecting');
          await cmd(TELNYX_API_KEY, ccId, 'reject', { cause: 'CALL_REJECTED' });
          break;
        }

        // IDEMPOTENT ON PURPOSE. Telnyx retries any delivery it does not get a
        // 2xx for within the webhook timeout, and a cold start can outrun a
        // short one. Inserting unconditionally would then open a SECOND CDR row
        // for the same call, answer it twice, and -- worse -- hand the retry's
        // attempt id to every later event, orphaning the first row with the
        // call's real history on it. call_control_id is unique per leg, so it
        // is the natural key to check, and v551 makes that a database rule so
        // two simultaneous retries cannot both pass this check.
        const { data: existing } = await admin.from('dialer_attempts')
          .select('id').eq('provider_call_id', ccId).maybeSingle();

        let attemptId: string;
        if (existing) {
          attemptId = existing.id;
        } else {
          const { data: created, error: insErr } = await admin.from('dialer_attempts').insert({
            direction: 'inbound',
            queue_id: queueId,
            from_number: p.from,
            to_number: p.to,
            provider_call_id: ccId,
            status: 'ringing',
          }).select('id').single();
          if (!created) {
            console.error('dialer-inbound: could not open attempt row', insErr?.message);
            break;
          }
          attemptId = created.id;
        }
        const attempt = { id: attemptId };

        await cmd(TELNYX_API_KEY, ccId, 'answer', {
          client_state: encodeState({ r: 'caller', a: attempt.id, q: queueId }),
        });
        break;
      }

      // ---------------------------------------------------------------------
      case 'call.answered': {
        if (!state) break;

        // --- the AGENT picked up: join the two legs ------------------------
        if (state.r === 'agent') {
          const { data: attempt } = await admin.from('dialer_attempts')
            .select('id, provider_call_id, answered_at')
            .eq('id', state.a).maybeSingle();
          if (!attempt) break;

          // Someone else got there first (two agents answering at once, or
          // the caller hung up). Politely end this leg rather than bridging
          // a call that is already handled.
          if (attempt.answered_at) {
            await cmd(TELNYX_API_KEY, ccId, 'hangup');
            break;
          }

          const { data: offer } = await admin.from('dialer_inbound_offers')
            .update({ result: 'answered', settled_at: new Date().toISOString() })
            .eq('id', state.o).select('agent_id').single();

          await admin.from('dialer_attempts').update({
            answered_at: new Date().toISOString(),
            status: 'answered',
            agent_id: offer?.agent_id ?? null,
          }).eq('id', state.a);

          await cmd(TELNYX_API_KEY, ccId, 'bridge', {
            call_control_id: attempt.provider_call_id,
          });
          break;
        }

        // --- the CALLER's leg is up: greet, or say we are closed -----------
        const queue = await loadQueue(state.q);
        if (!queue) break;

        const { data: open } = await admin
          .rpc('dialer_queue_is_open', { p_queue: state.q });
        if (!open) {
          await cmd(TELNYX_API_KEY, ccId, 'speak', {
            ...SPEAK, payload: queue.closed_message,
            client_state: encodeState({ r: 'caller', a: state.a, q: state.q, m: 'closed' }),
          });
          break;
        }

        await admin.from('dialer_attempts')
          .update({ enqueued_at: new Date().toISOString() }).eq('id', state.a);
        await cmd(TELNYX_API_KEY, ccId, 'speak', {
          ...SPEAK, payload: queue.greeting_text,
          client_state: encodeState({ r: 'caller', a: state.a, q: state.q, m: 'greet' }),
        });
        break;
      }

      // ---------------------------------------------------------------------
      // Greeting finished, or a hold-music loop ended. Either way it is a tick:
      // look for an agent, and check the caller has not been waiting too long.
      case 'call.speak.ended':
      case 'call.playback.ended': {
        if (!state || state.r !== 'caller') break;

        // The closed-hours line just finished playing: say goodbye properly
        // rather than leaving dead air.
        if (state.m === 'closed') {
          await cmd(TELNYX_API_KEY, ccId, 'hangup');
          break;
        }

        // The voicemail prompt just finished: start recording.
        if (state.m === 'vm') {
          await cmd(TELNYX_API_KEY, ccId, 'record_start', {
            format: 'mp3', channels: 'single',
            client_state: encodeState({ r: 'caller', a: state.a, q: state.q, m: 'vm' }),
          });
          break;
        }

        const { data: attempt } = await admin.from('dialer_attempts')
          .select('id, enqueued_at, answered_at, ended_at, from_number')
          .eq('id', state.a).maybeSingle();
        if (!attempt || attempt.answered_at || attempt.ended_at) break;

        const queue = await loadQueue(state.q);
        if (!queue) break;

        const waited = attempt.enqueued_at
          ? (Date.now() - new Date(attempt.enqueued_at).getTime()) / 1000 : 0;
        if (waited >= queue.queue_timeout_seconds) {
          await toVoicemail(state.a, queue, ccId);
          break;
        }

        await offerToNextAgent(state.a, queue, ccId, attempt.from_number);
        break;
      }

      // ---------------------------------------------------------------------
      case 'call.hangup': {
        if (!state) break;

        // --- an agent's leg ended -----------------------------------------
        if (state.r === 'agent') {
          const { data: offer } = await admin.from('dialer_inbound_offers')
            .select('id, result').eq('id', state.o).maybeSingle();
          // Already answered means this is just the bridged call ending.
          if (offer?.result === 'answered') break;

          await admin.from('dialer_inbound_offers')
            .update({ result: 'timeout', settled_at: new Date().toISOString() })
            .eq('id', state.o);

          const { data: attempt } = await admin.from('dialer_attempts')
            .select('id, provider_call_id, answered_at, ended_at, from_number')
            .eq('id', state.a).maybeSingle();
          if (!attempt || attempt.answered_at || attempt.ended_at) break;

          const queue = await loadQueue(state.q);
          if (queue) {
            await offerToNextAgent(state.a, queue, attempt.provider_call_id, attempt.from_number);
          }
          break;
        }

        // --- the caller hung up -------------------------------------------
        const { data: attempt } = await admin.from('dialer_attempts')
          .select('id, answered_at').eq('id', state.a).maybeSingle();

        // TIMINGS FROM THE CARRIER, NOT FROM OUR CLOCK, wherever Telnyx gives
        // them. Everything else on this path stamps new Date() at the moment
        // a webhook is processed, which folds delivery latency and our own
        // queueing into what is supposed to be a measurement of a phone call.
        // For status that is harmless. For a number that ends up next to a
        // charge it is not, so start_time/end_time win when present.
        const endedAtIso = p.end_time ? new Date(p.end_time).toISOString()
                                      : new Date().toISOString();
        const answeredIso = attempt?.answered_at as string | undefined;

        // BILLED SECONDS WERE NEVER SET ON THIS PATH. Outbound gets them from
        // dialer-telnyx-webhook; inbound is handled here and simply never
        // computed them, so every inbound row had billed_seconds null and any
        // billed-minute total across both directions silently counted only
        // half the traffic.
        //
        // THE INCREMENT IS A GUESS AND IS LABELLED AS ONE. Outbound on the
        // Voice API is demonstrably 60/60 -- a 44-second call billed exactly
        // $0.0120, which is one minute at $0.0120/min. Inbound on this same
        // account does NOT behave that way: three legs of 3s, 17s and 19s
        // cost $0.0003, $0.0012 and $0.0015, and under 60/60 all three would
        // have cost the same. So inbound is charged at some finer granularity
        // that the observed data does not pin down.
        //
        // Rather than encode a number nobody has confirmed, the increment is
        // an env var defaulting to 60 (the conservative direction: it
        // over-states, so a reconciliation notices rather than a shortfall
        // hiding). provider_cost_usd from call.cost remains the authoritative
        // figure and is what reconciles to the invoice; billed_seconds only
        // ever explains the shape of it. Set TELNYX_INBOUND_BILLING_INCREMENT
        // once Telnyx confirms the real one.
        const INBOUND_INCREMENT = Math.max(
          1, Number(Deno.env.get('TELNYX_INBOUND_BILLING_INCREMENT')) || 60);

        const update: Record<string, unknown> = {
          ended_at: endedAtIso,
          // status is constrained to the v523 vocabulary, which has no
          // 'abandoned' -- the boolean below is what carries that meaning, and
          // it is the number the floor is actually judged on, so it is
          // recorded outright rather than inferred from timestamps later.
          status: answeredIso ? 'completed' : 'no_answer',
          was_abandoned: !answeredIso,
        };

        if (answeredIso) {
          const talk = Math.max(0, Math.round(
            (Date.parse(endedAtIso) - Date.parse(answeredIso)) / 1000));
          update.talk_seconds = talk;
          update.billed_seconds =
            talk > 0 ? Math.ceil(talk / INBOUND_INCREMENT) * INBOUND_INCREMENT : 0;
        } else {
          // Never answered: no talk time and nothing to bill. Explicit zeros
          // rather than nulls, so "we know it was nothing" is distinguishable
          // from "nobody ever wrote this" -- which is the bug being fixed.
          update.talk_seconds = 0;
          update.billed_seconds = 0;
        }

        await admin.from('dialer_attempts').update(update).eq('id', state.a);
        break;
      }

      // ---------------------------------------------------------------------
      // Sent because "Enable Call Cost" is on for the Call Control
      // application. Without this case an inbound call would have no cost on
      // it at all, while every outbound call does -- and the two sit in one
      // Call log, so the gap would read as "inbound is free".
      //
      // Field names read defensively across the shapes Telnyx has used, the
      // same way dialer-telnyx-webhook does, rather than assuming one and
      // silently storing null forever.
      case 'call.cost': {
        if (!state) break;
        const c = p.total_cost ?? p.cost ?? p.call_cost ?? null;
        const amount = (c && typeof c === 'object') ? (c.amount ?? c.total ?? null) : c;
        if (amount != null && Number.isFinite(Number(amount))) {
          await admin.from('dialer_attempts').update({
            provider_cost_usd: Number(amount),
            provider_cost_currency:
              (c && typeof c === 'object' ? c.currency : null) ?? p.currency ?? 'USD',
          }).eq('id', state.a);
        } else {
          console.warn('dialer-inbound: call.cost with no recognised amount:',
                       JSON.stringify(p).slice(0, 300));
        }
        break;
      }

      // ---------------------------------------------------------------------
      case 'call.recording.saved': {
        if (!state) break;
        const urls = p?.public_recording_urls || p?.recording_urls || {};
        await admin.from('dialer_attempts').update({
          recording_id: p?.recording_id ?? null,
          recording_path: urls?.mp3 ?? urls?.wav ?? null,
        }).eq('id', state.a);
        break;
      }

      default:
        // Unknown events are acknowledged and ignored. Telnyx retries any
        // non-2xx forever, so silence is not an option.
        break;
    }
  } catch (e) {
    console.error('dialer-inbound: unhandled', eventType, e);
  }

  // Always 200 once the delivery is authenticated.
  return json({ ok: true });
});
