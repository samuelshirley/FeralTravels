# Penny Cost Engineering — Implementation Spec

> **Audience:** A Claude agent picking this up cold. Read CLAUDE.md at the repo root first for project orientation, then this document.
>
> **Status:** Spec — none of this is implemented yet. Five features below, ordered by priority.

---

## Background

### What triggered this work

A 4-segment, 18-day trip from Girona (Spain) to Blåvand (Denmark) hit Penny's `MAX_TOOL_USE_ITERATIONS` cap (16) mid-plan. The trip was partially saved and the UI surfaced a "Penny didn't finish your plan / Continue planning" bubble (see `src/components/ChatPanel.tsx:1660-1690`). The truncation is set when the loop runs out of iterations without an `end_turn` stop reason (`src/lib/claude.ts:838-840`).

The user wants Penny to support trips up to ~4 months (~120 days, multi-country) without bankrupting the project on tokens or Google Maps API calls.

### Current cost machinery (what already exists — don't rebuild)

**Prompt caching is already wired up.** `src/lib/claude.ts:570-803` sets three ephemeral cache breakpoints per request: end of system prompt, end of tools array, and a rolling one on the latest `tool_result`. The rolling breakpoint is moved forward each iteration with proper cleanup so the 4-breakpoint cap isn't blown. After iteration 1, system + tools + history reads at 0.10× input price. Cache hit rate is logged per replan.

**Google Directions has an in-process LRU cache.** `src/lib/google/directions.ts:85-128`. 24h TTL, keyed on (origin, destination, mode, avoid, waypoints). Survives within a single Node process — does NOT survive Vercel serverless cold starts.

**Context is already projected, not raw.** `src/lib/penny/context.ts` builds a `PennyContext` from trip data — projected fields only, chat history capped at 12 messages × 4000 chars each.

**Per-iteration output cap.** `max_tokens: 4096` per Anthropic call.

**Per-user spend caps.** `REPLAN_USD_CAP_PER_DAY` ($5) and `REPLAN_REQUESTS_PER_HOUR` (40) as backstops.

**Usage logging.** `usage_events` table (`src/server/db/schema.ts:543`) — logged providers today:

| Provider | Where logged |
|---|---|
| `anthropic:replan` | `src/app/api/trip/replan/route.ts:203, 576, 620` |
| `anthropic:replan-truncated` | `src/app/api/trip/replan/route.ts:298` |
| `google-places` | `src/server/repos/usage.ts:194` |
| Various `penny:*` events for validation/leak/contiguity failures | `src/app/api/trip/replan/route.ts` |
| `cron:nightly_replan` | `src/lib/replan/runReplan.ts:308` |
| **`google:directions`** | **NOT LOGGED — gap, see Feature 3** |

### What the user explicitly ruled out

- **Binary encoding / non-JSON serialization formats.** Anthropic tokenizes text. Base64-encoded binary uses *more* tokens than JSON, not fewer. YAML/XML are worse than minified JSON. Real lever is dropping fields, not changing format.
- **Building a custom LLM.** What the user described as "building a custom LLM" is just context engineering. Stay on Anthropic Sonnet 4 (`claude-sonnet-4-20250514`).

### Relevant memories to honor

These are in the user's auto-memory and apply across this work:

- **Prefer simple/deterministic.** Favor minimal deterministic solutions over speculative LLM-driven complexity. Wait for real complaints before building more.
- **Penny is a wrapper only.** Plan numbers (dates, day counts, ETAs) come from the DB via `computePlanSummary`, never from LLM prose.
- **Fuel planning safety bias.** Fuel planner must bias conservative; only actual fuel stops reset the tank — never assume implicit refuels from rest/overnight.
- **Flag stale code.** If you spot dead/stale code while implementing these features, tell the user.
- **Multi-agent git workflow.** User runs agents in parallel. Be careful not to strand work on un-pushed branches.

---

## Feature 1 — Local replan (tactical vs structural triage)

**Highest steady-state cost win.** Don't drag the full 4-month trip context into the prompt when the user just wants to add a gas stop on day 50.

### The problem

`buildPennyContext` always returns the entire trip — every leg, stop, route, and task. For long trips, the JSON blob in the initial user message could be 30-50K tokens. That's outside the prompt cache breakpoints on iteration 1 (the rolling cache only starts moving after the first `tool_result`), so you pay full input price every time it misses the 5-minute Anthropic cache TTL.

Most user turns on a long trip are tactical: "add a fuel stop on day 50," "swap the campsite on leg 12," "add a task to call ahead at this border crossing." These don't need 120 legs in scope.

### The shape

1. **Add a triage step before `buildPennyContext`.** A deterministic classifier (regex on intent keywords / target leg references) decides: structural change or tactical change?
   - **Structural** = extract_trip_intent, add/remove legs across the trip, change start/end dates, replan whole segments. Behave as today — full context.
   - **Tactical** = single-leg stop/task/route edits, fuel/dump-station planning for one leg, "find me an alternative" for a single stop. Narrow context.

2. **Build a narrow context for tactical turns.** New function `buildPennyContextNarrow(tripId, userId, { focusLegIds, neighborhoodSize })` that returns:
   - The focused leg(s) with full detail
   - N legs before + N legs after (default N=1) with full detail
   - All other legs as a one-line summary (id, sort_order, leg_type, dates, start_name → end_name, distance_km)
   - Trip-state-at-now (see Feature 2)
   - Vehicle, units_pref, recent chat, vehicle_profile_blocked — same as today

3. **Add a "give me leg N" lookup tool.** New `get_leg(leg_id)` lookup tool (joins `LOOKUP_TOOL_NAMES` alongside `get_route`). Lets Penny pull full leg detail on demand if her narrow context isn't enough.

4. **Route in `src/app/api/trip/replan/route.ts`.** Classify, pick which builder, send.

### Where to make changes

- `src/lib/penny/context.ts` — add `buildPennyContextNarrow`, possibly refactor `projectLeg` into `projectLegFull` and `projectLegSummary`.
- `src/lib/penny/tools/getLeg.ts` — new file, follow the shape of `getRoute.ts`.
- `src/lib/penny/tools/index.ts` — register `getLeg`, add to `LOOKUP_TOOL_NAMES`, add to `TOOLS` array.
- `src/lib/penny/triage.ts` — new file, deterministic classifier. Start with regex on intent keywords (fuel stop, dump, single leg id references, "swap", "find alternative", "add task"). No LLM call.
- `src/app/api/trip/replan/route.ts` — call triage before context build, pick builder accordingly.
- `src/lib/claude.ts` — needs to know that `extract_trip_intent` can't fire in narrow mode (or escalate to full mode if it does — TBD; safest is to disallow narrow mode when extract_trip_intent has been requested by Penny and re-run with full context).

### Acceptance criteria

- Tactical turn on a 120-leg trip sends <5K tokens in the initial user message (today it's 30-50K).
- Structural turn behaves identically to today.
- If Penny calls `get_leg` because narrow context wasn't enough, that's logged so we can tune the neighborhood size.
- Penny still produces correct fuel/continuity output — verify by spot-checking that fuel state carries forward (see Feature 2 dependency).
- No regression on existing e2e tests.

### Risks / edge cases

- Misclassification — tactical turn that actually needed structural context. Mitigation: bias toward full context when in doubt; add usage event `penny:triage-escalation` when Penny calls `get_leg` on a non-neighbor leg, to find missed cases.
- Penny may hallucinate references to legs outside her narrow window. Mitigation: the one-line summary of all legs gives her enough to know they exist; the `get_leg` tool lets her resolve.
- Fuel/dump tools need accurate tank state — depends on Feature 2.

### Dependencies

- Feature 2 (trip-state-at-now carry) — needed so fuel/continuity tools work in narrow mode.

---

## Feature 2 — Compact past legs into "trip-state-at-now"

**Drops dead context but keeps the bits Penny actually needs to reason forward.**

### The problem

Once a leg's `date_iso` is in the past and its status is locked (`selected`, `completed`), Penny doesn't need the full leg detail to plan the future. But you can't just delete past legs from context — `src/lib/penny/fuelTankState.ts` computes km burned since last refuel, and that math needs to know about past fuel stops. Drop them blindly and Penny will either re-suggest a refuel you just made or assume the tank is full when it's not.

### The shape

Carry forward a small structured object summarizing past state, drop the leg-by-leg detail.

**New field on `PennyContext`:**

```ts
trip_state_at_now: {
  current_date: string;                          // YYYY-MM-DD
  position: { lat, lng, name } | null;           // end of last completed leg
  last_completed_leg: { id, sort_order, date_iso, end_name } | null;
  last_refuel: {
    leg_id, date_iso, location: {lat,lng,name},
    km_since: number,                            // km driven since last refuel
    estimated_remaining_km: number | null,       // from vehicle.refill_distance_km - km_since
  } | null;
  totals_so_far: {
    completed_legs: number,
    completed_driving_km: number,
    completed_drive_minutes: number,
  };
}
```

This is <500 tokens regardless of trip length.

### Where to make changes

- `src/lib/penny/context.ts` — add `trip_state_at_now` to `PennyContext`, compute in `buildPennyContext`. Drop past legs from `legs` array entirely OR compact them to one-line summaries — pick based on whether Feature 1 lands first.
- `src/lib/penny/fuelTankState.ts` — read from `trip_state_at_now.last_refuel` for the seed instead of replaying the full leg history. Keep the DB-shim in `src/lib/penny/server/fuel.ts` working.
- `src/lib/penny/schedule.ts` — if `computeStartFixes` reaches back across past legs, make sure it can read from `trip_state_at_now.position` for leg continuity from "today."
- System prompt in `src/lib/claude.ts` SYSTEM_PROMPT — add a paragraph explaining `trip_state_at_now` and that past legs are NOT in scope unless Penny calls `get_leg(id)` to look one up.

### Acceptance criteria

- A 120-leg trip where 50 legs are past sends ~70 legs of detail + trip_state_at_now instead of 120 legs.
- Fuel planning on the next driving day correctly accounts for km since last refuel (write a unit test in `src/lib/penny/fuelTankState.test.ts` — make sure one exists).
- Continuity from "today's location" works even though Penny can't see the past leg detail.
- Penny doesn't re-suggest fuel stops that already exist in the past.

### Risks / edge cases

- A user editing a past leg ("I actually got fuel at Munich, not Salzburg") — Penny needs to know past data exists. The `get_leg` tool from Feature 1 covers this; if Feature 1 doesn't land first, expose `get_leg` here too.
- Multi-day rest stops where no driving happened — make sure `last_completed_leg` stays anchored to the last drive, not the rest day. Same `position` logic.
- Trip with no past legs (status='draft', first plan) — `trip_state_at_now` should be null or have a `kind: 'unstarted'` sentinel; don't break the prompt.
- Caravan dump tracking has similar state-carry needs — `last_dump_station` should probably go in `trip_state_at_now` too.

### Dependencies

- Logical pair with Feature 1, but can ship independently. Doing 2 first makes 1 cheaper because narrow contexts already drop past legs.

---

## Feature 3 — Log Google Directions to usage_events + per-user spend dashboard

**Closes the cost visibility gap. Do this first — it's the smallest change and lights up measurement for everything else.**

### The problem

`usage_events` logs Anthropic spend and Google Places spend. **Google Directions is not logged.** Every `get_route` call hits Directions, and a multi-segment trip easily makes 20+ calls per replan. At Google's pricing ($5 / 1000 basic, $10 / 1000 with traffic) this can add up, especially across many planning sessions.

Also: no per-user spend dashboard exists. There's a `getUserSpendSince` query in `src/server/repos/usage.ts:210` but nothing in `/admin/users/[id]` surfaces it.

### The shape

1. **Wrap `getDirections` in `src/lib/google/directions.ts` to log on cache miss.** Today the cache check happens at line 203-205; the actual fetch happens after. Right before `cacheSet` at line 306, log a usage event with `provider: 'google:directions'`.
2. **Pass userId + tripId through.** This requires plumbing — `getDirections` currently doesn't take them. Add optional params (don't break existing callers).
3. **Estimate cost.** Basic Directions = $5 / 1000 = 500 microcents per call. Bump to 1000 microcents if `departureTime` is set (traffic-aware). Persist in `costMicrocents`.
4. **Add per-user spend section to `/admin/users/[userId]`.** Show today / 7d / 30d, broken down by provider, with the $5/day cap line drawn. Query already half-exists.

### Where to make changes

- `src/lib/google/directions.ts` — wrap cache miss with usage logging. May need to import `logUsageEvent` from `@/server/repos/usage`.
- All callers of `getDirections` — pass userId/tripId. Likely:
  - `src/lib/penny/tools/getRoute.ts` — currently doesn't take userId/tripId in tool args; the dispatcher in `claude.ts:709-735` `executeLookupTool` would need to inject them. Cleanest path: thread them through `executeLookupTool(tu, context, { userId, tripId })`.
  - `src/lib/penny/split-route.ts` — if it calls Directions directly.
  - Anywhere else `getDirections` is invoked (grep first).
- `src/server/repos/usage.ts` — add a helper if needed, e.g. `logGoogleDirectionsUsage({ userId, tripId, withTraffic, cached })`.
- `src/app/admin/users/[userId]/page.tsx` (or wherever the admin user detail page lives — check the architecture in CLAUDE.md) — add spend section.

### Acceptance criteria

- Every cache-miss Directions call inserts a row in `usage_events` with `provider='google:directions'`, populated `costMicrocents`, and matching `userId`/`tripId`.
- Cache hits do NOT log (otherwise you'd double-count). Optionally log cache hits with `costMicrocents=0` for visibility — user's call.
- Admin user page shows total spend today / 7d / 30d for that user across all providers.
- Run `scripts/smoke-api.ts` and the e2e suite — should pass without changes.
- Add a small backfill script (`scripts/backfill-google-directions-zero-cost-rows.ts`?) only if needed — probably not, just go-forward.

### Risks / edge cases

- `userId` is null when called from cron (`runReplan.ts`) — make `userId` nullable in the log, the `usage_events` schema already allows null on userId.
- Throwing in the log path must NOT break the Directions call. Wrap in try/catch like `logAnthropicUsageWithFallback`.
- Don't accidentally log inside the LRU cache returner — only on the actual API call.

### Dependencies

None. Smallest change in the bunch. Ship first so subsequent features can be measured.

---

## Feature 4 — Persist Directions cache to Postgres

**Quietly expensive. Vercel cold starts nuke the in-process LRU.**

### The problem

`src/lib/google/directions.ts:85-128` is an in-process `Map`. On Vercel serverless, each cold start gets a fresh process — the cache evaporates. Two browser sessions planning the same route = paid Google twice. With Feature 3 logging in place, the user will see this in real numbers.

### The shape

1. **New table `directions_cache`** in `src/server/db/schema.ts`:

```ts
export const directionsCache = pgTable('directions_cache', {
  cacheKey: text('cache_key').primaryKey(),     // hash of origin+dest+avoid+waypoints+mode
  originLat: doublePrecision('origin_lat').notNull(),
  originLng: doublePrecision('origin_lng').notNull(),
  destLat: doublePrecision('dest_lat').notNull(),
  destLng: doublePrecision('dest_lng').notNull(),
  result: jsonb('result').notNull(),            // DirectionsResult
  createdAt: timestamp('created_at').defaultNow().notNull(),
  expiresAt: timestamp('expires_at').notNull(),
}, (t) => ({
  expiresIdx: index('directions_cache_expires_idx').on(t.expiresAt),
}));
```

TTL = 30 days. Routes between fixed lat/lngs don't change month-to-month.

2. **New repo** `src/server/repos/directionsCache.ts`:
   - `getCached(key): Promise<DirectionsResult | null>` — read, check expiry, return.
   - `putCached(key, result, ttlMs): Promise<void>` — upsert.
   - Don't bother with explicit cleanup — let expired rows accumulate and prune via a cron or a one-off `scripts/prune-directions-cache.ts` later.

3. **Two-tier cache in `getDirections`:** check in-process LRU first (fast), then Postgres (cheap), then fetch (expensive). On fetch, write through both tiers.

### Where to make changes

- `src/server/db/schema.ts` — add table, bump table count in CLAUDE.md (23 → 24).
- `npm run db:generate` to create migration, `npm run db:migrate` to apply.
- `src/server/repos/directionsCache.ts` — new file.
- `src/lib/google/directions.ts` — refactor cache flow into a two-tier check.
- Update CLAUDE.md Repos list.

### Acceptance criteria

- First call to a given (origin, dest, avoid, waypoints) tuple hits Google and writes to both LRU + DB.
- Second call from a cold-started process hits the DB cache, not Google.
- Third call within the same process hits the LRU, not the DB.
- Feature 3's logging shows cache hit counts climbing after this ships (DB hits should NOT log Google cost; track them with `provider='google:directions-cache-hit'` and `costMicrocents=0` if useful).
- TTL is honored — old entries are treated as cache misses.

### Risks / edge cases

- Postgres write latency on cache miss adds ~5-50ms per first-time route. Acceptable.
- Multi-region read latency — Neon is single-region; if app is multi-region, plan for it. Not an issue at current scale.
- Cache key needs to be canonical: sort `avoid` array, normalize lat/lng precision (round to ~5 decimals, ~1m precision). Inconsistent rounding will fragment the cache and miss obvious hits.
- Don't cache failures (Google returned `no_results` or `api_error`). Only cache `ok: true` results.

### Dependencies

- Feature 3 should ship first so you can measure the cache hit rate going up.

---

## Feature 5 — Server-side auto-continue cycle + conditional iteration cap

**Solves the original truncation specifically.**

### The problem

Today the `MAX_TOOL_USE_ITERATIONS = 16` cap (`src/lib/claude.ts:72`) is the same for every replan — whether it's a tactical "add a fuel stop" turn or a fresh 18-day plan-from-scratch. The 4-month-trip use case will trip this every time on plan-build, and the user has to keep clicking "Continue planning" to recover.

### The shape

**Part A — conditional iteration cap.**

In `src/lib/claude.ts`, decide the iteration cap based on whether `extract_trip_intent` has been called this turn (signal: it's a fresh plan build):

```ts
const MAX_TOOL_USE_ITERATIONS_TACTICAL = 16;
const MAX_TOOL_USE_ITERATIONS_PLANNING = 32;
// In the loop, raise the cap once extractIntentCalled flips true.
```

Blast radius still bounded by the per-user `$5/day cap` and `40 req/hour`.

**Part B — server-side auto-continue.**

Today the "Continue planning" button is manual UI (`src/components/ChatPanel.tsx:1667-1689`). For long plans, automate it server-side:

1. When `truncated: true`, the replan route checks: did we save meaningful progress this turn (≥1 successful `add_leg`)? If yes, AND we haven't already auto-continued N times this *request chain*, kick off a follow-up replan with a system-generated "continue from where you left off, here's the partial plan" prompt.
2. Cap the auto-continue chain at 4 cycles (gives ~16 × 4 = 64 effective iterations).
3. Per-user $5/day cap still backstops the cost.
4. Surface the chain depth in the UI bubble — "Penny is still working (step 2 of 4)" — instead of asking the user to click.

### Where to make changes

**Part A:**
- `src/lib/claude.ts` — split `MAX_TOOL_USE_ITERATIONS` into tactical + planning, raise dynamically once `extractIntentCalled` flips.

**Part B:**
- `src/app/api/trip/replan/route.ts` — after streaming finishes, if `truncated && successful_add_legs > 0 && auto_continue_depth < 4`, recursively invoke another replan in the same request (or queue a continuation; pick the cleanest plumbing — likely a `runReplanOnce()` inner function called in a loop).
- `src/components/ChatPanel.tsx` — replace the "Continue planning" button with a progress indicator when the server is auto-continuing. Keep the button as a fallback if auto-continue itself bailed.
- `usage_events` — log each auto-continue cycle with `provider: 'anthropic:replan-auto-continue'` so it's visible.

### Acceptance criteria

- Fresh 18-day plan (the original incident trip) completes in a single user-facing turn without manual "Continue planning" clicks.
- Tactical turn still capped at 16 iterations (the existing safety net).
- $5/day cap is still respected — auto-continue does NOT bypass it.
- If auto-continue itself runs out of cycles, fall back to the existing manual button.
- Penny's prose response to the user is from the FINAL cycle, not concatenated across cycles.

### Risks / edge cases

- Infinite loops if Penny keeps making "progress" without ever finishing. The 4-cycle cap is the hard ceiling. Also: if cycle N produces fewer `validatedActions` than cycle N-1, stop — she's regressing.
- Failures partway through an auto-continue chain — keep partial progress visible, surface the failure mode in UI.
- Cost spike on plans that genuinely need 4 cycles. Worst case: 4 × 32 iterations × 4096 output tokens × $15/MTok = ~$8 per plan, but per-user cap kicks in long before that.

### Dependencies

- None hard, but synergizes with Feature 1: if narrow-context tactical turns are cheaper, the cap on tactical turns matters less and the planning cap can go higher safely.

---

## Suggested ship order

1. **Feature 3** (log Google Directions + spend dashboard) — smallest, lights up measurement.
2. **Feature 4** (persist Directions cache) — small follow-on, immediate visible win in #3's numbers.
3. **Feature 5** (conditional cap + auto-continue) — solves the original truncation without big refactor. Part A (cap) is a 10-line change; Part B is bigger.
4. **Feature 2** (trip-state-at-now) — needs careful unit tests around fuel state. Ships independently.
5. **Feature 1** (local replan / triage) — biggest architectural change. Ship last; benefits compound after Features 2-5 are in place.

## What to verify before claiming done on each feature

- `tsc --noEmit` passes.
- `npm run test` passes.
- `npm run e2e:smoke` passes.
- For any DB-touching feature: migrations applied via `npm run db:generate` + `npm run db:migrate`, schema.ts edited, CLAUDE.md updated to reflect new tables/repos/scripts/routes.
- Update CLAUDE.md in the same commit as any structural change (this is mandatory per CLAUDE.md itself).

## Open questions to surface with the user before implementing

- Feature 5 Part B: should the auto-continue chain run synchronously (long-held SSE stream) or detach and update the trip async? Synchronous is simpler, asynchronous is more resilient to client disconnects.
- Feature 1: where exactly is the line between tactical and structural? Cheap regex classifier vs. a 1-Haiku-call classifier? Start cheap, escalate if misclassification hurts.
- Feature 3: should we log cache hits too (with $0 cost) for visibility, or only billable misses?

## Out of scope (do not build)

- Custom LLM training.
- Binary / non-JSON serialization formats.
- Multi-model routing (Haiku for tactical, Sonnet for planning) — speculative; revisit after #1-5 land and there's data.
- Sub-agents.

---

## Key files at a glance (one-line each)

- `src/lib/claude.ts` — tool-use loop, prompt caching, iteration cap, where truncation gets set.
- `src/lib/penny/context.ts` — builds `PennyContext` sent to Penny.
- `src/lib/penny/tools/getRoute.ts` — the get_route tool definition.
- `src/lib/penny/tools/index.ts` — tool registry; add new tools here.
- `src/lib/google/directions.ts` — Google Directions wrapper + in-memory LRU cache.
- `src/lib/penny/fuelTankState.ts` — pure tank math, needs trip_state_at_now seed (Feature 2).
- `src/lib/penny/schedule.ts` — leg continuity / rest-day materializer.
- `src/server/repos/usage.ts` — usage logging, per-user totals.
- `src/server/db/schema.ts` — single Postgres source of truth.
- `src/app/api/trip/replan/route.ts` — orchestration: triage, context build, Penny call, dispatch validated actions.
- `src/components/ChatPanel.tsx` — chat UI, "Continue planning" bubble at ~line 1660.
- `CLAUDE.md` — project map. Keep current with any structural change.
