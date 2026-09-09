# Decisions — what the app does, why, and what stops it going backwards

> **MERGE NOTE, 2026-09-09.** This file is being written on TWO branches at once.
> `test/enforce-decisions-register` holds sections **A–H** (product scope, Penny,
> Finn, auth, payments, CI, data contracts, UI); this branch holds section **I**
> alone, because the two were built in parallel and copying 16 KB of somebody
> else's evolving prose across to avoid a conflict would have been the worse
> trade. **Resolving the merge is a concatenation** — keep A–H from that branch,
> keep I from this one, and delete this note.

Format: **Decision** (present tense) — why — *Enforced by:* `test` | **NOT ENFORCED** (prose only).
A decision without a guard survives only as long as someone reads this file at the right moment.

---

## I. Spend defence

The threat this section exists for, stated once: the app has no revenue, and
every spend limit it had before 2026-09-09 was **per-account** — 120 replans an
hour, $5 of Anthropic a day, an OTP cooldown per address. An attacker picks the
number of accounts. A hundred signed-up bots at $5/day is **$500 overnight**
with every one of those limits passing and nothing to see until the Console
updates. The owner put the requirement as the consequence: *"if someone spends
five hundred dollars overnight, I have to close the entire app."*

So the defence is arithmetic first and cleverness afterwards. Four layers, each
useful alone, in the order they run.

I1. **A global circuit breaker caps what the WHOLE app may spend, checked before
any model call.** Anthropic spend alerts at $10 and stops at **$25** per rolling
24h; alerts at $3 and stops at $8 per hour. New accounts alert at 50 and stop at
100 per hour, alert at 100 and stop at 200 per day. Junk messages alert at 100
an hour and stop nothing. Plus a manual `app_meta.penny_locked` switch the owner
throws from /admin in one tap. **Max overnight loss is the 24h stop plus one
30-second cache window per running instance** — that is the whole design, and
both terms are written where the numbers are. *Enforced by:*
`payments/breakers.test.ts`, `e2e/breakers.spec.ts`.

I2. **The breakers fail CLOSED. The paywall switch fails OPEN. Neither is a
default.** A blip that answers "paywall on" walls people who have done nothing
wrong and costs us a customer; a blip that opens a breaker is the attack window,
during exactly the minutes an attack is most likely to be why the database is
struggling — and a Penny turn needs the database anyway, so refusing early
refuses a request that could not have succeeded. Both directions are argued
beside the code that implements them. *Enforced by:* `payments/breakers.test.ts`
(the `factsUnavailable` cases), `payments/switch.test.ts` (asserts the two
directions are opposite, in the source).

I3. **A tripped breaker is 503 `circuit_open` — never 401, never 402.** 401
clears the iOS keychain (`mobile/lib/api.ts`), so it would sign every device out
because the app was busy; 402 is the paywall's word and would offer a
subscription that does not help. *Enforced by:* `lib/breakerGate.test.ts`,
`e2e/breakers.spec.ts`.

I4. **The sign-up breakers refuse only addresses with NO existing account.** A
flood is a thousand strangers; the people it must not lock out are the ones
already using the app, who are exactly the ones with a `users` row. Refusing
every sign-in during a flood takes the app down on the attacker's behalf.
*Enforced by:* `lib/breakerGate.test.ts` (the gate sits behind the
known-address check).

I5. **Admins are exempt from every STOP and from no accounting.** The operator
has to be able to find out what is happening while it is happening. *Enforced
by:* `lib/breakerGate.test.ts` (the route passes `isAdminUser` in),
`payments/breakers.test.ts` (what the gate does with it).

I6. **Per-IP limits: 10 sign-in codes/hour, 5 account creations/day, 30 Penny
turns/hour.** Fixed windows in a counter table (`ip_request_counters`), NOT a
rolling query over a request log — a log grows with the flood it exists to
survive. **It is not an authentication boundary**: an IP is a hint, a household
shares one and an attacker has as many as they want, so the limits sit at ~10×
real behaviour and I1 is what actually bounds the damage. It **fails OPEN**, the
one gate here that does, because the counter write is its only reason to touch
the database and I1 is already in front of everything expensive. *Enforced by:*
`lib/ipLimit.test.ts`, `lib/breakerGate.test.ts`.

I7. **The test runner is exempt from the per-IP limits, and that exemption
cannot exist on production.** Playwright and Maestro sign in dozens of fixture
accounts from one runner address — the exact shape the limit refuses. Gated on
`isTestRequestAuthorizedByHeaders`, which is hard-off when
`VERCEL_ENV === 'production'` with no override. *Enforced by:*
`auth/test-endpoints.test.ts`.

I8. **A trial account's daily Anthropic cap is $0.50; a subscriber's is $5.**
Which applies comes from the VERDICT (`dailyReplanCapUsd`), never from a status
column re-read at the route. `Math.min`, so lowering the env override lowers
both rather than inverting them. Trial is the only state narrowed — `comped` is
the author's account and the fixtures. *Enforced by:* `payments/states.test.ts`.

I9. **Three junk messages IN A ROW pause Penny for that account for one hour.
Only a T1 resets the count.** The obvious reading — anything not-junk resets —
lets a bot alternate junk with a weather question so the third strike never
lands. A T2 earns no strike and no reset. The count is zeroed when the lock
fires, or "three in a row" becomes "one strike, forever". *Enforced by:*
`lib/strikes.test.ts`.

I10. **Every message is sorted into one of three tiers before Penny sees it.**
T1 goes to Penny; T2 (about the trip, but weather/hours/visas — nothing a route
planner can do) gets one honest line and no model call; T3 (code, gibberish,
prompt injection, off-topic) is refused and earns a strike. Both refusals are
written to the transcript, so it stays honest about what the driver asked and
what they got. *Enforced by:* `lib/pennyGate.test.ts`.

I11. **Three deciders, in order, and the first two are free.** A deterministic
ALLOW (the message names something on this trip, or uses trip vocabulary), a
deterministic DENY (shapes no driver types), then one Haiku call for the
remainder. **Measured on 50 messages — 25 real ones from production, 25 written
as junk: 0 false positives, 0 false negatives, 68% settled for $0, $0.001352 per
classifier call** against $0.085 for the planning turn it is gating.
*Enforced by:* `lib/pennyGate.test.ts`, `scripts/measure-message-gate.ts`.

I12. **A big keyword state machine was considered and rejected.** Language does
not enumerate: a list fails toward blocking real drivers ("anything with a
cheeseburger between Marfa and Big Bend" contains no trip vocabulary at all) and
fails open against the attacker anyway, who reads it and includes the word
"trip". So the deterministic layers are held to what NO driver types and what
EVERY driver types, and the ambiguous middle costs half a hundredth of a cent.
*Enforced by:* **NOT ENFORCED** — a judgement, recorded so it is not quietly
reversed.

I13. **The classifier may call exactly ONE tool, forced, with a closed schema
and 60 output tokens.** It is the only place in this work that points a model at
untrusted text, so the SURFACE is the security property — the prompt is advice.
A second tool in that array is the difference between "the worst a hostile
message can do is get itself misfiled" and "the worst it can do is whatever the
second tool does". No history, no database tools, no trip data beyond names.
*Enforced by:* `lib/classifierGuard.test.ts`.

I14. **The classifier is biased to allow, and fails OPEN to T1 on every failure
path.** A false T3 refuses a real driver mid-trip and earns them a strike; a
false T1 costs $0.085 and reaches Penny, who can say she cannot help. The gate
is an optimisation with teeth, not a security boundary — everything expensive is
still behind I1, I6 and I8. *Enforced by:* `lib/classifierGuard.test.ts`.

I15. **Every gate decision is recorded on the message AND in `usage_events`.**
`chat_history.gate_tier` / `gate_by` answer "why did Penny answer that with a
canned line" beside the message it is about; the `usage_events` rows are what
the junk breaker counts, so the smoke detector and the record are the same rows
rather than two things that can disagree. They are written `success: true` —
`/admin/errors` reads `success = false`, and burying real failures under refused
junk is the opposite of the point. *Enforced by:* **NOT ENFORCED** — the columns
are nullable and nothing fails if they stop being written.

I16. **Vercel's firewall is doing none of this.** Measured 2026-09-09:
`GET /v1/security/firewall/config` for the project returns
`{"active":null,"draft":null,"versions":[]}` — no rules, no draft, no versions,
never configured. Whether the Hobby plan would allow a `rate_limit` rule was not
settled, because the only ways to find out are the dashboard or a `PUT` that
mutates live production config. It would not change the answer: the app also
runs on a laptop and in CI, where no edge firewall exists at all, and those are
the two places this is tested. *Enforced by:* **NOT ENFORCED** — re-check the
Firewall tab before assuming it is still true.
