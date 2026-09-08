// supabase/functions/dialer-autopilot/index.ts
//
// Keeps the DID pool healthy without anyone watching it. Runs on pg_cron
// (see v540), same net.http_post pattern as auto-close-stale-entries and the
// list-builder maintenance jobs.
//
// WHY THIS EXISTS. Caller-ID reputation, not dialer features, is what
// determines answer rate on outbound. A flagged number keeps dialing at a
// collapsed connect rate and nothing about the call fails -- calls connect,
// the CDR looks normal, agents just find that nobody picks up. Without a
// loop watching for it, the decay is invisible until the whole pool is burnt
// and numbers have to be replaced rather than rested.
//
// THE TRIGGER IS ANSWER RATE, NOT A VENDOR FLAG. Waiting for a reputation
// service to report a spam label is too slow: carriers suppress a number
// days before any monitoring vendor says so. dialer_did_health() (v539)
// compares each DID's answer rate against the pool MEDIAN over the same
// window -- same lists, same hours, same agents -- so anything that moves
// one number and not the others is the number itself.
//
// WHAT IT DOES, in order:
//   1. Refresh answer_rate_7d on every DID (also what the admin screen shows)
//   2. Quarantine numbers whose answer rate has collapsed against the median
//   3. Rest numbers that have been active too long, if the pool can spare them
//   4. Wake rested numbers back up when the active pool falls below target
//   5. Warn when the healthy pool is too small to cover the day's dialing
//
// EVERY ACTION IS LOGGED to dialer_did_events with the numbers behind it, so
// a threshold can be argued with later rather than guessed at, and so a
// status change is never mistaken for someone doing it by hand.
//
// DELIBERATELY DOES NOT BUY NUMBERS. Ordering charges a live carrier account
// and stays a human decision (dialer-pool, owner/admin). Autopilot manages
// the pool it is given and says loudly when that pool is too small.
//
// WHO MAY CALL IT: pg_cron, and nothing else. It runs as the service role
// and moves DID statuses, and every threshold below is overridable per
// request -- so an unauthenticated caller could pass min_active:0 with a
// quarantine_ratio above 1 and take the entire pool out of rotation, which
// stops every agent (gate 5 refuses the dial when no DID is available).
// It shipped that way: verify_jwt was false and nothing checked the header.
// Job 37 was already SENDING the service-role key; the function simply never
// looked at it. It looks now, and the thresholds are clamped besides -- see
// LIMITS -- because "only cron can call it" and "a typo in the cron entry
// cannot stop the floor" are two different guarantees and both are cheap.
//
// Deploy WITH JWT verification (matches auto-close-stale-entries, the other
// cron-driven function on this project):
//   supabase functions deploy dialer-autopilot
// No Telnyx secrets: this function reads the CDR and moves statuses. Number
// reputation vendors would plug in here later, as CONFIRMATION of what the
// answer rate already showed, never as the primary trigger.

import { createClient } from 'jsr:@supabase/supabase-js@2';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}

// ---- thresholds ----------------------------------------------------------
// Overridable per invocation so they can be tuned from a cron entry without a
// deploy, but every default is deliberate.
const DEFAULTS = {
  // Trailing window for the answer-rate comparison. Long enough to survive a
  // quiet day, short enough that a dying number is caught inside a week.
  window_days: 7,
  // Below this many dials a rate is noise. A DID with 4 dials and 1 answer
  // reads as 25% and means nothing.
  min_dials: 30,
  // Quarantine below this fraction of the pool median. 0.4 is deliberately
  // forgiving: real variance between numbers is wide, and wrongly retiring a
  // healthy number costs more than carrying a bad one for another day.
  quarantine_ratio: 0.4,
  // Rotate an active number out after this long, so no number carries the
  // whole load and reputation is spread.
  rotate_after_days: 21,
  // A rested number needs real time off to recover; waking it early wastes
  // the rest.
  rest_days: 14,
  // Never let the active pool fall below this. Gate 5 refuses the dial when
  // no DID is available, which stops the floor entirely.
  min_active: 3,
  // Roughly what one number should carry per day. Used only to warn that the
  // pool is too small for the volume actually being dialled.
  dials_per_did_per_day: 80,
};

// ---- LIMITS --------------------------------------------------------------
// Every threshold is overridable so it can be tuned from the cron entry
// without a deploy. That is worth keeping and it is also the sharp edge, so
// each one is bounded to a range in which the WORST outcome is a bad day
// rather than a stopped floor.
//
// min_active is the load-bearing one: it is the guard that stops step 2
// quarantining the last usable numbers, so its floor is 1 and 0 is not
// expressible. quarantine_ratio is capped below 1 because a ratio of 1 or
// more means "quarantine every number at or below the median", which is by
// definition half the pool. min_dials has a floor because judging a DID on
// four dials is judging noise.
const LIMITS: Record<string, [number, number]> = {
  window_days:          [1, 90],
  min_dials:            [5, 5000],
  quarantine_ratio:     [0.05, 0.95],
  rotate_after_days:    [1, 365],
  rest_days:            [1, 365],
  min_active:           [1, 100],
  dials_per_did_per_day:[1, 500],
};

function clampConfig(over: Record<string, unknown>): [Record<string, number>, string[]] {
  const out: Record<string, number> = { ...DEFAULTS };
  const notes: string[] = [];
  for (const [k, raw] of Object.entries(over || {})) {
    const range = LIMITS[k];
    if (!range) { notes.push(`ignored unknown setting "${k}"`); continue; }
    const n = Number(raw);
    if (!Number.isFinite(n)) { notes.push(`ignored non-numeric "${k}"`); continue; }
    const c = Math.min(range[1], Math.max(range[0], n));
    if (c !== n) notes.push(`clamped ${k} ${n} -> ${c}`);
    out[k] = c;
  }
  return [out, notes];
}

// Constant-time-ish comparison, same as the FreeSWITCH functions use for
// FS_XML_SECRET. The key is long and random so a timing side channel is not
// the realistic attack, but there is no reason to hand one over.
function secretOk(given: string, expected: string): boolean {
  if (!given || !expected || given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

// The `role` claim out of a JWT payload.
//
// !! THIS DOES NOT VERIFY THE SIGNATURE, AND MUST NOT BE ASKED TO. !!
// It is safe ONLY because this function is deployed with verify_jwt = true,
// so the platform has already rejected anything not signed by this project
// before a single line here runs. Reading a claim out of an already-verified
// token is fine; reading one out of an unverified token is trusting the
// attacker's own JSON. If verify_jwt is ever flipped back to false, this
// check becomes forgeable by anyone who can base64 -- so the two settings
// travel together, and that is why it is shouted about here.
//
// Claim rather than key equality, deliberately. The first version of this
// gate compared the bearer against SUPABASE_SERVICE_ROLE_KEY byte for byte
// and it REFUSED THE REAL CRON JOB: the key in the vault is a valid, current
// service-role token that is simply not the same string as the one in the
// function's environment. Equality was asserting something narrower than
// what actually matters, which is "this caller holds service-role
// authority", and it would have failed the nightly run silently at 05:10.
function jwtRole(token: string): string | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(atob(b64 + '='.repeat((4 - b64.length % 4) % 4)));
    return typeof payload?.role === 'string' ? payload.role : null;
  } catch {
    return null;
  }
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405);

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
  const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

  // A service-role caller, not merely "a valid JWT". verify_jwt on the
  // platform proves the token is signed by this project; it does NOT prove
  // who holds it. Every signed-in staff account has a validly signed JWT, and
  // this endpoint hands its caller the whole DID pool -- so the claim has to
  // be checked, not just the signature.
  const bearer = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  const authorised = jwtRole(bearer) === 'service_role'
                  || (!!SERVICE_ROLE && secretOk(bearer, SERVICE_ROLE));
  if (!authorised) {
    console.warn('dialer-autopilot: refused a caller that is not service_role');
    return json({ ok: false, error: 'unauthorized' }, 401);
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE);

  const body = await req.json().catch(() => ({}));
  const [cfg, cfgNotes] = clampConfig((body?.config ?? {}) as Record<string, unknown>);
  if (cfgNotes.length) console.warn('dialer-autopilot: config adjusted -', cfgNotes.join('; '));
  // A dry run reports every decision without making one. Worth using the
  // first few times, and whenever a threshold changes.
  const dryRun = body?.dry_run === true;
  const nowIso = new Date().toISOString();

  const actions: Record<string, unknown>[] = [];
  const logEvent = async (didId: string, event: string, reason: string, detail: unknown) => {
    actions.push({ did_id: didId, event, reason, detail });
    if (dryRun) return;
    await admin.from('dialer_did_events')
      .insert({ did_id: didId, event, reason, detail }).then(() => {}, () => {});
  };

  try {
    // ---- 1. health snapshot ---------------------------------------------
    const { data: health, error: hErr } = await admin.rpc('dialer_did_health', {
      window_days: cfg.window_days,
      min_dials: cfg.min_dials,
    });
    if (hErr) return json({ ok: false, error: hErr.message }, 500);
    const rows = health || [];

    // Refresh the stored rate on every DID even when no action follows -- it
    // is what the admin screen displays, and a stale figure there is worse
    // than none.
    if (!dryRun) {
      for (const r of rows) {
        await admin.from('dialer_dids').update({
          answer_rate_7d: r.answer_rate,
          answer_rate_computed_at: nowIso,
        }).eq('id', r.did_id);
      }
    }

    const poolMedian = rows.find((r: any) => r.pool_median != null)?.pool_median ?? null;

    // ---- 2. quarantine collapsed numbers ---------------------------------
    // Only ever acts on numbers with enough data. A new DID is not judged.
    const activeCount = rows.filter((r: any) => r.status === 'active').length;
    let projectedActive = activeCount;

    for (const r of rows) {
      if (r.status !== 'active') continue;
      if (!r.enough_data || r.ratio_to_median == null) continue;
      if (Number(r.ratio_to_median) >= cfg.quarantine_ratio) continue;

      // Never quarantine the floor out of existence. A pool this small is a
      // buying problem, not a rotation problem, and stopping every agent is
      // worse than carrying one suspect number for another day.
      if (projectedActive <= cfg.min_active) {
        await logEvent(r.did_id, 'flagged',
          'Answer rate collapsed but pool is at the minimum — not quarantined. Buy numbers.',
          { answer_rate: r.answer_rate, pool_median: poolMedian, ratio: r.ratio_to_median,
            active_remaining: projectedActive });
        continue;
      }

      if (!dryRun) {
        await admin.from('dialer_dids').update({
          status: 'quarantined', reputation_status: 'flagged', updated_at: nowIso,
          notes: `Autopilot: answer rate ${r.answer_rate} vs pool median ${poolMedian} `
               + `(${r.ratio_to_median}x) over ${cfg.window_days}d`,
        }).eq('id', r.did_id);
      }
      projectedActive--;
      await logEvent(r.did_id, 'quarantined',
        `Answer rate ${r.ratio_to_median}x the pool median over ${cfg.window_days} days`,
        { answer_rate: r.answer_rate, pool_median: poolMedian, dials: r.dials, answers: r.answers });
    }

    // ---- 3. rotate long-serving numbers out -------------------------------
    const rotateBefore = new Date(Date.now() - cfg.rotate_after_days * 86400000).toISOString();
    const { data: stale } = await admin.from('dialer_dids')
      .select('id, phone_e164, activated_at')
      .eq('status', 'active')
      .not('activated_at', 'is', null)
      .lt('activated_at', rotateBefore);

    for (const d of (stale || [])) {
      // Resting is a luxury the pool has to be able to afford.
      if (projectedActive <= cfg.min_active) break;
      if (!dryRun) {
        await admin.from('dialer_dids')
          .update({ status: 'resting', rested_at: nowIso, updated_at: nowIso })
          .eq('id', d.id);
      }
      projectedActive--;
      await logEvent(d.id, 'rested',
        `Active since ${String(d.activated_at).slice(0, 10)} — rotating out after ${cfg.rotate_after_days} days`,
        { activated_at: d.activated_at });
    }

    // ---- 4. wake rested numbers when the pool runs thin -------------------
    if (projectedActive < cfg.min_active) {
      const restedBefore = new Date(Date.now() - cfg.rest_days * 86400000).toISOString();
      const { data: ready } = await admin.from('dialer_dids')
        .select('id, phone_e164, rested_at')
        .eq('status', 'resting')
        .or(`rested_at.is.null,rested_at.lt.${restedBefore}`)
        .order('rested_at', { ascending: true, nullsFirst: true })
        .limit(cfg.min_active - projectedActive);

      for (const d of (ready || [])) {
        if (!dryRun) {
          await admin.from('dialer_dids')
            .update({ status: 'active', activated_at: nowIso, updated_at: nowIso })
            .eq('id', d.id);
        }
        projectedActive++;
        await logEvent(d.id, 'activated',
          `Pool below minimum of ${cfg.min_active} — waking a rested number`,
          { rested_at: d.rested_at });
      }
    }

    // ---- 5. is the pool big enough at all? --------------------------------
    // Compares yesterday's real dial volume against what the active pool can
    // carry at the per-number daily cap. This is the number that tells you to
    // go buy DIDs, and it is derived from what you actually dialled rather
    // than from a plan.
    const since = new Date(Date.now() - 86400000).toISOString();
    const { count: dialsYesterday } = await admin.from('dialer_attempts')
      .select('id', { count: 'exact', head: true })
      .gte('initiated_at', since);

    const capacity = projectedActive * cfg.dials_per_did_per_day;
    const shortfall = Math.max(0, (dialsYesterday ?? 0) - capacity);

    // THE POOL CAN BE TOO SMALL WITHOUT BEING OVER CAPACITY, and the two
    // failures look nothing alike from here.
    //
    // The capacity check compares yesterday's dials against what the active
    // pool could carry. On a quiet day that is 0 against 160 and the advice
    // read "Pool has enough headroom for current volume" -- while the pool
    // sat at 2 active numbers against a min_active of 3.
    //
    // That is not a rounding-error of a lie. min_active is the guard in step
    // 2: quarantine is skipped entirely while projectedActive <= min_active,
    // because emptying the pool stops every agent. So at 2 of 3, the ONE
    // thing this function exists to do -- pull a burnt number out of
    // rotation before it drags the whole answer rate down -- cannot happen,
    // and the only line of output anybody reads said everything was fine.
    //
    // A DID with a collapsed answer rate would still be logged as 'flagged'
    // per number, but only if it had enough dials to be judged. With a pool
    // this small and this new, nothing has enough data, so there was no
    // signal anywhere at all.
    const belowMinimum = projectedActive < cfg.min_active;
    const advice = belowMinimum
      ? `Pool is BELOW its minimum: ${projectedActive} active against a `
        + `min_active of ${cfg.min_active}. Quarantine is suppressed while this `
        + `is true -- a number whose answer rate collapses will be flagged and `
        + `left in rotation, because taking it out would stop the floor. Buy `
        + `at least ${cfg.min_active - projectedActive + 1} more number(s) to `
        + `restore reputation protection.`
      : shortfall > 0
        ? `Pool is too small: ${dialsYesterday} dials against capacity for ${capacity}. `
          + `Buy roughly ${Math.ceil(shortfall / cfg.dials_per_did_per_day)} more numbers `
          + `in the area codes shown under Coverage.`
        : 'Pool has enough headroom for current volume.';

    if (belowMinimum) {
      console.warn('dialer-autopilot: pool below min_active -- quarantine suppressed.', advice);
    }

    return json({
      ok: true,
      dry_run: dryRun,
      // Empty on every normal run. Non-empty means a setting in the cron
      // entry was out of range and did NOT take effect -- worth seeing,
      // because the alternative is a threshold that looks applied and is not.
      config_notes: cfgNotes,
      pool_median_answer_rate: poolMedian,
      dids_evaluated: rows.length,
      active_after: projectedActive,
      actions_taken: actions.length,
      actions,
      capacity_check: {
        dials_last_24h: dialsYesterday ?? 0,
        daily_capacity: capacity,
        shortfall,
        // Separate from shortfall on purpose: a pool can be under its minimum
        // and over its capacity independently, and this one disables
        // quarantine while it is true.
        below_minimum: belowMinimum,
        min_active: cfg.min_active,
        active: projectedActive,
        quarantine_suppressed: belowMinimum,
        // Deliberately worded as an instruction, not a metric: this string
        // ends up in a cron log nobody reads unless something is wrong.
        advice,
      },
    });
  } catch (e) {
    console.error('dialer-autopilot: unhandled', e);
    return json({ ok: false, error: e instanceof Error ? e.message : 'Unexpected error' }, 500);
  }
});
