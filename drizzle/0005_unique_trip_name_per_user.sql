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

-- Step 1: deduplicate any existing rows that would violate the new index.
-- For each (user_id, lower(trim(name))) group with more than one row, keep
-- the oldest (lowest id) untouched and rename the rest with " (2)", " (3)"
-- suffixes. We probe for an available suffix in case the user already has a
-- trip named "Foo (2)" — in that case we skip ahead until we find a free one.
-- RAISE NOTICE so the migration log shows exactly what got renamed.
DO $$
DECLARE
  dup RECORD;
  candidate TEXT;
  suffix INT;
BEGIN
  FOR dup IN
    SELECT id, user_id, name,
           ROW_NUMBER() OVER (PARTITION BY user_id, lower(trim(name)) ORDER BY id) AS rn
      FROM trips
  LOOP
    IF dup.rn > 1 THEN
      suffix := dup.rn;
      candidate := dup.name || ' (' || suffix || ')';
      WHILE EXISTS (
        SELECT 1 FROM trips
         WHERE user_id = dup.user_id
           AND lower(trim(name)) = lower(trim(candidate))
           AND id <> dup.id
      ) LOOP
        suffix := suffix + 1;
        candidate := dup.name || ' (' || suffix || ')';
      END LOOP;
      UPDATE trips SET name = candidate WHERE id = dup.id;
      RAISE NOTICE 'Renamed duplicate trip id=% from "%" to "%"', dup.id, dup.name, candidate;
    END IF;
  END LOOP;
END $$;
--> statement-breakpoint

-- Step 2: enforce the constraint going forward.
CREATE UNIQUE INDEX IF NOT EXISTS "trips_user_name_unique_idx"
  ON "trips" ("user_id", lower(trim("name")));
