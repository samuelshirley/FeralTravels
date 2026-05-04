-- Enforce that trip names are unique per user, case-insensitive and ignoring
-- surrounding whitespace. The application layer in
-- src/server/repos/trips.ts (assertTripNameAvailable) checks the same rule
-- so the user gets a friendly 409 error message; this index is the
-- race-condition backstop in case two requests slip past the app check.
--
-- Match rule: lower(trim(name)) — so "Yellowstone", "yellowstone", and
-- "Yellowstone " all collide.
--
-- Templates note: templates have a user_id (the admin who created them) so
-- this constraint applies only within that user's own trips. Two different
-- users can independently have a "Pacific Coast" trip with no conflict.
--
-- Cloning note: cloneTrip() probes for an available "(copy)" / "(copy N)"
-- suffix before inserting, so cloning the same template multiple times
-- still works — see src/server/repos/trips.ts.
--
-- If this CREATE INDEX fails on existing data, you have duplicate trip
-- names today. Find them with:
--   SELECT user_id, lower(trim(name)) AS norm, count(*)
--   FROM trips
--   GROUP BY 1, 2
--   HAVING count(*) > 1;
-- and rename the offenders manually before re-running this migration.

CREATE UNIQUE INDEX IF NOT EXISTS "trips_user_name_unique_idx"
  ON "trips" ("user_id", lower(trim("name")));
