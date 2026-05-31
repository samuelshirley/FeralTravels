-- Backfill must run BEFORE the NOT NULL constraint, or the ALTER fails on any
-- existing trip that never had a parsed start date. Use the trip's own creation
-- date as the placeholder (closest honest stand-in for "when it was meant to
-- start"); the user can correct it, and new trips are forced through the
-- onboarding date question anyway.
UPDATE "trips" SET "start_date_parsed" = "created_at"::date WHERE "start_date_parsed" IS NULL;--> statement-breakpoint
ALTER TABLE "trips" ALTER COLUMN "start_date_parsed" SET DEFAULT CURRENT_DATE;--> statement-breakpoint
ALTER TABLE "trips" ALTER COLUMN "start_date_parsed" SET NOT NULL;
