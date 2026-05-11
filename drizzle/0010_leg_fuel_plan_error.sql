-- Last auto fuel-plan failure (cleared on computing / ready / none).
ALTER TABLE "legs" ADD COLUMN IF NOT EXISTS "fuel_plan_error" text;
