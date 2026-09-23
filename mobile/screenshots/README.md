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

Four shots, in the order §3 of `docs/design/app-store-listing.md` argues for.
The filenames carry that order, because App Store Connect uses upload order.
`05-settings` is out of the set and, since 2026-09-23, out of the flow too — see
Status.

| File | Screen | Why it is in the set |
|---|---|---|
| `01-trips.png` | Trips list | It is a real tool with real trips |
| `02-penny-chat.png` | Penny, after a real reply | The differentiator |
| `03-itinerary.png` | Day 1 expanded, fuel stops loaded | The product actually working |
| `04-map.png` | Route and stop markers | The visual anchor |

## The trip in them

The same canonical two legs the test flows use — **Paris → Strasbourg →
Stuttgart**, real coordinates and distances from `CANONICAL_TWO_LEGS` in
`src/server/repos/testSupport.ts` (but NO road geometry — see `04-map` under
Status) — seeded under names a
customer could read (`Paris to Stuttgart`, `The Hilux`, `Sam`) instead of
`E2E Fixture Trip`. Same graph, different labels; `ios-e2e-local.sh` passes the
three names to `scripts/ios-e2e-fixture.mjs`.

The account is a throwaway `playwright-…@e2e.feraltravels.com` fixture on the
LOCAL server and local database, never production. Its address must not
appear on a public store listing, which is why there is no Settings shot.
**Check none of the four shows it.**

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
pixels. These go on a public listing. Open all four.

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

**Regenerated 2026-09-23** on an iPhone 17 Pro Max simulator (iOS 26.5, Xcode
26.6, Maestro 2.10.0), 1320x2868, from `ec8986b` (origin/main at the time), with
the status bar pinned to 9:41 / full signal / full battery by the runner. The
2026-09-02 set it replaces was from `35d1757` and a light-themed app; 81 commits
have touched `mobile/` since.

The run needed one flow fix: the day row's label now carries the country
(`WED 7 OCT, Paris, France → Strasbourg, France, 489 km, …`), so
`.*Paris → Strasbourg.*` stopped matching and the flow died on the LIST step.
It is `.*Paris.*→ Strasbourg.*` now, read off the hierarchy dump.

| Image | Verdict (what the 2026-09-23 PNG actually shows) |
|---|---|
| `01-trips` | **Fine, still thin.** One card, "Paris to Stuttgart · 2 days · ~645 km", under a 07 Oct 2026 date rule, with "+ New trip" and "Edit trips". Two-thirds of the frame is empty. The screen also says "trips" three times (nav title, eyebrow, heading), which is the app's copy, not the flow's. Seeding more trips would sell better. |
| `02-penny-chat` | **Good.** A real reply to "How is the fuel looking on day one?": 489 km against the Hilux's 300 km range, both placed stops named with their distances (Reims ~147 km, near Saverne ~442 km), and "you'll need both". Specific and correct against what 03 shows. Her wording varies run to run, so re-read it on every regeneration. |
| `03-itinerary` | **Good.** Day 1 open, three stops on the timeline — Paris 0 km, fuel Reims Ids 147 km, fuel Station AVIA Saverne 442 km, Strasbourg 489 km — with a Google Maps button each, header "2 fuel". Still carries the "LOCATION OFF — OPEN SETTINGS" link (location is denied on purpose, see above). |
| `04-map` | **Usable, with a known flaw.** Tiles loaded (dark style, France to the Netherlands), both fuel markers, the three town markers and a "Next stop · fuel — Reims Ids" card. **The route is not a road line**: `CANONICAL_TWO_LEGS` seeds no `geometry`, so `TripMap` draws its dashed straight-line fallback, faint and nowhere near the fuel markers. The 2026-09-02 set had the same line. The fix is seeding a real LineString in `testSupport.ts`, which is outside this directory. |
| `05-settings` | **REMOVED from the set on 2026-09-02, and from the flow on 2026-09-23.** It showed the fixture's `playwright-…@e2e.feraltravels.com` address, twice, for two different reasons. Centring the 'Vehicle profile' heading did not push it off a 6.9" screen; centring the range stat did, until the copy-rule cleanup deleted two blurbs, the screen got shorter, and the address came back into frame. The workaround only held while the page was long. The step itself survived the removal, though, and the runner copies every PNG the flow takes, so each regeneration put the leaking image back in this directory. |

**Things seen on the way that are NOT in this set but will be again:**

- **Finn's stops vary between runs.** Two runs placed Reims + Saverne; the one
  in between placed a single Intermarché at Clermont-en-Argonne (233 km). Both
  are within range. The images follow whichever one it returns.
- **The map's next-stop button overflows on a long station name.** With
  "Intermarché station-service Clermont En Argonne" the navigate and
  external-link icons rendered OUTSIDE the card's edges. "Reims Ids" fits, so
  this set is clean, but the layout bug is in the app (`mobile/components/`),
  and a different Finn result would put it on the listing.

### Getting `05-settings` back

The screen is short and the address sits directly above the thing the image is
meant to be about, so no amount of scrolling separates them reliably — twice now
a crop that worked stopped working when something above it changed. Fix the
layout instead, in rough order of preference:

1. **Move "Signed in as" below the vehicle profile**, or mask the address. It is
   arguably the better Settings screen anyway: the first thing on it should not
   be your own email.
2. **Use the `Plan` card as image 5.** It is what an App Review reviewer is sent
   to find (`docs/design/ios-review-notes.md` §2) and it photographs cleanly —
   but it sells the subscription rather than the product, and the Danger zone
   sits right under it.
3. **Stay at four.** Which is what the set does today.

`trips/[tripId]` is FIXED (the back button reads "Back"), verified on device in
the regenerated set — `src/lib/routeLabels.test.ts` guards it now.
