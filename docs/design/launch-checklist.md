# Launch checklist

The list we work off from here to the App Store, and the record of what
"launched" means. Nothing on it is done until it is ticked here.

## Rule 0 — there are no real users yet

**Until Sam says, in words, that the app is launched and live, every row in the
production `users` table is a test account.** His own addresses, throwaways, and
people he handed it to deliberately. Several carry real Anthropic spend; that is
his own testing, not usage by a stranger.

This is written down because it keeps getting forgotten, and the forgetting has
a shape: someone enumerates the prod users, sees 28 accounts that a change would
affect, and recommends the cautious option. That is the wrong call at this
stage. **Nothing on this checklist is gated on protecting production accounts.**
Break them, block them, delete them — the point of having them is to find out
what happens.

The day this flips is the day Sam says so, and it gets recorded here. An
App Store build existing is not launch. TestFlight is not launch.

## Before Apple payments

The order matters: the paywall has to be proven to work before there is
anything real to buy behind it, not after.

- [ ] **`PAYWALL_ENABLED=1` on production.** Vercel → feral-travels → Settings →
      Environment Variables → Production, then redeploy (the running deployment
      does not pick up a new env var on its own). Without this `applySwitch`
      rewrites every verdict to entitled and NOTHING blocks — no `/trips`
      overlay, no trip lock, no bubble from Penny, no 402 — while the admin
      panel still correctly reports `trial_expired`. See
      `src/server/payments/switch.ts`.
- [ ] Walk a `day7-trip` account end to end on **desktop**: overlay on `/trips`,
      no "+ New trip" button, trip page locked, Penny's bubble in the chat.
- [ ] Walk the same account end to end on **iOS**.
- [ ] Walk a `day7-empty` account (no trip — it has no chat to be sent to, which
      is why `mobile/app/paywall.tsx` exists).
- [ ] Confirm `/settings` and account deletion stay reachable while blocked.
      A paywall in front of "delete my account" is an App Store 5.1.1(v)
      rejection.
- [ ] Confirm the admin header chip reads `PAYWALL ON`.

## Apple

- [ ] Paid Applications Agreement active (StoreKit returns an EMPTY product
      list until it is — that is why `POST /api/purchase/test` exists).
- [ ] Products created in App Store Connect: `com.feraltravels.app.monthly`,
      `com.feraltravels.app.annual`.
- [ ] `NEXT_PUBLIC_APP_STORE_URL` set to the real numeric listing id. Until it
      is, every "Continue to the iPhone app" button lands on an App Store
      search page.
- [ ] RevenueCat migration — `docs/design/revenuecat-implementation.md`. Its
      last step is deleting `POST /api/purchase/test`.
- [ ] `SUBSCRIPTION_TESTING` UNSET on production once real purchases work. It
      arms the fake-purchase route and the admin test-account generator; the
      accounts it makes carry `source: 'fake'` subscriptions nobody paid for.

## At launch

- [ ] Sam says it, here, with a date.
- [ ] Decide what happens to the existing prod accounts: comped, wiped, or left
      to hit the wall. This is the moment Rule 0 stops applying.
