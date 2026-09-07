-- The driver's preferred driving day, in hours — the onboarding "how long do
-- you want to drive each day?" answer (2026-09-04).
--
-- Nullable on purpose: every trip planned before this column existed, and
-- every driver who skipped the question, falls through to the flat
-- DEFAULT_MAX_DRIVE_HOURS_PER_DAY (8) that has capped every day since travel
-- style was removed. Read by Penny's context and by get_route's day splitting;
-- the leg validators keep the 8h ceiling as the hard limit regardless.
ALTER TABLE "trips" ADD COLUMN "daily_drive_hours" integer;
