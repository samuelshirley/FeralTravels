-- Per-account strike state for the message gate.
--
-- Three junk messages in a row pause Penny for that account for an hour. Both
-- columns are additive and default to the "never struck" state, so the code
-- half can deploy before or after this without a window where either is wrong.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "penny_strikes" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "penny_locked_until" timestamp with time zone;
