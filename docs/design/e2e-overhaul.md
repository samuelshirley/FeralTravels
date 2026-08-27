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

### The fix: `CANONICAL_TRIP` in code

One fixture, defined in `src/server/fixtures/canonicalTrip.ts`, consumed by
both `testSupport.seedFixture` and `payments/testAccounts.seedRealisticAccountData`.
It must carry:

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

### 1. Penny cannot be asserted verbatim, and should not be

The ask was: *"it needs to make sure penny always builds the same trip and
responds the same with the same information."*

She will not. Same prompt, same model, different tool-call ordering and different
prose — that is what a sampled model is. A spec that asserts her exact words
fails on a week where nothing changed, and a spec that fails for no reason gets
muted, which leaves the most important flow in the app untested. The ask is
right; the assertion is the wrong instrument.

What IS deterministic, and is a **stronger** test than string equality:

- **Shape** — leg count, first leg starts at the named origin, last ends at the
  named destination, cities named in the prompt all appear as leg endpoints.
- **Continuity** — every leg starts within 50 km of where the previous ended.
  This is the invariant `computeStartFixes` and `contiguityGate` exist to hold,
  and the "scrambled trip" incident is what happens when it breaks.
- **`planSummary`** — day counts, depart/arrive dates and totals are computed by
  `computePlanSummary` from the rows, not by the model. Given the same legs these
  are exactly equal, every run. Assert them.
- **Physics** — no leg over `DEFAULT_MAX_DRIVE_HOURS_PER_DAY`; rest days have
  start == end; every fuel stop inside `range_km` of the one before it.
- **Hygiene** — her prose contains no `<invoke>`/`<parameter>` markup
  (`sanitize.ts`), and states none of the numbers the UI renders from
  `planSummary`.
- **Idempotence of the deterministic layer** — run the same prompt twice against
  two fresh users and assert the two `planSummary` objects agree on day count and
  date range, even where the routes differ.

That last one is the closest honest form of "always builds the same trip", and
it catches real regressions: a prompt change that makes her split days
differently moves it immediately.

**Decision required:** accept invariant-based assertions for spec 7, or insist on
verbatim and accept a spec that will be muted within a month.

### 2. Preview database: clone of prod, or empty?

Owner's position, and it is correct: a prod clone "doesn't really help our
testing". Every spec seeds its own user and its own trip; nothing reads a row it
did not write. The clone buys nothing and costs the one genuinely risky property
in the pipeline.

**Blocked on `CANONICAL_TRIP` above** — the admin generator reads a prod trip
today, so removing the clone before the fixture exists breaks it.

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
CSS file. Recommendation: `retries: 1` **in CI only, for the Anthropic project
only** — split it into its own Playwright project the way `announcement` already
is. Everything else stays at 0, because a retry on a real bug is a hidden bug.

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
| 17 | Day-7 paywall blocks every screen | `subscriptions.spec.ts` | EXTEND — 13 tests cover the states; "every screen" is not asserted |

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

## Order of work

1. `CANONICAL_TRIP` + wire both consumers. Nothing else can start.
2. Preview DB → empty; `SUBSCRIPTION_TESTING` → preview.
3. Specs 4, 6, 12, 13 (`trip-list`) — cheapest, and they exercise the fixture.
4. Specs 14, 15, 16 (`trip-detail`, `fuel`) — the fixture's stops earn their keep.
5. Specs 2, 3 (`vehicles`), 9, 10 (`account`), 11 extension.
6. Spec 5 (`trip-edit`) — hardest of the deterministic ones.
7. Spec 17 (paywall, every screen).
8. Spec 7 (Penny) last, once the invariant helpers from 5 exist to reuse.
