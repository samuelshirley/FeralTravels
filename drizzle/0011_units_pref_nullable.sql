-- Allow NULL = user has not completed the units onboarding step yet.
-- Persisted 'metric' | 'imperial' means explicit choice (skip units_pick on new trips).
ALTER TABLE "users" ALTER COLUMN "units_pref" DROP DEFAULT;
ALTER TABLE "users" ALTER COLUMN "units_pref" DROP NOT NULL;
