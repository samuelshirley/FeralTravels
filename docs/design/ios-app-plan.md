# iOS app plan — Expo/React Native + paid subscription

> Status (2026-07-12): ACTIVE — supersedes the "defer" stance in
> `docs/future/native-app-rewrite.md`. That doc's architecture thinking
> (Expo + RN, monorepo shape, backend untouched) carries forward and is
> referenced below rather than repeated.

## Decisions locked (Sam, 2026-07-12)

- **React Native via Expo**, iOS first, Android after. Not Ionic/Capacitor
  (wrapper work gets thrown away — see rejected path A in the rewrite doc).
- **Backend stays exactly as-is**: Next.js API routes on Vercel + Neon.
  The mobile app is a new UI client hitting the same endpoints Penny and
  the web UI already use. No backend rewrite.
- **Monorepo option 1, phased (revised 2026-07-31):** `mobile/` (Expo)
  and later `shared/` land ADDITIVELY first — the Next.js app stays at
  the repo root for now so the iOS branch doesn't collide with in-flight
  fix work. The `web/` move + Vercel root-directory change happens as
  its own small PR once things settle. Same destination, mergeable
  steps.
- **Sequencing (Sam, 2026-07-31): TestFlight FIRST, paywall after.**
  Payments/trial/promo work below is designed but deliberately not
  built until the app runs on TestFlight. Branch: `feature/ios-app`
  (based on `refactor/google-only-datasources` HEAD per "pending
  commits are master").
- Apple Developer (individual, enrolled ✓), Xcode ✓, Expo account ✓.
  Bundle ID: **`com.feraltravels.app`**.
- **One subscription: $10.00/year, even number.** No $9.99. Set even
  price points manually per storefront (€10, £8, …) — do NOT let Apple
  auto-convert (it produces .49/.99 endings). Note: US storefronts add
  state sales tax on top at charge time (Apple + state law, applies to
  every app); EU storefronts are tax-inclusive so €10 charges €10.
- **Payment rail: Apple In-App Purchase (StoreKit 2)** — required by
  Guideline 3.1.1 for digital subscriptions; Apple Pay itself is not
  permitted for digital goods. UX is the desired one anyway: native
  sheet, double-click/Face ID, done. Android later = Google Play
  Billing, same one-tap model. **No external-purchase-link path** (the
  US post-Epic link-out exists but means a web checkout form — rejected).
- **Commission: 15%** via the App Store Small Business Program (<$1M/yr;
  enroll — it is not automatic). $10 → ~$8.50 net.
- **Web checkout: YES, via RevenueCat Web Billing — as a fast-follow
  after iOS ships (decided 2026-07-12).** Sam wants paying to be
  seamless on either platform. RevenueCat Web Billing with **Stripe
  Managed Payments** (Stripe = merchant of record, handles global tax —
  this resolves the earlier objection to web checkout) gives the web
  paywall an Apple Pay button in Safari / Google Pay in Chrome →
  Touch ID on desktop, done. One entitlement record per user regardless
  of where they paid; both platforms read the same state. **Hard
  compliance rule: the iOS app never mentions or links to the web
  checkout** (web → App Store pointers are fine; the reverse is not).
  Build order: iOS IAP first (required for review anyway), Web Billing
  immediately after — the entitlement module is unchanged, web
  purchases are just another source writing the same table.

## Subscription architecture

**RevenueCat** between StoreKit/Play Billing and our backend (free tier
until ~$2.5k MRR — fine for the foreseeable future):

- Handles receipt validation, renewals, cancellations, refunds, grace
  periods, and cross-platform entitlements. Removes the need to build
  App Store Server Notifications handling ourselves, and is the same
  integration for Android later.
- App side: RevenueCat SDK presents the offering; purchase runs through
  the native StoreKit sheet.
- Backend side: **one new webhook route** `/api/webhooks/revenuecat` —
  Zod-validated payload + shared-secret/signature check (fits the
  lockdown invariants: one narrow contract, nothing free-form), writes
  entitlement state through a repo.
- Schema: entitlement fields on `users` (e.g. `entitlement_status`,
  `entitlement_expires_at`, `entitlement_source`), written ONLY by the
  webhook repo path. Web + mobile both read the same flag.
- RevenueCat app-user-id = our `users.id`, so web sign-in sees the same
  entitlement with no extra linking step.

## App Store compliance checklist (review WILL check these)

- [ ] **Sign in with Apple** (Guideline 4.8) — mandatory because we
      offer Google OAuth. Add Apple provider to NextAuth + native flow.
      Email OTP alone wouldn't trigger this; Google login does.
- [ ] Paywall boilerplate: price + renewal period stated, auto-renew
      disclosure, **Restore Purchases** button, links to Privacy Policy
      and Terms of Use (EULA) on the paywall screen itself.
- [ ] Privacy: App Privacy "nutrition label" in App Store Connect,
      privacy manifest file (`PrivacyInfo.xcprivacy`), account-deletion
      flow reachable in-app (Guideline 5.1.1(v)) — we need a delete-
      account endpoint + UI if none exists.
- [ ] Location permission strings (`NSLocationWhenInUseUsageDescription`)
      that say *why* (fuel planning along your route) — vague strings
      get rejected.
- [ ] No mention anywhere in the app of buying/subscribing outside the
      app (anti-steering applies to the app; the WEB pointing users to
      the App Store is fine).
- [ ] Demo/review account for App Review with a seeded trip, since the
      app is account-gated (OTP sign-in: provide a test account Apple
      can access — likely needs a review-only credential path or a
      long-lived test account; NOT the deleted e2e backdoor — design
      carefully).
- [ ] Apple Developer Program account active ($99/yr) — ID verification
      can take days; start this first.

## Trial, paywall, and promo codes (decided 2026-07-12)

**Trial: 7 days of USE, metered by us — not Apple's intro offer.**
Every user (including existing ones) is on trial from the day this
ships. A "day" = a distinct calendar day the user opened the app,
tracked server-side in a new `user_active_days` table (one row per
user per day, unique on (user_id, date_iso), inserted on any
authenticated app open — survives reinstalls and covers web + iOS
identically). On the 8th distinct usage day with no entitlement → hard
paywall. App-side gating like this is fully allowed by Apple; the
subscription in App Store Connect is just $10/yr with no intro offer.

**Paywall screen:** big Subscribe button → StoreKit sheet (one tap,
Face ID, done). Below it, "Have a code?" → code input.

**Promo codes: FREE codes only, our own system.** Free access granted
by us is compliant (no money changes hands — Guideline 3.1.1 governs
*purchases*). Discounted codes are NOT possible in a custom system
(any payment must run through IAP; arbitrary custom pricing doesn't
exist there). If discounts are ever needed, use Apple Offer Codes
(App Store Connect-defined tiers) — deferred indefinitely.

- Admin panel gets a promo-codes page: create code, set **duration per
  code** (N days / 1 year / **no expiry** — lifetime), optional max
  redemptions, list codes + who redeemed.
- Redemption: user types code in the paywall modal → server validates →
  entitlement granted instantly with the code's expiry (or none). Works
  identically on web and iOS. Codes are single-purpose strings Sam can
  text to people.

**Payments as a bounded module in ONE directory — `src/server/payments/`.**
Not a separate deployment (deploys with the app), but everything
payments lives under one roof so "payments" always means one place:

```
src/server/payments/
  index.ts        # PUBLIC surface — hasEntitlement(userId) etc.; the
                  # ONLY file the rest of the app may import from
  entitlements.ts # entitlements table access (repo discipline, in-module)
  promoCodes.ts   # code create / validate / redeem
  trial.ts        # usage-day metering (user_active_days)
  webhook.ts      # RevenueCat webhook: signature verify + apply
  schemas.ts      # Zod contracts for every payload in/out
```

Convention amendment: payments DB access lives in this directory (not
`src/server/repos/`) — same discipline (no raw SQL outside these
files), different home, so the module is self-contained. Thin API
routes as usual: `/api/webhooks/revenuecat`, `/api/promo/redeem`,
`/api/admin/promo-codes` (+ admin UI page `app/admin/codes/`), all
calling into the module.

The single public question: `hasEntitlement(userId)` — true if active
IAP sub, unexpired/lifetime promo grant, or still inside the
7-usage-day trial. **Free or full-paid only — no discount tiers.**
Nothing outside the module touches payment internals; extractable to a
real service later if ever needed.

`entitlements` sketch: user_id, status (`trial | active | comped |
expired`), source (`iap | promo | trial`), expires_at (nullable —
null = lifetime comp), promo_code_id (nullable), updated_by
(`webhook | promo | system`). Written only by the module's repo paths
(webhook, promo redemption, trial metering) — same lockdown pattern as
the rest of the DB.

## Build phases (from the rewrite doc, still accurate)

1. Expo scaffold + auth (incl. Sign in with Apple) + trips list on
   simulator. Auth is the messiest piece: NextAuth cookie sessions →
   token handoff for native (secure-storage JWT or session-token
   exchange endpoint).
2. Feature parity: trip detail, chat panel (Penny), leg cards, stops,
   map (`react-native-maps`), vehicle settings.
3. Subscription: RevenueCat + paywall + webhook + entitlement gating.
4. Native extras (post-parity): push notifications, offline tiles,
   background GPS.
5. App Store submission: assets, screenshots, privacy, review
   iterations (expect ≥1 rejection).

## Open questions

- Desktop usage: check `usage_events` / `user_viewport_time` in prod to
  confirm the "nobody uses desktop" hunch before deprioritizing web.
- Web paywall v1 (before Web Billing ships): "Subscribe in the iOS app"
  + code input. After Web Billing: same wall gains a real subscribe
  button (Apple Pay / Google Pay via Stripe).
- App Review demo account must never hit the paywall mid-review — comp
  it with a lifetime promo code (the system conveniently solves this).
