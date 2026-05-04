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
