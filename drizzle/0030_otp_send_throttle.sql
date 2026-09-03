-- Per-address send throttle for sign-in codes.
--
-- Replaces the old cooldown, which was inferred from the age of the pending
-- row in `email_otp_codes`. That was resettable: `verify_otp_code` deletes
-- that row on success, on expiry, and once five wrong guesses are burned, so
-- five cheap POSTs of a wrong code cleared the rate limit on an endpoint that
-- sends real email to any address a stranger types. The counter has to outlive
-- the code it is throttling, which means its own table.
--
-- New table only: nothing to backfill, and an empty throttle table is exactly
-- the correct starting state (every address on its first rung). Safe to apply
-- ahead of the code — the app simply keeps using the old cooldown until the
-- new code ships, and it is safe behind the code too, which is the direction
-- that actually matters.
CREATE TABLE IF NOT EXISTS "otp_send_throttle" (
	"email" text PRIMARY KEY NOT NULL,
	"sends" integer DEFAULT 0 NOT NULL,
	"window_started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_sent_at" timestamp with time zone DEFAULT now() NOT NULL
);
