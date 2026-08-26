# Subscriptions

Status: **designed, not built.** Every number here came out of
`scripts/lifetime-spend.ts` against production on 2026-08-26, not out of a
hat. Re-run it before changing any of them.

## The shape

Seven days free with no card. Then pay or stop.

| Day | What the user sees |
|---|---|
| 0 | Signs up, uses everything. No paywall, no card, no mention of price |
| 1-6 | Full access |
| 7+ | On next open: a modal offering **$2/month** or **$19.99/year**. The app is blocked behind it |

The trial also ends early if the account burns **$1 of Anthropic spend**
before day 7 — see *Trial ceiling* below.

**Why no card up front.** The industry-standard 14-day-trial-with-card
converts better and is worse. You commit before you know whether the thing
is any good, and the app that took your card is the one you have to
remember to cancel. Nothing in StoreKit requires an early paywall; the app
simply doesn't present the purchase sheet until the trial is spent. This
is a deliberate product position, not an oversight.

**Trial start needs no new schema.** `users.created_at` already exists.
The gate is `now() > users.created_at + interval '7 days'`.

## Pricing

| Plan | Gross | Apple (15%, Small Business Program) | Net to us |
|---|---|---|---|
| Monthly | $2.00/mo | $0.30 | **$1.70/mo** ($20.40/yr) |
| Annual | $19.99/yr | $3.00 | **$17.00/yr** |

Apply for the Small Business Program — it is not automatic, and without it
Apple takes 30% and every number below halves.

Annual is cheaper than 12× monthly ($19.99 vs $24.00). That is the normal
discount for paying up front and it is intentional.

## What a user actually costs

From production, 2026-05-20 to 2026-08-26: 29 users, 32 trips, **$34.22**
of Anthropic spend.

The lifetime average of $1.07/trip is a **trap**, because two synthetic
accounts are 75% of it:

| Account | Trips | Anthropic | LLM calls |
|---|---|---|---|
| samuelashirley@gmail.com (dev) | 1 | $18.46 | 157 |
| feral-e2e-fixture (CI) | 1 | $7.10 | 45 |
| **all 27 other users** | **30** | **$8.66** | **84** |

Real users cost **$0.29/trip**. The heaviest genuine user
(robingockert97, 3 trips) has cost **$1.19 in three months**.

That single dev trip at $18.46 across 157 calls is worth understanding
before scaling anything — it has the shape of the replan loops behind the
scrambled-trip incident, not of a user planning a holiday.

**This is why the original "25 trips" allowance was scrapped.** At the
naive $1.07 average, 25 trips costs $26.75 against $17.00 of revenue — a
$10 loss per subscriber. At the real $0.29 it costs $7.50. Identical plan,
opposite sign, decided entirely by a number nobody had measured.

## The usage cap

Two thresholds, one query, different jobs.

| Threshold | Value | Action |
|---|---|---|
| **Watch** | $2.00 / rolling 12mo | Admin alert only. Nothing user-visible |
| **Stop** | $8.50 / rolling 12mo | Soft block + admin alert + user-facing message |

**$8.50 is 50% of annual net revenue** — the point where unit economics
stop working. **$2.00 is statistically anomalous** — five times the
heaviest real user, and historically it catches only the dev and CI
accounts.

Having both matters. The stop threshold is so far above real usage
(~29 trips' worth) that by the time it fires, costs have already regressed
badly. The watch threshold is the early warning, and it fires without
anyone being blocked.

**Rolling 12 months, not per calendar month, for both plans.** A monthly
subscriber who plans one big trip in July and nothing else would blow a
monthly allowance while costing nearly nothing across the year. Same
budget, it just doesn't evaporate every 30 days. (A monthly subscriber who
cancels after one month technically got a year's allowance for $1.70. At
observed usage rates that is worth nothing to exploit.)

### Meter Anthropic only

`usage_events.cost_microcents` is populated for both providers. **Only sum
`provider LIKE 'anthropic%'`.**

`logGooglePlacesUsage` stores the **gross** estimate (per-call list price ×
calls). Google's free tier resets monthly across every row and can only be
subtracted at aggregate time — see `GoogleBillableSummary` in
`src/server/repos/usage.ts`. Summing Google into the cap counts money
nobody was ever billed for, and would block users who cost us zero.

Google spend still belongs in the admin panel. It just must not gate
anything.

### Trial ceiling

**$1 of Anthropic spend, or 7 days, whichever comes first.**

Seven days alone is a weak bound. At roughly $0.12 per LLM call, a
determined account could burn $50 before the week is out. $1 is three
trips' worth at real rates — a genuine taste, and a hard floor on what a
non-paying account can cost.

This is the original "two weeks free or ten trips" instinct, denominated
in the thing that actually costs money instead of a proxy that doesn't.

## Soft block

Blocked when over the stop threshold, or when the trial has ended without
a subscription:

- **Blocked:** new trip creation, replanning, any Penny conversation
- **Allowed:** viewing existing trips, `report_position`, settings,
  account deletion, all legal pages

Viewing an existing itinerary makes no Anthropic calls, so leaving it
readable costs nothing and avoids stranding someone mid-road-trip with a
plan they can no longer see. Account deletion must never be blocked —
Apple requires it reachable in-app.

The user-facing message differs by cause. Trial-ended is a sales moment
("Subscribe to keep planning"). Cap-exceeded is not the user's fault and
should not read like an accusation — it points at support, and support
gets a real human reply.

## Admin alerting

Both thresholds email `support@feraltravels.com` through the existing
Resend path in `src/app/api/support/route.ts` (`AUTH_RESEND_KEY` +
`AUTH_EMAIL_FROM`). No new integration.

The email must say **which threshold**, the user, their 12-month Anthropic
total, their trip count, and their $/trip. The last number is the point:
a cap firing is far more likely to mean per-trip cost has regressed than
that a user is abusing anything. Word the alert that way so future-you
reads it as an efficiency signal, not a fraud signal.

Fire **once per user per threshold crossing**, not per blocked request, or
one blocked user sends a hundred emails.

Admin panel already computes per-user lifetime and 7-day spend ordered by
cost (`src/server/repos/admin.ts`). It needs: 12-month Anthropic total per
user, distance to each threshold, and subscription state.

## Purchase path: iOS only, for now

All payment goes through Apple IAP. **Android and web purchase are
explicitly deferred** — this is a portfolio project first, and one payment
integration is worth more finished than two half-built.

Consequence to accept knowingly: anyone without an iPhone cannot pay at
all. That is a real market limit, not an oversight. Revisit with Stripe on
web when there is evidence anyone wants this.

Apple permits honoring an iOS-purchased subscription on the web. What it
restricts is pointing users *out* of the app to buy elsewhere — and even
that is loosening in the US, with a 5-15% link-out fee proposed as of
August 2026.

### Library

**RevenueCat** (`react-native-purchases`). Free under $2.5k/mo revenue,
handles receipt validation, webhooks and entitlements. `expo-iap` +
StoreKit 2 direct is the lower-dependency alternative and materially more
work.

Either is a **native module**, so adopting it changes `mobile/package.json`
— which `mobile.yml` correctly reads as a native input: it skips the OTA
and cuts a fresh TestFlight binary. No manual step.

## Web access

Web is subscription-gated, with the App Store as the only way in.

| State | Web gets |
|---|---|
| Signed out | Marketing landing page, App Store link, sign-in. **Not** a bare wall |
| Signed in, in trial | Full access |
| Signed in, subscribed | Full access |
| Signed in, trial expired / unsubscribed | Soft block: "Continue on iPhone" + App Store link. Existing trips readable |
| Signed in, over cap | Existing trips readable, creation blocked, support link |

**`/privacy`, `/terms` and `/support` must stay reachable signed out.**
App Review fetches them, and a site-wide paywall is the easiest way to
silently regress the fix from PR #7. Whatever middleware enforces the gate
needs those paths allowlisted **with a test** — `e2e/legal-pages.spec.ts`
already asserts exactly this and must keep passing.

## Server-side entitlement

The client is never the authority. Trip creation is gated in the Next.js
API, so the API must know subscription state.

- RevenueCat webhook (or App Store Server Notifications V2) → a
  `subscriptions` table: user, product, status, current period end,
  trial-ends-at.
- Entitlement = `status IN ('active','trialing')` **OR**
  `now() < users.created_at + 7 days`.
- Webhook handler must be **idempotent** — Apple and RevenueCat both
  retry. Key on the transaction/event id.
- Never trust a client-supplied receipt as proof of anything.

## Account states

Eleven states. Every one needs a test.

| # | State | How you get there | App | Web |
|---|---|---|---|---|
| 1 | `trial` | < 7 days old, < $1 Anthropic | Full | Full |
| 2 | `trial_spent` | < 7 days but >= $1 Anthropic | Paywall | Soft block |
| 3 | `trial_expired` | >= 7 days, never subscribed | Paywall | Soft block |
| 4 | `subscribed` | Active IAP, < $2/12mo | Full | Full |
| 5 | `subscribed_watch` | Active, $2-$8.50/12mo | Full — user sees nothing, we get an email | Full |
| 6 | `subscribed_capped` | Active, >= $8.50/12mo | Soft block + support message | Soft block |
| 7 | `cancelled_in_period` | Auto-renew off, before period end | **Full** | **Full** |
| 8 | `expired` | Period ended, no renewal | Paywall | Soft block |
| 9 | `billing_grace` | Payment failed, Apple retrying — **off at launch** | Full + banner | Full |
| 10 | `refunded` | Apple issued a refund | Blocked immediately | Blocked |
| 11 | `comped` | Allowlist | Full, no cap | Full |

## Cancel, expire, refund and grace are four different things

**This corrects the original plan**, which treated cancellation as an
immediate block. It is not, and shipping it that way would be taking money
for access we then withheld.

- **Cancel** — the user turns off auto-renew. They have already paid
  through `expires_date`. **Access continues unchanged until then.**
  Someone who cancels on day 3 of an annual plan keeps the app for 362
  more days. Blocking them earns a refund request and a one-star review,
  and deserves both.

  This is not a loss. **Cancelling returns no money** — it only stops the
  next renewal, and we keep the full $19.99. Serving the year they paid
  for is the transaction completing, and the marginal cost of doing so is
  bounded by the $8.50 cap and realistically about thirty cents. Keeping
  the money while withholding the product is the version that costs
  something.
- **Expire** — the paid period actually ended. *Now* they hit the paywall.
- **Refund** — Apple returned the money. Revoke immediately, no grace.
- **Billing grace period** — renewal payment failed and Apple is retrying.
  An App Store Connect **toggle**, not architecture: entitlement treats
  grace as active either way, because that is what Apple and RevenueCat
  report. Turn it off and state 9 simply never occurs, with no code
  change. **Shipping with it off**, on the author's call; it can be turned
  on later for free.

  Recorded so the reasoning isn't relitigated: the fear was that a fake
  card could buy access. It cannot. Grace applies only to an *existing*
  subscriber whose *renewal* failed, and Apple validates payment at
  initial purchase — there is no path into this state without having
  successfully paid at least once. The real exposure is one renewal
  period of access for someone whose card expired, which is why the
  feature exists and why it is widely enabled.

### Refunds are Apple's decision, not ours

"Refund only if they used less than 50%" is not a policy we can enforce.
The user asks *Apple*; Apple decides; we find out afterwards via a `REFUND`
notification. There is no API where we approve or deny.

What we actually get is one advisory lever: when a refund is requested,
Apple may send a `CONSUMPTION_REQUEST` notification asking for consumption
data, which we answer through the App Store Server API. Supplying honest
usage — trips planned, LLM calls, dollars consumed — is what informs Apple
on an abusive request. It improves the odds. It does not decide them.

So the policy becomes: **answer consumption requests with real numbers, and
revoke on `REFUND`.** Anything stronger is a policy we would be unable to
keep.

The "only refund if they used less than 50%" rule survives — relocated.
It is not a gate we operate; it is the *content* of the consumption
answer. A user who burned $9 of Anthropic and then asks for their $19.99
back gets that reported, and Apple is materially more likely to decline.

### What the admin panel can and cannot have

**No "issue refund" button.** The money is Apple's to return; there is no
developer-initiated refund for IAP. A button implying otherwise would be
a lie in the UI.

What it gets instead:

- **Revoke access** — break-glass only, for genuine abuse or a missed
  `REFUND` webhook. Everything routine is automatic: the cap blocks at
  $8.50 on its own, and `REFUND` revokes on its own. If this button is
  ever the normal way something happens, the automation is broken.

  Because it can take away time somebody paid for, the UI has to argue
  back. It requires a typed reason, records who clicked it and when, and
  when the user has paid time remaining it says so in the confirmation:
  *"This user has paid through 2027-03-14."* **Cancelling is not a reason
  to press it** — a cancelled subscriber keeps the term they bought, and
  the button existing must not quietly turn that policy into a habit.
- A log of `REFUND` and `CONSUMPTION_REQUEST` events per user.
- Consumption requests answered automatically from `usage_events`, with
  the reply recorded so a declined refund can be explained later.

**Revoke on refund *granted*, not *requested*.** Apple declines refund
requests routinely. Revoking on the request cuts off someone who is still
a paying customer and whose money we still hold.

## Comped accounts

Two kinds, one mechanism:

- `samuelashirley@gmail.com` — the author's account.
- E2E fixture addresses — `playwright-*@e2e.feraltravels.com`.

Follow the `users.isAdmin` precedent exactly, including its comment:
*"Mirrors admin allowlist at sign-in; never infer admin from email alone."*
A `comped` boolean on `users`, set from an allowlist at sign-in — never an
email compared inside a paywall check. An entitlement test that does string
matching on email is one typo away from comping `@gmail.com`.

Comped accounts skip the paywall **and** the usage cap, but still write
`usage_events`, or the author's own spend vanishes from the numbers this
whole document is built on.

## E2E coverage

### The fixture endpoint

A new `/api/test/subscription` following the existing guard in
`src/server/auth/test-endpoints.ts` — no new pattern, no weakening:

- 404 unless `areTestEndpointsEnabled()` — which is `false` on
  `VERCEL_ENV === 'production'` with no override, ever.
- `x-e2e-test-secret` when `E2E_TEST_ENDPOINTS_SECRET` is set.
- **Refuses any address failing `FIXTURE_EMAIL_PATTERN`**, secret or not.

That last rule is the whole safety argument. Without it this is an endpoint
that grants free subscriptions, and the existing guard file already says
why the address shape rather than a config flag is the boundary: *"a guard
you can widen with an env var is not a guard."*

It sets fixture state only: `users.created_at` (to age an account past day
7 without waiting a week), subscription status and period end, and a
synthetic `usage_events` total. It mints no sessions — sign-in stays real
OTP or real OAuth, matching the existing rule that there is *no* sign-in
bypass anywhere in this codebase.

### The specs

| Spec | Sets up | Asserts |
|---|---|---|
| `sub-trial-day0` | Fresh fixture user | No paywall. Can create a trip and talk to Penny |
| `sub-trial-day6` | `created_at` = 6 days ago | Still no paywall |
| `sub-trial-day7` | `created_at` = 7 days ago | Paywall modal on open. Both prices shown. App behind it |
| `sub-trial-spend` | 3 days old, $1.20 of usage | Paywall fires on spend, not age |
| `sub-purchase` | Day 7 + sandbox IAP | Purchase completes, modal dismisses, trip creation works |
| `sub-flag-flip` | Subscription row set directly | Access granted without the app ever seeing a receipt — proves the server, not the client, is the authority |
| `sub-watch` | Active, $3 of usage | User sees **nothing**. Alert email queued once |
| `sub-capped` | Active, $9 of usage | Soft block + support message. Existing trips still readable |
| `sub-cancelled` | Auto-renew off, period ends in 30d | **Full access.** The regression this table exists to prevent |
| `sub-expired` | Period ended yesterday | Paywall |
| `sub-grace` | Billing retry state | Full access + banner. *Deferred while the App Store Connect toggle is off — state 9 cannot occur* |
| `sub-refunded` | `REFUND` notification processed | Blocked immediately, including existing trips |
| `sub-refund-requested` | `CONSUMPTION_REQUEST` received, no `REFUND` | **Still full access.** Consumption answered from `usage_events`. Revoking here would cut off a customer whose refund Apple may decline |
| `sub-comped` | Fixture/allowlist account | No paywall, no cap, `usage_events` still written |
| `sub-web-signed-out` | No session | Landing page + App Store link. **Not** a bare wall |
| `sub-web-unsubscribed` | Signed in, expired | "Continue on iPhone", trips readable |
| `sub-legal-still-public` | Paywall enabled | `/privacy`, `/terms`, `/support` return 200 signed out |

`sub-legal-still-public` overlaps `e2e/legal-pages.spec.ts` on purpose. That
spec exists because the pages were once unreachable signed-out, and a
site-wide paywall is the most likely way to break them again.

### Webhook tests

Unit, not E2E — replay real RevenueCat/ASSN payloads against the handler:

- Each notification type maps to the right state.
- **Idempotent**: the same event id twice changes nothing. Both Apple and
  RevenueCat retry, so this will happen in production.
- Out-of-order delivery: a stale `DID_RENEW` arriving after `REFUND` must
  not resurrect access.
- An unknown notification type is logged and ignored, never fatal.

## Open questions

- Refund edge case: a trip planned while subscribed, then refunded. State
  10 blocks the account, so the data survives but is unreachable. Is that
  right, or should refunded users keep read-only access to what they made?
- Sandbox vs production StoreKit in CI: sandbox purchases need an Apple
  sandbox tester account, which does not fit the fixture-email pattern.
  `sub-purchase` may have to be a manual pre-release check rather than CI.
- Does `subscribed_watch` need a user-visible signal at all, or is silence
  right until the hard cap?
