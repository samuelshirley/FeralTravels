-- Make `trips.trip_name_ci_key` the generated `lower(trim(name))` column the
-- baseline always said it was, so trips_user_name_unique_idx blocks duplicate
-- trip names per user.
--
-- Production was bootstrapped with `drizzle-kit push` from a schema.ts that
-- declared the column as plain `text`, never generated. Nothing writes it, so
-- on prod it holds only NULLs; Postgres treats NULLs as distinct, so the unique
-- index never fired and the repo's name checks (which look up by the key)
-- never found a match. 'Baja' and 'baja ' both inserted for one user.
--
-- Postgres cannot ALTER a plain column into a generated one, so this drops and
-- re-adds it. The column holds only NULLs, so dropping it loses nothing, and
-- the IF EXISTS guards make it run from either starting state (plain or
-- already generated).
--
-- Existing duplicates are renamed first, or CREATE UNIQUE INDEX would fail and
-- block the deploy: the oldest trip keeps its name, later ones get ' 2', ' 3'…
-- (the findAvailableTripName style), skipping any name already taken.
DO $$
DECLARE r record; n int; candidate text;
BEGIN
  FOR r IN
    SELECT id, user_id, name FROM (
      SELECT id, user_id, name,
             row_number() OVER (PARTITION BY user_id, lower(trim(name)) ORDER BY created_at, id) AS rn
      FROM trips) d
    WHERE rn > 1
  LOOP
    n := 2;
    LOOP
      candidate := trim(r.name) || ' ' || n;
      EXIT WHEN NOT EXISTS (SELECT 1 FROM trips WHERE user_id = r.user_id AND lower(trim(name)) = lower(candidate));
      n := n + 1;
    END LOOP;
    UPDATE trips SET name = candidate WHERE id = r.id;
  END LOOP;
END $$;--> statement-breakpoint
DROP INDEX IF EXISTS "trips_user_name_unique_idx";--> statement-breakpoint
ALTER TABLE "trips" DROP COLUMN IF EXISTS "trip_name_ci_key";--> statement-breakpoint
ALTER TABLE "trips" ADD COLUMN "trip_name_ci_key" text GENERATED ALWAYS AS (lower(trim("name"))) STORED;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "trips_user_name_unique_idx" ON "trips" USING btree ("user_id","trip_name_ci_key");
