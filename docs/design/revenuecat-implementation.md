# RevenueCat implementation

Status: **not built.** The server half is done and deployed —
`src/server/payments/`, the `subscriptions` / `subscription_events` tables
(migration 0026), and `POST /api/webhooks/revenuecat`. Nothing on the Apple
side exists yet, and no line of StoreKit has ever run.

`docs/design/subscriptions.md` is the WHY — the pricing, the eleven account
states, why cancelling does not block. This file is the HOW, in order, written
for the version of you who has forgotten all of it. Follow it top to bottom.

**The order is the document.** Most of these steps are cheap and most of them
block the next one. Doing them out of order is how you end up staring at an
empty purchase sheet with no error message, which is exactly the failure
Section 1 exists to prevent.

| # | Step | Blocks |
|---|---|---|
| 1 | Paid Apps Agreement + tax + banking | **Everything.** No products in sandbox until this is Active |
| 2 | Subscription group + two products | Anything fetching a price |
| 3 | Small Business Program | Nothing technical — but every number in subscriptions.md |
| 4 | `react-native-purchases` in the Expo app | The purchase call |
| 5 | RevenueCat project, In-App Purchase Key, entitlement, `app_user_id` | The webhook finding the user |
| 6 | Webhook URL + `REVENUECAT_WEBHOOK_SECRET` in Vercel | Access ever being granted |
| 7 | Sandbox Apple Account | Testing any of it |
| 8 | The code swap | — |
| 9 | Verify, ending at the database | — |

---

## 1. The Paid Apps Agreement, and why it is first

**Until the Paid Apps Agreement is Active, StoreKit returns an empty product
array.** Not an error. Not a permission denial. An empty array, in sandbox and
in TestFlight, and RevenueCat turns that into `offerings.current === null` or a
current offering with no packages. The paywall renders with no prices and no
buy button, and there is nothing in any log to tell you why.

Every developer hits this once. It costs a day. Do it now, before you write
anything, because it is the one step here with a *human* in the loop.

**Where:** App Store Connect → **Business** (top nav) → **Agreements** tab →
the **Paid Apps** row → *View and Agree to Terms*. Only the **Account Holder**
can do this — no other role, including Admin.

Three things must all be green, not one:

| Thing | Where | Wanted status |
|---|---|---|
| Paid Apps agreement | Business → Agreements | **Active** (not "Waiting for User Info") |
| Tax forms | Business → Tax | Submitted and accepted |
| Bank account | Business → Banking | **Complete** (not "In Progress") |

Banking is the slow one — it wants a real account, and Apple validates it.
Tax forms for a US-domiciled individual are quick; the W-9 equivalent for other
jurisdictions less so.

**The trap inside the trap:** a local Xcode **StoreKit configuration file**
works perfectly without any of this, because it never talks to Apple. So a
simulator test can pass, convincingly, while the sandbox is still returning
nothing. Do not use a StoreKit config file to "verify the integration" —
verify it against the real sandbox or you have verified nothing. (It is also a
listed cause of empty products in its own right: a config file left active in
the scheme makes the SDK fetch from the file instead of the store.)

**Also note:** when Apple publishes a new version of the agreement, you cannot
create new apps *or new in-app purchases* until you accept it. If products stop
appearing months from now and nothing changed, check this row first.

---

## 2. The two products in App Store Connect

One subscription **group**, two products inside it.

**Why one group:** products in the same group are mutually exclusive and Apple
handles upgrade/downgrade/proration between them for free. Monthly → annual is
then a single tap with Apple doing the maths, and the user can never hold both.
Two groups would mean building that yourself and getting it wrong.

**Where:** the app record → **Monetization** → **Subscriptions** → create a
group (reference name is internal; the *display name* is customer-facing and
appears in the user's Manage Subscriptions screen — make it "Feral Travels").

Then two auto-renewable subscriptions in it:

| Product ID | Duration | Price | Source of truth |
|---|---|---|---|
| `com.feraltravels.app.monthly` | 1 month | **$2.00** | `PRODUCTS` in `src/server/payments/constants.ts` |
| `com.feraltravels.app.annual` | 1 year | **$20.00** | same |

The ids must match `constants.ts` **exactly**, character for character. A
mismatch is the second most common cause of an empty offering.

**Whole-dollar prices are selectable.** Apple's December 2022 pricing overhaul
added 700 new price points — 900 in total, from $0.29 up to $10,000 — and
explicitly removed the requirement that prices end in `.99`. $2.00 and $20.00
both exist as price points. You do not need to accept $1.99/$19.99.

**Do not let Apple auto-convert the other storefronts.** Pick the USD price
point, then check the international table it generates: auto-conversion
produces endings like €2.49 and £1.79. Set the even equivalents by hand per
storefront if you care about that (the earlier plan doc did; it is cosmetic and
not blocking). Note US storefronts add state sales tax on top at charge time —
that is Apple and state law, not something you control.

**What state a product must be in to be fetchable in sandbox:** **Ready to
Submit** (or Approved, once live). A product sitting in **Missing Metadata**
is invisible to StoreKit — that is a third way to get an empty array. To clear
Missing Metadata each product needs:

- a localization: display name + description,
- a price for the primary storefront,
- a **review screenshot** (yes, before you have ever run the paywall — take a
  mock or a screenshot of the design, it is only for review),
- subscription group localization + the group display name.

Products do **not** need to be submitted with a build to work in sandbox; they
need to be out of Missing Metadata. They *do* need to be submitted alongside a
build for the first App Store release.

Allow propagation time. For a live app the community rule of thumb is products
must have been Approved for 24h+ before they reliably resolve; in sandbox it is
usually minutes, but "I just created it" is a legitimate reason for an empty
result.

---

## 3. Small Business Program — apply now, it is not automatic

15% instead of 30%. **Every net figure in `subscriptions.md` and every
threshold in `constants.ts` assumes it** — `STOP_MICROCENTS` is $8.50 because
that is 50% of $17.00 annual net at 15%. At 30% the annual nets $14.00 and the
cap is wrong.

- **Eligibility:** ≤ $1,000,000 USD in total proceeds in the prior calendar
  year and in the current year, across all associated developer accounts. You
  are nowhere near it.
- **Where:** developer.apple.com → App Store → Small Business Program → Enroll.
  Account Holder, and you must have accepted the current Paid Apps agreement
  first — which is another reason Section 1 comes first.
- **When it takes effect:** 15 days after the end of the fiscal month in which
  your enrolment is approved. Approved in February → the rate changes in mid
  March. So apply *before* you have revenue, not after.

There is no deadline and no cost. Apply the same day you sign the agreement.

---

## 4. `react-native-purchases` in the Expo app

```bash
cd mobile
npx expo install react-native-purchases
```

`expo install` rather than `npm install` so the version is pinned to something
compatible with Expo SDK 54 / RN 0.81. **No config plugin entry is needed** —
the package autolinks, and EAS runs prebuild for you. Do not add anything to
`app.config.js` for it.

We do **not** want `react-native-purchases-ui`. That package is RevenueCat's
prebuilt paywall templates; our paywall is Penny asking in her own voice, which
is the whole product personality and is not a template.

### What this does to the release pipeline, and why that is correct

`react-native-purchases` is a **native module**. Installing it changes
`mobile/package.json` and `mobile/package-lock.json`, and both are on the
native-input list in `.github/workflows/mobile.yml`:

```
NATIVE_RE='^mobile/(app\.config\.js|package\.json|package-lock\.json|eas\.json|assets/)'
```

So the merge that adds it **skips the OTA and cuts a fresh TestFlight binary**.
That is not a workaround and there is no manual step — but understand what it
means: **this change cannot reach an already-installed build over the air.**
A JS bundle that calls into a native module the installed binary does not carry
crashes on launch. The workflow refusing to publish it is the safety property,
not a limitation.

Practical consequence: after the merge, every tester must install the new
TestFlight build before they can see the paywall at all. Budget ~30 minutes of
EAS build plus 5–15 minutes of App Store Connect processing, then tell them.

---

## 5. RevenueCat wiring

### 5a. Project and app

RevenueCat dashboard → new **project** ("Feral Travels") → add an **App Store**
app. Bundle ID: `com.feraltravels.app`, exactly, correctly capitalised.

Grab the **public SDK key** for Apple (`appl_…`). It is public by design — it
goes in the client bundle. Put it in `mobile/eas.json` under
`build.production.env` and `build.preview.env` as `EXPO_PUBLIC_REVENUECAT_IOS_KEY`,
alongside the Google client id already there.

> **Do not skip the eas.json part.** `eas.json`'s `env` block applies to builds
> only; `eas update` bundles with whatever is in the shell. `mobile.yml`
> already reads the block out of `eas.json` and exports it before publishing an
> OTA (the step named *Load the production env from eas.json*) precisely so
> `EXPO_PUBLIC_*` values cannot silently collapse to their fallbacks. Adding
> the key there means the OTA path keeps working. Adding it anywhere else means
> a future OTA ships an app with no RevenueCat key.

### 5b. The In-App Purchase Key — not the shared secret

The old advice is the App-Specific Shared Secret. **That is for StoreKit 1,
which Apple has deprecated.** RevenueCat SDK v5+ uses StoreKit 2, and with
StoreKit 2 *transactions fail to be recorded at all* without an In-App Purchase
Key. Configure the key; ignore the shared secret entirely.

1. App Store Connect → **Users and Access** → **Integrations** → **In-App
   Purchase** → *Generate In-App Purchase Key*.
2. Download the `.p8`. **You get exactly one download.** Put it somewhere you
   will still have it in a year — same drawer as the ASC API key `.p8` from the
   TestFlight setup.
3. Copy the **Issuer ID** from that same page. (If there is no Issuer ID shown,
   create an App Store Connect API key first — generating one is what surfaces
   it.)
4. RevenueCat → app settings → **In-app purchase key configuration** → upload
   the `.p8`, paste the Issuer ID. Wait for "Valid credentials".

That is a *different* key from the App Store Connect API key EAS uses to
auto-submit builds. Two `.p8` files, two purposes, both downloadable once.

### 5c. Entitlement and products

- **Entitlement identifier: `pro`.** One entitlement, both products attached to
  it. `webhook.test.ts` already fixtures `entitlement_ids: ['pro']`, so pick
  that string and do not improvise.
- Product Catalog → **Products** → import or add both product ids.
- **Attach both to `pro`.** A product not attached to an entitlement grants the
  buyer nothing — the purchase succeeds and the app stays locked.
- Create one **Offering** (identifier `default`) with two **packages**,
  `$rc_monthly` and `$rc_annual`, pointing at the two products. The offering is
  what the app fetches to render prices.

### 5d. `app_user_id` — the one thing that must not be wrong

**Set RevenueCat's app user id to our `users.id`.** Not the email, not an
anonymous id, not the session token.

This is not a preference. `src/server/payments/webhook.ts` resolves the buyer
like this:

```ts
const defaultFindUserId = async (appUserId) => {
  const rows = await db.select({ id: users.id }).from(users).where(eq(users.id, appUserId)).limit(1);
  return rows[0]?.id ?? null;
};
```

A direct equality join against the primary key. If the app configures
RevenueCat with anything else, every webhook lands as `ignored_unknown_user`,
the money is taken, and nobody is entitled. The outcome is deliberately kept
distinct from `ignored_unknown_type` in the schema comment so that this failure
is legible in the admin log instead of looking like routine noise — but legible
is not the same as fixed.

The shape in the app:

```ts
// configure once, anonymous — the user may not be signed in yet
Purchases.configure({ apiKey: REVENUECAT_IOS_KEY });

// on sign-in (and on app launch with a restored keychain session)
await Purchases.logIn(user.id);

// on sign-out
await Purchases.logOut();
```

`logIn` after sign-in rather than `configure({ appUserID })` at boot, because
the keychain session is read asynchronously and the SDK should not be blocked
on it. RevenueCat aliases the anonymous id to the real one on `logIn`, so a
purchase can never be stranded.

The app never has to *tell* our server about a purchase. It calls
`Purchases.purchasePackage(...)`, the sheet does its thing, and the entitlement
arrives at our database through the webhook. A receipt the client hands us is a
claim; the webhook is proof. `schemas.ts` says the same thing about
`original_app_user_id`: we do not read it, because the paywall is behind an
authenticated screen and an anonymous purchase cannot happen. If that ever
changes, the user lookup grows a fallback to that field.

---

## 6. The webhook

RevenueCat dashboard → project → **Integrations** → **Webhooks** → Add.

| Field | Value |
|---|---|
| URL | `https://www.feraltravels.com/api/webhooks/revenuecat` |
| Authorization header | a long random string you generate — see below |
| Environment | **Sandbox and Production**, both |
| Scope | this app |
| Event types | all (the handler ignores what it does not know, on purpose) |

Generate the secret with `openssl rand -base64 32`. Paste the **same string**
into both places:

1. RevenueCat's *Authorization header* field.
2. Vercel → project → Settings → Environment Variables → `REVENUECAT_WEBHOOK_SECRET`,
   **Production** environment. Redeploy for it to take effect.

The route compares the inbound `Authorization` header against that variable
**verbatim**, hashed to fixed length and compared in constant time. If you type
`Bearer <secret>` into RevenueCat, the env var must be `Bearer <secret>` too,
prefix included. There is no parsing.

**The route returns 503 until the variable is set. That is deliberate.** Not a
200 and above all not an open door — an unset secret means the deploy is not
finished, and a handler that default-opens on a missing variable is one
`vercel env rm` away from letting anyone on the internet mint subscriptions.
503 is also the useful answer, because RevenueCat retries it (5 attempts:
5, 10, 20, 40, 80 minutes), so events that arrive during a misconfigured window
are delivered once you set the variable rather than lost.

**Turn sandbox events on.** They carry `environment: "SANDBOX"` in the payload,
which is stored verbatim on the `subscription_events` row. Without them,
sandbox testing proves the purchase sheet works and proves nothing about the
half of the system that grants access.

Everything else — idempotency on `event_id`, out-of-order rejection by the
store's own `event_timestamp_ms`, `CANCELLATION` keeping the user entitled
until `expiration_at_ms` — is already built and unit-tested in
`src/server/payments/webhook.test.ts`. You are wiring a URL, not writing logic.

---

## 7. Sandbox testing

### The Sandbox Apple Account

App Store Connect → **Users and Access** → **Sandbox** → add a tester. Use an
address you control that has **never** been an Apple ID —
`sandbox+feral@…` on a domain you own is the usual trick. Region matters: it
determines the storefront, and therefore whether you see `$2.00` or `€2,00`.

On the device: Settings → Developer → **Sandbox Apple Account** → sign in
there. Do **not** sign out of your real Apple ID in Settings → Media &
Purchases and sign in as the sandbox account; modern iOS has a dedicated slot
for this and using the wrong one is how you get stuck in a purchase loop.

### TestFlight uses sandbox automatically

**Any build installed from TestFlight runs against the sandbox StoreKit
environment.** Testers are never charged. You do not need to hand anyone a
sandbox account for basic "does the sheet appear and does access unlock"
testing — their own Apple ID works and spends nothing.

### The accelerated renewal rates — and there are two different tables

This is the part that surprises people: **a monthly subscription does not take
a month to renew in test.** Which table applies depends on *how* you are
testing.

**A. Signed in with a Sandbox Apple Account** (default renewal rate, set per
tester under Users and Access → Sandbox → the account → *Subscription Renewal
Rate*):

| Real duration | Sandbox |
|---|---|
| 1 week | 3 minutes |
| 1 month | **5 minutes** |
| 2 months | 10 minutes |
| 3 months | 15 minutes |
| 6 months | 30 minutes |
| 1 year | **1 hour** |

Billing retry period: 10 minutes. Billing grace period: 5 minutes. Auto-renews
up to **12 times**, then auto-renew switches off on the thirteenth. Other
selectable rates exist (every 3 minutes, 30 minutes, hourly) if you want
`RENEWAL` webhooks slower or faster.

**B. A TestFlight build on a normal Apple ID:** every subscription renews once
per **day**, regardless of its real duration, up to **6 renewals in a week**,
then auto-renew turns off. Slower and less controllable — fine for a smoke
test, useless for exercising renewal and expiry.

So: **use a Sandbox Apple Account when you are testing the state machine.**
Monthly at the default rate gives you a `RENEWAL` webhook every five minutes
and an `EXPIRATION` about an hour in — the whole lifecycle in one coffee.

To exercise the states that are not on the happy path, use the sandbox account
settings on-device: cancel to get `CANCELLATION` (and watch the user *stay*
entitled — that is state 7 and the regression this whole design exists to
prevent), and use the billing-retry controls for `BILLING_ISSUE`. Refunds
cannot be self-served; `REFUND` stays a unit-tested path only, which is why
`webhook.test.ts` replays one.

---

## 8. The exact code swap

The whole point of the fake purchase path is that this section is short.

### Changes

| File | Change |
|---|---|
| `mobile/package.json` / `package-lock.json` | `react-native-purchases` added |
| `mobile/eas.json` | `EXPO_PUBLIC_REVENUECAT_IOS_KEY` in `build.preview.env` and `build.production.env` |
| `mobile/lib/purchases.ts` | **the adapter.** Its internals are replaced: `getProducts()` returns the offering's packages instead of `PRODUCTS` from the shared constants; `purchase(productId)` calls `Purchases.purchasePackage` instead of `POST`ing to the test-purchase route; `restore()` calls `Purchases.restorePurchases()` instead of being a no-op. **The exported signatures do not change.** |
| `mobile/lib/auth.ts` (or wherever sign-in completes) | `Purchases.logIn(user.id)` on sign-in, `Purchases.logOut()` on sign-out |
| `mobile/app/_layout.tsx` | `Purchases.configure({ apiKey })` once at boot |

### Does **not** change

| File | Why |
|---|---|
| `mobile/components/` paywall UI | It renders whatever `getProducts()` hands it. It never knew where the prices came from |
| `src/server/payments/**` | The webhook was always the authority. It cannot tell a real purchase from a fake one and must not be able to |
| `src/app/api/webhooks/revenuecat/route.ts` | Already live, already tested |
| `src/types/entitlement.ts` | The wire contract is unchanged. `PaywallProduct` was designed to carry a store-supplied `priceLabel` |
| `src/server/db/schema.ts` | `subscriptions.source` already enumerates `'fake'` alongside `'apple_iap'`. Real purchases just start writing the other value |
| Every e2e spec except `sub-purchase` | They set fixture state through `/api/test/subscription`, never through a store |

**One deliberate behaviour change in the UI, and it is a downgrade of our own
copy.** `priceLabel` in `constants.ts` (`"$2"`, `"$20"`) exists only as the
fallback for an unreachable store; it is wrong in every currency but USD. Once
StoreKit is live the sheet must render **the store's own localized price
string** — `product.priceString` off the package. Keep the constant as the
offline fallback, but stop preferring it. A German user seeing "$2" on a
€-charged subscription is a 3.1.2 disclosure problem, not a cosmetic one.

**Delete the fake path? No.** Keep `/api/test/subscription` and the
`testPurchaseAllowed` flag — they are behind `areTestEndpointsEnabled()`, which
is hard-off on production, and they are what lets `sub-flag-flip` prove the
server rather than the client is the authority. What *should* disappear is any
route that writes `source: 'fake'` outside the allowlisted test path.

---

## 9. How to verify it actually worked

Tick these in order. **Do not stop at "the purchase sheet said Success."**
StoreKit will happily tell you a purchase succeeded while our database knows
nothing about it — that is precisely the failure mode `app_user_id` causes, and
it looks identical to working until someone tries to plan a trip.

1. **Products resolve.** On a TestFlight build, the paywall shows two prices,
   from the store, in the storefront's currency. Empty list → Section 1, then
   product state, then id spelling, in that order.
2. **`app_user_id` is ours.** RevenueCat dashboard → Customers → find the
   customer. Their id must be a UUID that exists in our `users` table. If it
   starts with `$RCAnonymousID:`, `logIn` never ran.
3. **The purchase completes** and the sheet dismisses.
4. **The webhook arrived.** RevenueCat → Integrations → Webhooks → the delivery
   log shows a `200` for an `INITIAL_PURCHASE`. A `503` means the Vercel env
   var is missing; a `401` means the Authorization strings differ.
5. **There is a row.** This is the one that counts:

   ```sql
   select event_id, type, outcome, event_time_ms, received_at
   from subscription_events
   where user_id = '<users.id>'
   order by received_at desc limit 5;
   ```

   `outcome` must be **`applied`**. `ignored_unknown_user` means step 2 is
   wrong. `ignored_duplicate` on the *first* event means you replayed something.

6. **The subscription row says what you bought.**

   ```sql
   select status, source, product_id, current_period_end, auto_renew
   from subscriptions where user_id = '<users.id>';
   ```

   Expect `active` / `apple_iap` / the right product id / a period end in the
   future / `auto_renew = true`.

7. **`hasEntitlement` flips.** The actual question the app asks. Either hit
   `GET /api/me/entitlement` as that user and read `entitled: true` with
   `state: "subscribed"`, or check it in a script. A `subscriptions` row that
   does not move this boolean means the resolver disagrees with the row, and
   `states.ts` is where the answer is.

8. **The block lifts.** Create a trip as that user. This is the thing they paid
   for and the only end-to-end proof.

9. **Renewal works.** Wait five minutes on a sandbox account with a monthly
   sub. A second `subscription_events` row, `type = RENEWAL`, `outcome =
   applied`, and `current_period_end` moved forward.

10. **Cancellation does not block.** Cancel in the sandbox account settings.
    `CANCELLATION` applies, `auto_renew` goes `false`, `status` stays `active`,
    and `hasEntitlement` stays **true** until the period ends. If access
    disappears here, `TYPE_MAP` has been edited and someone is about to lose
    362 days they paid for.

---

## Corrections to earlier docs, found while writing this

- **`subscriptions.md` prices the annual plan at $19.99; `constants.ts` says
  $20.00.** The code is newer and the reasoning is better (whole-dollar price
  points exist; the net table should read $20.00 → $3.00 → $17.00, which is
  what the $8.50 cap is derived from). Fix the doc, not the code.
- **`ios-app-plan.md` is stale on payments throughout** and should be read as
  history: it specifies one product at $10/year, a trial metered in *usage
  days* via a `user_active_days` table, promo codes, and entitlement columns on
  `users`. None of that is what shipped. `subscriptions.md` plus
  `src/server/payments/` supersede it.
- **`ios-app-plan.md` and `mobile/app.config.js` both call Sign in with Apple
  "mandatory" under Guideline 4.8. The guideline does not say that.** It
  requires an *equivalent* alternative login service that limits collection to
  name and email, lets the user keep the address private, and does not collect
  in-app interactions for advertising. Sign in with Apple is the safe way to
  satisfy it and it is already built, so nothing needs to change — but do not
  cite it as "Apple requires Sign in with Apple", because a reviewer arguing
  the point will be arguing from the actual text.
- **The App-Specific Shared Secret is legacy.** Anything telling you to paste
  one into RevenueCat is StoreKit 1 advice. Use the In-App Purchase Key.
- **App Store Connect's "Agreements, Tax, and Banking" is now "Business".**
  Older instructions name the old section.
