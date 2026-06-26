# Task brief: Penny captures the "comfortable range" gold number

**Status:** Proposed
**Date:** 2026-06-26
**Owner:** Penny / onboarding (separate task from Finn)
**Pairs with:** `docs/design/finn-fuel-agent.md` — Finn *consumes* this number; he never derives it.

> **One sentence:** Penny's job is to produce **one validated machine number — the driver's comfortable driving range between fills (km, stored)** — and keep it current as the trip unfolds. That number is Finn's gold; everything he plans hangs off it.

## Why this is its own task

Finn does fuel *math*. Penny does the *conversation* that produces Finn's single most important input. Mixing them violates the seam: Finn must receive an already-resolved number, never interpret free text (same lockdown rule as `start_date_parsed` — see `parseStartDate.ts`). This task owns the capture, validation, persistence, and live-update of that number. It does **not** find stations.

**Why split it out now:** Penny used to handle the fuel logic end-to-end, and that sprawl is a big part of why the planner drifted into weird states — fuel state leaked across the chat boundary and got re-interpreted. The fix is a hard handoff: **Penny produces a perfect, validated number and stops there; Finn starts from that number and owns everything after it.** The only thing crossing the boundary is structured data.

## What the number is (and what it is NOT)

The gold number is the user's **comfortable range** — how far *they* are happy to drive on a tank before refuelling — **not** the vehicle's technical maximum.

> Sam's Hilux: technical range ~650 km on an 80 L tank; the gauge reads zero at ~60 L used but there's still ~20 L / ~100 km of reserve. Sam's *comfortable* number is **500 km** — he'll stretch to 550 even with the needle on empty, because he knows the truck. That lived-in "500" is what we want, reserve already baked in by the human who knows their rig.

**Critical consequence — do not double-count the reserve.** Because the user's number already includes their mental reserve, Finn must use it **as-is**. Today `computeEffectiveRangeKm(refill_distance_km)` appears to shave a further ~20% off. If the gold number is "comfortable," that second haircut makes every plan too conservative (a 500 km comfortable range becomes a 400 km planning range and Finn nags for fuel too early). **Decision for this task:** the stored number is the comfortable/usable range; Finn subtracts only `kmBurnedSinceLastRefuel`, no extra reserve. Reconcile/retire the double-reserve in `computeEffectiveRangeKm`.

## Grounding in what already exists

This is **not** a greenfield field. `src/lib/vehicleProfile.ts` already has:

- `refill_distance_km` — *"How far between fuel stops?"* with help text *"how far you like to drive on a tank before refueling… regardless of your tank's actual capacity."* **That is already the gold number.** This task refines its *framing, validation conversation, and live updates* — it does not invent a new column.
- Bounds: `FUEL_STOP_SPACING_KM_MIN = 200`, `FUEL_STOP_SPACING_KM_MAX = 1500`. Keep as the validation guardrails.
- Unit handling: imperial users enter miles; stored as km. Keep.

So the deliverable is mostly: (1) sharpen Penny's onboarding conversation around it, (2) the live-update path, (3) the reserve-double-count fix, (4) re-add fuel type (below).

## Penny's onboarding conversation

1. **Explain the concept in plain terms** — "your *happy* range, not the max; include whatever cushion you keep in your head." Offer the Hilux-style example so the user calibrates to "comfortable," not "until I'm stranded."
2. **Capture the number** (km or mi per their units).
3. **Validate deterministically** against `FUEL_STOP_SPACING_KM_MIN/MAX`; if out of range, Penny re-asks rather than storing junk.
4. **Confirm back** — "Got it, I'll plan a fill roughly every 500 km, and I'll never route you past it." Pair with the existing full-tank-at-start statement.
5. **Lockdown:** the conversation is converted to the number via a forced tool/schema (the `record_parsed_date` / `coerceVehicleProfileValue` pattern), re-validated server-side, and only the validated integer is persisted. Penny never free-types the value into the DB.

## Also capture: fuel type (re-add — it was removed)

Finn's **fuel-type-match math** needs to know what the vehicle burns (diesel / petrol+octane / LPG / + AdBlue for many diesels) to match against OSM `fuel:*` tags. `fuel.ts` notes fuel type *was removed from the vehicle profile in migration 0007*. **Re-add a `fuel_type` field** to the vehicle profile and have Penny capture it in onboarding. Without it, Finn can't guarantee "this station actually sells your fuel," which is a real failure mode (a petrol-only station is useless to a diesel Hilux).

## Keeping the number current (live updates + GPS)

The gold number and the *current tank state* drift on the road; the plan must adapt:

- **Display the live figure** in the trip UI: *"Comfortable range: 500 km"* (mi for imperial). Next to it, an **edit affordance** so the user can update it mid-trip ("actually I'm comfortable to 550 today" / "I just filled up" / "tank's at half"). Updating re-runs Finn's math for the *next* stop only (forward-only, like the existing fuel replan).
- **Tank-state override** belongs per-trip: `trips.start_fuel_fraction` (default 1.0) for the start, plus the `reportPosition`-style "I filled here / I'm at X" updates that already anchor progress.
- **GPS reconciliation (future, design now):** we compute an *expected* remaining range from the plan; with GPS we know the *actual* position/elapsed distance. When they diverge beyond a threshold, **put the ball in the user's court** — surface "you've gone further/less than planned — update your tank level?" rather than silently trusting either source. The user owns the truth; we prompt, we don't assume.

### Known bug to fold in (not this task's core, but adjacent)

The existing GPS prompt **fires at the wrong time — on list load instead of initial page load.** Likely a web-lifecycle issue (will differ on the coming iOS/Android native apps). Capture as a follow-up: move the prompt to initial page load, and revisit when native lands. *Flagged here so it isn't lost; fix tracked separately.*

## Out of scope

Finding stations, pricing, ranking, gap alarms — all Finn (`finn-fuel-agent.md`). This task ends at "a current, validated comfortable-range number + fuel type + tank state, exposed cleanly to Finn."

## Action items

1. [ ] Confirm the gold number = comfortable range used **as-is** (retire the double-reserve in `computeEffectiveRangeKm`).
2. [ ] Sharpen Penny's onboarding script + validation around `refill_distance_km`.
3. [ ] Re-add `fuel_type` to the vehicle profile + onboarding capture.
4. [ ] Add the live "comfortable range" display + edit affordance; wire forward-only re-plan on change.
5. [ ] Add `trips.start_fuel_fraction`; per-trip starting-tank override.
6. [ ] Design GPS reconciliation prompt; fix the prompt-timing bug (initial page load).
