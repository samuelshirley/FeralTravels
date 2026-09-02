# App Review notes — what to paste, and why it says that

The text an App Review reviewer reads, kept in the repo so it changes when the
app does. §6 of `docs/design/app-store-listing.md` is the submission checklist;
this file is only the reviewer-facing part of it.

Two blocks go into App Store Connect:

- **App Review Information → Notes** — everything under *"The text to paste"*.
- **Sign-In Information** — left EMPTY. See the next section for why that is a
  decision and not an omission.

---

## 1. There is no demo account, on purpose

The obvious thing to hand a reviewer is a username and a password. This app has
neither: it is passwordless. Sign-in is a six-digit code emailed to a real
inbox, or Google, or Apple. So "a demo account" would have to mean one of:

| Option | Why not |
|---|---|
| An address with a **fixed code** an env var lets through | A credential that bypasses `verifyOtpCode`'s expiry and attempt limits is a backdoor whatever it is called. `src/lib/noBackdoorGuard.test.ts` fails the unit suite on anything shaped like one, and it exists because this exact class of thing was deleted once already. |
| A **mailbox the reviewer can read** | A second credential to hand out, on a domain we send real sign-in mail from. |
| A **pre-made account** whose code we paste in the notes | Codes are single-use and expire. It is stale before the reviewer opens the form. |

The answer is **Sign in with Apple**. The reviewer uses their own Apple ID —
Hide My Email works — and gets a real, complete, fully functional account in a
seven-day trial. Nothing is faked, nothing is bypassed, and there is no
credential to leak. This is what guideline 2.1(a) actually asks for.

**If a reviewer rejects on 2.1(a) anyway**, the fallback is an env-gated fixed
code for one designated review address. Do NOT build it pre-emptively: it is
backdoor-shaped, it sits directly beside the guard test that forbids that shape,
and it contradicts the no-bypass rule the whole auth surface is built on. Build
it if and only if a rejection makes it necessary, and delete it after.

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

> **Feral Travels plans road trips and finds cheap fuel along the route.**
>
> **Signing in — no demo credentials needed.**
> This app is passwordless. On the sign-in screen, tap **Sign in with Apple** and
> use your own Apple ID; Hide My Email works. That creates a complete, fully
> functional account with a seven-day free trial. The "email me a code" option
> sends a real six-digit code to a real inbox, so please use Sign in with Apple.
>
> **To see the subscription and make a sandbox purchase:**
> 1. Sign in as above. You land on the trips list; a trip is created for you and
>    Penny opens the conversation.
> 2. Tap **Settings** in the bottom navigation bar.
> 3. Scroll to the **Plan** card. It shows the current plan — "Free trial — 7
>    days left" — and a **View plans** button.
> 4. Tap **View plans**. The sheet lists both subscriptions with the App Store's
>    own localized prices and billing periods: $2.00 per month and $20.00 per
>    year. Links to Terms of Use and the Privacy Policy, a **Restore purchases**
>    control and a **Manage subscription** link are on the same sheet.
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
fix — they are all clicks in App Store Connect or RevenueCat, and they are in
dependency order in `docs/design/iap-setup.md`.

- [ ] **Paid Applications Agreement Active.** Until it is, StoreKit returns an
      EMPTY product list with no error anywhere — the sheet shows prices with no
      checkout, step 5 above is impossible, and nothing in any log says why.
      This is why it is section 1 of the setup doc.
- [ ] **Both products created and in the "Ready to Submit" state** —
      `com.feraltravels.app.monthly`, `com.feraltravels.app.annual`. The ids must
      match `PRODUCTS` in `src/server/payments/constants.ts` character for
      character; a typo drops that plan silently from the sheet, so **one price
      where there should be two is a product-id problem, not an agreement one**.
- [ ] **Both products attached to this app version for review.** A subscription
      not submitted alongside the build is not reviewed with it.
- [ ] **`EXPO_PUBLIC_REVENUECAT_IOS_KEY` set in `mobile/eas.json`.** It is
      currently the literal `REPLACE_WITH_appl_KEY_FROM_REVENUECAT` on BOTH the
      `preview` and `production` profiles. `mobile/lib/config.ts` requires the
      `appl_` prefix, so that placeholder correctly resolves to *unset* — which
      means a build cut today ships with purchasing disabled and the sheet in its
      "no checkout" mode. **This is the single thing most likely to fail a
      submission**, and it cannot be fixed by an OTA: `EXPO_PUBLIC_` values are
      compiled in.
- [ ] **A RevenueCat sandbox purchase actually walked, once, end to end** —
      including the webhook arriving at `POST /api/webhooks/revenuecat` and the
      app flipping over. `mobile/storekit/` removes App Store Connect from that
      loop but NOT RevenueCat.
- [ ] **`PAYWALL_ENABLED=1` on the production Vercel environment**, and a
      redeploy. Without it `applySwitch` rewrites every verdict to entitled and
      nothing blocks — which reads as a working app right up until a reviewer
      wonders what the subscription is for.
- [ ] **`SUBSCRIPTION_TESTING` UNSET on production.** It arms the fake-purchase
      route; an allowlisted address deliberately beats the real store.
- [ ] **A TestFlight build carrying all of it.** Build 7 (2026-08-27) predates
      the in-app-purchase client, the Settings "View plans" control and the
      privacy manifest. None of the three can arrive over the air.

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
