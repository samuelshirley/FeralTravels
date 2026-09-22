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

- [ ] **Force the paywall onto each test account below, NOT the deployment.**
      `/admin/users/[id]` → **Force the paywall on this account**. The global
      switch — the `app_meta.paywall_enabled` row, the `PAYWALL ON/OFF` pill in
      the `/admin` header — stays OFF: the web app is the demo while the iOS
      build is in review, and turning it on would wall every account past its
      trial with nothing to buy. It is not an env var; `PAYWALL_ENABLED` has not
      been read since 2026-09-02 and setting it in Vercel does nothing. With
      neither the override nor the switch on, `applySwitch` rewrites every
      verdict to entitled and NOTHING blocks — no `/trips` overlay, no trip
      lock, no bubble from Penny, no 402 — while the admin panel still correctly
      reports `trial_expired`. See `src/server/payments/switch.ts`.
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

- [x] Paid Applications Agreement active (verified 2026-09-21). How it was
      signed, since it will be asked again when the details change: it does
      not require being autónomo or a business bank account. Account Holder
      Type **Individual**, a personal Spanish IBAN with the name exactly as the
      bank has it (Apple states it need not match the agreement's legal
      entity), and the non-US tax questionnaire (W-8BEN shape) with the **NIE
      as the foreign TIN**. When the alta lands, update the Tax Forms to
      autónomo status (and ROI/VIES if registered), and the bank account if
      it changes.
- [ ] **Decide the trader address.** EU DSA Articles 30/31: selling
      subscriptions makes you a trader, and Apple **publishes** the trader
      name, address, phone and email on the EU product page — a P.O. box or
      the gestoría's address, not home. Verification needs 2FA on both email
      and phone plus a document. Apps without verified trader status are
      removed from the EU App Store.
- [ ] Products created in App Store Connect: `com.feraltravels.ios.monthly`,
      `com.feraltravels.ios.annual`.
- [ ] `NEXT_PUBLIC_APP_STORE_URL` set to the real numeric listing id. Until it
      is, every "Continue to the iPhone app" button lands on an App Store
      search page.
- [ ] Each subscription has a Review Information screenshot, and the app
      record has Pricing and Availability set. Until both are done, StoreKit
      calls both product ids invalid (`scripts/storekit-probe.sh`, iap-setup §1).
- [x] Fake purchase deleted (2026-09-21): `POST /api/purchase/test` and every
      caller are gone; the webhook is the only grant path.
- [x] The test-account generator cannot run in production, whatever
      `SUBSCRIPTION_TESTING` says — it refuses to load there (decision E13).
      Leaving the variable set on production is now harmless, but unset it
      anyway so the environment says what it means.
- [ ] Production database wiped AFTER the removal is merged and deployed (a
      deploy of the old code would repopulate `source: 'fake'` rows), then
      `drizzle-kit push`. `scripts/db-reset.ts` refuses production without its
      single-use override — the refusal prints how. Then confirm
      `app_meta.paywall_enabled` is off, `appletest@feraltravels.com` signs in
      clean, and `SELECT count(*) FROM subscriptions WHERE source = 'fake'` is 0.

### Before each submission

- [ ] **`APPLE_REVIEW_SIGNIN=1` on production.** Vercel → feral-travels →
      Settings → Environment Variables, **Production only**. This is what makes
      the Sign-In Information credentials in
      `docs/design/ios-review-notes.md` §3 work —
      `appletest@feraltravels.com` / `000000`. Without it that code is refused
      like any other wrong code, and the reviewer is stuck on the verify screen
      with nothing anywhere saying why. `scripts/check-env.sh` prints whether
      it is armed.
- [ ] Sign in as `appletest@feraltravels.com` with `000000` on a real device
      against production, before submitting. The flag is the kind of thing that
      gets set on the wrong environment.
- [ ] Sign-In Information and the Notes field in App Store Connect match §3.
- [ ] Submit with **Manual release**. The alta gates taking real revenue, not
      testing — signing the agreement and sandbox purchases move no money — so
      release is pressed only once the alta censal is effective.

### After approval

- [ ] **Unset `APPLE_REVIEW_SIGNIN` on production.** Same day. It disarms
      without a deploy, and the fixed code is for the review queue only.
- [ ] Retire the mechanism entirely when there is no upcoming submission:
      delete `src/server/auth/reviewAccount.ts`, its two guards, the three call
      sites and decision **D9**. §1 of the review notes has the full list.

## At launch

- [ ] Sam says it, here, with a date.
- [ ] Decide what happens to the existing prod accounts: comped, wiped, or left
      to hit the wall. This is the moment Rule 0 stops applying.
