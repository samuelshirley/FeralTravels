-- Replace the expression unique index from 0005 (user_id, lower(trim(name))) with a
-- STORED generated column + plain index. drizzle-kit push introspection returns null
-- for expression index members and crashes with _ZodError — drizzle.orm#3062.
--
-- Behavior is identical: uniqueness on case-insensitive trimmed name per user.

ALTER TABLE trips
  ADD COLUMN IF NOT EXISTS trip_name_ci_key text
  GENERATED ALWAYS AS (lower(trim(name))) STORED;

DROP INDEX IF EXISTS trips_user_name_unique_idx;

CREATE UNIQUE INDEX IF NOT EXISTS trips_user_name_unique_idx
  ON trips (user_id, trip_name_ci_key);
