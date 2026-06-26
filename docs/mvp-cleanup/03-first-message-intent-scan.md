# 03 — First-message intent scan

**Size:** Large · **Risk:** Medium (touches the trust boundary) · **Depends on:** 01

**Problem:** the user said "leaving tomorrow" in their first message but was still asked the start date. Today the first `trip_intent` message is stored raw as `pending_intent` (`src/server/onboarding.ts:632-647`, `298`) and the `trip_date` question is **always** asked (`onboarding.ts:99-118`). `extractTripIntent` exists (`src/lib/penny/tools/extractTripIntent.ts`) but runs *after* onboarding (`src/lib/claude.ts:358-373`) and doesn't pre-fill questions.

**Goal:** scan message 1, extract any onboarding answers it already contains, persist them, and **skip those questions**.

## Approach (must respect the lockdown invariants)

Reuse the exact pattern from `src/server/parseStartDate.ts` (forced-tool LLM → validate → persist):

1. On `trip_intent` submit, run a **forced-tool extractor** (Haiku via a `DATE_PARSE_MODEL`-style cheap model). Tool schema returns ONLY declared fields, each nullable:
   - `start_date_phrase` (string|null) → feed into existing `resolveStartDate()` for the ISO + `assumed` flag. Do NOT let the model author the ISO directly — reuse the existing date resolver.
   - `comfortable_range_km` / `hard_max_range_km` (int|null) — only if explicitly stated.
   - (Optional, later) destination/waypoints if cheaply extractable; otherwise leave for Penny's existing post-onboarding `extractTripIntent`.
2. **Server re-validates** every returned value (e.g. `validateISODateString`, range bounds, `assertRangeOrder`) before persisting. "Return null rather than guess" in the tool instructions.
3. For each field that came back valid, **mark its onboarding step satisfied** and skip it. Surface a one-line confirmation note ("Got it — leaving tomorrow, Sat 27 Jun") so the user sees what was inferred and can correct.
4. If extraction returns null for a field, fall through to asking the question as today.

## Guardrails
- Endpoint stays locked: the extractor lives at the onboarding boundary only, never bolted onto a general edit route.
- The model converts, it does not author: forced tool schema, tight bounds, server re-validation. No free-text persistence.
- Confirm-don't-assume for low-confidence dates: if `resolveStartDate` returns `assumed=true`, still show the one clarifying confirmation rather than silently committing.

## Scope cut for v1
Start with **start date + range** (highest-frequency, lowest-ambiguity). Destination/stop extraction can stay with the existing post-onboarding `extractTripIntent` to avoid double-parsing. Revisit after this ships.

## Done when
- "leaving tomorrow" (and "next Saturday", "in November") in message 1 skips the date question with a visible confirmation.
- A stated range in message 1 skips the range question.
- Garbage/no-signal still asks normally.
- New unit tests for the extractor + validation; e2e covers the skip path. `npm run test` + `tsc --noEmit` pass.
