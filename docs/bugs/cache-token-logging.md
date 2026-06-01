# Bug — Cache tokens lumped into `input_tokens`, cache hit rate unrecoverable

> **Audience:** A Claude agent picking this up cold. Read `CLAUDE.md` at the repo root first for project orientation, then this document.
>
> **Status:** Diagnosed, not fixed. Verified still present against `main` HEAD `62a4d79` on 2026-06-01.

## Where

- `src/server/repos/usage.ts:47-58` — `logAnthropicUsage` rolls cache tokens into `inputTokens` before insert.
- `src/server/db/schema.ts` — `usageEvents` table at line ~543. Only has `input_tokens` + `output_tokens` columns; no cache columns.

## What's wrong

`logAnthropicUsage` correctly receives `cacheCreationInputTokens` and `cacheReadInputTokens` from the Anthropic API response, uses them to compute the discounted dollar cost in `costMicrocents` — and then **sums them into `inputTokens`** before insert:

```ts
inputTokens: input.inputTokens + cacheCreate + cacheRead,
```

The comment at line 44-46 explains this as deliberate ("Roll cache tokens into the stored inputTokens column so the dashboard reflects total token volume"). But the side effect is that **cache hit rate is not recoverable from the data.** You can't tell whether a 50K-input-token replan was 100% cache reads (cheap) or 100% uncached (expensive) — the `input_tokens` column looks identical. Only `cost_microcents` differs.

## Why it matters

Several cost-engineering features in `docs/PENNY_COST_ENGINEERING.md` depend on being able to measure cache hit rate per replan. Without splitting cache tokens out, we can't:

- Tell whether prompt caching is actually landing on long-trip replans.
- Tell whether the 5-minute Anthropic cache TTL is being missed across spaced-out turns.
- Decide whether Feature 1 (narrow context) and Feature 2 (compact past legs) actually paid off.

This is a precursor to most of the cost-engineering spec work. Ship this first; the bigger cost-engineering features become measurable afterward.

## Fix shape

1. Add two columns to the `usage_events` table:
   - `cache_creation_input_tokens INTEGER` (nullable)
   - `cache_read_input_tokens INTEGER` (nullable)
2. Update the schema in `src/server/db/schema.ts` (`usageEvents` definition near line 543).
3. `npm run db:generate` to create the migration, `npm run db:migrate` to apply.
4. Update `logAnthropicUsage` to persist them in separate columns instead of summing into `inputTokens`. Keep `inputTokens` as the pure regular-input count.
5. Update CLAUDE.md if the schema reference needs touching (column additions only, no table-count change).
6. Update `src/server/repos/usage.ts` consumers (`getUserSpendSince`, etc.) if they reference the rolled-up count. Check before changing — the cost dollar amount should NOT change.
7. Update `scripts/debug-trip.ts` to show the three columns separately — currently it has a note saying "input column includes cache tokens — cache hit rate not currently recoverable from schema." Remove that disclaimer and add a cache hit rate field to the totals row.

## Acceptance criteria

- New columns exist and are populated on every Anthropic replan event.
- A spot query against `usage_events` can compute `cache_read_input_tokens / (input_tokens + cache_creation_input_tokens + cache_read_input_tokens)` to get cache hit rate per row.
- Historical rows have null in the new columns — that's fine, we're going-forward.
- Cost in `cost_microcents` remains accurate (the dollar math already accounted for cache tokens correctly).
- `npx tsc --noEmit` + `npm run test` pass.
- `scripts/debug-trip.ts` shows cache hit rate in its output.

## State at handoff

- `scripts/debug-trip.ts` is a read-only diagnostic written during the original investigation. **Not yet committed.** Useful for verifying this fix landed correctly. Commit it as part of this fix or as a tiny precursor commit.
- Sam's `main` may have uncommitted staged changes from earlier sessions — check `git status` before starting. Per `[[user_multi_agent_git_workflow]]`, resolve or set aside before committing.
- Related docs: `docs/PENNY_COST_ENGINEERING.md` (the bigger cost-engineering work this unblocks).

## Memories to honor

- `[[feedback_prefer_simple_deterministic]]` — this is a straightforward schema + repo change, no LLM logic involved.
- `[[feedback_flag_stale_code]]` — if while doing this you find dead helpers around the old usage logging, tell Sam.
