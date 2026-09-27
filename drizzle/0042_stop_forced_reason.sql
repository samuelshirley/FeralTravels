-- Why Finn forced a fuel stop, as data: `{"kind":"next_fuel_far","gap_km":412}`.
--
-- The reason used to exist only as English in `notes` ("Top up here — next fuel
-- is 412 km away."), which no screen rendered and which could only ever say
-- km. Structured, each client words it in the driver's units.
--
-- NULL on every stop that was not forced, and on every row written before this
-- migration: those are not parsed out of `notes`, they pick the value up when
-- their leg is next re-sourced. Additive; either order of deploy is safe.
ALTER TABLE "stops" ADD COLUMN IF NOT EXISTS "forced_reason" jsonb;
