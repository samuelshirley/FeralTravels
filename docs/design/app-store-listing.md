# App Store listing — Feral Travels

ASC App ID **6802705582** · bundle `com.feraltravels.app` · version **1.0.0** (build 3)

Everything below is ready to paste. Character limits are Apple's and are enforced
by the form. Three fields are **blocked** on work that does not exist yet — they
are marked and explained at the bottom.

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
```

Deliberately does NOT name Finn, does not use ALL-CAPS section headers, and does
not claim campsite/amenity finding. It describes only what v1 actually ships.

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

Only the **6.9-inch** set is mandatory; Apple scales it down for smaller devices.
Capture at 1290 x 2796 from the iPhone 17 Pro simulator you already have running
(Cmd-S saves to Desktop). Three to five, in this order:

1. **Trips list** — shows it is a real tool with real trips
2. **Penny chat mid-plan** — the differentiator; make sure her reply is visible
3. **Itinerary with a fuel stop** — the "why this stop exists" line showing
4. **Map with the route** — visual anchor
5. **Settings / vehicle profile** — proves the fuel maths is yours to set

Seed a good-looking trip first. A screenshot of an empty state sells nothing, and
reviewers see these too.

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

**Tracking: NO.** There are no ad networks, no analytics SDKs, and no data
brokers in the build. Answer "Data Not Used to Track You" — but only while that
stays true. Adding an analytics SDK later means updating this label.

Third parties that receive data, for your own reference when writing the privacy
policy: Anthropic (chat content), Google Maps Platform (coordinates for routing
and place search), Resend (email address for sign-in codes), Neon (database),
Vercel (hosting).

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

4. **Screenshots** (§3) — still the largest piece of manual work.

5. **App Privacy label** (§4) and **age rating** (§5) — fillable today, nothing
   blocks them.

6. **Free Apps agreement Active** — App Store Connect → Business.

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

Everything in §1–§5 can be completed in App Store Connect today; none of it
depends on a build.

The build is the long pole, and it is the one thing that has to happen before
"Submit for Review" means anything:

1. Cut the native build (§6.1) and wait for it to reach TestFlight — roughly
   30 minutes of build plus 5–15 of App Store Connect processing.
2. Install it and work through the P1 device checklist in
   `pr7-review-and-test-plan.md` — Google sign-in, Apple sign-in, the location
   primer on a fresh install, account deletion from the app.
3. Fix whatever that surfaces, merge, and let the pipeline decide: a JS fix goes
   out as an OTA in seconds; a native one cuts another build on its own.
4. Attach the build to the version, answer §4 and §5, paste the review notes,
   confirm the Free Apps agreement, submit.
