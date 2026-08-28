# E2E overhaul

The suite as it stands proves the app can be signed into. It does not prove the
app works. This is the plan to change that, the decisions it needs, and the one
place the owner asked for something that will not survive contact with an LLM.

Written 2026-08-27. Companion to `docs/design/launch-checklist.md` — nothing
here is gated on protecting production accounts; there are none yet.

## The thing that blocks everything else

**No fixture in this repo builds a trip with stops.**

`seedCanonicalFixture` (`e2e/fixtures/test-trip.ts`) posts four strings to
`/api/test/seed`. The itinerary it gets back is `CANONICAL_TWO_LEGS`
(`src/server/repos/testSupport.ts:68`): two legs, Paris → Strasbourg →
Stuttgart. No stops. No routes. No geometry. No chat. `existing-trip.spec.ts:41`
says so out loud — *"Seeded legs have no intermediate stops, so there is exactly
one link: the destination."*

The only code that produces legs **and** stops **and** routes **and** geometry
together is `cloneTrip`, and it copies rows out of a trip that already exists in
the database. That is what the admin test-user generator uses
(`seedRealisticAccountData` → the admin's most recent prod trip), which is why
that generator produces good-looking accounts and the E2E suite does not.

Three consequences, and they are the reason this document exists:

1. **Nine of the seventeen tests below cannot be written against the current
   fixture.** Anything about stops, fuel, maps links, or a trip long enough to
   have a third stop day has nothing to run against.
2. **The preview database has to be a clone of production** — because the admin
   generator's data comes from production. That is the sharpest accepted edge in
   `CLAUDE.md` (real user data on a public URL) and it exists to serve a fixture.
3. **Nothing tests the cache.** You cannot assert "a day with fuel stops does not
   re-search" without a fixture that has fuel stops and a fresh cache stamp.

### The fix: `CANONICAL_TRIP` in code — BUILT

Built 2026-08-28 in `src/server/fixtures/canonicalTrip.ts`, extracted from the
owner's "August Portugal Trip" (`30df628c-cdb7-479b-9edd-e4ddbeb494d8`) — a trip
a person actually planned, which is the only way to get real road geometry and
real Google places into a fixture. Twelve days, six driving and six base, two
countries, segment grouping, geometry on every leg, three real fuel stops, and
all three fuel cache states in one seed. Still to wire into
`testSupport.seedFixture` and `payments/testAccounts.seedRealisticAccountData`.

No calendar date is written down: `startISO` defaults to `seededTripStartISO()`
(today + 14) and every leg date derives from it, so the trip is in the future
whenever it is seeded — asserted out to 2031 in `canonicalTrip.test.ts`. The
fuel cache is stored as an AGE IN HOURS rather than a timestamp for the same
reason: a stored date would start fresh and quietly go stale, and the test
asserting "a cached day is not re-searched" would pass, then fail, for reasons
unrelated to the code.

What it carries:

| Piece | Why a test needs it |
|---|---|
| 5–6 legs, drive and rest mixed | test 5 needs a "3rd stop day" to extend; rest days are the shape `update_leg` refuses to move |
| geometry on every drive leg | the native map draws only what it is given; without it a seeded trip is scattered dots |
| routes + route_links | the destination "open in Maps" button (test 14) |
| fuel stops, `source: 'osm'`, with `googleMapsUri` | tests 14 and 16 |
| `fuel_status: 'ready'` + a **fresh** `fuel_stops_updated_at` | test 16 is meaningless without it |
| one `other` (user-added) stop | the second of the two stop types renders differently |
| a generated chat transcript | a finished itinerary with an empty transcript is a state Penny cannot produce |
| vehicle: Hilux, 500 km | range maths |
| a second profile: Tacoma, shorter range | test 3 |

Dates come from `seededTripStartISO()` (today + 14) as they already do, and the
transcript from the generator added in `732eda4` — no calendar date is written
into the fixture, per `seedDates.ts`.

Once it exists, the preview database can be **empty plus migrations** instead of
a prod clone, and the admin generator works on a fresh database. Both fall out
of the same change.

## Decisions needed before the specs are written

### 1. Penny — RESOLVED, and the first answer here was wrong

The first draft of this document said an LLM cannot be asserted verbatim and
proposed tolerances. The owner pushed back: *"if I tell her I want to go from
Girona to Porto over five days, she should always come up with the same route
and stops... two plus two is not going to equal three magically one day."*

He is substantially right, and there is a concrete reason it has been varying.

**Penny's planning loop sets no temperature.** `src/lib/claude.ts:749` calls
`client.messages.create({ model, max_tokens, system, tools, messages })` — no
`temperature`, so it runs at the API default of 1.0, maximum sampling variance,
on the single most important call in the app. The three small parsing calls all
set `temperature: 0` deliberately (`onboardingIntentScan.ts:145`,
`parseRangeEstimate.ts:117`, `parseStartDate.ts:159`). The one that picks the
route does not. Nobody told her to be consistent.

**Action: set `temperature: 0` on the planning loop.** It is choosing waypoints,
not writing prose that benefits from variety.

With that done, the honest split is:

| Layer | Varies? | Assert |
|---|---|---|
| Route + overnight choices | should not, at temperature 0 | **exactly** — a golden trip |
| `planSummary` (day counts, dates, totals) | no — computed from rows by `computePlanSummary` | **exactly** |
| Leg distances | ±1% — the routing provider is deterministic | exact to 1% |
| Drive durations | traffic and roadworks move these | ±15% |
| Penny's prose | yes, and should | shape only: no tool markup, no numbers |
| Model version | changes outright when Anthropic ships | this is what fails the test, on purpose |

So: **a golden-trip snapshot.** Girona → Porto over five days produces one
recorded answer; the spec asserts it; if the route changes the test goes red and
a human decides whether the new route is better. That is the instrument the
owner actually wants — variance becomes a signal instead of a tolerance — and it
is the thing that catches a prompt regression the day it lands.

Two caveats worth stating rather than discovering later. Temperature 0 is
*near*-deterministic, not guaranteed: provider-side batching can still produce
rare divergence. And a model version bump WILL move the golden file — that is
correct behaviour for this test, and it is a review, not a flake.

### 2. Preview database: clone of prod, or empty?

Owner's position, and it is correct: a prod clone "doesn't really help our
testing". Every spec seeds its own user and its own trip; nothing reads a row it
did not write. The clone buys nothing and costs the one genuinely risky property
in the pipeline.

**RESOLVED: yes, empty.** Unblocked — `CANONICAL_TRIP` now exists
(`src/server/fixtures/canonicalTrip.ts`), so nothing needs a prod row any more.

### 3. `SUBSCRIPTION_TESTING` on preview

Previously argued against on the grounds that preview is a public URL holding a
clone of production data. With decision 2 taken, that objection is gone: there is
no real data to protect. The route it arms (`/api/purchase/test`) is still locked
to the hardcoded `sam+trial-<tag>@feraltravels.com` pattern, and the admin
generator behind it still requires the cookie-only admin guard, the hardcoded
one-address allowlist, `emailVerified`, and `is_admin`.

Turn it on for preview. `scripts/check-preview-env.mjs` currently asserts the
opposite and moves to the required list in the same change.

### 4. Retries

`playwright.config.ts` sets no `retries`, so it is 0 everywhere, and
`E2E_MAX_SKIPPED=0` means nothing may skip. With a 2-minute Anthropic spec in the
suite, one transient 529 from the API reds the deploy gate on a PR that changed a
CSS file. **RESOLVED: `retries: 2`, everything in parallel.** Note the consequence, so it
is a choice and not a surprise: a retry turns a real intermittent bug into a
green build. If a spec starts passing only on attempt 2, that is a finding — the
HTML report records the retry, and it is worth looking at rather than enjoying.

## The seventeen, mapped

`NEW` = does not exist. `EXTEND` = spec exists, does not cover this.

| # | What | Where | State |
|---|---|---|---|
| 1 | Fresh user completes onboarding, ends with a vehicle | `onboarding-flow.spec.ts` | EXTEND — stops at the units question, never asserts the vehicle row lands |
| 2 | Seeded user removes a vehicle | `vehicles.spec.ts` | EXTEND — `vehicle-crud` only proves the LAST one cannot be removed |
| 3 | Remove, then add a Tacoma with a shorter range | `vehicles.spec.ts` | NEW — and assert the shorter range reaches fuel planning, or it tests a form |
| 4 | Validate the trip list | `trip-list.spec.ts` | NEW |
| 5 | Add days at the 3rd stop day; validate UI **and** API | `trip-edit.spec.ts` | NEW — the big one; dates downstream must re-anchor |
| 6 | Delete a fully seeded trip | `trip-list.spec.ts` | NEW |
| 7 | Manual onboarding, message by message, real Penny | `penny-plan-trip.spec.ts` | REWRITE — currently asserts ≥3 legs and two city names |
| 8 | Legal pages | `legal-pages.spec.ts` | DONE — 10 tests, both raw HTTP and rendered |
| 9 | Send a support message | `account.spec.ts` | NEW — also covers the modal fixed this session |
| 10 | Avatar and settings menu | `account.spec.ts` | NEW — photo-or-glyph, never initials |
| 11 | Delete an account with a full trip | `account-deletion.spec.ts` | EXTEND — 12 solid tests, but against the 2-leg fixture |
| 12 | Edit trips from the list page | `trip-list.spec.ts` | NEW |
| 13 | Rename a trip | `trip-list.spec.ts` | NEW |
| 14 | Maps links render and route correctly | `trip-detail.spec.ts` | EXTEND — `existing-trip` covers the destination button, not stop links |
| 15 | Metric vs imperial | `trip-detail.spec.ts` | NEW — see the note below |
| 16 | A cached day does not re-search fuel | `lazy-fuel-sourcing.spec.ts` | EXTEND — see the note below |
| 17 | Day-7 paywall blocks every screen | `paywall-screens.spec.ts` | NEW — see below; writing it found a hole |

### Note on 15 — this is a product decision, not only a bug

Two real bugs were found and fixed (`StopCard`'s caption and the map marker
tooltip both ignored `units_pref` outright). But flipping to imperial will still
not make everything imperial, **by design**: `src/lib/units.ts` keeps km as the
primary label for everyone and adds miles as a secondary, because "we've decided
to teach metric". If the intent is that imperial means miles *instead of*
kilometres, that is a change to `formatKmDual` and this spec should assert the
new behaviour. Say which before the spec is written.

### Note on 16 — the bug was real and is fixed

`cloneTrip` never copied `fuelStatus` or `fuelStopsUpdatedAt`, so every cloned
leg looked never-sourced while holding sourced stops, and opening any day re-ran
the full OSRM + Overpass + pricing search. Fixed, with a structural guard
(`cloneTripColumns.test.ts`). The E2E half still needs writing, and it needs
`CANONICAL_TRIP` to carry a fresh cache stamp — the current spec asserts a fetch
DOES fire, which is the never-sourced case and only half the contract.


### Note on 17 — "every screen" is not true today, and the allowlist that would make it true is dead code

The ask: a seeded seven-day-old user hits the wall, the app is soft-blocked and
unusable **on all screens** with a message saying it needs a subscription; iOS
can buy, desktop and mobile web show a link to the App Store listing.

Three things came out of taking that literally.

**a) The paywall has no central gate.** `middleware.ts` imports only
`isPublicPath`. `PAYWALL_EXEMPT_PREFIXES` and `isPaywallExempt`
(`src/lib/paywallPaths.ts:75`, `:93`) are defined, documented at length,
covered by eleven unit tests — and **called by nothing at runtime**. Enforcement
is instead hand-written into eight files that each remembered to ask
`getAccountVerdict`. A route added tomorrow gets no gate by default, and nothing
fails when it doesn't.

**b) `/vehicle-setup` is one of the routes that forgot.** It contains zero
entitlement checks (`grep -c 'getAccountVerdict\|hasEntitlement'` → 0), so a
fully blocked account can still reach it and edit vehicles. Found by enumerating
the screens for this spec rather than by using the app.

**c) "All screens" would be an App Store rejection if taken literally.**
`/settings` must stay reachable — it holds sign-out and account deletion, and
guideline 5.1.1(v) requires in-app deletion; a paywall in front of it fails
review. `/privacy`, `/terms` and `/support` must stay anonymously fetchable for
App Review and Google brand verification. Both facts are already argued in
`paywallPaths.ts`; the spec has to encode the **partition**, not a blanket.

So the spec is a table over every route, with nothing unclassified:

| Screen | Blocked? |
|---|---|
| `/` | inherits — redirects to `/trips` |
| `/trips` | **blocked** — overlay, no "+ New trip" |
| `/trips/[tripId]` | **blocked** — panes locked, composer disabled, `paywall-cta` |
| `/vehicle-setup` | **should be blocked — currently is not** |
| `/settings` | exempt, deliberately (sign-out, deletion) |
| `/login`, `/login/verify` | public |
| `/privacy`, `/terms`, `/support` | public, anonymously |
| `/admin/**` | admin-only; a blocked non-admin gets nothing either way |
| iOS `/trips`, `/trips/[id]`, `/index` | **blocked** → `/paywall` |
| iOS `/settings`, `/sign-in` | exempt |

And the API side, which is the half a UI test cannot see: `POST /api/trips`,
`/api/trips/[id]/clone`, `/api/trips/[id]/onboarding` and `/api/trip/replan` all
return 402 with `code === PAYWALL_ERROR_CODE`; `/api/me/**` and `/api/support`
stay 200.

**The fix this implies** is not more per-route checks — it is wiring the
allowlist that already exists. `getAccountVerdict` needs a database, so it
cannot run in edge middleware; the shape that fits is a shared
`requireEntitledPage()` helper plus a structural guard in the unit suite —
every route under `src/app` either calls it or appears in
`PAYWALL_EXEMPT_PREFIXES`, checked by parsing the route tree the same way
`cloneTripColumns.test.ts` parses the schema. That turns "we remembered" into
"it cannot be forgotten", and it is what makes spec 17 a test of a rule rather
than a snapshot of eight files.

**The buttons.** Web cannot take money, so the CTA is a link out:
`APP_STORE_URL` (`src/lib/paywallCopy.ts`) reads `NEXT_PUBLIC_APP_STORE_URL` and
falls back to `https://apps.apple.com/search?term=Feral%20Travels` — the listing
id does not exist yet, and the search URL is a real working Apple page rather
than a dead link. The spec asserts the CTA points at an `apps.apple.com` URL,
not at the literal fallback, so setting the real id later does not red it. On
iOS the same block renders `PurchaseSheet` with the two products; with an empty
product list (StoreKit before the Paid Applications Agreement) it says to buy in
the app instead. Both surfaces show the same copy, from the same
`paywallCopy` module, which is the thing worth asserting — that they cannot
drift into offering different things.

## Order of work

1. ~~`CANONICAL_TRIP`~~ DONE. Wire both consumers — `testSupport.seedFixture`
   and `seedRealisticAccountData` — then delete `CANONICAL_TWO_LEGS`.
   Set `temperature: 0` on the planning loop in the same pass.
2. Preview DB → empty; `SUBSCRIPTION_TESTING` → preview.
3. Specs 4, 6, 12, 13 (`trip-list`) — cheapest, and they exercise the fixture.
4. Specs 14, 15, 16 (`trip-detail`, `fuel`) — the fixture's stops earn their keep.
5. Specs 2, 3 (`vehicles`), 9, 10 (`account`), 11 extension.
6. Spec 5 (`trip-edit`) — hardest of the deterministic ones.
7. Spec 17 (paywall) — preceded by wiring `PAYWALL_EXEMPT_PREFIXES` into a
   `requireEntitledPage()` helper and closing `/vehicle-setup`, since the spec
   is otherwise a snapshot of which routes happened to remember.
8. Spec 7 (Penny) last, once the invariant helpers from 5 exist to reuse.
