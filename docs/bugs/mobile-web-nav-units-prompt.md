# Claude Code prompt — items 8–12: mobile-web reload flash, navigation links, location toggle, units

Continues the campaign in `docs/bugs/onboarding-fix-prompt.md` (items 1–7). Same rules: **reproduce
each one in a real browser with the Playwright MCP before writing a fix.** The causes below come
from reading the source — confirm them on screen and say where I am wrong. Web/desktop-narrow is
where I found all of these; mirror to `mobile/` after web is right.

Two of these overturn decisions the code documents as deliberate (11 especially). Those are my
calls to make, and I have made them — but read the existing reasoning before you delete it, and
tell me if it says something I have not accounted for.

---

## 8. Reloading at phone width paints the desktop layout first, then swaps

**Observed:** load the trip page in a phone-width viewport (iPhone 14 Pro Max, 430×932 in
devtools), reload. The screen flashes a layout with visibly wrong proportions, then flashes again
into the real mobile layout. Fast enough that I cannot screenshot it, slow enough to be ugly on
every single load.

**What the source says:** `useMediaQuery` (`src/lib/useMediaQuery.ts:16-40`) always initialises
`matches` to `false` and only reads `window.matchMedia` in a `useEffect`. So the first client
render is `useViewport() === 'desktop'` for everyone, on every device. That was a correct fix for
a real problem — reading `matchMedia` in the `useState` initialiser caused hydration errors #425 /
#418 / #423 — and its comment argues the resulting flip is "sub-frame and invisible".

**That claim was true when it was written and is false now.** It reasons about `MobileFooter`,
which conditionally renders one small element (`MobileFooter.tsx:24-25`). `TripWorkspace` returns
an entirely different component tree per viewport (`src/app/trips/[tripId]/TripWorkspace.tsx:516`
for mobile, `:650` for tablet, desktop by fallthrough). So a phone paints the full desktop
two-pane workspace at 430px, then unmounts it and mounts the mobile tree. That is two whole trees
mounting, not a class toggle — visible, and expensive.

**Constraint on the fix:** do not solve it by reading `matchMedia` during render. That is the bug
that was fixed; reintroducing it trades a flash for hydration errors. Options worth weighing,
pick one and say why:

- Decide the layout in **CSS**, not JS: render one tree and let media queries lay it out. Truest
  fix, largest diff.
- A tiny **blocking inline script** in `layout.tsx` that stamps `data-viewport` on `<html>` before
  first paint, with the tree keyed off that. No hydration mismatch, because the server markup does
  not depend on it.
- **Server-side hint** (a `viewport` cookie, or the client hint headers) so SSR emits the right
  tree on a reload.

Also confirm whether the *second* flash is this same swap or a separate data-loading state — I saw
two and could only account for one.

Fix the stale comment in `useMediaQuery.ts` whichever way you go: it currently tells the next
reader the flicker is invisible.

## 9. First onboarding question as frame 7b, then plain chat with the Q&A visible

Design intent, not a defect — and it **amends item 4** of `onboarding-fix-prompt.md`.

- Onboarding **step 1 only** gets the 7b treatment: the `SETUP · 1 OF 4` progress line, the
  tappable prompt rows (`Paris to Stuttgart, 5 h days`, `Pyrenees loop with 3 rest days`) that
  prefill the composer, and the `Where to?` placeholder.
- After that, onboarding runs as **ordinary chat**: each question is a Penny bubble and each answer
  is a right-aligned user bubble, left in the transcript.

**This overrides the receipts bullet in item 4** of the other prompt, which asked for answered
steps to collapse to `Check` + one-line receipts per §7d of `docs/design/nocturne-reskin.md`. I
have changed my mind: I want to see the questions and the answers in the transcript. Update that
bullet in `onboarding-fix-prompt.md` in the same commit so the two documents do not disagree, and
note in `docs/design/nocturne-reskin.md` §7d that the receipts treatment is superseded — do not
silently leave the design doc saying the opposite of what shipped.

## 10. Navigation links open a map pin instead of starting the drive

**Observed:** the `NEXT STOP · Shell · fuel · 390 km` button at the bottom of the trip screen, and
the arrow on each row under `STOPS` inside a day, both open Google Maps on a **dropped pin** for
the coordinates. They should open **directions from my current location to that point, in
turn-by-turn**, which is what the `NAVIGATE (…)` buttons at the top of the day card already do.

**What the source says:** this is old hand-rolled code sitting beside a library that already does
it right. Two places build a *search* URL by hand:

- `src/components/Itinerary.tsx:418` — `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`
- `src/components/StopsSection.tsx:137-140` — a local `mapsHref()` with the identical string,
  used for the start row (`:164`), every stop row (`:178`) and the destination row (`:191`)

Meanwhile `src/lib/maps.ts` has `buildNavUrl` (`:33`), `buildLegDirectionsUrl` (`:159`) and
`buildSegmentedNavUrls` (`:255`) — the working builders the NAVIGATE buttons use, which emit
`/maps/dir/?api=1&destination=…&travelmode=driving&dir_action=navigate`.

**The fix is a swap, and the origin needs no work:** `buildNavUrl` omits `origin` entirely when no
start coords are passed (`maps.ts:48-50`), and Google Maps then routes from the device's current
location — exactly what I asked for. So `buildNavUrl({ end_lat: lat, end_lng: lng })` is the whole
change at both sites. Delete both hand-rolled builders; do not leave one behind "for the pin case".

**Also make the whole row a tap target.** In `StopsSection.tsx` the row is a `div` and only the
trailing arrow `<a>` (`:396-400`) is clickable, so the obvious thing to press — the `FUEL / Shell /
390 km` row itself — does nothing. The row should be the link. Keep the `×` remove control
separate and above it in the stacking order so removing a stop never navigates.

While you are there, check every other navigate affordance in the app against the same rule —
`buildSegmentedNavUrls` output is fine, anything hand-building a `/maps/search/` URL for a "go
here" action is not. §7g of `docs/design/nocturne-reskin.md` is explicit that navigation is an
external hand-off and must look like one.

## 11. Imperial users still get kilometres

**Observed:** switch to Imperial in Settings, open a trip. The headline meta line still reads
`~1,309 km · 4 days · 1 fuel`, and opening a day shows the fuel stop at `390 km`. Leg rows show
`652 km (405 mi)`.

**Two separate causes; both need fixing.**

**(a) Hardcoded km literals that never consult the preference.** Four sites, and
`src/components/Distance.tsx` is the component they should all be using — `StopCard.tsx:135` has a
comment describing this exact bug being fixed once already:

- `src/components/Itinerary.tsx:589` — the headline total (`~1,309 km`). This file already calls
  `useUnits()` at `:102`, so it had everything it needed.
- `src/components/Itinerary.tsx:748` — a group total, via `primaryOverride`
- `src/components/Itinerary.tsx:938` — the NEXT STOP distance
- `src/components/StopsSection.tsx:393` — the stop rows in an open day (my `390 km`). This file
  imports no units machinery at all.

**(b) A product decision I am reversing.** `Distance` and `formatKmDual`
(`src/lib/units.ts:53-68`) deliberately keep **km as the primary label even for imperial users** —
both say so in comments, framed as "we've decided to teach metric", with miles as a small
secondary. That is where `652 km (405 mi)` comes from, and it is working as designed.

I am changing that decision: **an imperial user sees miles, and no kilometres anywhere.** Change
it at the source — `formatKmDual` / `Distance` — rather than at the call sites, so it lands on
every distance in the app at once. `formatKm` (`units.ts:40-47`) already returns miles-only for
imperial and is probably the whole answer. Delete the "teach metric" comments; do not leave
reasoning behind that contradicts the behaviour. Check the trip-list cards, the map sheet, the
plan-summary card and the costs block in the same pass — anywhere a distance renders.

**Guard, and it should be structural:** after this, a hardcoded `km` string in a component is
always a bug. Add the cheapest thing that makes that class impossible to reintroduce — an ESLint
`no-restricted-syntax` rule against km/mi string literals in `src/components`, or a unit test that
scans the component tree for them. A test that merely checks these four sites is not the guard.

---

## 12. Location should be a toggle, and turning it on should raise the system prompt

**Observed:** Settings shows `Location`, the explainer, and a dot with the word `On` — a status
readout, not a control. I want a toggle: flip it on, and on iOS that fires the native
"Allow location" dialog.

**Where:** `src/components/LocationSection.tsx` (web) renders the dot + `On`/`Off` label at
`:56-69` and a separate `Turn on` button at `:70-79`, shown only when `enablePath === 'prompt'`.
`mobile/components/LocationSection.tsx` is the native counterpart. The permission plumbing is
already right and should not be rebuilt: `DeviceLocationProvider promptAllowed={false}` is
deliberate (`LocationSection.tsx:20-32`) — opening Settings must never raise the dialog by itself,
so the dialog fires only from the control the user pressed. Keep that; change the control, not the
plumbing.

**The honest problem with a toggle, which you have to solve rather than paper over:** neither iOS
nor a browser lets an app revoke its own location permission. A toggle implies both directions
work. So:

- **Off → On**: calls `request` and the system dialog appears. Straightforward, and it is what I
  asked for.
- **On → Off**: the app cannot do it. On iOS, hand the user to the Settings pane with
  `Linking.openSettings()` — `LegCard`'s `enablePath` branch already distinguishes "never asked"
  from "denied" and §7g of `docs/design/nocturne-reskin.md` says to wire exactly this. On web there
  is no equivalent API, and this file's own comment (`:8-16`) makes the case: a control that
  silently fails is worse than no control. So on web, an on-toggle that cannot be switched off
  needs a sentence saying where to change it, not a switch that snaps back.

If that means the web renders a switch and native renders a switch with a different off-path, fine
— say so in the comment. Do not ship a toggle that animates off and changes nothing.

---

## Tests

Same standard as the other prompt: no trimming for time.

- A units test that flips the preference to imperial and asserts **no `km`** renders on the trip
  screen, the open-day stops and the NEXT STOP row. Mutation-check it by restoring one hardcoded
  literal.
- A test that the NEXT STOP and stop-row hrefs are `/maps/dir/` URLs carrying `dir_action=navigate`
  and no `origin` — and that a click anywhere on a stop row (not just the arrow) follows it.
- For item 8, whatever you can assert without a real browser is weak; the real check is the
  Playwright MCP on a 430px viewport watching the reload, plus a screenshot before and after.
- For item 12, assert the toggle's on-path calls `request` and that the off-path on web does not
  claim to have revoked anything.
- Run the whole suite and report the real output.

## Report back

What you reproduced, where the cause differed from the above, the diff, the test output. Commit
when `tsc --noEmit` and `npm run test` pass — do not push, do not open a PR, do not merge.
