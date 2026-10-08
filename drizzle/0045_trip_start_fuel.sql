-- The tank a trip starts on: the onboarding `start_fuel` answer.
--
-- 'full' is what Finn has always assumed, so every existing row gets it and
-- nothing about an existing plan changes. 'fill_at_start' makes Finn place a
-- fill-up at the first station of the first drive day and plan the rest of the
-- trip from a full tank there. A closed set, enforced by the app (a Zod enum on
-- the onboarding answer, `StartFuel` in src/types/trip.ts), like the other
-- text-enum columns here. Additive; either order of deploy is safe.
ALTER TABLE "trips" ADD COLUMN IF NOT EXISTS "start_fuel" text DEFAULT 'full' NOT NULL;
