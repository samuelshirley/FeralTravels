# 04 — Penny capacity: auto-continue + raise limits

**Size:** Medium · **Risk:** Medium (cost) · **Pairs with:** 05 (loading UX covers the longer wait)

Two distinct limits, both real, both currently surfacing to the user.

## A. The 16-step truncation (the "Continue planning" button)

- Cap: `MAX_TOOL_USE_ITERATIONS = 16`, `src/lib/claude.ts:77`; loop at `:631`; `truncated` set at `:878-880`.
- Wall-clock budget `MODEL_LOOP_BUDGET_MS = 280_000` under `maxDuration = 300` (`src/app/api/trip/replan/route.ts:217`, `:185`) — so there's headroom; 16 iterations isn't timeout-bound, it's a loop-safety cap.
- Current UX: manual "Continue planning" button (`src/components/ChatPanel.tsx:1699-1744`) re-sends `"Continue planning the trip from where you left off..."`. The partial plan is already persisted, so a fresh turn resumes cleanly.

**Fix (decided: auto-continue + raise + UX):**
1. Raise `MAX_TOOL_USE_ITERATIONS` modestly (e.g. 16 → 24). Cost ceiling scales linearly (24 × 4096 ≈ ~98K output tokens worst case) — still bounded by the daily cap.
2. **Auto-continue:** when `truncated` comes back, automatically re-invoke the continuation (server-side preferred, or client auto-resend) instead of waiting for a click. Cap auto-continues (e.g. max 3 chained turns) to prevent runaway.
3. Show the planning loading state (doc 05) across the chained turns so it reads as one long "Penny's planning" wait, not a stutter.

**Watch:** each auto-continue is another replan request → counts toward the hourly/daily caps below. Either (a) don't count auto-continuations against the user's quota, or (b) ensure the raised caps absorb them. Decide during impl; I lean (a) — tag continuation requests and exempt them.

## B. The 40/hour + $5/day caps

- `REPLAN_REQUESTS_PER_HOUR = 40`, `REPLAN_USD_CAP_PER_DAY = 5` — `route.ts:180-181`; enforced `:278-300` (HTTP 429). Both env-configurable. **Admins are already exempt** (`src/server/auth/admin.ts` allowlist).

**Fix:**
- Add Sam's test accounts to the admin allowlist (likely why the 429 hit — the test user isn't whitelisted), OR raise `REPLAN_REQUESTS_PER_HOUR` for pre-launch (e.g. 40 → 120 via env). Keep the $5/day cap as a backstop.
- If auto-continue ships, make continuation requests exempt (see A).

## Done when
- A 16-day, 8-leg trip plans in one perceived flow without a manual "Continue planning" click.
- Auto-continue is capped and can't loop forever.
- Sam's test account no longer hits the 429 (whitelisted or raised).
- `npm run test` + `tsc --noEmit` pass; update the truncation UX in ChatPanel.
