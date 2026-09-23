# App Review notes — what to paste, and why it says that

The text an App Review reviewer reads, kept in the repo so it changes when the
app does. §6 of `docs/design/app-store-listing.md` is the submission checklist;
this file is only the reviewer-facing part of it.

Two blocks go into App Store Connect:

- **App Review Information → Notes** — everything under *"The text to paste"*.
- **Sign-In Information** — the address and code in §3. This section explains
  what that account is and what it is not.

---

## 1. There IS a demo account now, and it is one address

**This reverses the previous decision, and the previous reasoning is kept below
because it is still the reason this thing is shaped the way it is.**

The app is passwordless: sign-in is a six-digit code emailed to a real inbox, or
Google, or Apple. App Store Connect's **Sign-In Information** form wants a
username and a password, and leaving it empty asks a reviewer to go and find the
Notes field. So one address now has a fixed code.

### What exists

| | |
|---|---|
| Address | `appletest@feraltravels.com` |
| Code | `000000` |
| Switch | `APPLE_REVIEW_SIGNIN=1`, production Vercel environment only |
| Module | `src/server/auth/reviewAccount.ts` |

**Unset the switch and it is gone** — that address behaves exactly like every
other address and `000000` is simply a wrong code. No deploy is needed to turn
it off, which is the point: it can be killed from the Vercel dashboard the
moment review is approved.

### Why this shape, and not a looser one

The earlier version of this section was right that a fixed code is the shape
`src/lib/noBackdoorGuard.test.ts` exists to prevent, so the whole design is
about leaving nothing to widen:

- **One hardcoded address and one hardcoded code**, both literals in source.
  Not a pattern, not a list, not env-readable. Changing either takes a code
  review and a deploy — the same reasoning that keeps `ADMIN_ALLOWLIST` and
  `FIXTURE_EMAIL_PATTERN` hardcoded.
- **The env flag can only turn it OFF.** It selects nothing. It is read as a
  strict `=== '1'` and cannot name a different address or a different code.
- **Three call sites, all on the same predicate**: `verifyOtpCode` accepts the
  code (there, rather than `signInWithOtpCore`, so the function that answers
  "is this code valid" is not left disagreeing with the one that signs the user
  in); `sendOtpCode` stores it, skips the Resend transport and runs *before* the
  resend ladder, so a reviewer tapping "resend" — which is what you do when no
  mail arrives, and none ever will — cannot lock themselves out;
  `assertSignupGateOpen` exempts it, because that gate refuses addresses with no
  account yet, which is exactly what a reviewer is on their first attempt.
- **Not admin, not comped, unrelated to `FIXTURE_EMAIL_PATTERN`.** It lands in
  the ordinary seven-day trial, which §2 explains is load-bearing: comping it
  would hide every paywall from the reviewer and recreate the "unable to locate
  the in-app purchases" rejection. The `/api/test/*` endpoints stay hard-off on
  production with no override; this is a separate mechanism on a separate
  domain because the two exist for opposite environments.

Guards: `src/lib/reviewAccountGuard.test.ts` and
`src/server/auth/reviewAccount.test.ts`. Decision register: **D9**.

### The removal condition

**Delete this once the app is approved.** Unset `APPLE_REVIEW_SIGNIN` in Vercel
to disarm it the same day; delete `reviewAccount.ts`, its two guards, the three
call sites and D9 to retire it. It exists for the review queue, not for us —
there is no other reason for a fixed credential to be in this app.

**Sign in with Apple is still the recommended path** and the notes in §3 still
lead with it: a reviewer using their own Apple ID gets a real account with
nothing faked, which is what guideline 2.1(a) actually asks for. The fixed code
is there so the Sign-In Information form has an answer.

---

## 2. Reaching the in-app purchase — the part that was broken

A reviewer who signs in with their own Apple ID lands in a **seven-day free
trial**. They are entitled. Every paywall in this app is gated on *not* being
entitled — Penny's bubble, `PlanRequiredOverlay`, `mobile/app/paywall.tsx` — so
until 2026-09-02 there was **no screen in the app that showed a price**, and no
way to complete a sandbox purchase at all. `GET /api/me/entitlement` returned
`products: []` for an entitled account, so even forcing a sheet open would have
rendered an empty one.

That is the "we were unable to locate the in-app purchases" rejection, and no
wording in these notes could have written around it.

**Settings → Plan → "View plans"** now opens the purchase sheet in every account
state, and the entitlement payload carries the prices in every state to match.
That is the route these notes send the reviewer down, and it is also the honest
product behaviour: someone three days into a trial who has decided should be
able to subscribe, and a monthly subscriber should be able to find the annual
price.

---

## 3. The text to paste

### Sign-In Information

Both fields are required by the form, so both are filled. The "password" is the
six-digit code the app asks for on the second screen.

```
User name:  appletest@feraltravels.com
Password:   000000
```

**`APPLE_REVIEW_SIGNIN=1` must be set on the production Vercel environment for
that to work.** Without it the code is refused like any other wrong code — see
§1, and `docs/design/launch-checklist.md` for where it sits in the submission
order.

### App Review Information → Notes

> **Feral Travels plans road trips and finds cheap fuel along the route.**
>
> **Signing in.** This app is passwordless — there is no password field. The
> quickest path is **Sign in with Apple** with your own Apple ID (Hide My Email
> works), which creates a complete, fully functional account with a seven-day
> free trial.
>
> If you prefer the credentials in the Sign-In Information field: enter
> **appletest@feraltravels.com** on the sign-in screen, tap **Email me a
> 6-digit code**, and then type **000000** into the six boxes on the next
> screen. No email is sent to that address and the code does not expire, so you
> can take as long as you need on that screen. Any other address sends a real
> code to a real inbox.
>
> **To see the subscription and make a sandbox purchase:**
> 1. Sign in as above. You land on the trips list; a trip is created for you and
>    Penny opens the conversation.
> 2. Tap **Settings** in the bottom navigation bar.
> 3. Scroll to the **Plan** card. It shows the current plan — "Free trial — 7
>    days left" — and a **View plans** button.
> 4. Tap **View plans**. The sheet lists both subscriptions with the App Store's
>    own localized prices and billing periods — in the US storefront, $2.69 per
>    month and $22.00 per year (€2 and €20 in the eurozone). Links to Terms of
>    Use and the Privacy Policy, a **Restore purchases** control and a **Manage
>    subscription** link are on the same sheet.
> 5. Tap either price to buy with your sandbox Apple Account. After the purchase
>    the app waits for our server to be notified by RevenueCat and then switches
>    the plan on — this normally takes a few seconds. If it takes longer than a
>    minute the app says the payment went through and points at Restore
>    purchases; nothing is lost, and reopening the app resolves it.
>
> **What the subscription unlocks:** planning. Creating a trip, cloning one, and
> talking to Penny — every action that runs our AI planner. Reading an itinerary
> you already have, changing your vehicle settings, restoring a purchase and
> deleting your account are never gated.
>
> **Deleting the account (guideline 5.1.1(v)):** Settings → scroll to the bottom
> → **Delete account** → type DELETE to confirm. It is immediate and permanent:
> trips, routes, stops, fuel plans, vehicles and the whole conversation history
> are removed. It is reachable in every account state, including from behind the
> paywall.
>
> **Location** is requested for trip progress ("I'm here now") and for planning
> fuel stops within range along the route. The app is fully usable if you decline
> it. **Photo library** access is only ever prompted when you tap the attach
> button in Penny's chat.
>
> Support: https://www.feraltravels.com/support · Terms:
> https://www.feraltravels.com/terms · Privacy:
> https://www.feraltravels.com/privacy

---

## 4. What has to be true before that text is honest

Every line above describes shipped behaviour except where this section says
otherwise. These are the things a reviewer would hit that no code change can
fix — they are clicks in App Store Connect, RevenueCat, Vercel or `/admin`, and
the store-side ones are in dependency order in `docs/design/iap-setup.md`.

- [ ] **Paid Applications Agreement Active.** Until it is, StoreKit returns an
      EMPTY product list with no error anywhere — the sheet shows prices with no
      checkout, step 5 above is impossible, and nothing in any log says why.
      This is why it is section 1 of the setup doc.
- [ ] **Both products created and in the "Ready to Submit" state** —
      `com.feraltravels.ios.monthly`, `com.feraltravels.ios.annual`. The ids must
      match `PRODUCTS` in `src/server/payments/constants.ts` character for
      character; a typo drops that plan silently from the sheet, so **one price
      where there should be two is a product-id problem, not an agreement one**.
- [ ] **Both products attached to this app version for review.** A subscription
      not submitted alongside the build is not reviewed with it.
- [x] **`EXPO_PUBLIC_REVENUECAT_IOS_KEY` set in `mobile/eas.json`** — done
      2026-09-03, on BOTH the `preview` and `production` profiles. Until then it
      was the literal `REPLACE_WITH_appl_KEY_FROM_REVENUECAT`, which
      `mobile/lib/config.ts` correctly resolved to *unset* (it requires the
      `appl_` prefix), so any build cut before that date ships with purchasing
      disabled and the sheet in its "no checkout" mode — **including build 3**.
      It cannot be fixed by an OTA: `EXPO_PUBLIC_` values are compiled in. The
      build that goes to review must be cut after this date.
- [ ] **A RevenueCat sandbox purchase actually walked, once, end to end** —
      including the webhook arriving at `POST /api/webhooks/revenuecat` and the
      app flipping over. `mobile/storekit/` removes App Store Connect from that
      loop but NOT RevenueCat.
- [ ] **The global paywall switch stays OFF during review** — the `PAYWALL
      ON/OFF` pill in the `/admin` header, which is the `app_meta.paywall_enabled`
      row (`src/server/payments/switch.ts`). NOT an env var: `PAYWALL_ENABLED`
      has not been read since 2026-09-02, and setting it in Vercel does nothing.
      Off is correct here, not a gap: the reviewer is inside a seven-day trial
      and reaches the purchase sheet through Settings → Plan → View plans (§2)
      in every account state, and the web app is the demo while the build is in
      review — ON would wall every account past its trial with nothing to buy.
      To watch the wall itself work, force it onto ONE disposable account from
      `/admin/users/[id]` ("Force the paywall on this account").
- [x] **No fake purchase exists** (removed 2026-09-21), so no address can beat
      the real store. `SUBSCRIPTION_TESTING` now arms only the test-account
      generator, which refuses to load in production anyway (decision E13).
- [ ] **A TestFlight build carrying all of it.** Build 7 (2026-08-27) was on the
      OLD Apple account and is unreachable; the first build on the new team
      (2026-09-02, buildNumber 1) is a **credentials bootstrap and must not be
      submitted** — it was cut with the `REPLACE_WITH_…` RevenueCat placeholder,
      so its purchase sheet shows prices with no checkout, which is precisely
      the rejection §2 above is about. `EXPO_PUBLIC_*` values are compiled in,
      so no OTA can fix it: the key goes into `eas.json` and a NEW build is cut.

---

## 5. Sign in with Apple — the one claim in the notes that is unverified

The notes above tell a reviewer to sign in with Apple. Every part of that path
exists in the repo:

- The button (`mobile/app/sign-in.tsx`, gated on `appleAvailable()`).
- The client call (`mobile/lib/oauth.ts`, forwarding the identity token and the
  full name Apple only ever sends on the FIRST authorization).
- The server verify (`src/server/auth/oauthIdentity.ts` — Apple's JWKS, issuer
  `https://appleid.apple.com`, audience = the bundle id, and the deliberate
  asymmetry that treats `@privaterelay.appleid.com` as proven and every other
  unverified Apple address as not).
- The entitlement: with `EXPO_PUBLIC_ENABLE_APPLE_SIGNIN=1`, `app.config.js`
  sets `ios.usesAppleSignIn` and adds the `expo-apple-authentication` plugin,
  whose config plugin writes `com.apple.developer.applesignin = ['Default']`
  into the entitlements. Verified by evaluating the config both ways.

**And as of 2026-09-02 there is a specific thing to check, not just a general
doubt.** The first build on the new team printed `Synced capabilities: No
updates` on a freshly registered `com.feraltravels.ios` identifier — at the
moment Sign in with Apple should have been added to it. Confirm the capability
is actually ticked on the App ID (Apple Developer → Identifiers →
`com.feraltravels.ios`) before submitting. The binary requests the entitlement
either way and `isAvailableAsync()` reports OS capability rather than app
setup, so the button renders whether or not the App ID allows it — this fails
at authorization, in front of a reviewer, on the guideline that made offering it
mandatory. `docs/design/iap-setup.md` has the full note.

**None of that is proof it works.** It has never run against Apple. It cannot
run on a simulator without a team, and the entitlement needs a provisioning
profile carrying the capability — which means a device build. `e2e/oauth-exchange.spec.ts`
proves only the refusals: forged tokens, wrong audience, wrong issuer, expired,
no `exp`. The happy path is unreachable from CI, because we cannot mint a token
Apple would vouch for.

So before submitting: install a TestFlight build on a real device and sign in
with Apple, **including once with Hide My Email**. Guideline 4.8 makes offering
it mandatory the moment Google sign-in is offered, and a button that fails on
tap is worse than a rejection — it is a rejection plus a bad first impression.

Also still unverified for the same reason: `AUTH_GOOGLE_IOS_CLIENT_ID` on the
**production** Vercel environment. CI proves it on *preview* only, and the app
points at `www.feraltravels.com`.
