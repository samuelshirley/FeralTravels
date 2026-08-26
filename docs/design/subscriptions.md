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

## Open questions

- Which grandfathering, if any, for the 29 existing accounts? They predate
  all of this and several are the author's.
- Does the 40% of signups who never make a single LLM call (12 of 29)
  represent an activation problem that matters more than any of this?
  A 7-day paywall converts nobody who never reached value in week one.
- Refunds and Apple's cancellation flow: what happens to a trip created
  while subscribed, after a refund?
