# App Store listing — Feral Travels

ASC App ID **— none yet** · bundle `com.feraltravels.ios` · version **1.0.0**

> **The app moved to a new Apple developer account on 2026-09-02.** The old ASC
> App ID `6802705582` and bundle `com.feraltravels.app` belong to a record on
> the previous team and are dead — a TestFlight upload binds a bundle id to its
> account permanently. A NEW app record has to be created on the new team before
> any of §1's fields can be filled in. `mobile/eas.json` now carries the new
> `appleTeamId` (`TJX3F3832H`) and NO `ascAppId` — it was removed rather than
> left pointing at the dead record. See the table at the top of
> `docs/design/iap-setup.md`.
(no TestFlight build on the new account. Build 7 of 2026-08-27 was the last on
the OLD one and is unreachable — it predated the in-app-purchase client, the
Settings "View plans" control and the privacy manifest anyway, and could not
have received any of the three over the air. The first build on the new team
starts from 1.)

Everything below is ready to paste. Character limits are Apple's, enforced by
the form, and were measured rather than eyeballed — see §2. What is still
outstanding is in §6, and it is now mostly Apple's paperwork rather than code.

**Updated 2026-09-02.** The description gained the Guideline 3.1.2 subscription
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
Trip plan with Penny, she'll create a day by day plan with google maps links and automagically finds gas stations based on your fuel range.
```

(Live in ASC as of 20 Aug 2026 — Sam's own wording. The description below is
written to match this voice: plain, spoken, no marketing register.)

### Description (4000 max)

```
Tell Penny where you want to go. She'll plan the drive.

You describe the trip the way you'd say it out loud — "Girona to Lisbon starting tomorrow, three days in Porto, three in Lisbon, no more than five hours driving a day" — and she builds the whole thing out. Day by day. Where you drive, how far, where you end up each night.

Then she finds gas stations along the route, based on how far your vehicle actually goes on a tank. Not every 300km whether you need it or not — only where you'd genuinely run low, and always before a long empty stretch. If she makes you fill up early, she tells you why.

Every leg and every stop has a Google Maps link, so getting moving is one tap.

Plans change on the road, so you just tell her. "We stopped early." "Going here instead." "Add a day in Porto." Paste a Maps link, an address, or just a place name and she'll route you through it.

What you get:

- A day-by-day plan from a plain description of your trip
- Fuel stops on your actual route, sized to your range
- A reason attached to any stop you wouldn't otherwise make
- Google Maps links for every leg and stop
- Add your own stops from a link, an address, or a name
- Edit anything mid-trip by just saying so

Feral Travels also runs in any browser at feraltravels.com, on the same account.

Built for overlanders, van lifers, and anyone who'd rather be driving than planning.

Seven days free, then $2 a month or $20 a year. Your trips stay readable either way.

Subscription terms: Feral Travels is an auto-renewing subscription. Payment is charged to your Apple Account at confirmation of purchase. It renews automatically unless auto-renew is turned off at least 24 hours before the end of the current period, and your account is charged for renewal within 24 hours of the end of that period. Manage your subscription and turn off auto-renew in your Apple Account settings after purchase.

Terms of Use: https://feraltravels.com/terms
Privacy Policy: https://feraltravels.com/privacy
```

Deliberately does NOT name Finn, does not use ALL-CAPS section headers, and does
not claim campsite/amenity finding. It describes only what v1 actually ships.

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

**Lengths, measured rather than eyeballed** (2026-09-02): subtitle 27/30,
promotional text 139/170, description 1990/4000, keywords 98/100. Apple's form
truncates silently in some fields and refuses in others; both are worse to find
out while pasting.

### Keywords (100 max, comma-separated, NO spaces after commas)

```
road trip,route planner,overland,fuel,gas station,van life,camper,itinerary,rv,4x4,diesel,roadtrip
```

98/100 characters. No spaces after the commas — they count. Keep "Google Maps"
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

The five, in upload order — the same five this section always listed, now
produced by `mobile/maestro/screenshots.yaml` rather than by five Cmd-S presses:

1. `01-trips` — the trips list. Shows it is a real tool with real trips.
2. `02-penny-chat` — Penny mid-plan. The differentiator, and the only one that
   has to be *earned*: the flow sends a real message and waits out a real reply,
   spending one Anthropic call.
3. `03-itinerary` — a day expanded with its fuel stops. The flow opens the day
   first on purpose; fuel is lazily sourced, so an unopened day is a picture of
   an itinerary with no fuel in it.
4. `04-map` — the route. Taken after the day is opened, because map stops are
   lazy too.
5. `05-settings` — the vehicle profile, scrolled to centre so the fixture email
   address is pushed off the top.

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
number of pixels. Look at all five before uploading.

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
- **Sign in with Apple**, native and web — `POST /api/mobile/oauth/exchange`,
  merged and in production.
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

1. **A TestFlight build that contains the OAuth work.** Builds 2 and 3 predate
   PR #7 — their native fingerprint is `f407a3a…` against today's `ad7c05a…`.
   Neither has the reversed-client-id URL scheme or the `usesAppleSignIn`
   entitlement, so in those binaries the Apple button does not render and the
   Google one dead-ends. An OTA cannot fix either: both are compiled in.
   **Cut a native build from current `main`** — Actions → Mobile → Run workflow
   → mode `build` — and let auto-submit carry it to TestFlight.

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

   Note what this does to §5's review notes: a reviewer must be able to SEE the
   subscription. Settings → Plan → "View plans" opens the purchase sheet in every
   account state precisely so a reviewer on a fresh trial — who is entitled, and
   therefore sees no paywall anywhere — still has a screen with prices on it.

5. **Screenshots regenerated against the build you actually submit**, and looked
   at. The command is one line now (§3); the looking is not automatable.

6. **App Privacy label** (§4) and **age rating** (§5) — fillable today, nothing
   blocks them. §4 grew two rows (purchase history, diagnostics) when the
   dependency audit went past `node_modules` into a real `pod install`; answer
   from the table, not from memory.

7. **`PAYWALL_ENABLED=1` on production.** Strictly speaking the app is
   submittable without it — the purchase is still findable (Settings → Plan →
   View plans) and still completes — so this is not a hard blocker the way the
   agreement is. But leave it off and a reviewer buys a subscription that
   visibly changes nothing, because they were already entitled, which invites
   exactly the "what is this purchase for" question you do not want asked.
   `docs/design/ios-review-notes.md` §4 lists it as required for that reason and
   that is the position to work to.

   Its preconditions are at the end of `docs/design/iap-setup.md`. The one that
   is not negotiable: do not flip it before a build containing the purchase
   sheet is what testers actually have. A blocked user on an older binary has no
   way to pay, and an OTA cannot deliver the sheet.

### App Review Information → Notes

Sign in with Apple is the answer to guideline 2.1(a): the reviewer uses their
own Apple ID and gets a real, fully functional account — no demo credentials,
no fixed code, no backdoor. Leave the demo username/password fields empty and
paste:

> This app is passwordless. Tap "Sign in with Apple" on the sign-in screen and
> use your own Apple ID (Hide My Email works) — that creates a full account with
> no demo credentials needed. The email + 6-digit code option is for users who
> prefer email; it sends a real code to a real inbox, so please use Sign in with
> Apple.

**Fallback, only if a reviewer rejects on 2.1(a) anyway:** an env-gated fixed
code for one designated review address. Do NOT build this pre-emptively — it is
backdoor-shaped, it sits directly next to `noBackdoorGuard.test.ts`, and it
contradicts the no-bypass rule the rest of the auth surface is built on.

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
4. **Regenerate the screenshots** against that build and look at all five (§3).
5. **Attach, answer §4 and §5, paste the review notes, submit.**

`PAYWALL_ENABLED` is not on this list. The app is submittable with the paywall
off, and turning it on afterwards is an env change — see §6.7.
