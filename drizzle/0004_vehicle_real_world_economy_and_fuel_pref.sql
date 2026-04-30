-- Two related vehicle additions, both about how the fuel-stop planner
-- actually behaves on a trip:
--
-- 1. `real_world_kmpl` — overlanders rarely hit spec fuel economy. Loaded
--    truck, roof rack, headwinds, mountain grades; "12 km/L Hilux" pulls
--    9–10 km/L in practice. Letting users record their actual observed
--    economy (alongside the spec they entered first) keeps both numbers
--    visible without one hiding the other behind a fudge factor.
--
--    `effective_range_km` (computed in TS) prefers `real_world_kmpl` when
--    set, otherwise falls back to `fuel_economy_kmpl`. The 20% reserve
--    buffer still applies on top — running on fumes is dangerous regardless
--    of which economy figure you trust.
--
-- 2. `fuel_timing_pref` — most drivers refuel at a consistent point in the
--    day (end-of-day near camp, or first-thing-in-the-morning, or "when
--    low" purely reactively). Penny's auto fuel planner can bias stop
--    placement toward that preference instead of plonking stops on
--    centerline math alone.
--
--    Enum values: 'start_of_day' | 'when_low' | 'end_of_day'. NULL means
--    no preference and the planner uses the existing centerline math.

ALTER TABLE "vehicles" ADD COLUMN IF NOT EXISTS "real_world_kmpl" double precision;--> statement-breakpoint
ALTER TABLE "vehicles" ADD COLUMN IF NOT EXISTS "fuel_timing_pref" text;
