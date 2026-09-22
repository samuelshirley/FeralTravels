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
(3 trips) has cost **$1.19 in three months**.

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
- **Re-activate access** (added 2026-09-10) — the undo, and until it existed
  the revoke was a one-way door: the button turned into a dead "Access
  already revoked", so a misfire, or a `REFUND` that turned out to be about
  a different account, was unfixable from the product.

  **It hands back the ROW, not TIME.** `revokeSubscription` overwrites
  `status` in place, so the status it is about to destroy is recorded in
  `subscriptions.pre_revoke_status` (migration 0040) and the undo consumes
  it. An account that was already `expired` when it was revoked comes back
  `expired`; a term that ran out *while* the account was revoked stays run
  out, because `resolveAccountState` already treats the clock as the
  authority over a stale status. Without that, this button would be a way
  to mint free plans out of dead accounts.

  Same typed reason as its opposite and the same record, because handing
  paid access back is equally a decision somebody has to explain later —
  but deliberately NOT the same danger styling, since this is the
  recoverable direction. It says what the account lands on *before* the
  press, since "re-activated" is not a state. `'none'` is the recorded
  value when there was no subscription row at all (revoking a trial user
  creates one), and the undo then deletes the row so the trial rules apply
  again. A row revoked before the column existed is REFUSED with a
  sentence rather than guessed at.
- A log of `REFUND` and `CONSUMPTION_REQUEST` events per user, and of both
  admin actions above — they go through the same `subscription_events`
  ledger, which is what makes clearing `revoked_at`/`_by`/`_reason` on an
  undo safe: those three columns only ever describe the LATEST revoke.
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


---

## Paywall, promo codes, breakers and limits — the CLAUDE.md notes

> Moved out of `CLAUDE.md` on 2026-09-20, verbatim, when that file was cut from
> 225 KB back to a map. Nothing here was rewritten or deleted — only relocated.
> `CLAUDE.md` links here from the one-line summary that replaced it.

**Subscriptions / paywall (migration 0026, 2026-08-26):** seven days free from
`users.created_at`, then $2/month or $20/year through Apple IAP. Designed in
`docs/design/subscriptions.md`; the numbers there came out of
`scripts/lifetime-spend.ts` against production, not out of a hat.

- **`src/server/payments/` is a BOUNDED MODULE and `index.ts` is its only
  public surface.** This is a deliberate amendment to the `repos/` convention:
  a repo file is a shared surface anything may call, and the whole value here
  is that the number of places able to decide "this user has paid" stays at
  one. The single public question is `hasEntitlement(userId)`. Nothing outside
  the module imports `./states`, `./entitlements`, or the `subscriptions`
  table.
- **`states.ts` is a pure function with the clock passed in.** All twelve
  account states are unit-tested by describing a moment rather than by writing
  rows (`states.test.ts`). Three rules that are NOT obvious at a call site, and
  are why no route re-derives this: cancelling does not end access (they paid
  through `current_period_end`, and cancelling returns no money); the trial
  ends on SPEND as well as age ($1 of Anthropic); comped accounts skip the cap
  but still write `usage_events`.
- **Gated routes:** `api/trip/replan`, `api/trips` (create),
  `api/trips/[id]/clone`, `api/trips/[id]/onboarding` — all via
  `requireEntitledUser()` in `auth/guards.ts`. Reads are NOT gated: viewing an
  itinerary makes no Anthropic calls, and account deletion must never be gated
  (App Store 5.1.1(v)). `api/trips/[id]/onboarding` had no cap of any kind
  before this and runs three Anthropic calls.
- **402 carries `code`/`state`/`blockReason`** via `HttpError.details`. Until
  this, the only structured field on any error body was the log correlation id,
  so clients could only branch on status.
- **The paywall is a MESSAGE FROM PENNY, not a modal** — a UI-only `paywall`
  flag on the chat message, riding the same rail as `truncated` and
  `planningMedia`, never persisted. Copy is server-authored
  (`payments/copy.ts` → `GET /api/me/entitlement`) so it changes without a
  TestFlight binary. `mobile/app/paywall.tsx` exists because chat is
  trip-scoped (`chat_history.trip_id` is NOT NULL) and a lapsed trial that
  never made a trip had nowhere to be told.
- **iOS zero-trip users auto-create a trip and land in Penny's chat.** The web
  deliberately does not (`src/app/trips/page.tsx` says so) — a browser tab that
  silently creates a row is surprising; a single-purpose phone app is the
  opposite case. Guarded by a per-mount ref so it can't become a trip factory.
- **`PrivacyInfo.xcprivacy` is authored in `app.config.js`, never in `mobile/ios/` (2026-09-02).** `ios.privacyManifests` is @expo/config-plugins' supported seam and it MERGES into Expo's stock template, so `expo prebuild` emits the file and the gitignored, `--clean`-regenerated `ios/` tree is never hand-edited. **Its absence or an incomplete required-reason list is ITMS-91053** — which is not a build error, not a runtime error and not visible in the app, but an email from App Store Connect AFTER the upload. `src/lib/privacyManifest.test.ts` is the only thing that can notice it going missing, and it reads the config as TEXT (`noMobileImportGuard` forbids `src/` importing from `mobile/`).
  - **Every reason code was read off the manifests actually on disk**, not recalled: FileTimestamp `C617.1` (React, cxxreact, folly, boost, glog, expo-application, react-native-maps) + `0A2A.1`/`3B52.1` (expo-file-system); UserDefaults `CA92.1` (React, expo-constants, RevenueCat); DiskSpace `E174.1`/`85F4.1` (expo-file-system); SystemBootTime `35F9.1` (boost). `DDA9.1` and `8FFB.1` are deliberately ABSENT and the test fails if they appear — the tempting fix for a rejection is to paste in every code in the category, and that is a claim rather than a fix.
  - **"Third-party SDKs ship their own manifest" has a precondition worth checking.** It only holds if the SDK's `.xcprivacy` reaches the built product. `RevenueCat` and `PurchasesHybridCommon` each ship one, and NEITHER is built into a resource bundle — `Pods.xcodeproj` has `ResourceBundle-*_privacy` targets for React-Core, React-cxxreact, ExpoApplication, ExpoConstants and ExpoFileSystem, and none for those two. So nothing aggregates them and the app target speaks for that code. Their required-reason usage is `CA92.1`, already declared; what was uncovered was `PurchaseHistory`. Found by reading a real `mobile/ios/Pods` after a prebuild.
  - **The collected-data list is EIGHT rows and is duplicated on purpose** — here, and as the nutrition-label table in `docs/design/app-store-listing.md` §4. Change one, change the other, and change the App Store Connect questionnaire with them. `PurchaseHistory` (`subscriptions` is keyed on `users.id` and holds product id / original transaction id / period end) and `OtherDiagnosticData` (`ChatPanel`'s stream-error beacon → `/api/analytics/client-error` → `usage_events` WITH a `user_id`) were both missing until the audit went past `node_modules`. **Product Interaction is deliberately absent**: `/api/analytics/viewport-time` exists but only the web calls it.
  - **The Google Maps SDK is not in the iOS build** — no Google pod is installed, because `EXPO_PUBLIC_GOOGLE_MAPS_API_KEY` is not on the `eas.json` build profiles, so the app uses Apple Maps. Its bundled manifest would add Crash Data, Device ID, Performance Data and Product Interaction for Analytics; setting that key changes the nutrition label.
- **The iOS app moved to a NEW Apple developer account, and a new bundle id (2026-09-02).** `com.feraltravels.ios`, with products `com.feraltravels.ios.monthly` / `.annual`. **The old `com.feraltravels.app` is permanently unusable** — uploading a TestFlight build binds a bundle id to the account that uploaded it, forever (confirmed with Apple DTS), and one was uploaded under the old US team. Nothing had shipped and there are no users, so it was a pure rename.
  - **The bundle id is not only a build setting.** It is the AUDIENCE `oauthIdentity.ts` checks Apple ID tokens against (`APPLE_APP_BUNDLE_ID || 'com.feraltravels.ios'`), it is the Maestro `APP_ID` in `ci.yml` and `ios-e2e-local.sh`, and it prefixes both product ids — which live in `constants.ts` AND `mobile/storekit/FeralTravels.storekit`, where a mismatch produces the same empty offering a real one does. All renamed together; `git grep com.feraltravels.app` should return only the Android package.
  - **Android is deliberately still `com.feraltravels.app`.** The binding is Apple's, Play has never seen this id, and a second rename with no reason behind it is not a tidy-up.
  - **`mobile/eas.json` carries the complete set for the new account** as of 2026-09-03: `appleTeamId: TJX3F3832H` and `ascAppId: 6807913556`. `ascAppId` was REMOVED rather than updated on 2026-09-02, because the replacement did not exist yet and leaving `6802705582` would have aimed `eas submit` at a record on the old US team. That gap had a real cost: the merge of PR #21 classified as native, built, and then failed on `Set ascAppId in the submit profile` — the binary reached EAS and nothing reached TestFlight. `ascAppId` lives in the `submit` block, so it never affected `eas build`, only the submit.
  - **The Google iOS OAuth client was EDITED IN PLACE, not replaced** — same client id, rebound to the new bundle id — so `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID` and `AUTH_GOOGLE_IOS_CLIENT_ID` needed no change anywhere, and the `205269478779-…` client must NOT be deleted: it is the live one. **Google takes five minutes to a few hours to propagate an OAuth client edit**, so a native sign-in right after one can still be rejected against the old binding with an error naming a bundle id the client no longer has. That is the change not having landed, not a misconfiguration.
  - `APPLE_APP_BUNDLE_ID` should be DELETED from Vercel if set — the code default is correct now, and a stale env var would silently override it and fail every Apple sign-in. The table in `docs/design/iap-setup.md` is the list.
- **In-app purchases — CLIENT BUILT (2026-09-01), CONFIGURATION PENDING.**
  `react-native-purchases` is in `mobile/` (no Expo config plugin — the package
  ships none and autolinks; do not add one to `app.config.js` or prebuild
  fails). **Nothing on the server changed**: the webhook was always the
  authority, it cannot tell a real purchase from a fake one, and there is still
  exactly one grant path. What Apple and RevenueCat still need clicking, in
  dependency order, is `docs/design/iap-setup.md`.
  - **`mobile/lib/purchases.ts` is the ONLY module that imports the SDK** —
    same bounded-module rule as `src/server/payments/`. Screens use
    `usePurchaseFlow` (`mobile/lib/purchaseFlow.ts`); the three surfaces that
    sell (Penny's bubble in `ChatPanel`, `PlanRequiredOverlay`, `app/paywall.tsx`)
    each used to carry their own copy of purchase-then-refetch, and the hard
    part of that flow is what happens when the refetch says no.
  - **`app_user_id` is `users.id`, confirmed with the server before every
    purchase.** `configurePurchases()` subscribes to `onTokenChange` so every
    sign-in `logIn`s and every sign-out `logOut`s (including `apiFetch`'s 401
    `clearToken`), and `requirePurchaserId()` REFUSES to buy if it cannot
    confirm the id — buying anonymously produces `ignored_unknown_user`, i.e. a
    real charge and no access, undetectable from inside the app. The id comes
    from `GET /api/me/identity` (which gained an `id` field for this) rather
    than from the sign-in response, because a restored keychain session has no
    sign-in response.
  - **A purchase is not an entitlement.** `purchasePackage` resolving means
    Apple charged the card; the app then POLLS `GET /api/me/entitlement` on the
    schedule in `src/lib/entitlementPolling.ts` (front-loaded, then 5s, giving
    up at 60s) showing "Payment received — switching your plan on…". Giving up
    is NOT an error — the money is real and the webhook retries for hours — so
    the copy leads on the charge having gone through and points at Restore.
  - **Prices come from the store's Offerings, not `constants.ts`.**
    `usePurchaseFlow` merges the server's plan list (order, cadence, note — all
    still server-authored and reword-able without a build) with the store's
    `product.priceString`. `priceLabel` in `constants.ts` is the fallback for an
    unreachable store, as its own comment always said; "$2" in front of somebody
    charged €2,49 is a 3.1.2 disclosure problem. A server plan with no matching
    store package is DROPPED — so ONE price where there should be two means a
    product id typo, not an agreement problem.
  - **Restore purchases** (Guideline 3.1.1, and the only recovery when the poll
    gives up) and a **Manage subscription** link to
    `itms-apps://apps.apple.com/account/subscriptions` are on the purchase sheet
    AND in Settings (`mobile/components/SubscriptionSection.tsx`) — the sheet's
    copies are for someone being sold to, Settings' are for someone who already
    paid and therefore never sees a paywall.
  - **Two message channels, not one.** `error` is red; `notice` is not. Ask to
    Buy arrives as RevenueCat's `PAYMENT_PENDING_ERROR` — an *error* code for a
    state working exactly as designed — and a cancelled purchase is the user
    closing a sheet they opened. Neither may be painted as a failure.
  - The `PURCHASES_ERROR_CODE` mapping lives in `mobile/lib/purchases.ts` beside
    the import so `tsc --noEmit` in `mobile/` checks the member names; the
    vocabulary and copy live in `src/lib/purchaseOutcome.ts` (mirrored) so the
    root vitest project can test them — `mobile/` has no test runner and CI's
    unit job installs no `mobile/node_modules`.
  - **Simulator loop:** `mobile/storekit/FeralTravels.storekit` is a local fake
    App Store; `scripts/ios-e2e-local.sh storekit` injects it into the generated
    scheme (run automatically by `build`) and `… xcode` opens the workspace to
    drive a purchase. It removes App Store Connect from the loop, NOT RevenueCat.
    It cannot be driven by Maestro — the config is activated by the scheme's
    launch action and Maestro launches outside any scheme; there is no
    `simctl storekit` subcommand as of Xcode 26.6 (checked). No flow attempts a
    purchase.
  - **The purchase sheet is reachable in EVERY account state, from Settings ->
    Plan -> "View plans" (2026-09-02), and this is an App Review blocker, not a
    convenience.** All three paywall surfaces are gated on NOT being entitled —
    that is what a paywall is — and a reviewer signing in with their own Apple
    ID (the right answer to 2.1(a), and what `app-store-listing.md` tells them to
    do) lands in a seven-day trial. Entitled. So there was **no screen in the app
    that showed a price**, and no way to complete a sandbox purchase: the
    "we were unable to locate the in-app purchases" rejection, which no review
    note can write around. `GET /api/me/entitlement` accordingly now sends
    `products` in every state rather than `[]` when entitled; the
    accidental-render property it was protecting still holds, in the surfaces
    that own it (`PlanRequiredOverlay` returns null when entitled,
    `app/paywall.tsx` redirects, Penny's bubble is server-flagged). It is also
    the honest product behaviour — a trial user who has decided can subscribe,
    and a monthly subscriber can find the annual price. `SubscriptionSection`
    gained the button and a `planStatusLine` status line; `docs/design/ios-review-notes.md`
    is the text a reviewer reads and the ordered list of what must be true in
    App Store Connect before it is honest.
  - **`TRANSFER` is handled (2026-09-02), and NOT through `TYPE_MAP`** — it maps
    to no single status because it concerns two users. **The rule, decided by
    the owner: the subscription follows the Apple ID.** The account that just
    restored it holds it; the previous account is expired immediately. One
    `subscriptions` row per user and one payment behind it, so leaving the
    origin entitled would fund two accounts from one purchase. **Accepted
    consequence: the losing account is told nothing** — its next gated request
    402s with the ordinary "subscription ended" copy, which is close enough to
    true, and the event is rare.
  - **Three things about the TRANSFER payload make it unlike every other event**,
    and all three were verified against RevenueCat's field reference rather than
    assumed. (1) It carries **no `app_user_id`** — so `app_user_id:
    z.string().min(1)` would have 400'd every real transfer at the boundary and
    RevenueCat would have retried each one for as long as its backoff allowed;
    the field is now nullish with a `superRefine` that keeps it required for
    every other type. (2) The destination is `transferred_to`, the origin
    `transferred_from`, both ARRAYS — never infer either from `app_user_id`,
    which is the trap: using it would grant the subscription to the account that
    just LOST it, silently. (3) It carries **no `product_id`, no
    `expiration_at_ms` and no `original_transaction_id`**, so the destination's
    row is built from the ORIGIN's row — the only place those facts exist.
    Taking the event at face value would write `currentPeriodEnd: null`, which
    `resolveAccountState` reads as "no end": an unlimited subscription granted
    by a transfer.
  - **Both sides get a `subscription_events` row**, the origin's under a
    suffixed id (`event_id` is UNIQUE), both carrying the verbatim payload — so
    the move is reconstructable afterwards, which matters precisely because the
    losing user is never told and a support question arrives with no other
    trail. The move itself is ONE transaction behind the `transferSubscription`
    dep: separable expire-then-upsert either funds two accounts from one
    purchase or leaves nobody entitled. **An unknown destination changes
    NOTHING**, not even the origin's row — that reads as "the subscription has
    gone, expire them" and is wrong, because an unknown destination means the
    purchase left our system and expiring the origin would strand somebody still
    paying with nobody to hand access to.
- **Spend defence — the global circuit breakers (2026-09-09).** Every spend gate before this one was per-account (120 replans/hour, $5/day, OTP cooldowns), and an attacker picks the number of accounts: a hundred bots at $5/day is $500 overnight with every one of them passing. `src/server/payments/breakers.ts` is the pure evaluator, `breakerCheck.ts` the DB reader + 30s cache + alerting, and **every threshold lives in `payments/constants.ts` (`BREAKERS`)** — Anthropic spend $10/$25 per 24h and $3/$8 per hour, new accounts 50/100 per hour and 100/200 per day, junk messages 100/hour alert-only, plus the manual `app_meta.penny_locked` switch thrown from /admin. A tripped breaker is **503 `circuit_open`** (never 401, which clears the iOS keychain; never 402, which is the paywall's word) and admins are exempt from the stop, never from the accounting. It **fails CLOSED** — the opposite of `paywallEnabledFromValue`, and the reasoning is written beside both. The sign-up breakers refuse only addresses with **no existing account**, so a flood never locks out the people already using the app. Max overnight loss is therefore the 24h stop plus one 30-second cache window per running instance. The full rationale is section I of `docs/decisions.md`; don't restate it here. *Enforced by:* `payments/breakers.test.ts`, `lib/breakerGate.test.ts` (the routes call the gate before any model call or OTP send), `payments/switch.test.ts` (the two switches fail in opposite directions), `e2e/breakers.spec.ts` (its own Playwright project, running last, because a global breaker is global).
- **The message gate — three tiers before Penny (2026-09-09).** Every message reaching `api/trip/replan` is sorted first: **T1** goes to Penny, **T2** (about the trip but not something a route planner can do — weather, opening hours, visas) gets one canned line and no model call, **T3** (code, gibberish, prompt injection, off-topic) is refused and earns a strike. Both refusals are written to the transcript. **Three deciders, in order:** a deterministic ALLOW (`src/lib/pennyGate.ts` — the message names something on THIS trip, or uses trip vocabulary), a deterministic DENY (shapes no driver types), then ONE forced-tool Haiku call (`CLASSIFY_MODEL`, `src/server/pennyClassifier.ts` + the pure request in `src/lib/pennyClassifierPrompt.ts`) for the remainder. **Measured on 50 messages — 25 real ones from prod `chat_history`, 25 written as junk: 0 false positives, 0 false negatives, 68% settled for $0, $0.001352 per classifier call** against $0.085 for the planning turn it gates (`npx tsx scripts/measure-message-gate.ts`). The classifier may call **exactly one tool, forced, closed schema, 60 output tokens, no history** — the surface is the security property, not the prompt — and it **fails OPEN to T1** on every failure path, the deliberate opposite of the breakers. **A bigger keyword state machine was considered and rejected**: language does not enumerate, so it fails toward blocking real drivers and fails open against an attacker who includes the word "trip". Recorded on `chat_history.gate_tier`/`gate_by` (migration 0039) and in `usage_events` (`penny:gate`, tier in `model`) — which is what the junk breaker counts. *Enforced by:* `lib/pennyGate.test.ts`, `lib/classifierGuard.test.ts`, `lib/models.test.ts`.
- **Breaker alerts email from PRODUCTION only, and the manual lock never emails at all (2026-09-09).** Both are corrections made after the owner's inbox took `[OPEN] Penny locked by hand: 1 (alert at 1, stop at 1)` from a CI preview: `e2e/breakers.spec.ts` throws the manual lock on every run, and the email carries no environment, so a preview's alert was indistinguishable from production's. The lock is exempt because it is open when a human threw it thirty seconds ago — an alert is for something you do NOT already know — and `/api/admin/penny-lock` still writes the `usage_events` row that answers "who closed the app, and when". A non-production deployment logs instead. *Enforced by:* `lib/breakerGate.test.ts`.
- **The global spend breaker ignores fabricated spend; the per-user cap counts it (2026-09-09).** `/api/test/subscription` writes `usage_events` rows under `SYNTHETIC_SPEND_PROVIDER` (`anthropic:e2e-subscription-fixture`) to drive accounts into paywall states, and a full Playwright run plants **$22.70** of them — against a $25/24h global ceiling. So `sumAnthropicMicrocents` in `breakerCheck.ts` excludes that ONE provider: the rows are not money (they can only be written through `/api/test/*`, hard-off on production), and counting them lets the test suite 503 the specs running beside it once retries push it over. The exclusion is deliberately narrow — the breaker fixture's own rows still count, because seeding app-wide spend is what that one is for, and `anthropicMicrocentsInWindow` (the PER-USER cap) counts both, because fabricating a user's balance is exactly what that fixture does. Found by `e2e/breakers.spec.ts`'s baseline assertion, which exists to make "the breaker works" distinguishable from "something else is refusing".
- **Per-account: a trial cap and strikes (2026-09-09).** A **trial account's daily Anthropic cap is $0.50**, a tenth of a subscriber's $5 (`TRIAL_REPLAN_USD_CAP_PER_DAY` / `REPLAN_USD_CAP_PER_DAY` in `payments/constants.ts`); which one applies comes from the VERDICT via `dailyReplanCapUsd(state, subscriberCap)`, never from a status column re-read at the route, and the `REPLAN_USD_CAP_PER_DAY` env override lowers **both** (`Math.min`, so it cannot invert them). Trial is the only state narrowed — `comped` is the author's account and the fixtures, everything else entitled has paid. **Strikes:** three T3 (junk) messages IN A ROW pause Penny for that account for **one hour** (`users.penny_strikes`, `users.penny_locked_until`, migration 0038); the pure rule is `src/lib/strikes.ts`. **Only a T1 resets the count** — the obvious "anything not-junk resets" reading lets a bot alternate junk with a weather question so the third strike never lands; a T2 earns no strike and no reset. The count is zeroed when the lock fires, or "three in a row" becomes "one strike, forever". *Enforced by:* `lib/strikes.test.ts`, `payments/states.test.ts`.
- **Per-IP limits (2026-09-09).** `src/lib/ipLimit.ts` is the pure window math and the numbers (sign-in codes **10/IP/hour**, account creations **5/IP/day**, Penny turns **30/IP/hour**); `src/server/ipLimit.ts` is the counter table and the gate. **Fixed windows in a counter table (`ip_request_counters`), not a rolling query over a request log** — a log grows with the flood it exists to survive; one row per (scope, address, window) cannot. The known cost is a boundary straddle, and it is written down where the decision is. **It is not an authentication boundary**: an IP is a hint, a household shares one and an attacker has as many as they want, so the limits sit at ~10× real behaviour and the global breaker is what actually bounds the damage. **It fails OPEN** — the one gate in the lockdown work that does, because the counter write is its only reason to touch the database and the breaker in front of it already fails closed. The account-creation limit sits BEHIND the "does this address already have an account" check (in `assertSignupGateOpen`), so a household, an office or a university is never refused on the second cup of coffee. Test-runner traffic is exempt via `isTestRequestAuthorizedByHeaders` — hard-off on production, asserted from both sides. **Vercel's own firewall is NOT doing any of this:** the project's WAF config read `{"active":null,"draft":null,"versions":[]}` on 2026-09-09 (no rules, no versions, never configured), and the app also runs on a laptop and in CI where no edge firewall exists at all. *Enforced by:* `lib/ipLimit.test.ts`, `lib/breakerGate.test.ts`, `auth/test-endpoints.test.ts`.
- **The paywall master switch is a DATABASE ROW, not an env var (2026-09-02).** `app_meta` key `paywall_enabled`, `'1'` for on, flipped from `/admin` through `POST /api/admin/paywall`. It was `PAYWALL_ENABLED=1` in Vercel, which had two problems that only appear at the moment you want to use it: **turning it off needed a redeploy** — the slowest control in the system, reached for exactly when the paywall is blocking people who should not be blocked — and **nothing could see it**, so the two `/admin` blocks that warn "the switch is off" were reading a prop threaded down from a page that read `process.env` itself.
  - **`paywallEnabled()` is now async and cached ~30s in-process**, and the cache is not an optimisation: it is called from `applySwitch`, which `getAccountVerdict` calls on EVERY gated request, so an uncached read is a query per Penny turn forever for a value that changes twice a year. The cache is per-instance and Vercel runs several, so worst case is ~30s after the last instance's read — fine for this, and it would not be for anything security-critical. This decides whether a TRUE verdict is ENFORCED, never what the verdict is.
  - **Fails closed, to OFF**, on a read error, and a failed read is not cached. The asymmetry is not close: answering "on" during a database blip paywalls every account until it clears, and answering "off" costs a few free Penny turns. `paywallEnabledFromValue` is the pure rule and its test pins the direction of every ambiguity — `'true'`, `'yes'`, `' 1'` and a missing row are all OFF.
  - **Every flip is logged** to `usage_events` (`admin:paywall-switch`) with the admin who pressed it, because `app_meta` has nowhere to record an author and "who turned the paywall on, and when" is the first question asked the first time somebody is blocked unexpectedly.
  - **Ops note:** delete `PAYWALL_ENABLED` from Vercel once this is deployed. Nothing reads it any more, so leaving it set is inert rather than dangerous — but a variable that looks like it controls the paywall and does not is exactly the thing that costs an afternoon later.
- **Promo codes — BUILT (migrations 0028 + 0029, 2026-08-27, reworked 2026-09-02).** An admin mints a code for one email address; that person signs in and **the code claims itself**, and the paywall lets them through. Designed so the entitlement surface did not grow: **redeeming writes an ordinary `subscriptions` row with `source: 'promo'`**, and `hasEntitlement`, `resolveAccountState` and its twelve tested states needed **no change at all**. Nothing in the paywall path reads `promo_codes` — a second entitlement source would have been a second place able to decide someone has paid, which is exactly what the bounded-module rule exists to prevent. A promo user shows in the admin panel as a subscriber whose row says where it came from.
  - **What it grants: a FIXED TERM (migration 0029, 2026-09-02).** `promo_codes.grant_months` is 6 or 12 — a select in the admin form, validated in the Zod schema on `POST /api/admin/promo`, NOT free text (an admin typing 600 into a months box is a mistake nobody notices for fifty years). It used to be unlimited. The ORDINARY $8.50 rolling-twelve-month usage cap still applies: a promo account generates no revenue to offset spend. `auto_renew` stays `true` — nothing renews a promo, but `false` resolves to `cancelled_in_period` and would tell the admin panel a story about a cancellation that never happened; the term ends on its date whatever `auto_renew` says.
  - **THE CLOCK STARTS AT REDEMPTION, not at minting.** Minting is when an admin types an address into a form; redemption is when the recipient actually has the app. A six-month code minted today and redeemed in three weeks would otherwise be five months and a week of a gift meant as six, with nothing telling anybody. `expires_at` is the separate control for "use it or lose it" and is the right one for that job — hence the admin labels, "code expires in (days)" against "access: 6/12 months".
  - **`resolveAccountState` needed NO change for the term to work**, and that is worth knowing before touching it. Its `periodOver` branch already treats an `active` row with a past `current_period_end` as `expired` — "the clock is the authority, not the stale status", written for a missing renewal webhook. `promoTerm.test.ts` pins that for a promo row specifically, because the branch is now load-bearing for two features and a change making expiry depend on `auto_renew` or `source` would leave `states.test.ts` green while giving every ambassador unlimited access. `addMonthsUTC` clamps (31 Aug + 6mo is 28 Feb, not 3 Mar) and lives in `src/lib/promoCode.ts` — the pure half — because `promo.ts` is `server-only` and the unit project cannot import it.
  - **The code CLAIMS ITSELF on sign-in (2026-09-02).** `claimPromoOnSignIn` finds an unredeemed, unexpired code bound to that address and redeems it, so minting for somebody who has not signed up yet is now enough. **Wired into BOTH sign-in paths** — the Auth.js `signIn` event AND `createSessionForEmail` in `auth/otp.ts` — for the same reason `syncCompedFlagOnSignIn` is: `createSessionForEmail` is not an Auth.js sign-in, so those events never fire for OTP or for the native OAuth exchange, and wiring only the events is a mistake this repo has already made once. It goes through the EXISTING `redeemPromoCode` and its atomic claim, so there is still no second grant path and two concurrent sign-ins cannot both win a code. **Failure is silent and non-fatal** — logged to `usage_events` (`promo:auto-claim`), never a reason somebody cannot get into the app. The manual box stays in both purchase sheets as the fallback for somebody who signed up with a different address than the one you minted for.
  - **It will not clobber a LIVE Apple subscription, on EITHER path.** `upsertSubscription` writes ONE row per user, so redeeming for somebody who already pays Apple would overwrite their `apple_iap` row while Apple carried on charging them, and the next renewal webhook would land against a row that no longer carries the transaction id it is keyed to. The guard lives in `redeemPromoCode` (2026-09-02) so the manual box and the auto-claim both get it — it was in the auto-claim only, on the argument that a user typing a code is at least choosing, which does not hold: they are choosing to redeem a code, not to detach a subscription, and nothing on that screen says the second thing happens. Checked BEFORE the atomic claim, so the code is not spent. **Scoped to LIVE rows** (`holdsLiveApplePurchase`, pure and in `src/lib/promoCode.ts`): `active`, `grace` and `cancelled`-with-time-left are protected — `cancelled` because they paid through the term and an `UNCANCELLATION` can still arrive — while `expired`/`refunded`/`revoked` are not, since a lapsed customer is exactly who an ambassador plan is for. Deliberately NOT `hasEntitlement`: that runs through `applySwitch`, which reports everybody entitled while the paywall switch is off, so it would refuse every redemption on production today.
  - **Codes are BOUND to one address and single-use.** `decidePromoRedemption` (`src/lib/promoCode.ts`, pure, unit-tested, mirrored to mobile) compares the code's email against the SESSION's — there is no `email` field in the request body, so nothing can redeem on another address's behalf. **`promo_wrong_account` is checked BEFORE spent and expired, deliberately:** somebody holding a forwarded code must not learn, by trying it, whether it has been used or when it lapsed, because both are facts about the real recipient's account.
  - **The claim is atomic**, not a check-then-write: `UPDATE … WHERE id = ? AND redeemed_at IS NULL RETURNING`. Postgres picks the winner, so two requests landing together cannot both come back with a grant — the same lesson as `penny_turns_one_running_per_trip_idx`. The claim happens BEFORE the grant on purpose: the losing order leaves an unclaimed code that has already granted access, i.e. one that can be spent twice.
  - **The alphabet omits `O/0`, `I/1/L`, `S/5` and `U`** — the pairs people misread off a phone — and generation uses rejection sampling, not `byte % 27`, which would bias the first four characters. `promoCode.test.ts` asserts that, because a biased code space is the kind of thing nobody goes back and checks.
  - **Stored in plaintext, and the `deleted_users` HMAC reasoning does NOT carry over.** A code is not a bearer token: redeeming needs a session for the bound address, which needs a code delivered to it. What plaintext exposes is "an admin issued a code to alice@example.com", and a preview clone already exposes every address in `users` wholesale. What it buys is real — the admin can re-read a code they issued three weeks ago when the recipient loses it.
  - **Surfaces:** the promo box is in BOTH purchase sheets (web: `src/components/PurchaseOptions.tsx`, rendered inside `PurchaseSheet` for Penny's bubble and the pane scrim, and INLINE in the `/trips` block overlay since 2026-09-22 so that overlay no longer stacks a sheet on itself; iOS: `mobile/components/PurchaseSheet.tsx`), under the two prices and a peer of them — not a "have a code?" disclosure, because hiding the one control a comped user was told to look for is a small cruelty. Both call `onRedeemed` only after re-reading `/api/me/entitlement`; a 200 from the redeem route is not entitlement. Admin: `PromoCodeBlock` on `/admin` (mint, copy, list), which warns when the paywall switch is off for the same reason `TestUserBlock` does — with the switch off, redeeming looks like it did nothing. **No delete and no revoke:** an unspent code that should not have gone out is handled by not sending it, and a spent one is a subscription, ended through the existing break-glass revoke that demands a typed reason.
  - **A promo and an admin comp are DIFFERENT grant paths and Settings names them differently.** `users.comped` is a boolean checked at the top of `resolveAccountState`, before any subscription row is read, and surfaces as `state: 'comped'` — that is the author's own account and the E2E fixtures, and it reads "On the house — no end date". A promo is an ordinary `subscriptions` row that resolves to `subscribed`, and reads **"Ambassador plan — ends 3 Mar"** (the owner's word, and "ends" rather than "renews" because nothing renews it). Telling them apart needs `source` on the wire, plumbed through `AccountVerdict` alongside `productId` the same way — display only, never read by the rules.
  - Copy lives in `src/lib/promoCopy.ts` (mirrored), one message per refusal code, sharing no string — `promoCopy.test.ts` fails if they collapse or if one starts accusing the reader. Both clients render the server's message verbatim so there is one place to reword it.
  - Tests: `src/lib/promoCode.test.ts`, `src/lib/promoCopy.test.ts`. `POST /api/test/promo` mints a code for a fixture address so an E2E spec can walk a redemption without an admin session (same three guards as the rest of `/api/test/*`).

- **A revoke is undoable, and the undo hands back the ROW, not TIME (migration 0040, 2026-09-10).** `/admin/users/[id]` could take access away and could not give it back: the button turned into a dead "Access already revoked", so a misfire — or a `REFUND` webhook that turned out to be about a different account — was unfixable from the product.
  - **`subscriptions.pre_revoke_status` is the whole mechanism.** `revokeSubscription` overwrites `status` IN PLACE, so the moment it runs the previous status is gone, and `currentPeriodEnd`/`productId`/`source` cannot tell an active plan from an expired one. It now records what it is about to destroy, and `reactivateSubscription` consumes it — so an account that was `expired` when it was revoked comes back **expired**, which is what stops the button being a way to mint free plans out of dead accounts. A term that ran out WHILE the account was revoked also stays run out, for free: `resolveAccountState` already treats the clock as the authority over a stale status.
  - **`'none'` is the extra member of the union and it is load-bearing.** Revoking an account with no subscription row CREATES one, and what the undo has to restore is the ABSENCE of a row — the seven-day trial is derived from `users.created_at` and is deliberately never stored — so the undo DELETES the row. Without that member, a mistakenly-revoked trial user is indistinguishable from a row revoked before the column existed, which is **refused** with a sentence rather than guessed at (there are such rows in prod; backfilling them is a job for a human with `subscription_events` in front of them).
  - **A double-revoke must not clobber the recorded status** — the second press is exactly the one an admin makes when unsure the first worked, and recording `'revoked'` as the thing to restore would destroy the only field that makes the undo possible. The rule is written twice, on purpose: `preRevokeStatusFor` in TypeScript (unit-tested) and a `CASE` inside the `ON CONFLICT DO UPDATE`, so the write is atomic against a concurrent one rather than a read-then-write.
  - **BOTH admin actions now write a `subscription_events` row** naming the admin and their typed reason, inside the same transaction as the write. Neither did before. That ledger is what makes clearing `revoked_at`/`_by`/`_reason` on an undo safe — those three columns only ever describe the LATEST revoke, and an undo would otherwise erase the fact that one ever happened. `/admin/users/[id]` renders them as an ordered ACCESS HISTORY under the row. `eventTimeMs` is our own clock, matching `PROMO_REDEEMED` and `FAKE_PURCHASE`, with the known consequence that a store event delayed past an admin decision is treated as stale.
  - The decision is pure and unit-tested in `payments/reactivation.ts` (`planReactivation`, `preRevokeStatusFor`, `reactivationLandingLine`); `POST /api/admin/subscription/reactivate` mirrors the revoke route down to the ZodError branch, and a refusal is a **400 carrying its own sentence, never a silent 200**. The admin route is unreachable from CI (one hardcoded address), so `e2e/subscriptions.spec.ts` drives the same two functions through `/api/test/subscription`'s `adminAction`. *Enforced by:* `payments/reactivation.test.ts`, `payments/reactivateRoute.test.ts`, the round trip in `payments/states.test.ts`, `adminEntitlementAuditGuard.test.ts`.
- **The `revoked` paywall copy is the ONE joke, and `usage_cap` never borrows it (2026-09-10).** A suspended account used to read like a bank letter; it now leads with Penny having lost all her balls in the river. The gag may be reworded — what may not move is "temporarily suspended" and "email support", because a locked-out person needs to know they are locked out and where to go, and a joke wrapped around either is worse than the dry version. It is `revoked` ONLY: `usage_cap` fires when OUR per-trip cost regressed, so a joke about somebody's account at that moment reads as blaming them for our bug. All three surfaces move together — `payments/copy.ts` (Penny's bubble + the app overlay), `lib/paywallCopy.ts` (the web notice), `auth/guards.ts` `paywallMessage()` (the 402 string). `PaywallCopy.heading` is new and OPTIONAL: the app overlay's hardcoded "Planning is paused" is right for the other three and wrong for a suspension, so only that one sends a heading, server-authored so it changes without a TestFlight binary. *Enforced by:* `paywallCopy.test.ts`.
- **There is no fake purchase (removed 2026-09-21).** `POST /api/purchase/test`
  granted a subscription without Apple to `sam+trial-<tag>@feraltravels.com`
  addresses while `SUBSCRIPTION_TESTING=1`; it, `isTestPurchaseAllowed`, the
  `testPurchaseAllowed` payload field, the app's `test` purchase mode and every
  button that called it were deleted before the production wipe. This bullet
  used to say the Playwright subscription specs ran on it — they never did;
  they write state through `/api/test/subscription` and went 15/15 before and
  after the removal. The webhook is the only grant path (decision E6).
  `npm run trial-account new` still prints a fresh address, but the script now
  refuses the production database (decision E13).
- **The Test users block at the bottom of `/admin` creates disposable paywall
  accounts** — `payments/testAccounts.ts` behind `POST /api/admin/test-users`,
  armed by `SUBSCRIPTION_TESTING=1`, every action refusing any address outside
  `sam+trial-<tag>@feraltravels.com`. Two one-click presets, each producing a
  real account state. **It cannot run in production**: `payments/testAccounts.ts`
  writes `source: 'fake'` subscriptions, so it refuses to LOAD there, the route
  answers 404 from `testAccountsAvailable()` before a dynamic import, and the
  card is absent from production `/admin` (decision E13). (There is no `/admin/test-users` PAGE — it was folded into
  the dashboard; a link to it survived the move and 404'd for two weeks.)
  **The block warns when the paywall switch is off**, because an account
  generated in that state is `trial_expired` and still walks every surface
  unblocked — `applySwitch` rewrites the verdict — which reads exactly like a
  broken paywall and is not one. It hands back the
  address, a REAL sign-in code, and a `/login/verify?email=…` link to paste
  into an incognito window. **There is deliberately no "sign in as this user"
  action** — the auth guard test in `src/lib/` fails the suite on anything
  resembling one, and it caught the first draft of the comment explaining this.
  What the page removes is the mailbox, not a step of authentication: the code
  goes through the real verify form and the real verifier with its expiry and
  attempt limits. Same trade `/api/test/otp` makes for E2E.
  **The `resend` action is the sharp edge** — it reaches `sendOtpCode` directly
  and returns the code, so the address assert sits in the ROUTE, before the
  call. Without it an admin could be handed a working sign-in code for any
  user's account. `testAccounts.test.ts` exists to make removing it loud.

- **`syncCompedFlagOnSignIn` must be called from BOTH sign-in paths** — the
  Auth.js `signIn`/`createUser` events AND `createSessionForEmail` in
  `auth/otp.ts`, which is not an Auth.js sign-in and is what OTP and
  `/api/mobile/oauth/exchange` actually use. Wiring only the events left every
  native sign-in on the column default. `syncAdminFlagOnSignIn` has always had
  a call in both places for exactly this reason.
