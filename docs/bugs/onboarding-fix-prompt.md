# Claude Code prompt — six defects: onboarding, paste row, vanishing fuel stop

> Items 8–12 continue in `docs/bugs/mobile-web-nav-units-prompt.md`. Item 9 there amends item 4
> here (no receipts). Read both before starting the onboarding layout work.

Seven items. Six were found on the desktop web build — three onboarding defects (1–3), the
onboarding layout against the Nocturne design (4), the day card's paste row (5), and a fuel
stop that disappears when Penny edits a leg's destination (6). The seventh is a CI tidy-up (7).
Fix all of them.

**Before writing a single line of fix: reproduce every item in a real browser with the
Playwright MCP.** For 1–4 use a first-run account — `createOnboardingTrip` in
`e2e/fixtures/test-trip.ts`, not `seedCanonicalFixture`, because a seeded complete vehicle
skips the vehicle step entirely. For 5 and 6 you need a planned multi-hundred-km leg with a
fuel stop on it, so run the flow through to a plan first. There is no PR for this work yet, so
reproduce against local dev; once the PR is open, re-verify on its preview URL (a cold
production build is where the layout and hydration behaviour actually shows).

The causes below come from *reading* the source, not from watching it fail. Confirm each one on
screen and tell me where I'm wrong.

**Order:** 1 first — it blocks the flow, and 2–4 cannot be exercised end to end until a chip
tap works. 5 is a deletion and independent. 6 is the one with an unknown cause; give it the
time that needs rather than shipping a guess with the rest. 7 is a workflow edit that touches
no app code — do it whenever, in its own commit.

---

## 1. Chip taps are dead on a `chips` step

**Observed:** step 2 (`trip_date`, "When are you setting off?") — tapping `Next Saturday`,
`In a month` or `Not sure yet` does nothing at all.

**What the source says:** `src/components/ChatPanel.tsx:2446-2448` renders the chip row when
`kind === 'select' || kind === 'chips'`, but `submitOnboardingPick` bails one line in —
`src/components/ChatPanel.tsx:1575`, `if (q.kind !== 'select') return;`. `trip_date` is
`kind: 'chips'` (`src/server/onboarding.ts:160`). Commit `d84a9b9` fixed the *typed* half of
this same split; the tap half was never fixed.

Identical bug on native: `mobile/components/ChatPanel.tsx:1191`. Fix both surfaces.

**Structural guard, not a patch:** do not simply add `'chips'` to the comparison — this shape
has already drifted once. Export one constant (or discriminated type) naming the kinds that
are answered by tapping, and have both the renderer and the handler read it, on web and on
native. A future kind must not be able to render chips no handler will accept.

## 2. Origin is never asked, and the trip never gets planned

**Observed:** answer `annecy france` → the wizard runs to the end → the handoff fires → Penny
replies *"Looks like you're heading to Annecy, France! Where are you starting from?"* and
plans nothing.

**Wanted:** when the opening message does not state a start location, ask for it as the step
**immediately after `trip_intent`**, before the date. When it does state one
("Paris to Stuttgart"), skip the step.

**Prefill it from the device location and ask for confirmation, the way iOS does** — the
question is `Are you leaving from Girona?` with that as the accented chip, not an empty text
box. The data is already stored: `POST /api/trips/[id]/position` writes
`trips.last_known_lat/lng` and `last_known_place`
(`src/app/api/trips/[id]/position/route.ts`), fed by `DeviceLocationContext` +
`lib/reverseGeocode.ts` on web and `useDeviceLocation` (`mobile/lib/location.ts`) on native, and
`buildPennyContext` already projects it as `device_location`. So the server can build this
question with the stored place as its `defaultValue` and needs nothing new from the client.

**Confirm, never assume** — same rule the exact-vs-vague start date follows. Where the driver
is standing right now is not necessarily where the trip starts (planning a trip from home for a
van parked elsewhere is ordinary), so the location fills the chip and the driver taps it; it is
never applied silently. Degrade honestly: permission denied, unresolved, or no stored position
→ ask the plain question with no chip. Never block the step on the lookup. This shares its
source with 7b's location-seeded composer placeholder (`{city} to …`, falling back to
`Where to?`) — build one resolver, use it in both places.

**Where:** `scanFirstMessage`'s `SCAN_TOOL` (`src/server/onboardingIntentScan.ts:46-74`)
carries only `start_date_phrase` and `range_km` — there is no origin field, so nothing
downstream can know. That module's header comment documents the extension path: nullable
field on the tool schema → validated mapping into `OnboardingScanResult` → wire the question.
Then add the state in `src/server/onboarding.ts` beside `trip_date`; the branch that decides
what comes after intent is `if (state === 'trip_intent' && input.questionKey === 'trip_intent')`
at ~`:824`, where `patch.onboardingState` is set. Origin is not safety-critical the way fuel
range is, so a clearly stated origin can be applied without a confirm step — mirror the
exact-start-date branch directly above it.

Progress totals move with this. Check `preVehicleSteps` at `src/server/onboarding.ts:535`
and `:574` and keep the counter honest on both the units-already-chosen and first-run paths.

## 3. The range question's answer bubble shows the trip intent

**Observed:** under *"What's your driving range on a tank, in kilometers?"* the user bubble
reads `annecy france`.

**What the source says:** that bubble is not an answer — it is the handoff.
`src/components/ChatPanel.tsx:1476-1482` calls `sendChatMessage(result.tripIntent …)`, and
`sendChatMessage` (`:1055`) pushes an optimistic **user** bubble for whatever it is handed. So
the stored intent is replayed into the transcript as if the driver had just typed it, landing
directly under the last question. The same branch also never appends `result.answerLabel`, so
the driver's actual final answer never renders at all — the non-handoff branch does it at
`:1487-1499`.

**Wanted:** the handoff turn reaches Penny without rendering a user bubble for the intent, and
the final onboarding answer gets its receipt like every other step. Keep the
`insertPlanningMedia` dog-clip behaviour exactly as it is — that one is intentional.

## 4. Onboarding layout does not match the design

Spec: `docs/design/nocturne-reskin.md` §7b–7e (declared high-fidelity — colours, sizes,
spacing, radii and copy are final; use tokens, never hard-coded values) and turn 7 of
`Trip Plan.dc.html`. Deltas on the desktop build today:

- Chips sit in a strip **below** the transcript under a `SETUP · 2 OF 5` eyebrow
  (`ChatPanel.tsx:2410-2423`). Design: chips live **inside Penny's bubble**; the step counter
  and a 2px accent progress bar (soft glow) live in the header.
- Counter reads 5 steps; design is 4. `totalSteps` at `src/server/onboarding.ts:591-592` still
  counts both `buildVehicleProfileQuestions` entries even though `buildVehicleSetupQuestion`
  (frame 7e) answers them in one card.
- `trip_date` is missing the accented `MagicWand` chip built from `Question.defaultValue` and
  the `Pick a date` / `CalendarBlank` chip. `defaultValue` is currently spent prefilling the
  composer instead (`ChatPanel.tsx:617-619`) — per the design it should be the tappable
  confirm chip, with the footnote beneath it.
- ~~Answered steps remain full Q&A bubbles; the design collapses them to `Check` + one-line
  receipts.~~ **SUPERSEDED — do not build the receipts.** See item 9 in
  `docs/bugs/mobile-web-nav-units-prompt.md`: only step 1 gets the 7b treatment, and every
  question and answer after it stays in the transcript as ordinary chat bubbles. Mark §7d of
  `docs/design/nocturne-reskin.md` superseded on this point rather than leaving the design doc
  contradicting what ships.
- 7b's `TAP TO START, THEN EDIT` prompt rows and the location-seeded composer placeholder
  (`{city} to …`, falling back to `Where to?`) are absent.

Web first — that is where I am testing — then mirror on native.

---

## 5. Pasting a Maps link into a day card 500s — remove the row

**Observed:** in an expanded day, `Paste GPS or a Maps link` → paste
`https://maps.app.goo.gl/E9VYBkjCT1cgCBbt8` → Add → inline red Zod error, then the global
error modal:

```
[ { "received": "google_maps", "code": "invalid_enum_value",
    "options": [ "penny", "user", "google_places", "google", "manual" ],
    "path": [ "source" ],
    "message": "Invalid enum value. Expected 'penny' | 'user' | 'google_places' | 'google' | 'manual', received 'google_maps'" } ]
```

**What the source says:** two different vocabularies both called `source` collide.
`resolveCoordsFromInput` returns *where the coordinates came from* — `'google_maps'`
(`src/lib/coordsResolve.ts:169`, `:207`, `:216`, `:281`) — while `stops.source` records *who
authored the stop*, validated against `['penny','user','google_places','google','manual']`
(`src/app/api/stops/route.ts:21`). The paste flow forwards the first into the second at
`src/components/stops/useStopActions.ts:137`, `source: coords.source ?? 'user'`. A bare
lat/lng paste carries no `source`, falls back to `'user'` and works — which is why only Maps
links break, and why nothing caught it.

**What I want, for now:** delete the paste affordance entirely — the toggle row, the input,
the Add button and the hook's paste state — on web (`src/components/StopsSection.tsx:536` and
`src/components/stops/useStopActions.ts`) and native
(`mobile/components/StopsSection.tsx:390`). Take the dead code with it rather than hiding it
behind a flag. Update `CLAUDE.md` (the `StopsSection` / `PASTE GPS` references and the §7g
line in `docs/design/nocturne-reskin.md`) in the same commit.

**What must keep working, and must be proven:** pasting a Maps link **in chat**. That path
does not go through `/api/stops` — `resolveMapsLinksInMessage` (`src/lib/claude.ts:25-28`)
resolves the link into context and Penny writes the stop through `add_stop`, whose `source`
comes from her own tool enum (`src/lib/penny/tools/addStop.ts:191`). Confirm in the browser
with that same short link that it still resolves and lands as an `other` stop, and add an e2e
spec covering it — that is now the only paste path in the product, so it needs the coverage
the row's removal frees up.

---

## 6. Changing a leg's destination silently deletes its fuel stop and nothing re-sources it

**Observed:** day 1 was `Girona → Annecy`, 652 km, with a fuel stop at `Intermarché
station-service Moirans` (523 km). I pasted a Maps link in chat and told Penny to end the day
there instead. She applied it — and the fuel stop is gone. The expanded day now reads
`NAVIGATE (1 STOP)` and `No stops yet — fuel stops appear here automatically`, with no
planning spinner, and it stays that way. A 652 km day against the saved range needs a stop, so
this is not "Finn decided none was needed".

**Where to look — and do not pick one of these from reading, prove it:**

- The delete is deliberate. `update_leg` with changed coords calls `invalidateLegFuelCache`
  (`src/app/api/trip/replan/route.ts:1237-1239`), which drops the auto option stops and sets
  `fuel_status = 'none'` (`src/server/fuel.ts:422-425`). Continuity repair does the same for
  every leg it re-chains (`route.ts:701`). That is correct — the old plan was computed for a
  route that no longer exists.
- The re-source is what is missing. `LegCard`'s lazy effect
  (`src/components/LegCard.tsx:199-262`) *should* fire again: `needsFetch` includes
  `fuel_status === 'none'` and the signature folds the status in, so `ready:<ts>` →
  `none:none` ought to trigger a fetch on the reload that follows the turn. It plainly did
  not. Find out which of these is true by watching it happen and by reading the row:
  `fuel_status` and `fuel_stops_updated_at` on that leg after the turn; whether the leg id
  survived `rebuildTripSchedule` or the card remounted; whether the fetch fired and Finn
  returned zero; whether `expanded` / `isPast` short-circuited it. Build a read-only `postgres`
  client the way `scripts/lifetime-spend.ts` does — do not import
  `src/server/db/client.ts`, it is `server-only` and throws under `tsx`.

**Beyond the mechanism, the behaviour is wrong on its own terms.** "Re-sources lazily on next
open" is the right rule for a day the driver is not looking at. This day was open on screen.
An invalidation that empties a visible day must re-source it immediately and show the existing
`Planning fuel stops…` spinner while it does — going from a planned stop to `No stops yet`
with no motion reads as data loss, and on a 652 km leg it is a safety number quietly
disappearing. Make the open-day case re-source without waiting for a collapse/expand cycle.

**Guard:** a test that a leg with a planned fuel stop, whose end coords are then changed
through the replan path, ends up with fuel stops again rather than an empty list — the
structural version, not an assertion that `invalidateLegFuelCache` was called. Mutation-check
it.

---

## 7. Stop pinning the preview URL into the PR description

The preview block is published in two places by `Publish the preview URL on the PR`
(`.github/workflows/ci.yml:359-425`): a sticky comment, and a pinned block prepended to the PR
**description**. Drop the second one — the URL changes on every push, so a link sitting in the
description is a value that goes stale in the one place a reader assumes is authoritative,
while the comment is already deleted-and-reposted each run so it is always current and always
at the bottom of the thread where you are reading.

Remove the "2. Pinned block at the top of the PR description" half (`ci.yml:411-425`) and the
part of the comment above it (`:355-358`) that describes it. Keep the sticky comment and its
delete-and-repost reasoning exactly as they are.

This is for FUTURE PRs only — no self-heal, no back-fill. A description that already carries
the block keeps it; I'll clear PR #23's by hand if it bothers me. Delete the code, including
the now-unused `marker` / `endMarker` region regex if nothing else uses it.

Check whether `CLAUDE.md`'s deploy-pipeline section describes the pinned block; if it does,
update it in the same commit.

---

## Tests

Reliability is worth the CI minutes; do not trim coverage or narrow scope to save time.

- Cover the chat Maps-link path end to end (see item 5) — it is now the only one.
- Cover the destination-change-keeps-fuel case (see item 6).
- Extend `e2e/onboarding-flow.spec.ts`: a chip tap advances the date step (red today); a
  first-run intent with no origin is asked for one *before* the date; an intent naming both
  ends skips that step; the handoff renders no user bubble carrying the intent text and does
  render a receipt for the final answer.
- **Mutation-check every new test**: reintroduce the exact bug, watch it go red, restore.
  Name which tests you checked this way.
- Run the whole suite, not only what you touched, and report the real output.

## Report back

What you reproduced in the browser, the actual cause of each item where it differs from the
above, the diff, and the test results.

Commit the finished work once `tsc --noEmit` and `npm run test` pass — scoped commits, one per
item where they are separable, and update `CLAUDE.md` in the same commit as any structural
change it documents. Do not push, do not open the PR, do not merge: I do that.
