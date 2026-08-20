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

## 6. Blocked — cannot submit until these exist

**Account deletion.** Guideline 5.1.1(v) requires an account-based app to offer
account deletion from inside the app. There is no endpoint and no UI. This is a
rejection, not a warning.

**App Review sign-in.** Guideline 2.1(a): "If your app includes account-based
features, provide either an active demo account or fully-featured demo mode."
The app is gated behind an emailed OTP and the test OTP endpoint is hard-off in
production, so a reviewer left on the OTP path waits forever for a code they
cannot read.

**Sign in with Apple is the answer, and it is already built** — the reviewer
uses their own Apple ID and gets a real, fully functional account. No demo
credentials, no fixed code, no backdoor. What remains is delivery, not code:

1. **Merge and promote `feat/native-oauth`.** `POST /api/mobile/oauth/exchange`
   is 12 commits ahead of `main` and is NOT in production. Ship a build that
   offers Apple sign-in against today's prod and every tap 404s.
2. **Cut a fresh native build.** `usesAppleSignIn` is an entitlement, so OTA
   cannot add it — and `appleAvailable()` returns false without it, which means
   the button silently does not render. eas.json gained
   `EXPO_PUBLIC_ENABLE_APPLE_SIGNIN=1` in 0099bf9, AFTER build 3 was cut, so
   build 3 almost certainly has no Apple button. Rebuild:
   `EXPO_PUBLIC_ENABLE_APPLE_SIGNIN=1 npx expo prebuild --clean` then a
   production EAS build, uploaded as a new build.
3. **Verify on a real device via TestFlight.** Apple sign-in cannot be exercised
   on the simulator. Include a Hide My Email run — the relay address path
   (`@privaterelay.appleid.com`) is handled in `oauthIdentity.ts` but untested
   against the live provider.
4. **App Review Information → Notes**, something like:

   > This app is passwordless. Tap "Sign in with Apple" on the sign-in screen
   > and use your own Apple ID (Hide My Email works) — that creates a full
   > account with no demo credentials needed. The email + 6-digit code option is
   > for users who prefer email; it sends a real code to a real inbox, so please
   > use Sign in with Apple.

   Leave the demo username/password fields empty.

**Fallback, only if a reviewer rejects on 2.1(a) anyway:** an env-gated fixed
code for one designated review address. Do NOT build this pre-emptively — it is
backdoor-shaped, it sits directly next to `noBackdoorGuard.test.ts`, and it
contradicts the no-bypass rule the rest of the auth surface is built on.

**Agreements.** App Store Connect → Business → the Free Apps agreement must show
Active before the version can be submitted.

---

## 7. What you can do right now

Everything in §1, §2 and §3 can be filled in and saved today. §4 can be completed
today. §5 can be completed today. Only §6 blocks the actual "Submit for Review"
button.
