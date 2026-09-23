# App Store listing — Feral Travels

ASC App ID **6807913556** · bundle `com.feraltravels.ios` · version **1.0.0**

> **The app moved to a new Apple developer account on 2026-09-02.** The old ASC
> App ID `6802705582` and bundle `com.feraltravels.app` belong to a record on
> the previous team and are dead — a TestFlight upload binds a bundle id to its
> account permanently. A NEW app record was created on the new team on
> 2026-09-03, and §1's fields go on that one. `mobile/eas.json` now carries the
> new `appleTeamId` (`TJX3F3832H`) and `ascAppId` (`6807913556`, the record created
> on the new team on 2026-09-03). The old `6802705582` was removed rather than
> left pointing at a dead record. See the table at the top of
> `docs/design/iap-setup.md`.
TestFlight builds exist on the new account; §6.1 says which one to submit.

Everything below is ready to paste. Character limits are Apple's, enforced by
the form, and were measured rather than eyeballed — see §2. What is still
outstanding is in §6, and it is now mostly Apple's paperwork rather than code.

**Updated 2026-09-21** (promotional text, description and keywords; see §2).
Previously updated 2026-09-02. The description gained the Guideline 3.1.2 subscription
disclosure it was missing (§2), §3 stopped being five Cmd-S presses and became a
command, and §4 grew two rows after the dependency audit went past
`node_modules` into a real `pod install`. Companions: `docs/design/iap-setup.md`
(the ordered click-list for Apple and RevenueCat) and
`docs/design/ios-review-notes.md` (the text a reviewer reads, and why).

---

## 1. App Information (set once, not per-version)

| Field | Value |
|---|---|
| Name | `Feral Travels` |
| Subtitle (30) | `Plan overland trips by chat` |
| Primary category | **Travel** |
| Secondary category | **Navigation** |
| Content rights | Does **not** contain third-party content |
| Age rating | Run the questionnaire — see §5 |

---

## 2. Version Information

### Promotional text (170 max, editable without review)

```
Road trip plan with Penny. Tell her where you want to go; she creates a plan with gas stops and Google Maps route links. Change your mind? She takes care of the updates.
```

(Sam's own wording, 2026-09-21. 169/170 — his draft ran 170/170, dead on the
cap, so the comma before "and" came out and "Google Maps" was capitalised. The
description below is written to match this voice: leads with the searchable
noun phrase, semicolons and commas rather than em dashes, a rhetorical question
answered in the next sentence, plain verbs. No marketing register, and no
compressed or clever phrasing — that reads as written by something else.)

### Description (4000 max)

```
Road trip plan with Penny. Tell her where you want to go; she creates the plan.

Say it how you'd say it out loud. "Girona to Lisbon, leaving Tuesday, three days in Porto, no more than five hours driving a day." She comes back with the trip laid out day by day, with the distance and drive time on every leg.

She adds gas stops along the route based on your vehicle's range, so you're not guessing where the next station is on a long empty stretch. Set your range once in Settings and she plans around it.

Every leg and every stop gets a Google Maps link. One tap and you're navigating.

Change your mind? Just tell her. "We stopped early." "Going here instead." "Add a day in Porto." Paste a Google Maps link, an address, or a place name and she'll route you through it.

Feral Travels also runs in a browser at feraltravels.com, on the same account.

Built for overlanders, van lifers, and anyone who'd rather be driving than planning.

Seven days free. Then $2.69 a month or $22.00 a year in the US; prices in other countries show in the app before you buy. Your trips stay readable either way.

Subscription terms: Feral Travels is an auto-renewing subscription. Payment is charged to your Apple Account at confirmation of purchase. It renews automatically unless auto-renew is turned off at least 24 hours before the end of the current period, and your account is charged for renewal within 24 hours of the end of that period. Manage your subscription and turn off auto-renew in your Apple Account settings after purchase.

Terms of Use: https://feraltravels.com/terms
Privacy Policy: https://feraltravels.com/privacy
```

The price line changed on 2026-09-23 because Sam kept the store's prices (€2/€20
base; US $2.69/$22.00, the fallbacks in `src/server/payments/constants.ts`),
not $2/$20.

Deliberately does NOT name Finn, does not use ALL-CAPS section headers, and does
not claim campsite/amenity finding. It describes only what v1 actually ships.

**Two claims were removed on 2026-09-21 because the app does not do them**, and
they had been sitting in this file marked "ready to paste" since 2026-08-20:

- *"where you end up each night"* — the plan has legs, stops and base days. It
  does not pick or record accommodation.
- *"If she makes you fill up early, she tells you why"*, and the bullet *"A
  reason attached to any stop you wouldn't otherwise make"* — Penny writes leg
  notes, but nothing attaches a justification to an individual fuel stop.

Neither was checked against the app before it was written down. Anything added
to the description from here gets verified against a screen or the code first —
a metadata claim the reviewer can disprove in the app is a 2.3.1 rejection, and
the queue costs a week.

The feature bullet list is gone too: it restated the three paragraphs above it
in worse prose, which is the shape that reads as machine-written.

**The last three paragraphs are Guideline 3.1.2 and are not optional.** An
auto-renewing subscription has to disclose price, period and renewal behaviour,
and the metadata needs a functional link to both the Terms of Use and the
Privacy Policy. The binary carries its half already — the purchase sheet shows
each plan's localized price and cadence, a renewal sentence, and Terms/Privacy
links (`mobile/components/PurchaseSheet.tsx`) — but the *listing* has to say it
too, and this is the single commonest metadata rejection for a first
subscription app.

**Also set App Store Connect → App Information → License Agreement.** Leaving it
on Apple's standard EULA is fine and is the default; what is not fine is the
Terms link above 404ing. It does not — `/terms` is public and
`e2e/legal-pages.spec.ts` fails if that changes.

**Lengths, measured rather than eyeballed** (2026-09-21): subtitle 27/30,
promotional text 169/170, keywords 97/100; description 1624/4000, re-measured
2026-09-23. Apple's form truncates silently in some fields and refuses in
others; both are worse to find out while pasting.

### Keywords (100 max, comma-separated, NO spaces after commas)

```
road trip,trip planner,fuel,gas station,van life,campervan,camper,itinerary,rv,4x4,diesel,offroad
```

97/100 characters. No spaces after the commas — they count. **"overland" came
out on purpose**: it is already in the subtitle, Apple indexes the name and
subtitle alongside this field, and nine characters spent repeating it buy
nothing. That paid for `campervan` and `offroad`. `route planner` became
`trip planner` — higher-volume query, and `route` is the weaker standalone
token. Keep "Google Maps"
out of here; third-party trademarks in the keyword field get flagged.

Do not repeat "Feral Travels" or "Travel" — the name and category are already indexed.

### What's New in This Version

```
First release.
```

### URLs

| Field | Value |
|---|---|
| Support URL | `https://feraltravels.com/support` — page built 20 Aug 2026 |
| Marketing URL | leave blank — optional, and `/` redirects to `/login` |
| Privacy Policy URL | `https://feraltravels.com/privacy` — page exists |
| Copyright | `2026 Samuel Shirley` |

---

## 3. Screenshots

**Regenerate them; do not take them by hand.**

```bash
scripts/ios-e2e-local.sh screenshots       # 6.9-inch, the required slot
```

It boots the right simulator, seeds the canonical trip under a customer-readable
name, signs in through the real OTP flow, walks the app and writes the set to
`mobile/screenshots/6.9/`. Committed, so the next release regenerates rather than
reuses. `mobile/screenshots/README.md` has the per-image notes.

The four, in upload order, produced by `mobile/maestro/screenshots.yaml` rather
than by Cmd-S presses:

1. `01-trips` — the trips list. Shows it is a real tool with real trips.
2. `02-penny-chat` — Penny mid-plan. The differentiator, and the only one that
   has to be *earned*: the flow sends a real message and waits out a real reply,
   spending one Anthropic call.
3. `03-itinerary` — a day expanded with its fuel stops. The flow opens the day
   first on purpose; fuel is lazily sourced, so an unopened day is a picture of
   an itinerary with no fuel in it.
4. `04-map` — the route. Taken after the day is opened, because map stops are
   lazy too.

`05-settings` was dropped: it showed the account email address.

**A correction this section used to contain.** It said to capture "1290 x 2796
from the iPhone 17 Pro simulator". Those two do not go together: the iPhone 17
Pro is the 6.3-inch device at 1206 x 2622, and the 6.9-inch slot needs a Pro Max
or a Plus. Following it would have produced a set App Store Connect refuses.
`scripts/pick-screenshot-simulator.mjs` now owns the mapping, picks the newest
installed model for the slot, and the runner measures every PNG with `sips` and
fails on a mismatch — a mixed-size set is a rejected upload.

Only the **6.9-inch** set is mandatory. `app.config.js` sets
`supportsTablet: false`, so there is no iPad slot at all, and Apple scales the
6.9" set down for smaller iPhones.

**Nothing here can tell a good screenshot from a bad one.** The runner proves
size and count; a map that never loaded its tiles and a map that did are the same
number of pixels. Look at all four before uploading.

---

## 4. App Privacy (the nutrition label)

Derived from the actual schema and API calls, not guessed.

**Do you collect data? YES.**

| Data type | Collected | Linked to user | Used for tracking | Purpose |
|---|---|---|---|---|
| Email address | Yes | Yes | No | App Functionality (sign-in) |
| Name | Yes | Yes | No | App Functionality — optional, only via Google sign-in |
| Precise location | Yes | Yes | No | App Functionality — anchoring trip progress, fuel stops along route |
| Photos | Yes | Yes | No | App Functionality — user attaches images to Penny |
| Other user content | Yes | Yes | No | App Functionality — chat messages, trips, vehicle profiles |
| User ID | Yes | Yes | No | App Functionality |
| Purchase history | Yes | Yes | No | App Functionality — what plan you are on and when it renews |
| Other diagnostic data | Yes | Yes | No | App Functionality — the chat stream-error beacon |

These eight rows are the same eight as `ios.privacyManifests` in
`mobile/app.config.js`, and `src/lib/privacyManifest.test.ts` fails if that list
changes. **Change one, change all three** — this table, the manifest, and the
answers in App Store Connect.

The last two were found by auditing the build rather than the source:

- **Purchase history.** `subscriptions` is keyed on `users.id` as its primary key
  and stores the product id, Apple's original transaction id and the period end;
  `subscription_events` keeps the store's verbatim payload. So this is true of
  our own server whatever RevenueCat does. It is also *not* covered by
  RevenueCat's own manifest in practice: the `RevenueCat` and
  `PurchasesHybridCommon` pods each ship a `PrivacyInfo.xcprivacy`, but neither
  is built into a resource bundle the way React-Core and the Expo modules are
  (`Pods.xcodeproj` has `ResourceBundle-*_privacy` targets for those and none for
  these two), so nothing aggregates them into the app. Checked in a real
  `mobile/ios/Pods` after a prebuild.
- **Other diagnostic data.** `ChatPanel`'s `reportStreamError` posts a short
  code, the failure phase and up to 500 characters of error text to
  `/api/analytics/client-error`, which requires a session and writes it to
  `usage_events` **with a `user_id`**. Linked, therefore, whether or not it is
  interesting. Not "Crash Data": nothing crashes and there is no crash reporter
  in the build.

**Product Interaction is deliberately absent.** `/api/analytics/viewport-time`
exists but only the web calls it — grepped, not assumed. The day the app starts
calling it, this table grows a row.

**Tracking: NO.** There are no ad networks, no analytics SDKs, and no data
brokers in the build. Answer "Data Not Used to Track You" — but only while that
stays true. Adding an analytics SDK later means updating this label.

**The Google Maps SDK is not in the iOS build.** `react-native-maps` can link it,
and its bundled manifest would add Crash Data, Device ID, Performance Data and
Product Interaction for Analytics — but no Google pod is installed (checked in
`mobile/ios/Pods`), because `EXPO_PUBLIC_GOOGLE_MAPS_API_KEY` is not set on the
build profiles in `eas.json`. The app uses Apple Maps. Setting that key changes
this table.

Third parties that receive data, for your own reference when writing the privacy
policy: Anthropic (chat content), Google Maps Platform (coordinates for routing
and place search — server-side only), **RevenueCat (purchase events, keyed to
`users.id` as `app_user_id`)**, **Apple (the purchase itself)**, Resend (email
address for sign-in codes), Neon (database), Vercel (hosting).

---

## 5. Age rating

Answer the questionnaire honestly rather than copying a rating. The one question
that matters here: Penny is a free-form AI chat surface. Apple revised the age
rating bands in 2025 and treats AI chat as a distinct question, so expect the
answer to push this above the automatic 4+. There is no user-to-user messaging,
no user-generated content visible to other users, and no web browser, which keeps
it near the bottom of the range.

---

## 6. Blocked — cannot submit until these are true

Rewritten 2026-08-20. The previous version of this section listed account
deletion and native OAuth as blockers; both shipped in PR #7 and PR #9. Reading
a stale blocker list is how a submission gets delayed by work that is already
done, so this section states what is checkable today.

### Done

- **Account deletion** (guideline 5.1.1(v)) — in-app on web and native,
  `POST /api/me/delete`, migration 0024, admin view at `/admin/deleted`. Covered
  by `e2e/account-deletion.spec.ts`.
- **Sign in with Apple**, native only — `POST /api/mobile/oauth/exchange`,
  merged and in production. Web Apple sign-in is not configured on production:
  `AUTH_APPLE_ID` and `AUTH_APPLE_SECRET` are absent there.
- **Legal URLs** — `/privacy`, `/terms`, `/support` are live and anonymous on
  `www.feraltravels.com`, guarded by `e2e/legal-pages.spec.ts`.
- **Export compliance** — `ITSAppUsesNonExemptEncryption: false` in
  `app.config.js`, so App Store Connect stops asking per upload.
- **App Store Connect API key** on EAS, distribution certificate and
  provisioning profile both valid to Aug 2027.
- **`PrivacyInfo.xcprivacy`** — declared in `mobile/app.config.js` under
  `ios.privacyManifests`, so `expo prebuild` emits it and the gitignored `ios/`
  tree is never hand-edited. Verified by running a real prebuild and reading the
  emitted file, and guarded by `src/lib/privacyManifest.test.ts`. Its absence is
  ITMS-91053, which arrives as an email AFTER the upload; every reason code was
  read off the dependency manifests actually on disk. See §4.
- **Screenshots** — automated. `scripts/ios-e2e-local.sh screenshots` regenerates
  the 6.9-inch set into `mobile/screenshots/6.9/`. See §3.
- **In-app purchases, client side** — `react-native-purchases`, store prices from
  Offerings, Restore, Manage Subscription, and the webhook still the only thing
  that grants access. See `docs/design/iap-setup.md`.

### Actually outstanding

1. **A TestFlight build from current `main`.** Build 11 (1.0.0, commit
   `ec8986b`, native fingerprint `6c9e8245…`, cut 2026-09-23 by a manual Mobile
   run) carries the OAuth scheme, the Apple Sign-in entitlement, the purchase
   sheet, the `feral_travels` entitlement (PR #54) and the onboarding calendar /
   Custom pace chip (PR #55) in its bundled JS. Builds 6–10 have the same native
   fingerprint but bundle older JS, which is what a reviewer's first launch
   runs. To cut another: Actions → Mobile → Run workflow. It takes no inputs; a
   manual run always builds and auto-submits
   (`gh workflow run Mobile --ref main`). Dispatch only after Deploy to
   production is green for that commit.

2. **Verify Sign in with Apple on a real device.** It cannot be exercised on the
   simulator. Include a Hide My Email run: the relay path
   (`@privaterelay.appleid.com`) is unit-tested in `emailVerification.test.ts`
   but has never met the live provider.

3. **`AUTH_GOOGLE_IOS_CLIENT_ID` in the Vercel PRODUCTION environment.** CI
   proves it is set on *preview* (`e2e/oauth-exchange.spec.ts` fails with 503
   otherwise), and preview is not production. The app points at
   `www.feraltravels.com`, so production is the one that decides whether Google
   sign-in works on a phone. Check it by hand.

4. **The Paid Applications Agreement, plus the two products and the RevenueCat
   wiring.** This replaced the Free Apps agreement the moment the app gained a
   subscription, and it is the longest human-in-the-loop item on the list — it
   needs the Account Holder, tax forms and a validated bank account.
   **Until it is Active, StoreKit returns an empty product array**: not an
   error, not a denial, nothing in any log. `docs/design/iap-setup.md` is the
   ordered click-list and section 1 is that agreement.

   Note what this does to the review notes (`ios-review-notes.md` §3): a
   reviewer must be able to SEE the subscription. Settings → Plan → "View
   plans" opens the purchase sheet in every account state precisely so a
   reviewer on a fresh trial — who is entitled, and therefore sees no paywall
   anywhere — still has a screen with prices on it.

5. **Screenshots regenerated against the build you actually submit**, and looked
   at. The command is one line now (§3); the looking is not automatable.

6. **App Privacy label** (§4) and **age rating** (§5) — fillable today, nothing
   blocks them. §4 grew two rows (purchase history, diagnostics) when the
   dependency audit went past `node_modules` into a real `pod install`; answer
   from the table, not from memory.

7. **The global paywall switch stays OFF through review.** It is the
   `app_meta.paywall_enabled` row, flipped from the `PAYWALL ON/OFF` pill in the
   `/admin` header — not an env var; `PAYWALL_ENABLED` has not been read since
   2026-09-02. The app is submittable with it off: the purchase is still
   findable (Settings → Plan → View plans) and still completes. The cost,
   accepted: a reviewer inside their trial buys a subscription that visibly
   changes nothing, because they were already entitled. The alternative is
   worse — the web app is the demo while the build is in review, and turning
   enforcement on would wall every account past its trial with nothing to buy.
   To see the wall work, force it onto one disposable account from
   `/admin/users/[id]`. `docs/design/ios-review-notes.md` §4 says the same.

   Its preconditions for after review are at the end of `docs/design/iap-setup.md`. The one that
   is not negotiable: do not flip it before a build containing the purchase
   sheet is what testers actually have. A blocked user on an older binary has no
   way to pay, and an OTA cannot deliver the sheet.

### App Review Information → Sign-In Information and Notes

Both come from `docs/design/ios-review-notes.md` §3. The Sign-In Information
fields ARE filled (`appletest@feraltravels.com` / `000000`), and the Notes are
the "text to paste" block there. That file owns the reviewer-facing text; do not
keep a second copy here. `APPLE_REVIEW_SIGNIN=1` must be set on the production
Vercel environment or the code is refused (`ios-review-notes.md` §1).

---

## 7. Order of operations

Everything in §1, §2, §4 and §5 can be typed into App Store Connect today; none
of it depends on a build. §3 needs a build but not Apple's paperwork.

**Start the Paid Applications Agreement first anyway** (§6.4). It is the only
item here with a human at Apple's end and a bank validation in the middle, and
nothing about in-app purchase can be tested until it is Active — so it should be
running in the background while everything below happens.

1. **Agreement, tax, banking** — Business → Agreements. Then the subscription
   group and the two products, then the RevenueCat wiring.
   `docs/design/iap-setup.md`, in that order, top to bottom.
2. **Cut the native build.** Actions → Mobile → Run workflow. ~30 minutes of EAS
   plus 5–15 of App Store Connect processing. This one must contain the purchase
   sheet and the privacy manifest, so it has to come after the IAP work merges —
   an OTA cannot deliver either.
3. **Device checklist** — the P1 list in `pr7-review-and-test-plan.md` (Google
   and Apple sign-in, the location primer on a fresh install, account deletion),
   plus a real sandbox purchase all the way to a `subscription_events` row with
   `outcome = 'applied'`. Section 9 of `revenuecat-implementation.md` is that
   checklist and it does not stop at "the sheet said Success".
4. **Regenerate the screenshots** against that build and look at all four (§3).
5. **Attach, answer §4 and §5, fill App Review Information from
   `ios-review-notes.md` §3, submit.**

The paywall switch is not on this list: the app is submittable with it off, and
turning it on afterwards is the `app_meta.paywall_enabled` row, flipped from the
`/admin` pill with no redeploy — see §6.7.
