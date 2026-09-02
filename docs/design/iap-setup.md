# In-app purchases: the setup, in dependency order

Status: **the code is built.** `react-native-purchases` is in the app,
`mobile/lib/purchases.ts` configures it, prices come from the store's Offerings,
and the entitlement still comes from the webhook. What remains is
**configuration** — Apple's, then RevenueCat's — and none of it is in this repo.

`docs/design/subscriptions.md` is the WHY (pricing, the twelve account states,
why cancelling does not block). `docs/design/revenuecat-implementation.md` is
the architecture and the verification checklist, and is still accurate. **This
file is the ordered list of things to click**, plus what each failure looks like
when you have not done them.

**The order is the document.** Almost every step here blocks the next one, and
doing them out of order is how you end up staring at an empty purchase sheet
with nothing in any log to tell you why.

> ## ⚠ The app moved to a new Apple developer account (2026-09-02)
>
> **New bundle id: `com.feraltravels.ios`. New products:
> `com.feraltravels.ios.monthly`, `com.feraltravels.ios.annual`.**
>
> The old `com.feraltravels.app` is **permanently unusable**. Uploading a
> TestFlight build binds a bundle id to the developer account that uploaded it,
> forever — confirmed with Apple DTS — and one was uploaded under the old US
> team. The app has never been released and has no users, so this is a pure
> rename with nothing to migrate.
>
> Every id in this repo is already renamed. What is NOT, because it does not
> exist yet, is everything bound to the *account*:
>
> | Still on the old account | Where | What it needs |
> |---|---|---|
> | `ascAppId: "6802705582"` | `mobile/eas.json` | The new app record's id. `eas submit` targets the OLD app until this changes. |
> | `appleTeamId: "4CG2UE2L49"` | `mobile/eas.json` | The new team id. |
> | `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID` | `mobile/eas.json`, both profiles | **A NEW Google Cloud OAuth client.** iOS clients are bound to a bundle id, so the existing `205269478779-…` one cannot authorise `com.feraltravels.ios`. See below. |
> | `AUTH_GOOGLE_IOS_CLIENT_ID` | Vercel (production + preview) | The same new client id, server side — it is the audience `oauthIdentity.ts` checks Google tokens against. |
> | `APPLE_APP_BUNDLE_ID` | Vercel, **if it is set** | The Apple ID-token audience. The code default is already `com.feraltravels.ios`; an env var still holding the old value would silently override it and fail every Apple sign-in. Check, and delete it rather than update it — the fallback is correct now. |
> | App Store Connect record, agreements, products, sandbox testers, In-App Purchase Key | Apple + RevenueCat | All of §1–§7 below, from scratch, on the new account. |
>
> **The Google OAuth client is the one most likely to be forgotten**, because
> nothing fails at build time. An iOS OAuth client in Google Cloud is registered
> against a specific bundle id; point the app at `com.feraltravels.ios` while the
> client still says `com.feraltravels.app` and the button renders, opens, and
> dies at the redirect with an unregistered-client error. Create a new client
> (Google Cloud → Credentials → Create credentials → OAuth client ID → iOS,
> bundle id `com.feraltravels.ios`), then update **both** `eas.json` profiles and
> **both** Vercel environments. `app.config.js` derives the reversed URL scheme
> from that value automatically, so nothing else changes.
>
> Leaving the old client id in `eas.json` is worse than emptying it: an empty
> string collapses to null and the button HIDES itself (`mobile/lib/config.ts`),
> while a wrong-but-present value shows a button that dead-ends. If a build has
> to be cut before the new client exists, empty it.
>
> `docs/design/ios-oauth/README-oauth.md` is the full OAuth walkthrough and still
> names the old team; read it for the steps, not the values.

| # | Step | Blocks | Who can do it |
|---|---|---|---|
| 0 | Nothing — try it in the simulator first | — | you, in 10 minutes |
| 1 | **Paid Applications Agreement** + tax + banking | **Everything real** | Account Holder only |
| 2 | Subscription group + the two products | Any price from Apple | Admin |
| 3 | Small Business Program | Every number in `constants.ts` | Account Holder |
| 4 | RevenueCat project, In-App Purchase Key, entitlement, offering | The app seeing a price at all | you |
| 5 | `EXPO_PUBLIC_REVENUECAT_IOS_KEY` in `mobile/eas.json` | The app talking to RevenueCat | you |
| 6 | Webhook URL + `REVENUECAT_WEBHOOK_SECRET` in Vercel | Access ever being granted | you |
| 7 | Sandbox Apple Account | Testing renewal and expiry | you |
| 8 | `PAYWALL_ENABLED=1` | Any of it mattering | you, **last** |

---

## 0. Before any of it: the simulator

There is a **StoreKit configuration file** in `mobile/storekit/` — a fake App
Store in a JSON file. With it, the purchase sheet, Apple's confirmation dialog,
cancel, Ask to Buy and accelerated renewals all work in the simulator with **no
App Store Connect round trip and no sandbox Apple Account**.

```bash
scripts/ios-e2e-local.sh up        # local server + throwaway database
scripts/ios-e2e-local.sh build     # prebuild, inject the store, compile, install
scripts/ios-e2e-local.sh xcode     # open the workspace, press Run
```

**It does not remove RevenueCat from the loop.** The app asks RevenueCat for an
Offering and RevenueCat looks each product up through StoreKit; this file
satisfies the second step and not the first. So section 4 and section 5 are
still required before a price appears — but sections 1, 2 and 7 are not.
`mobile/storekit/README.md` has the full table.

It also cannot be driven by Maestro: the configuration is activated by the
scheme's launch action, and Maestro installs the `.app` and launches it outside
any scheme. There is no `simctl storekit` subcommand as of Xcode 26.6 (checked,
not assumed). Purchases are a human loop; the flows in `mobile/maestro/`
deliberately do not attempt one.

---

## 1. The Paid Applications Agreement, and why it is first

**Until it is Active, StoreKit returns an empty product array.** Not an error.
Not a permission denial. An empty array, in sandbox and in TestFlight, and
RevenueCat turns that into `offerings.current === null` or a current offering
with no packages.

**What it looks like in this app:** the purchase sheet shows the two prices —
`$2` and `$20`, the fallback strings from `PRODUCTS` in
`src/server/payments/constants.ts` — with **no buy button**, under the line
*"The App Store isn't offering these plans on this build yet."* That is
`mode: "unavailable"` in `mobile/lib/purchaseFlow.ts`, and it is the honest
rendering of "we asked and got nothing back". There is nothing in any log,
because nothing failed.

Every developer hits this once and it costs a day. It is the one step here with
a human in the loop at Apple's end, so start it now.

**Where:** App Store Connect → **Business** (top nav) → **Agreements** tab → the
**Paid Apps** row → *View and Agree to Terms*. Only the **Account Holder** can
do this — no other role, Admin included.

Three things must all be green, not one:

| Thing | Where | Wanted status |
|---|---|---|
| Paid Apps agreement | Business → Agreements | **Active** (not "Waiting for User Info") |
| Tax forms | Business → Tax | Submitted and accepted |
| Bank account | Business → Banking | **Complete** (not "In Progress") |

Banking is the slow one — Apple validates a real account. When Apple publishes a
new version of the agreement you cannot create new apps *or new in-app
purchases* until you accept it; if products stop appearing months from now and
nothing changed, check this row first.

---

## 2. The two products

One subscription **group**, two products inside it. Products in the same group
are mutually exclusive and Apple handles upgrade, downgrade and proration
between them for free — so monthly → annual is one tap with Apple doing the
maths, and nobody can hold both.

**Where:** the app record → **Monetization** → **Subscriptions** → create a
group. The reference name is internal; the **display name** is what the user
sees in Manage Subscriptions, so make it "Feral Travels".

| Product ID | Duration | Price | Source of truth |
|---|---|---|---|
| `com.feraltravels.ios.monthly` | 1 month | **$2.00** | `PRODUCTS` in `src/server/payments/constants.ts` |
| `com.feraltravels.ios.annual` | 1 year | **$20.00** | same |

The ids must match `constants.ts` **character for character**. This is the
second commonest cause of an empty offering, and in this app it has a distinct
symptom worth knowing: `usePurchaseFlow` merges the server's plan list with the
store's packages **by product id** and drops any plan with no matching package.
So a single mistyped id makes that one plan vanish from the sheet while the
other still buys. One price where there should be two means a typo, not an
agreement problem.

**Whole-dollar prices are selectable.** Apple's December 2022 overhaul added 700
price points and removed the requirement that prices end in `.99`. You do not
need $1.99/$19.99. Check the international table it auto-generates — conversion
produces endings like €2.49; set the even equivalents by hand per storefront if
you care (cosmetic, not blocking).

**A product must be out of Missing Metadata to be fetchable in sandbox** —
state **Ready to Submit** or Approved. Each one needs a localization (display
name + description), a price for the primary storefront, a **review
screenshot** (a mock is fine; it is only for review), and the subscription group
localization. Products do not need to ship with a build to work in sandbox; they
do for the first App Store release.

---

## 3. Small Business Program — apply now, it is not automatic

15% instead of 30%. **Every net figure in `subscriptions.md` and every threshold
in `constants.ts` assumes it** — `STOP_MICROCENTS` is $8.50 because that is 50%
of $17.00 annual net at 15%. At 30% the annual nets $14.00 and the cap is wrong.

- **Eligibility:** ≤ $1,000,000 USD proceeds in the prior and current calendar
  year, across all associated accounts. Nowhere near it.
- **Where:** developer.apple.com → App Store → Small Business Program → Enroll.
  Account Holder, and the current Paid Apps agreement must already be accepted —
  another reason section 1 is first.
- **When it takes effect:** 15 days after the end of the fiscal month in which
  enrolment is approved. Approved in February → the rate changes in mid March.

No deadline, no cost. Apply the same day you sign the agreement.

---

## 4. RevenueCat

### 4a. Project and app

Dashboard → new **project** ("Feral Travels") → add an **App Store** app. Bundle
ID `com.feraltravels.ios`, exactly, correctly capitalised.

### 4b. The In-App Purchase Key — not the shared secret

Old advice says App-Specific Shared Secret. **That is StoreKit 1, which Apple has
deprecated.** RevenueCat SDK v5+ uses StoreKit 2, and with StoreKit 2
*transactions are not recorded at all* without an In-App Purchase Key.

1. App Store Connect → **Users and Access** → **Integrations** → **In-App
   Purchase** → *Generate In-App Purchase Key*.
2. Download the `.p8`. **You get exactly one download.** Same drawer as the ASC
   API key `.p8` from the TestFlight setup — two `.p8` files, two purposes, both
   downloadable once.
3. Copy the **Issuer ID** from that page. (No Issuer ID shown? Create an App
   Store Connect API key first; generating one surfaces it.)
4. RevenueCat → app settings → **In-app purchase key configuration** → upload
   the `.p8`, paste the Issuer ID, wait for "Valid credentials".

### 4c. Entitlement, products, offering

- **Entitlement identifier: `pro`.** Not negotiable and not improvised: it is
  hardcoded as `REVENUECAT_ENTITLEMENT_ID` in `mobile/lib/config.ts` and
  fixtured as `entitlement_ids: ['pro']` in `webhook.test.ts`. If the dashboard
  says something else, `restorePurchases` reports **"nothing to restore"** to
  somebody who is paying.
- Product Catalog → **Products** → add both product ids.
- **Attach both to `pro`.** A product with no entitlement grants the buyer
  nothing: the purchase succeeds and the app stays locked.
- One **Offering** (identifier `default`) with two packages, `$rc_monthly` and
  `$rc_annual`. The offering is what the app fetches to render prices — the
  app reads `offerings.current.availablePackages`, so it must be the *current*
  one.

### 4d. `app_user_id` — the one thing that must not be wrong

**RevenueCat's app user id must be our `users.id`.** Not the email, not an
anonymous id, not the session token. `src/server/payments/webhook.ts` resolves
the buyer with a direct equality join against the primary key; anything else
lands every webhook as `ignored_unknown_user` — **the money is taken and nobody
is entitled**, and it looks identical to working until somebody tries to plan a
trip.

**This is already handled in code and there is nothing to configure**, but know
where it lives, because it is the thing to check first if a purchase ever fails
to grant:

- `GET /api/me/identity` now returns `id`. It is read from the server, not
  remembered from the sign-in response, because a restored keychain session has
  no sign-in response — the state the app is in on every launch after the first.
- `configurePurchases()` (`mobile/lib/purchases.ts`) subscribes to
  `onTokenChange`, so every sign-in calls `Purchases.logIn(users.id)` and every
  sign-out calls `logOut()` — including the automatic `clearToken()` that
  `apiFetch` performs on a 401.
- `requirePurchaserId()` runs before **every** purchase and restore and
  **refuses** if it cannot confirm the id. Buying anonymously is worse than not
  buying: the second is a message on screen, the first is an unattributable
  charge.

**Verify it once, by eye:** RevenueCat → Customers → find yourself. The id must
be a UUID that exists in `users`. If it starts with `$RCAnonymousID:`, `logIn`
never ran.

---

## 5. The key in the build

RevenueCat → API keys → the **public** Apple SDK key (`appl_…`). Public by
design: it identifies the app and grants nothing, and every entitlement decision
is made server-side from the webhook.

Replace `REPLACE_WITH_appl_KEY_FROM_REVENUECAT` in **both** `build.preview.env`
and `build.production.env` in `mobile/eas.json`.

**Both, and in eas.json specifically.** `eas.json`'s `env` block applies to
builds; `eas update` bundles with whatever is in the shell — and
`.github/workflows/mobile.yml` reads that block out of `eas.json` and exports it
before publishing an OTA (the step named *Load the production env from
eas.json*) precisely so `EXPO_PUBLIC_*` values cannot silently collapse to their
fallbacks. Put the key anywhere else and a future OTA ships an app with no
RevenueCat key.

The key must start with `appl_`. `mobile/lib/config.ts` enforces that, and it is
not pedantry: it makes the placeholder above behave as *unset* rather than as a
key, and it catches the two wrong keys on the same dashboard page — the Android
key (`goog_`) and the **secret** API key, which must never be in a client
bundle.

**What an unset key looks like:** the sheet renders the fallback prices with no
buy button and says purchasing is not wired up — the same `mode: "unavailable"`
as section 1. That is deliberate. The two failures are indistinguishable from
inside the app, so the app says the one true thing it knows.

### What installing this did to the release pipeline

`react-native-purchases` is a **native module**, so `mobile/package.json` and
`mobile/package-lock.json` moved and `scripts/decide-mobile-release.mjs`
classifies the merge as **native**: no OTA, a fresh TestFlight binary, ~30
minutes of EAS queue and one build credit.

That is the safety property, not a limitation. A JS bundle that calls into a
native module the installed binary does not carry **crashes on launch**. Every
existing tester must install the new TestFlight build before they can see any of
this.

---

## 6. The webhook

RevenueCat → project → **Integrations** → **Webhooks** → Add.

| Field | Value |
|---|---|
| URL | `https://www.feraltravels.com/api/webhooks/revenuecat` |
| Authorization header | a long random string — `openssl rand -base64 32` |
| Environment | **Sandbox and Production**, both |
| Event types | all (the handler ignores what it does not know, on purpose) |

Paste the **same string** into RevenueCat's *Authorization header* field and
into Vercel → Settings → Environment Variables → `REVENUECAT_WEBHOOK_SECRET`,
**Production**. Redeploy. The route compares the inbound header **verbatim** —
if you typed `Bearer <secret>` into RevenueCat, the env var must be
`Bearer <secret>` too. There is no parsing.

**The route returns 503 until the variable is set, deliberately.** An unset
secret means the deploy is not finished, and a handler that default-opens on a
missing variable is one `vercel env rm` away from letting anybody mint
subscriptions. 503 is also the useful answer: RevenueCat retries it (5, 10, 20,
40, 80 minutes), so events queued during a misconfigured window are delivered
once you set it.

**Turn sandbox events on.** They carry `environment: "SANDBOX"` in the payload,
stored verbatim on the `subscription_events` row. Without them, sandbox testing
proves the sheet works and proves nothing about the half of the system that
grants access.

### What the app does while it waits

`purchasePackage` resolving means Apple charged the card. It does **not** mean
our server knows. So the app polls `GET /api/me/entitlement` on the schedule in
`src/lib/entitlementPolling.ts` — front-loaded, then every 5s, giving up after
**60 seconds** — showing *"Payment received — switching your plan on…"*
throughout.

Giving up is not an error and the copy says so: the purchase is real, the
webhook retries for hours on its own, and the next app open resolves it. The
user is pointed at Restore purchases and told they have not been charged twice.

If purchases routinely hit that 60-second timeout, the webhook is not arriving —
check the delivery log (section 9 of `revenuecat-implementation.md`), not the
poll.

---

## 7. Sandbox testing

**Where the sandbox account goes:** Settings → Developer → **Sandbox Apple
Account**. Do *not* sign out of your real Apple ID under Media & Purchases and
sign in as the sandbox account; modern iOS has a dedicated slot and using the
wrong one is how you get stuck in a purchase loop.

Create the tester at App Store Connect → Users and Access → **Sandbox**, using an
address that has **never** been an Apple ID. Region decides the storefront, and
therefore whether the sheet says `$2.00` or `€2,00` — which is the whole point of
rendering `product.priceString` rather than `constants.ts`'s `"$2"`.

**TestFlight builds run against sandbox automatically** and testers are never
charged, so basic "does the sheet appear, does access unlock" needs no sandbox
account at all.

**Accelerated renewals, and there are two different tables.** With a **Sandbox
Apple Account**, 1 month = **5 minutes** and 1 year = **1 hour**, up to 12
renewals (rate is per-tester under Users and Access → Sandbox). A **TestFlight
build on a normal Apple ID** renews once per *day* regardless of duration, up to
6 times. So use a sandbox account when you are testing the state machine:
monthly gives a `RENEWAL` webhook every five minutes and an `EXPIRATION` about an
hour in.

The cases worth actually walking, all four of which the app has distinct
behaviour for:

| Case | How | What must happen |
|---|---|---|
| Cancel mid-sheet | Tap Cancel in Apple's dialog | Sheet stays open, **no red message** |
| Ask to Buy | Sandbox account → Ask to Buy, or Xcode's StoreKit editor | A grey notice about approval; **never** an error |
| Already subscribed | Buy on a second app account with the same Apple ID | "Restore purchases" advice, not a second charge |
| Cancelled subscription | Cancel in sandbox account settings | `auto_renew` false, `status` still `active`, **access continues** |

That last one is the regression the whole design exists to prevent. If access
disappears there, `TYPE_MAP` in `webhook.ts` has been edited and someone is about
to lose 362 days they paid for.

---

## 8. `PAYWALL_ENABLED=1` — last, and only when all of the above is true

See "What has to be true before the paywall goes on" below. Nothing before this
step blocks anybody; this step blocks everybody it applies to.

---

## Known gaps, stated rather than discovered later

**`TRANSFER` is handled as of 2026-09-02.** It used to be absent from
`TYPE_MAP`, so a restore onto a different app account with the same Apple ID
recorded `ignored_unknown_type` and entitled nobody. The owner's rule is that
the subscription follows the Apple ID: the account that just restored it holds
it, and the previous one is expired in the same transaction. The losing account
is not notified — its next gated request 402s with the ordinary
"subscription ended" copy.

Worth knowing before you touch it: a TRANSFER payload carries **no
`app_user_id`, no `product_id`, no `expiration_at_ms` and no
`original_transaction_id`** — only `transferred_from` and `transferred_to`. The
destination's row is therefore built from the origin's existing row, and the
Zod schema had to be taught that this one event has no `app_user_id` or it would
have rejected every real transfer at the boundary. See `applyTransfer` in
`webhook.ts` and the TRANSFER block in `webhook.test.ts`.

**The test-purchase path is untouched and stays.** `/api/purchase/test`,
`isTestPurchaseAllowed`, the `sam+trial-<tag>@feraltravels.com` pattern and
`SUBSCRIPTION_TESTING=1` all still work exactly as before — the Playwright
subscription specs run on them, and a sandbox purchase cannot replace them
because StoreKit's sheet is system UI behind a sandbox Apple ID login that
Playwright cannot drive.

In the app, `testPurchaseAllowed` **wins over the store**: an allowlisted address
gets the fake path even with RevenueCat live, because that is what such an
address is for. To exercise the real store, use any other address. To retire the
path entirely, unset `SUBSCRIPTION_TESTING` — no deploy needed.

---

## What has to be true before `PAYWALL_ENABLED=1` on production

The switch is off by default and that default is load-bearing: merging the
paywall PR once blocked 28 of 29 production accounts in the same instant, none of
whom had been told a trial existed and none of whom had any way to pay. Turning
it on is an env change, not a deploy, and it is reversible with no state to
repair — but it is the moment every one of the following stops being theoretical.

**All of these, together:**

1. **Sections 1–7 are done and section 9 of `revenuecat-implementation.md` has
   been ticked end to end on a real device** — ending at a `subscription_events`
   row with `outcome = 'applied'` and a trip created afterwards. Not "the sheet
   said Success". StoreKit will happily confirm a purchase our database knows
   nothing about; that is exactly what a wrong `app_user_id` produces, and it
   looks identical to working.
2. **A TestFlight build carrying this code is the one testers have.** The
   paywall in an older binary has no purchase sheet behind it — the OTA that
   would fix that is refused, correctly, because this is a native change. A
   blocked user on an old build has literally no way out.
3. **`REVENUECAT_WEBHOOK_SECRET` is set in Vercel Production** and the delivery
   log shows a 200. Unset, the route 503s and *every* purchase silently fails to
   grant.
4. **`DELETED_USER_ENC_KEY` and `AUTH_GOOGLE_IOS_CLIENT_ID` are set** on
   production — not paywall config, but both are asserted by e2e specs that fail
   rather than skip, and both are ways for a newly-blocked user to be unable to
   leave or unable to sign in.
5. **Restore works on a real device**, because a subscriber reinstalling with no
   Restore is a subscriber locked out, and it is a Guideline 3.1.1 rejection
   besides.
6. **The existing production accounts have been dealt with, one way or the
   other.** Every one of them is older than seven days, so all of them are
   `trial_expired` the instant the switch flips. Comp them
   (`isCompedEmail`/`users.comped` — note `syncCompedFlagOnSignIn` clears the
   flag for anyone off the hardcoded allowlist on every sign-in, so a bulk
   `UPDATE` undoes itself), issue promo codes, or accept that they are blocked
   and tell them first. Choosing is fine; being surprised is not.
7. **Support can answer.** `usage_cap` and `revoked` both point the user at
   `support@feraltravels.com` with nothing to buy. If nobody is reading that
   inbox, the paywall has a dead end in it.

**And know what the switch does NOT cover.** `PAYWALL_ENABLED` gates
*enforcement*, everywhere — web, iOS and Penny — through `applySwitch` in
`entitlements.ts`. It does not stop the trial clock, the usage metering or the
state machine, all of which keep running and stay truthful, so `/admin` shows who
*would* be blocked before you flip it. **Read that list first.** It is the cheap
version of the answer, and it is the step that was skipped last time.
