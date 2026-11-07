#!/usr/bin/env node
/**
 * prod-canary — plans one real trip on PRODUCTION, the way a new user does, and
 * says loudly when any part of it no longer works.
 *
 * WHY. On 2026-11-02 the app was handed to its first outside user and broke on
 * the first message: production's ANTHROPIC_API_KEY had expired more than a
 * week earlier. Every test was green the whole time, because none of them can
 * touch that key — `src/lib/anthropicKey.ts` gives every non-production
 * environment ANTHROPIC_API_KEY_CI, so CI, previews and the `ai-tests` shard
 * prove the CI key and nothing about production's. Only a request to
 * production can. This is that request.
 *
 * WHAT, in order — the real new-user path, over the same HTTP API the iOS app
 * calls, signed in with a real session (no test endpoint; they are hard-off on
 * production and stay that way):
 *
 *   1. /api/me with the canary's bearer token — the session is still good.
 *   2. Sweep: delete any trip left behind by an earlier run that died.
 *   3. POST /api/trips, then answer every onboarding question from
 *      ONBOARDING_ANSWERS. The intent scan and the date parser are Anthropic
 *      calls. A question this script has no answer for FAILS the run: the
 *      wizard changed, and a canary that guesses is not checking anything.
 *   4. The hand-off turn (/api/trip/replan, handoff: true) — Penny plans
 *      Girona → Barcelona: Anthropic + Google Places name→coords + Directions.
 *   5. A second turn saying the tank holds only 40 km. Girona → Barcelona is
 *      ~102 km, inside any allowed range (200 km minimum), so on a full tank
 *      Finn correctly finds nothing to do and NO Places search runs — a dead
 *      Google key would pass. The low tank makes Penny call
 *      declare_fuel_state + plan_fuel_stops, and Finn must find a real station
 *      (verified on production 2026-11-03: one Google result ~28 km in).
 *   6. Delete the trip and any vehicle this run created, whatever happened.
 *
 * A turn passes only if it streamed an `applied` event with no `error` event,
 * no fallback bubble (Penny's canned reply when the model returned nothing
 * usable — it arrives as a normal `applied`, so "applied" alone proves nothing),
 * no failed or unpersisted actions, and the durable penny_turns row reads
 * `done`. Then the TRIP is read back: one leg, Girona → Barcelona, with
 * coordinates, and a fuel stop sourced from Google with a place_id.
 *
 * COST per run, counted on production 2026-11-03: 4 Penny model calls for the
 * hand-off and 2 for the fuel turn (Haiku 4.5), plus the onboarding intent scan
 * and date parse; Google: Places searchText ×2, Directions ×1, Places along
 * route ×1. Dollar figure: `npx tsx scripts/lifetime-spend.ts` and read the
 * canary user's row — its spend is deliberately NOT filtered out of any spend
 * table (src/server/repos/admin.ts: money spent is money spent).
 *
 * ACCOUNT. samuelashirley+canary@gmail.com — comped (src/server/payments/
 * comped.ts) so the paywall never fails it, and internal
 * (src/lib/internalAccounts.ts) so it is not counted as a user. The session is
 * a normal 30-day one, minted by scripts/prod-canary-token.sh, which also
 * stores its expiry; the run alerts five days before it lapses.
 *
 * USAGE
 *   PROD_CANARY_TOKEN=… [PROD_CANARY_TOKEN_EXPIRES=ISO] node scripts/prod-canary.mjs [--json out.json]
 *   CANARY_BASE_URL overrides https://www.feraltravels.com (a preview, say).
 *
 * Exit 0 healthy, 1 failing or token about to lapse. With $GITHUB_OUTPUT set it
 * also writes `alert=true|false` for the workflow's issue step.
 */
import { appendFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const TRIP_NAME_PREFIX = 'Canary ';

/** Keyed by the snapshot's `question.key`. */
export const ONBOARDING_ANSWERS = {
  trip_intent: 'Girona to Barcelona, one day',
  trip_origin: 'Girona',
  trip_date: 'in a month',
  trip_pace: '6',
  units_pref: 'metric',
  vehicle_setup: { name: 'Canary', range_km: 500 },
};

export const FUEL_MESSAGE =
  "When I set off from Girona I will have only 40 km of fuel in the tank and I won't refuel before. " +
  "Plan my fuel around that, don't ask me anything.";

export const TOKEN_WARN_DAYS = 5;

/** `data: {...}\n\n` frames → parsed events. A frame that is not JSON is kept as `{ kind: 'unparseable' }`. */
export function parseSse(text) {
  const events = [];
  for (const block of text.split(/\n\n+/)) {
    const line = block.split('\n').find((l) => l.startsWith('data:'));
    if (!line) continue;
    try {
      events.push(JSON.parse(line.slice(5).trim()));
    } catch {
      events.push({ kind: 'unparseable', raw: line.slice(0, 200) });
    }
  }
  return events;
}

/**
 * Everything wrong with one Penny turn, or [] when it is healthy.
 * `requireTool` — a tool name that must appear in the applied toolTrace.
 *
 * @param {Array<Record<string, any>>} events
 * @param {{ status?: string, error_message?: string | null } | null} turnRow
 * @param {{ requireTool?: string | null, minApplied?: number }} [opts]
 * @returns {string[]}
 */
export function judgeTurn(events, turnRow, { requireTool = null, minApplied = 0 } = {}) {
  const problems = [];
  const errors = events.filter((e) => e.kind === 'error');
  for (const e of errors) problems.push(`stream error: ${String(e.message ?? '').slice(0, 300)}`);
  if (events.some((e) => e.kind === 'unparseable')) problems.push('stream carried a frame that is not JSON');
  const applied = events.filter((e) => e.kind === 'applied');
  if (applied.length !== 1) {
    problems.push(`expected exactly one applied event, got ${applied.length}`);
  } else {
    const a = applied[0];
    if (a.fallback) problems.push(`Penny answered with a fallback bubble (${JSON.stringify(a.fallback).slice(0, 200)})`);
    if ((a.failedCount ?? 0) > 0) problems.push(`failedCount ${a.failedCount}: ${JSON.stringify(a.failedActions).slice(0, 300)}`);
    if ((a.persistFailedCount ?? 0) > 0) problems.push(`persistFailedCount ${a.persistFailedCount}`);
    if ((a.validationFailures ?? []).length > 0) problems.push(`validationFailures: ${JSON.stringify(a.validationFailures).slice(0, 300)}`);
    if ((a.appliedCount ?? 0) < minApplied) problems.push(`appliedCount ${a.appliedCount ?? 0}, expected ≥ ${minApplied}`);
    if (requireTool) {
      const tools = (a.toolTrace ?? []).flat();
      if (!tools.includes(requireTool)) problems.push(`Penny did not call ${requireTool} (toolTrace ${JSON.stringify(a.toolTrace)})`);
    }
  }
  if (!turnRow) problems.push('no penny_turns row for this idempotency key');
  else if (turnRow.status !== 'done') problems.push(`penny_turns status '${turnRow.status}'${turnRow.error_message ? `: ${turnRow.error_message}` : ''}`);
  return problems;
}

/** The trip as /api/trip returns it, after the hand-off. */
export function judgePlan(trip) {
  const problems = [];
  const legs = trip?.legs ?? [];
  if (legs.length !== 1) return [`expected 1 leg, got ${legs.length}`];
  const leg = legs[0];
  if (!/Girona/i.test(leg.start_name ?? '')) problems.push(`leg starts at '${leg.start_name}', not Girona`);
  if (!/Barcelona/i.test(leg.end_name ?? '')) problems.push(`leg ends at '${leg.end_name}', not Barcelona`);
  for (const k of ['start_lat', 'start_lng', 'end_lat', 'end_lng']) {
    if (typeof leg[k] !== 'number') problems.push(`leg.${k} is ${leg[k]}`);
  }
  return problems;
}

/** After the low-tank turn: Finn found a real station. */
export function judgeFuel(trip) {
  const leg = trip?.legs?.[0];
  if (!leg) return ['no leg to check fuel on'];
  const problems = [];
  if (leg.fuel_status === 'failed') problems.push(`fuel_status failed: ${leg.fuel_status_reason ?? leg.fuel_error ?? ''}`);
  const fuel = (leg.stops ?? []).filter((s) => s.stop_type === 'fuel');
  if (fuel.length === 0) problems.push(`no fuel stop on the leg (fuel_status '${leg.fuel_status}')`);
  else if (!fuel.some((s) => s.source === 'google' && s.place_id)) {
    problems.push(`fuel stop is not a Google station: ${JSON.stringify(fuel[0]).slice(0, 200)}`);
  }
  return problems;
}

/** null when fine; a message when the session lapses within TOKEN_WARN_DAYS (or the expiry is unknown). */
export function judgeTokenExpiry(expiresIso, now = new Date()) {
  if (!expiresIso) return 'PROD_CANARY_TOKEN_EXPIRES is not set — re-run scripts/prod-canary-token.sh so the canary can warn before its session lapses';
  const t = Date.parse(expiresIso);
  if (Number.isNaN(t)) return `PROD_CANARY_TOKEN_EXPIRES '${expiresIso}' is not a date`;
  const days = (t - now.getTime()) / 86_400_000;
  if (days < TOKEN_WARN_DAYS) {
    return `the canary's session expires ${expiresIso} (${days.toFixed(1)} days) — run scripts/prod-canary-token.sh`;
  }
  return null;
}

// ── runner ──────────────────────────────────────────────────────────────────

class StepFailure extends Error {}

async function main() {
  const base = (process.env.CANARY_BASE_URL || 'https://www.feraltravels.com').replace(/\/$/, '');
  const token = process.env.PROD_CANARY_TOKEN?.trim();
  const jsonOut = process.argv.includes('--json') ? process.argv[process.argv.indexOf('--json') + 1] : null;
  const steps = [];
  const started = Date.now();
  let tripId = null;
  let vehiclesBefore = null;
  let failure = null;

  const api = async (method, path, body, { stream = false } = {}) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(stream ? 300_000 : 60_000),
    });
    const text = await res.text();
    if (stream) return { status: res.status, text };
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* reported below */ }
    if (!res.ok) throw new StepFailure(`${method} ${path} → ${res.status} ${text.slice(0, 300)}`);
    if (json === null && text) throw new StepFailure(`${method} ${path} → ${res.status}, body is not JSON: ${text.slice(0, 200)}`);
    return json;
  };

  const step = async (name, fn) => {
    const t0 = Date.now();
    try {
      const detail = await fn();
      steps.push({ name, ok: true, ms: Date.now() - t0, ...(detail ? { detail } : {}) });
    } catch (err) {
      steps.push({ name, ok: false, ms: Date.now() - t0, detail: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  };

  const turn = async (name, message, handoff, opts) => {
    await step(name, async () => {
      const idempotencyKey = `canary-${randomUUID()}`;
      const { status, text } = await api('POST', '/api/trip/replan', { tripId, message, handoff, idempotencyKey }, { stream: true });
      if (status !== 200) {
        // The canary account has the same $0.50/day AI cap as everyone. Two
        // runs a day sit well under it (measured ~10–15¢ a run, 2026-11-03),
        // so hitting it means a run got more expensive — still an alert.
        const capHint = status === 429 && /spend cap/i.test(text)
          ? " (the canary account's own daily AI cap — Penny got more expensive per run, or the schedule runs too often)"
          : '';
        throw new StepFailure(`replan → ${status} ${text.slice(0, 300)}${capHint}`);
      }
      const events = parseSse(text);
      const { turn: row } = await api('GET', `/api/trips/${tripId}/turns?key=${encodeURIComponent(idempotencyKey)}`);
      const problems = judgeTurn(events, row, opts);
      const applied = events.find((e) => e.kind === 'applied');
      if (problems.length) {
        const said = applied?.response ? ` — Penny said: "${String(applied.response).slice(0, 300)}"` : '';
        const trace = applied?.toolTrace ? ` — tools ${JSON.stringify(applied.toolTrace)}` : '';
        throw new StepFailure(problems.join('; ') + said + trace);
      }
      return `${applied.modelCalls ?? '?'} model calls, tools ${JSON.stringify((applied.toolTrace ?? []).flat())}`;
    });
  };

  try {
    if (!token) throw new StepFailure('PROD_CANARY_TOKEN is not set');

    await step('session', async () => {
      const me = await api('GET', '/api/me');
      if (me?.ai_consent !== true) throw new StepFailure(`signed in, but ai_consent is ${me?.ai_consent} — the account must have agreed (scripts/prod-canary-token.sh does it)`);
      const ent = await api('GET', '/api/me/entitlement');
      if (!ent?.entitled) throw new StepFailure(`not entitled (${ent?.state}) — is the canary address in COMPED_ALLOWLIST?`);
      return `entitled (${ent.state})`;
    });

    await step('sweep leftovers', async () => {
      const trips = await api('GET', '/api/trips');
      const stale = (trips ?? []).filter((t) => String(t.name).startsWith(TRIP_NAME_PREFIX));
      for (const t of stale) await api('DELETE', `/api/trips/${t.id}`);
      vehiclesBefore = new Set(((await api('GET', '/api/vehicles')) ?? []).map((v) => v.id));
      return stale.length ? `deleted ${stale.length} left by an earlier run` : 'nothing left over';
    });

    let tripIntent = null;
    await step('onboarding', async () => {
      const trip = await api('POST', '/api/trips', { name: `${TRIP_NAME_PREFIX}${new Date().toISOString()}` });
      tripId = trip.id;
      let snap = await api('GET', `/api/trips/${tripId}/onboarding`);
      const answered = [];
      for (let i = 0; i < 12; i++) {
        const q = snap?.question;
        if (!q) throw new StepFailure(`onboarding ended in state '${snap?.state}' without a hand-off`);
        if (!(q.key in ONBOARDING_ANSWERS)) {
          throw new StepFailure(`onboarding asked '${q.key}' ("${q.label}"), which this canary has no answer for — the wizard changed; add it to ONBOARDING_ANSWERS`);
        }
        const res = await api('POST', `/api/trips/${tripId}/onboarding`, { questionKey: q.key, value: ONBOARDING_ANSWERS[q.key] });
        answered.push(q.key);
        if (res.didHandoff) { tripIntent = res.tripIntent; return `answered ${answered.join(', ')}`; }
        snap = res.next;
      }
      throw new StepFailure(`onboarding did not finish after 12 answers (${answered.join(', ')})`);
    });

    await turn('hand-off plan', tripIntent ?? ONBOARDING_ANSWERS.trip_intent, true, { minApplied: 1 });

    await step('plan read back', async () => {
      const trip = await api('GET', `/api/trip?tripId=${tripId}`);
      const problems = judgePlan(trip);
      if (problems.length) throw new StepFailure(problems.join('; '));
      const leg = trip.legs[0];
      return `${leg.start_name} → ${leg.end_name}`;
    });

    await turn('low-tank fuel turn', FUEL_MESSAGE, false, { requireTool: 'plan_fuel_stops' });

    await step('fuel read back', async () => {
      const trip = await api('GET', `/api/trip?tripId=${tripId}`);
      const problems = judgeFuel(trip);
      if (problems.length) throw new StepFailure(problems.join('; '));
      const s = trip.legs[0].stops.find((x) => x.stop_type === 'fuel');
      return `${s.name} at ${s.distance_from_start_km} km (${s.place_id})`;
    });
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err);
  } finally {
    const cleanup = [];
    if (token && tripId) {
      try { await api('DELETE', `/api/trips/${tripId}`); cleanup.push('trip deleted'); }
      catch (e) { cleanup.push(`trip NOT deleted: ${e.message}`); }
    }
    if (token && vehiclesBefore) {
      try {
        const after = (await api('GET', '/api/vehicles')) ?? [];
        // The server refuses to delete the default (and the last) vehicle, so
        // only this run's non-default extras go; the account settles at one.
        const extras = after.filter((v) => !vehiclesBefore.has(v.id) && !v.is_default);
        for (const v of extras) await api('DELETE', `/api/vehicles/${v.id}`);
        cleanup.push(`vehicles: ${after.length - extras.length} kept`);
      } catch (e) { cleanup.push(`vehicle cleanup failed: ${e.message}`); }
    }
    if (cleanup.length) steps.push({ name: 'cleanup', ok: !cleanup.some((c) => /NOT|failed/.test(c)), detail: cleanup.join('; ') });
  }

  const expiryWarning = token ? judgeTokenExpiry(process.env.PROD_CANARY_TOKEN_EXPIRES) : null;
  const ok = !failure && steps.every((s) => s.ok);
  const alert = !ok || Boolean(expiryWarning);
  const lines = [
    ok ? `**Production canary: healthy** (${((Date.now() - started) / 1000).toFixed(0)} s, ${base})` : `**Production canary: FAILING** at ${base}`,
    '',
    ...steps.map((s) => `- ${s.ok ? '✅' : '❌'} ${s.name} (${s.ms ?? 0} ms)${s.detail ? ` — ${s.detail}` : ''}`),
    ...(failure && !steps.some((s) => !s.ok) ? [`- ❌ ${failure}`] : []),
    ...(expiryWarning ? ['', `⚠️ ${expiryWarning}`] : []),
  ];
  const summary = lines.join('\n');
  console.log(summary);
  if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ ok, alert, summary, steps, expiryWarning }, null, 2));
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `alert=${alert}\n`);
  process.exit(alert ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('prod-canary crashed:', err);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, 'alert=true\n');
    process.exit(1);
  });
}
