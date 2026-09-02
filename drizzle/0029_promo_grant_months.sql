-- Promo codes get a fixed term instead of unlimited access.
--
-- `promo_codes` is EMPTY in production (verified read-only before writing this:
-- 0 total, 0 unredeemed, 0 redeemed), so there is nothing to backfill and no
-- judgement call about what an existing unredeemed code becomes.
--
-- The DEFAULT is still here, and then dropped, because "empty in prod" is not
-- "empty everywhere": local developer databases and any branch created before
-- this migration may hold rows, and `ADD COLUMN ... NOT NULL` without a default
-- fails outright on a non-empty table. 12 is the safe answer for such a row —
-- the more generous of the two options, on the principle that a code somebody
-- was already promised should not silently shrink.
--
-- Dropping the default afterwards is the point of the second statement: with it
-- left in place, an INSERT that forgot `grant_months` would silently mint a
-- twelve-month gift. Every real insert goes through `createPromoCode`, which
-- always supplies it.
ALTER TABLE "promo_codes" ADD COLUMN "grant_months" integer NOT NULL DEFAULT 12;
ALTER TABLE "promo_codes" ALTER COLUMN "grant_months" DROP DEFAULT;
