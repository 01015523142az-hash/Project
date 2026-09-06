// supabase/functions/dialer-autopilot/index.ts
//
// Keeps the DID pool healthy without anyone watching it. Runs on pg_cron
// (see v531), same net.http_post pattern as auto-close-stale-entries and the
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
// days before any monitoring vendor says so. dialer_did_health() (v530)
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
// Deploy with:
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

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405);

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
  const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE);

  const body = await req.json().catch(() => ({}));
  const cfg = { ...DEFAULTS, ...(body?.config ?? {}) };
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

    return json({
      ok: true,
      dry_run: dryRun,
      pool_median_answer_rate: poolMedian,
      dids_evaluated: rows.length,
      active_after: projectedActive,
      actions_taken: actions.length,
      actions,
      capacity_check: {
        dials_last_24h: dialsYesterday ?? 0,
        daily_capacity: capacity,
        shortfall,
        // Deliberately worded as an instruction, not a metric: this string
        // ends up in a cron log nobody reads unless something is wrong.
        advice: shortfall > 0
          ? `Pool is too small: ${dialsYesterday} dials against capacity for ${capacity}. `
            + `Buy roughly ${Math.ceil(shortfall / cfg.dials_per_did_per_day)} more numbers `
            + `in the area codes shown under Coverage.`
          : 'Pool has enough headroom for current volume.',
      },
    });
  } catch (e) {
    console.error('dialer-autopilot: unhandled', e);
    return json({ ok: false, error: e instanceof Error ? e.message : 'Unexpected error' }, 500);
  }
});
