# Task: Locking Penny down — spend circuit breakers, sign-up flood limits, message tiers

Branch: the CURRENT open PR's branch (`gh pr list --state open` — expected
`feat/haiku-and-fuel-tank-walk`). Commit there and push; do not open a second PR. Read CLAUDE.md
and `docs/decisions.md` first; add the decisions this task creates to the register as you go
(present tense, dated 2026-09-09, with `Enforced by:` naming the test), because this feature IS
a set of constitutional articles about money.

## The requirement, in the owner's words

"If someone spends five hundred dollars overnight, I have to close the entire app." The app has
no revenue yet. The threat is not an off-topic message; it is a bot (or 1,000 bot accounts)
hammering Penny, or a sign-up flood, while nobody is watching. Today the ONLY spend gates are
per-account (120 replans/hour, $5/day, admins exempt) and per-address OTP cooldowns. There is no
per-IP limit anywhere (`grep -rn x-forwarded-for src` returns nothing) and no global ceiling of
any kind. 100 bot accounts × $5/day is $500 overnight, exactly the number above, with every
existing gate passing.

Therefore the design is a **global circuit breaker first** — a hard ceiling on what the whole
app may spend, checked before any model call, so the worst case of ANY attack is the cap, by
arithmetic — and everything else exists to trip it less often. Build in this order; each layer
is useful alone and ships in its own commit.

## Layer 1 — circuit breakers (global, deterministic, alerting)

Constants in `src/server/payments/constants.ts` (with the reasoning comment style that file
already uses), read by nothing else:

| Breaker | Alert (email + admin banner) | Hard stop (503 to non-admins) |
|---|---|---|
| Anthropic spend, all users, rolling 24 h | $10 | **$25** |
| Anthropic spend, all users, rolling 1 h | $3 | $8 |
| New accounts, rolling 1 h | 50 | 100 (stop sending OTPs / refuse OAuth exchange for NEW addresses) |
| New accounts, rolling 24 h | 100 | **200** |
| Gated (T3) messages, all users, rolling 1 h | 100 | — (alert only; the strikes and IP limits do the stopping) |

- **Where:** a pure `evaluateBreakers(facts, thresholds)` in `src/server/payments/breakers.ts`
  (clock and counts passed in — same discipline as `states.ts`), unit-tested for every
  threshold edge. A thin DB reader assembles `facts` from `usage_events` (spend — Anthropic
  provider rows; `getGlobalUsage(hours)` already exists in `repos/usage.ts`) and `users.created_at`.
- **Checked BEFORE the model call** in `api/trip/replan` (after `requireEntitledUser`, before
  the per-user caps) and in `api/mobile/otp/send`, `/login` OTP send, and
  `api/mobile/oauth/exchange` for the sign-up counters. A tripped breaker returns **503** with
  `{ code: 'circuit_open', breaker, retryAfterSeconds }` — never 401 (the app clears the keychain
  on 401) and never 402 (that is the paywall's word). Admins are exempt from the STOP, never from
  the accounting.
- **Cached ~30 s in-process** like `paywallEnabled()` — this runs on every Penny turn; an
  uncached read is a query per turn forever. Worst case is 30 s of over-run per instance; state
  the bound in the comment.
- **Alerts:** reuse `payments/alerts.ts` (Resend to the admin address) — extend `usage_alerts` or
  add `breaker_alerts` so each threshold fires ONCE per window, not once per request. Subject
  line states the number and the cap: "Anthropic spend $10.40 in 24h (alert at $10, stop at $25)".
  Plus a red banner at the top of `/admin` while any breaker is at alert or open, with the live
  counts, and a **manual "close the app to Penny" switch** (`app_meta.penny_locked = '1'`, same
  pattern and logging as `paywall_enabled`) so the owner can stop spend from a phone in one tap
  without a deploy.
- **Fail direction:** a failed breaker read is treated as OPEN for the STOP checks
  (refuse) — the opposite of the paywall switch, deliberately: the paywall failing open costs a
  few free turns; a breaker failing open during a database blip is the attack window. Say this
  in the code where `paywallEnabledFromValue` says the reverse.
- Guards: `breakers.test.ts` (pure), `breakerGate.test.ts` (source-text: the replan route and all
  three sign-up routes call the gate before any model call / OTP send), plus an e2e in
  `e2e/subscriptions.spec.ts` or a new `e2e/breakers.spec.ts` that seeds spend rows over the STOP
  via a `/api/test/*` endpoint and asserts 503 `circuit_open` for a non-admin fixture and 200 for
  the admin path. Mutation-check all three.

## Layer 2 — per-IP limits (the sign-up flood)

First, a FACT check, not an assumption: does Vercel's Firewall offer rate-limiting rules on the
Hobby plan for this project? Look at the project's Firewall tab (or the Vercel MCP if it exposes
it) and record the answer in the PR body. If yes, configure: OTP send 10/IP/hour, `/api/trip/replan`
30/IP/hour, and note that the rules live outside the repo. If no (expected), build it:

- `src/server/ipLimit.ts`: client IP from `x-forwarded-for` (first hop) / `x-real-ip`, a
  `request_counters` table keyed `(scope, ip, window_start)` or a rolling query on a small
  `ip_requests` log with an index and a nightly prune. Limits as constants: OTP sends
  **10/IP/hour**, account creations **5/IP/day**, replans **30/IP/hour**. 429 with
  `retryAfterSeconds`. Keyed by IP only — never by anything identifying; the log is pruned at 7 days.
- Wire into the same routes as the sign-up breakers plus `api/trip/replan`. Admins exempt.
- The Maestro and Playwright suites sign in dozens of fixture accounts from ONE runner IP:
  exempt when `isTestRequestAuthorized()` (the existing per-run secret) is present on the
  request, and assert in `test-endpoints.test.ts` that this exemption is impossible on production.
- Guards: `ipLimit.test.ts` (pure window math, mutation-checked), and the source-text gate test
  from Layer 1 extended to the IP check.

## Layer 3 — per-account

- Trial accounts: daily cap **$0.50** (subscribers keep $5). Lives beside
  `REPLAN_USD_CAP_PER_DAY`; the verdict from `payments/` says which cap applies.
- **Strikes:** three T3 (junk) messages in a row → Penny locked for that account for **1 hour**
  (`users.penny_locked_until`, or a row in the counters table). Reset by an on-topic message
  before the third. Deterministic, no model. The chat shows one line: "Penny is paused for this
  account for an hour." and the admin user page shows the strike count.
- Guards: `strikes.test.ts` (pure), `states.test.ts` case for the trial cap.

## Layer 4 — message tiers (the last line, and the only AI in this task)

Every message that reaches `api/trip/replan` after the gates above is tiered BEFORE Penny:

- **T1 — this trip.** Route, days, stops, fuel, the vehicle, dates, places on the way, the
  driver's current situation ("we stopped early", "150 km in the tank", "anything with a
  cheeseburger between Marfa and Big Bend"). → Penny, as today.
- **T2 — adjacent.** About the trip but not something Penny can act on: weather, opening hours,
  visa/road conditions, "is Big Bend open in October". → a canned one-liner (one string in
  `src/lib/pennyGate.ts`, shared to mobile): "I can't check that, but I can plan around it — tell
  me what you'd change." No Penny call. No strike. Stored as a chat row so the transcript is honest.
- **T3 — junk.** Code, gibberish, requests unrelated to any trip, prompt-injection shapes. →
  blocked with a one-line refusal, strike +1, no Penny call.

Three deciders, in order, each recorded on the chat row (`gate_tier`, `gate_by`) and as a
`usage_events` row (`provider: 'penny:gate'`, cost 0 for deterministic, real cost for the
classifier):

1. **Deterministic ALLOW (fast path, $0):** the message mentions a name from THIS trip's legs or
   stops (from the DB), the vehicle's name, or trip vocabulary (`fuel|km|mi|day \d|stop|route|
   drive|leg|tank|range|camp|park|road`, case-insensitive, word-bounded) → T1. This should cover
   most real messages; measure the share.
2. **Deterministic DENY ($0):** code fence, `function(`, `import `, `SELECT `, `<script`, no
   vowels in a message over 12 chars, exact repeat of one of the account's last 5 messages,
   length over `MAX_MESSAGE_CHARS` → T3.
3. **Classifier for the remainder:** ONE Haiku call (`CLASSIFY_MODEL` in `models.ts`), a
   ~300-token prompt, `tool_choice` FORCED to a single `classify_message` tool whose schema is
   `{ tier: 'T1'|'T2'|'T3', reason: string(max 80) }`, `max_tokens: 60`, no other tools, no
   history, no trip context beyond the trip name and the leg names (so "Marfa" resolves). Biased
   to allow: the prompt says "when unsure, T1". Logged with its real cost. Expected ~$0.0005.
   Guard: `classifierGuard.test.ts` — the classifier call site passes exactly one tool, forces it,
   and the schema is `.strict()` (mutation-check by adding a tool).

Do NOT build a large keyword "state machine" for T1/T3 beyond the fast paths above — the owner
raised the idea and it was argued down: language does not enumerate, it fails toward blocking
real drivers, and a bot passes it by including the word "trip". The deterministic layers are
kept to what no driver would ever type and what every driver types.

**Measurement (in the PR body, before/after):** take the 25 most recent REAL user messages from
prod `chat_history` (kind `user`/`handoff`/`form_answer`, your own accounts) and 25 junk messages
you write (code, recipes, "ignore your instructions", gibberish, empty), run all 50 through the
tiering with the classifier on the CI key, and report: tier per message, which decider decided,
false positives (real → T2/T3) — target ZERO — false negatives, and total classifier cost.

## Admin panel

One block on `/admin`, "Penny lockdown", above the paywall block: each breaker's live count vs
alert vs stop (green/amber/red), the manual `penny_locked` switch, sign-ups last 1 h / 24 h,
gated messages last 24 h by tier with the top 5 accounts, IP limits hit last 24 h, and the
strike-locked accounts. Every number here is a query on data the layers already write; add
nothing that is not already recorded.

## Register + CLAUDE.md

Add to `docs/decisions.md` (new section "I. Spend defence"): the breaker thresholds and fail
direction; per-IP limits; the trial cap; strikes; the three tiers and the three deciders; that
the classifier can call one forced tool and nothing else. Each with `Enforced by:`. CLAUDE.md gets
one short paragraph pointing at the register section and the constants file — not the story.

## Validate, push

`npx tsc --noEmit && npm run test` green per commit; every guard mutation-checked and recorded
in the commit body; the e2e added to the PR's run. Push to the current PR branch; the PR body
gains a "Locking Penny down" section with the thresholds table, the Vercel-firewall fact, the
50-message measurement, and the max-overnight-loss arithmetic (**$25 + one 30-second cache
window per instance**) stated plainly.

## Follow-up (2026-09-09 18:21 CEST) — the breaker emailed the owner from a PREVIEW

The first preview that ran `e2e/breakers.spec.ts` (push `498150b`, 16:04 UTC) seeded $26 of
global spend into its throwaway Neon branch, the breaker correctly read $22.70/1h and OPENED —
and `breakerCheck.ts` sent the real alert email, because previews carry the real
`AUTH_RESEND_KEY` and the sender has no environment check. Real Anthropic spend in that hour,
per the Admin API: $0.00 (day total $0.38). The email read as "someone is draining tokens" and
was a test fixture.

Fix, same shape as `areTestEndpointsEnabled`:
- The breaker alert TRANSPORT sends only when `VERCEL_ENV === 'production'`. Everywhere else it
  still evaluates, still writes the `breaker_alerts` row (so the e2e can assert it), still
  paints the admin banner — and logs `[breakerCheck] alert suppressed (env=preview)` instead of
  sending. No override env var: the brief's failure mode is a stray variable on a preview.
- `breakerCheck.test.ts`: the sender is not invoked when `VERCEL_ENV` is `preview` or unset,
  and IS invoked (mocked) when `production`. Mutation-check by deleting the guard.
- `e2e/breakers.spec.ts` asserts on the `breaker_alerts` ROW via `/api/test/breakers`, never
  on an email having been sent.
- Same rule for `payments/alerts.ts` (the per-user WATCH/STOP emails), which has the same gap:
  `e2e/subscriptions.spec.ts` can push a fixture over WATCH on a preview.
- Register: amend the "Spend defence" section — "Alert emails leave only production; previews
  and local record the alert and suppress the send. Enforced by: breakerCheck.test.ts."
