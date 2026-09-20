# MVP scope — hold the line

> Moved out of `CLAUDE.md` on 2026-09-20, verbatim, when that file was cut from
> 225 KB back to a map. Nothing here was rewritten or deleted — only relocated.
> `CLAUDE.md` links here from the one-line summary that replaced it.

## MVP scope — current focus (hold the line)

> **Status (2026-06-26):** Deliberately scoping *down* to a small MVP that works perfectly, then shipping to production. Sam asked me to hold him to this. If a request adds scope beyond what's below, flag it as post-MVP **before** building — don't quietly re-expand the surface area.

**What the MVP is:** the user says where they want to go → the app builds a day-by-day plan (how far they drive each day) → it finds gas stations along the route within the vehicle's range. That's the whole product for v1.

**Stops — exactly two types (this is the line; hold it).** (1) **`fuel`** — gas stops Finn finds automatically along the route. (2) **`other`** — a place the user *explicitly* adds: they drop in a Google Maps link, an address, or a place name (the three inputs Penny's welcome message invites). These are the "user-added" stops; selected ones force the route through that point. Penny does **NOT** proactively find overnight spots, campgrounds, parks, groceries, or any other amenity — that auto-discovery is a post-MVP "leader" feature to be rebuilt properly later. `StopType` is `'fuel' | 'other'` and nothing else.

**Future architecture — per-stop-type finder services (NOT now):** Penny is the conductor, not the search engine. Today there is exactly one finder service — **Finn (fuel)** — and Penny only triggers Finn; for anything else she declines and asks the user to paste a Maps link. Each future stop type (groceries, overnight, stores, etc.) becomes its **own tuned algorithmic service** that owns its `StopType`, not new Penny smarts. The seam is already in place: `StopType` is the extension point, and `add_stop` is locked so Penny can only author `other` (fuel rows come exclusively from Finn). Adding a new finder later = new type + its own server-side service, plus Penny learning to call it. Don't build these now; don't let Penny fake them.

**Value thesis:** the app earns its keep *on the trip*, not just in pre-planning. The plan is a moving, day-by-day thing the user adapts as reality changes ("we stopped early", "we're actually going here instead"). Build for adaptability, not a static itinerary.

**In for MVP:** accounts/auth · vehicle setup (needed for range math) · the day-by-day plan · the **progress anchor** ("which day am I on / I'm here now" — keep this, it powers the adaptive view) · **Penny chat as the way to edit the plan** · lazy gas-stop planning (skeleton built eagerly; the per-day fuel-stop search is **lazy-loaded when the user opens that day** — no explicit button — and results are cached with a timestamp, so a stale cache triggers a cheap price re-check rather than a full re-search). **BUILT 2026-06-26 (migration 0013)** — see the "Lazy fuel sourcing" note under Schema below for what shipped (the cheap stale re-check awaits Finn's pricing task).

**Cut now (half-built / out of scope):** nightly replan · proactive emails · cron jobs · overnight-stop finder · the `draft/active/completed` trip **lifecycle** (keep the progress anchor, which is a different thing). Removing these should also kill a chunk of current bug surface.

**Fuel pricing + stop-finding is a SEPARATE task/agent.** "The right price" is **not** in this slice. This app only exposes the interface a dedicated fuel-stop + pricing agent plugs into; that agent is built in its own task (it needs region-specific price-data research — EU has open price feeds, the US does not).

**Finn fuel-stop contract (interface only for MVP — algorithm is Finn's own task, do NOT build now):** the app captures ONE range number per vehicle and hands it to Finn; how Finn *uses* it is out of this slice.

- `range_km` — the vehicle's fuel range (the single range metric since 2026-08-25; the old comfortable/hard-max pair is gone — see the "Single fuel range" note under Schema). Finn's stop logic must be "don't run dry before the next reachable station," **not** "stop every range_km." The greedy "only stop when you can't reach the next station, and pick the best station in range" approach is what prevents the redundant fill-up-then-fill-up-again-100km-later annoyance. Distance-interval stopping is the wrong model. It also catches the "passed the last station before a 250km void and ran out" failure: the trigger is "next fuel is X km away and X exceeds safe remaining range → top up **here** even though you're not low," not distance driven.
- **Forced-stop reason is mandatory.** When geography forces a top-up the driver wouldn't otherwise make (e.g. stations at 100/200km then a 250km void → must top up at 200), Finn must NOT try to engineer the stop away — it's physics. Finn MUST attach a one-line reason ("next fuel is 250km away"). A forced stop *with* a reason feels smart; without one it feels broken. This reason string is the cheapest fix for the confusion and is a first-class requirement, not a nicety.
- **MVP stance:** store the one number, Finn treats it as a never-exceed ceiling, ship. The long-gap edge (e.g. far-north Norway, Australian outback — real: routine 200–400km gaps) is a documented known limitation leaning on driver intelligence ("trust but verify"); don't pull the routing algorithm into the MVP to chase it.

**Assumption:** full tank at trip start unless the user says otherwise; Penny states this at the end of onboarding.

**Process:** ship → market → real feedback → iterate agile. Resist re-expanding scope from inside Sam's head.
