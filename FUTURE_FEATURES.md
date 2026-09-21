# Future features

A working backlog of ideas that came up during development but were deliberately deferred. Add to it; don't be precious about it.

---

## In-the-field questions ("where should I eat tonight?")

**Status:** Deferred from the feasibility-check session.

**What:** Let users ask Penny location-aware questions while on the road — "where should I eat near here?", "any decent spots to camp tonight?", "where's the closest fuel?"

**Why deferred:** The codebase has no GPS or geolocation today (verified by grep — no `navigator.geolocation`, no current-location field anywhere). Building this means either:

1. **Browser geolocation path.** Add `navigator.geolocation.getCurrentPosition()` somewhere on the trip workspace. Store the result on the user session or pass it directly into PennyContext (`current_location: { lat, lng, accuracy_m, captured_at }`). Decide UX: ask once per session? Re-prompt periodically? Fall back gracefully when denied?
2. **Ask-the-user path.** Penny just asks "where are you right now?" in plain prose. The user types a place name, Penny geocodes via existing tooling. No browser permission, no new infrastructure — but slower UX and no accuracy guarantee.

Either path also probably wants a real place-search tool — Penny currently has no `search_places` tool, and her training knowledge has obvious freshness limits (she won't know if a restaurant closed last month). Without one she can suggest plausible names but can't guarantee they exist or are open.

**Scope expansion in `<scope>`:** The current SYSTEM_PROMPT scope block redirects most non-trip questions. Adding "where to eat/sleep/refuel/etc. while on the trip" needs a careful prompt edit so Penny doesn't start answering off-trip food questions in general. A rule like *"in-the-field logistics (food, sleep, fuel, water near current location) are in scope only when the user is mid-trip OR they explicitly tie the question to the current trip"* is roughly the right shape.

**Decision needed before building:**
- Browser geolocation vs ask-the-user (or both, with geolocation as default and asking as fallback)
- Add a place-search tool, or make Penny work from her training knowledge with a "verify before going" caveat
- How to gate scope expansion so it doesn't bleed into off-topic chat

---

## Unit selector (metric vs imperial)

**Status:** Deferred. Penny is currently hard-coded to km-only via the `<units>` block in SYSTEM_PROMPT. If a user uses imperial units, Penny responds with a one-line deadpan ("I don't know what a 'mile' is") and plans in km anyway.

**What:** Let users pick their preferred unit system per-vehicle or per-trip. Convert all displayed distances/temperatures/volumes accordingly.

**Sketch of the work:**
- New column `vehicle.units_preference: 'metric' | 'imperial'` (default `'metric'`).
- Surface in `PennyContext` so the system prompt can adapt at request time.
- Replace the hard `<units>` block with conditional rendering — when imperial is set, swap "km" for "miles", "L" for "gallons", "°C" for "°F" in Penny's response style.
- UI: convert displayed values in `Itinerary.tsx`, `LegCard.tsx`, fuel/cost panels. All internal storage stays metric — conversion is presentation-layer only.
- Settings UI for the toggle.

The reason this was deferred: it's a real feature, not a bug fix. Wanted to ship the km-only enforcement first and design the selector properly.

---

## Direction-of-travel + off-highway fuel filtering

**Status:** Deferred. The auto-fuel planner picks the closest gas station to each knot center along the route polyline. Today that's purely a haversine ranking — it doesn't know which side of the highway the station is on, whether it's actually accessible without an exit-and-re-enter detour, or whether the user has to cross oncoming traffic to reach it.

**What the user wants in the StopRow UI:** small "right side" and "off highway" check indicators next to each fuel candidate, so the dropdown can surface the candidate that's both off-highway *and* on the direction-of-travel side of the road. Alternates that fail either check still show, just unchecked, so the user can pick them on purpose if needed.

**Sketch of the work:**
- Compute the route's *bearing* at each fuel knot from the surrounding polyline points (already decoded in `src/server/fuel.ts`).
- For each Places result, compute its bearing from the knot center. The angular delta against route bearing classifies it: roughly aligned → "right side" if the cross product is on the correct hemisphere for the country's drive-side, otherwise "wrong side". (Drive-side comes from the country code returned by reverse-geocoding the leg, or a per-trip setting.)
- "Off highway" needs a separate signal — possibly the Places `primaryType` (`gas_station` is fine, `truck_stop` is great, anything inside `route` polygons is suspicious) plus a small distance check from the polyline (≥80 m off the centerline = likely an off-ramp station).
- Persist these flags on each `StopAlternative` row so the swap dropdown can render them without re-querying Google.
- Bias `findTopGasStations` ranking: prefer right-side + off-highway, but don't *exclude* others — the user might still want a wrong-side station near their actual stop point.

**Decision needed before building:**
- How to determine drive-side reliably (country reverse-geocode? per-trip setting? user profile?). Australia/UK/Japan/India are right-hand-drive; the rest of the world is left.
- Whether "off highway" needs its own Places query (e.g. truck_stop + amenity filters) or can be derived from existing nearby-search payloads.
- UI: paired tick-mark / cross icons inline with each station row, vs separate filter pills above the dropdown.

This was deferred because the immediate pain (one fuel station per knot, no way to swap) was solved by Feature B (top-3 candidates with a swap dropdown). Adding directional bias is a refinement on the same dropdown; it doesn't unlock new behavior, just better defaults.

---

## Order the OTA after the production deploy

**Status:** Open. A known race in the live pipeline, not yet scheduled.

**The race:** a merge to `main` that touches `mobile/**` starts two workflows from the same push, and nothing orders them:

- `.github/workflows/mobile.yml` triggers on push to `main` for `mobile/**`. When the diff is JS-only it publishes with `eas update`, which its own header says reaches testers "on next launch, in seconds".
- `.github/workflows/deploy-production.yml` triggers on push to `main` for everything, then migrates the database and runs the Vercel production build and deploy.

There is no `needs:`, no `workflow_run`, and no shared concurrency group between them, so both start at once. The OTA routinely finishes before the Vercel build does. For a merge that changes both the app's JS and the API, a phone can run the new app code against the old API for as long as that build takes. If the deploy fails, that can last until the next successful deploy.

**Why it is still open:** closing this race is what the one-pipeline consolidation was drafted for (`pipeline.yml.new` and `mobile-workflow.new.yml`, in history at 960a73c). Those drafts never ran. They were deleted in 4ec95a8 and stay deleted, and deleting them did not fix the race. `docs/design/deploy-pipeline.md` already states it under "Mobile releases self-start on the same merge"; this entry keeps it on the backlog.
