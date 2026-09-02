# App Store screenshots

Generated, not taken. `scripts/ios-e2e-local.sh screenshots` walks a seeded trip
on a pinned simulator and writes the set into `mobile/screenshots/<size>/`.

```bash
scripts/ios-e2e-local.sh screenshots        # 6.9-inch, the only required slot
scripts/ios-e2e-local.sh screenshots 6.5    # the optional alternative slot
```

The images are committed. A screenshot nobody can regenerate is a screenshot
that quietly describes last release's app, and the thing it replaces — Cmd-S
into `~/Desktop`, five times — leaves five PNGs with no record of which build,
which account or which trip produced them.

## What is in the set

Five shots, in the order §3 of `docs/design/app-store-listing.md` argues for.
The filenames carry that order, because App Store Connect uses upload order.

| File | Screen | Why it is in the set |
|---|---|---|
| `01-trips.png` | Trips list | It is a real tool with real trips |
| `02-penny-chat.png` | Penny, after a real reply | The differentiator |
| `03-itinerary.png` | Day 1 expanded, fuel stops loaded | The product actually working |
| `04-map.png` | Route and stop markers | The visual anchor |
| `05-settings.png` | Vehicle profile | The fuel maths is yours to set |

## The trip in them

The same canonical two legs the test flows use — **Paris → Strasbourg →
Stuttgart**, real coordinates and real road geometry from
`CANONICAL_TWO_LEGS` in `src/server/repos/testSupport.ts` — seeded under names a
customer could read (`Paris to Stuttgart`, `The Hilux`, `Sam`) instead of
`E2E Fixture Trip`. Same graph, different labels; `ios-e2e-local.sh` passes the
three names to `scripts/ios-e2e-fixture.mjs`.

The account is a throwaway `playwright-…@e2e.feraltravels.com` fixture on the
LOCAL server and local database, never production. Its address is why
`05-settings.png` is scrolled with the vehicle card centred: that pushes the
"Signed in as" row off the top, and a fixture address must not appear on a
public store listing. **Check it did.**

## Sizes, and the correction that made this necessary

Only the **6.9-inch** iPhone slot is required — `app.config.js` sets
`supportsTablet: false`, so there is no iPad slot at all, and Apple scales the
6.9" set down for every smaller iPhone.

§3 of the listing doc says to capture "1290 x 2796 from the iPhone 17 Pro
simulator". **Those two do not go together.** The iPhone 17 Pro is the 6.3"
device at 1206x2622; the 6.9" slot needs a Pro Max or a Plus. Following that
instruction produces a set App Store Connect refuses. `scripts/pick-screenshot-simulator.mjs`
holds the device list per slot and the dimensions each one must produce, and
`ios-e2e-local.sh` measures every PNG with `sips` before keeping it — a set that
is silently the wrong size is otherwise something you discover at upload.

## What is NOT automated

**Looking at them.** Nothing in the pipeline can tell a map that loaded its
tiles from a grey rectangle where a map should be; both are the same number of
pixels. These go on a public listing. Open all five.

Two things to look at in particular on the first run:

- **`03-itinerary.png` may read "LOCATION OFF — TAP TO TURN ON"** in the
  navigate block. Location is denied on purpose: granting it makes the app
  report a position, and `report_position` RE-ANCHORS the trip to wherever the
  simulator thinks it is — Cupertino, unless told otherwise — so a Paris trip
  would quietly become a Californian one. If you want the GPS-on look, put the
  simulator on the route first (`xcrun simctl location <udid> set 48.5734,7.7521`
  is Strasbourg) and change the permission in `screenshots.yaml`, knowing it
  moves the trip.
- **`02-penny-chat.png` is a real Penny reply**, spending one Anthropic call.
  Read what she actually said. The flow waits for her to finish; it cannot
  judge whether the answer is worth showing anybody.

## Status

**It runs and it passes** (2026-09-02, iPhone 17 Pro Max, 1320x2868). Its first
run was a bring-up exactly as predicted — `docs/design/ios-e2e-bringup.md` has
the two findings, neither of them a typo in a selector.

**And then three of the five images turned out not to be shippable**, which is
the entire argument for this directory existing. Two are fixed; one still needs
a decision.

| Image | Verdict |
|---|---|
| `01-trips` | Honest but thin — one trip card and a lot of empty cream. Seeding a second and third trip would sell better. |
| `02-penny-chat` | **Good.** A real, specific answer: day 1 measured against the vehicle's range, a recommendation, and an offer to place a stop. |
| `03-itinerary` | **Was wrong, now good.** It read *"No fuel stop needed on this day"* — day 1 is 489 km and the fixture range was 500, so Finn correctly placed nothing, and the slot meant to show the product working showed it idle. `seedCanonicalFixture` now takes an optional `rangeKm` and the runner seeds 300, so the same leg genuinely needs stops: Reims at 147 km and Station AVIA Saverne at 442 km, with their routing buttons. Still carries a "LOCATION OFF — OPEN SETTINGS" line (see below). |
| `04-map` | **Intermittent, not broken.** The first run produced a blank grid with a route line on it — Apple Maps tiles had not loaded on a freshly booted simulator. A later run on the same warmed simulator rendered France and Germany properly, with the route and both gold fuel markers. **If it comes out blank, re-run it**; nothing in the flow can tell the two apart. |
| `05-settings` | **Still needs a decision.** The fixture's `playwright-…@e2e.feraltravels.com` address WAS plainly visible — centring the 'Vehicle profile' heading did not push it off a 6.9" screen. Centring the range stat instead removes it, but overshoots: the vehicle card is clipped at the top and the red **Delete account** panel dominates the frame, which is not what a store listing leads with. It also exposed a real app bug — the back button reads `trips/[tripId]`, a raw Expo Router route pattern. |

### `05-settings` — the options

The screen is short, so the address and the vehicle card are hard to separate by
scrolling alone. In rough order of preference:

1. **Fix the layout** — move "Signed in as" below the vehicle profile, or mask
   the address. It is arguably the better Settings screen anyway.
2. **Take the shot from a different account** whose address is presentable.
   `--user-name` already flows through; the ADDRESS does not, and it is a
   fixture pattern for good reasons.
3. **Use the `Plan` card as image 5 instead.** It is what an App Review reviewer
   is sent to find (`docs/design/ios-review-notes.md` §2) and it photographs
   cleanly — but it sells the subscription rather than the product.
4. **Drop to four images.** Three to five is the accepted range.

Fix `trips/[tripId]` regardless. It is visible to every user who opens Settings
from inside a trip, not just to a screenshot.
