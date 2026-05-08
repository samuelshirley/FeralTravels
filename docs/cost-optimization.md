# Penny Cost Optimization

Working notes for keeping per-trip Anthropic spend low enough that a $10
one-time price (or free tier) is sustainable. Update as we ship/learn.

## Baseline before changes

Single complex trip cost: ~$6 (reported). Driver was the
`replan()` agent loop in `src/lib/claude.ts` running Sonnet 4 ($3/$15 per MTok)
across up to 16 iterations per request, with the system prompt + 16 tool
schemas (~5–6K tokens) re-sent every iteration and zero prompt caching.

Caveat: ~10–20% of that $6 is Google Maps / Places API spend, not Anthropic.
Cross-check the `usage_events` table by `provider` to see the split.

## Shipped: prompt caching + cache-aware billing

`src/lib/claude.ts`

- `cache_control: { type: 'ephemeral' }` on the system prompt (`cachedSystem`).
- `cache_control` on the last entry of the tools array (`cachedTools`).
- Rolling `cache_control` on the most recent `tool_result` block, with prior
  markers stripped before each push so we stay under Anthropic's 4-breakpoint
  cap.
- Per-iteration accumulation of `cache_creation_input_tokens` and
  `cache_read_input_tokens` from `response.usage`.
- One-line console log per replan with cache hit rate so we can eyeball it.

`src/server/repos/usage.ts`

- `estimateAnthropicCostUsd` now takes optional cache-write/cache-read token
  counts and bills them at 1.25× and 0.10× base input price respectively.
- `LogAnthropicUsageInput` accepts `cacheCreationInputTokens` and
  `cacheReadInputTokens`. The values are summed into the stored `inputTokens`
  column so dashboard volume reflects total token traffic; the
  `costMicrocents` value reflects the correctly-discounted USD.
- No DB migration. If cache-token visibility becomes important for billing
  audits, add explicit columns later.

SDK was bumped from `^0.30.0` to `^0.40.x` to get standard
`cache_control` and `cache_creation_input_tokens` types.

### What to expect

- Iteration 1 of a replan writes the cacheable prefix (~5K tokens × 1.25 =
  ~6.25K billable). Iterations 2–N read the same prefix at 0.10×.
- A 16-iteration replan goes from ~80K base-priced input tokens for the
  prefix to ~6.25K + (15 × 500) ≈ ~14K effective tokens. Roughly 5–8× cheaper
  on the system+tools portion.
- The rolling tool_result breakpoint compounds savings as conversation
  history accumulates. Heavier replans benefit more.
- Cache window is 5 minutes by default, so back-to-back replans on the same
  trip benefit; replans hours apart pay the write cost again.

### How to verify

After deploy, watch console logs:

```
[penny.replan] tripId=42 input=2100 output=850 cacheWrite=5800 cacheRead=78400 cacheHitRate=0.93
```

Healthy steady-state: `cacheHitRate` > 0.7 once a trip has more than one
iteration. If it stays near 0, the cache isn't landing — likely culprits:
the system prompt is being mutated between calls, the SDK was downgraded, or
something in the messages array is changing what should be a stable prefix.

The `usage_events` table also reflects the discount. To see the new
per-trip spend distribution:

```sql
SELECT trip_id,
       SUM(cost_microcents) / 100.0 / 1000000 AS usd
FROM usage_events
WHERE provider = 'anthropic'
  AND created_at > NOW() - INTERVAL '7 days'
GROUP BY trip_id
ORDER BY usd DESC
LIMIT 20;
```

## Pending: Haiku 4.5 evaluation

Hypothesis (from Sam): most of Penny's work is mechanical translation of
free-text trip descriptions into Google Maps API calls. Disambiguation and
clarifying questions ("the big bridge in France" → Millau Viaduct) are the
exception, not the rule. If true, Haiku 4.5 should handle the routine path
at ~3× lower input price and ~3× lower output price than Sonnet 4.

### Decision criteria

Switch to Haiku 4.5 globally only if all hold:

1. The 16-tool orchestration still works — `extract_trip_intent` →
   `get_route` (batched in parallel) → `check_trip_feasibility` →
   `add_leg` (batched). Haiku must follow the gate ordering, not skip it.
2. Multi-waypoint batching still collapses to 2–3 iterations on the
   benchmark trip. If Haiku serializes one segment per turn, costs explode
   even at the lower per-token rate.
3. Distance / drive-time numbers are NEVER fabricated. Penny's protocol
   forbids inventing them; the validator catches obvious cases but a model
   that confidently outputs wrong numbers will still annoy users between
   retries.
4. Disambiguation quality on named landmarks is acceptable — or, if not,
   the failure mode is an honest "which X did you mean?" rather than a
   wrong pick.

If 1–3 hold but 4 fails, we go to plan B (router).

### Test scenarios

Run each on Haiku 4.5 and Sonnet 4 head-to-head before flipping the flag.
Save raw transcripts to `docs/haiku-eval/` for diffing.

1. **Single segment, no waypoints.** "Plan a trip from Tampa to Atlanta."
   Tests: `get_route` → `add_leg`. Should be 1–2 iterations.
2. **Multi-waypoint with batching.** "Tampa → Smoky → Grand Canyon → Moab
   → Seattle, two weeks." Tests: parallel `get_route` ×4, feasibility,
   batched `add_leg` ×N. The batching prompt is critical — a model that
   iterates per segment will burn the 16-iteration cap.
3. **Feasibility overrun.** "10 days, Tampa → Yellowstone → Glacier →
   Denver, 3 nights at each park." Tests: feasibility returns
   `over_budget`, model STOPS, asks user to extend or drop a stop. Haiku
   skipping this gate is a hard fail.
4. **Fuel planning.** "Add a leg from Phoenix to Page, 480 km" with
   refill_distance_km = 400. Tests: model recognizes the leg exceeds
   range, calls `plan_fuel_stops`. Should NOT fabricate gas station coords.
5. **Ambiguous landmark.** "I want to drive across the big bridge in
   France." Tests: model asks a clarifying question rather than guessing.
   This is the case Sam called out as needing intelligence — if Haiku
   silently picks the wrong bridge, the router becomes mandatory.

### Two-step ship plan

**Step 1 — Behind a flag.** Add `PENNY_MODEL` env var in `src/lib/claude.ts`
defaulting to the current Sonnet model. Set `PENNY_MODEL=claude-haiku-4-5-20251001`
in a staging environment, run the 5 scenarios, save transcripts. Compare
quality + per-trip cost.

**Step 2 — Decide.**
- If all 5 pass on Haiku: flip the prod default to Haiku 4.5. Watch
  `usage_events` for a week. Roll back via env var if quality complaints
  spike.
- If 1–4 pass and 5 fails: build the router (below).
- If anything else fails: stay on Sonnet, look for other levers.

### Plan B: router

Default to Haiku 4.5. On detected ambiguity, escalate to Sonnet 4 for the
current turn only.

Detection signals worth trying:
- Model emits a clarifying question (no tool calls, just text asking the
  user something) — escalate the next turn.
- User message contains a landmark/POI reference unmatched by a known list
  — escalate this turn.
- Validation retry count > 1 on a single iteration — escalate.

Implementation sketch: keep `MODEL` as the default, pass a per-call
`overrideModel` into `replan()` based on a heuristic over the user message
+ context. Worth no more than a day of work; if it's growing, we picked the
wrong abstraction.

## Other levers (only if still over budget after caching + Haiku)

- **Tighten the system prompt.** ~3K tokens, mostly cached now, but every
  request still pays the cache-write cost on the first iteration. Trim
  redundant rules; keep the non-negotiable gates.
- **Compress old `get_route` results in `messages[]`.** Once consumed and
  validated, replace the full payload with a stub. Real input savings on
  long replans, but behavior risk: Penny may reach back for the route.
  Don't do this without test coverage.
- **Reduce `MAX_TOOL_USE_ITERATIONS`** from 16. Currently a safety net for
  pathological loops. Lower it only after instrumenting how often real
  trips hit > 8.
- **Don't bother lowering `max_tokens` per iteration.** Anthropic bills
  actual output tokens, not the cap. Lowering it just risks truncating the
  legitimate big batched-leg turn (~10 `add_leg` calls × ~300 tokens each).
