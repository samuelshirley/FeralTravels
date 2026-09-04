-- Every `timestamp` column becomes `timestamptz`.
--
-- WHY. Postgres stores a `timestamp` (no zone) as a bare wall-clock reading
-- with no offset attached, and drizzle reads one back as if it were UTC. Those
-- two agree only when the database itself runs in UTC. Neon does, so
-- production and CI have always been correct and this is invisible there —
-- which is exactly what made it dangerous: the defect only appears somewhere
-- nobody was looking.
--
-- THE CONFIRMED CASE, found 2026-09-01 by pointing a local non-UTC cluster at
-- the app: `email_otp_codes.created_at` made `getExistingOtpAgeMs` return a
-- NEGATIVE age, so the 60-second resend cooldown never expired and EVERY
-- resend was a 429, forever. A user who never received their sign-in email
-- could never ask for another one. Nothing about that reads as a timezone bug
-- from the outside.
--
-- The expiry columns are the same shape and worse: `email_otp_codes.expires`
-- decides whether a sign-in code is still valid and `sessions.expires` decides
-- whether you are signed in at all. On a non-UTC database both are wrong by
-- the server's offset.
--
-- `USING <col> AT TIME ZONE 'UTC'` IS LOAD-BEARING. Without it Postgres
-- converts using the SESSION's TimeZone, so the same migration would mean
-- different things on different connections — reintroducing, at migration
-- time, precisely the ambient-zone dependency this removes. Every existing row
-- was written by a UTC server, so UTC is the correct interpretation, stated
-- explicitly rather than inherited.
--
-- SAFETY. This rewrites each table and briefly takes an ACCESS EXCLUSIVE lock.
-- The tables are small and the values do not move on a UTC database, so on
-- Neon this is a type relabel with identical contents. It is NOT additive, so
-- unlike the usual add/backfill/switch it cannot be half-applied: each
-- statement either converts its column or fails.
--
-- `users.emailVerified` is quoted because the NextAuth adapter created it
-- camelCase.

ALTER TABLE "announcement_dismissals" ALTER COLUMN "dismissed_at" TYPE timestamptz USING "dismissed_at" AT TIME ZONE 'UTC';
ALTER TABLE "announcements" ALTER COLUMN "created_at" TYPE timestamptz USING "created_at" AT TIME ZONE 'UTC';
ALTER TABLE "chat_history" ALTER COLUMN "created_at" TYPE timestamptz USING "created_at" AT TIME ZONE 'UTC';
ALTER TABLE "deleted_users" ALTER COLUMN "account_created_at" TYPE timestamptz USING "account_created_at" AT TIME ZONE 'UTC';
ALTER TABLE "deleted_users" ALTER COLUMN "deleted_at" TYPE timestamptz USING "deleted_at" AT TIME ZONE 'UTC';
ALTER TABLE "email_otp_codes" ALTER COLUMN "created_at" TYPE timestamptz USING "created_at" AT TIME ZONE 'UTC';
ALTER TABLE "email_otp_codes" ALTER COLUMN "expires" TYPE timestamptz USING "expires" AT TIME ZONE 'UTC';
ALTER TABLE "legs" ALTER COLUMN "created_at" TYPE timestamptz USING "created_at" AT TIME ZONE 'UTC';
ALTER TABLE "legs" ALTER COLUMN "fuel_stops_updated_at" TYPE timestamptz USING "fuel_stops_updated_at" AT TIME ZONE 'UTC';
ALTER TABLE "legs" ALTER COLUMN "updated_at" TYPE timestamptz USING "updated_at" AT TIME ZONE 'UTC';
ALTER TABLE "oauth_token_uses" ALTER COLUMN "expires" TYPE timestamptz USING "expires" AT TIME ZONE 'UTC';
ALTER TABLE "oauth_token_uses" ALTER COLUMN "used_at" TYPE timestamptz USING "used_at" AT TIME ZONE 'UTC';
ALTER TABLE "penny_turns" ALTER COLUMN "created_at" TYPE timestamptz USING "created_at" AT TIME ZONE 'UTC';
ALTER TABLE "penny_turns" ALTER COLUMN "updated_at" TYPE timestamptz USING "updated_at" AT TIME ZONE 'UTC';
ALTER TABLE "pois" ALTER COLUMN "last_verified" TYPE timestamptz USING "last_verified" AT TIME ZONE 'UTC';
ALTER TABLE "promo_codes" ALTER COLUMN "created_at" TYPE timestamptz USING "created_at" AT TIME ZONE 'UTC';
ALTER TABLE "promo_codes" ALTER COLUMN "expires_at" TYPE timestamptz USING "expires_at" AT TIME ZONE 'UTC';
ALTER TABLE "promo_codes" ALTER COLUMN "redeemed_at" TYPE timestamptz USING "redeemed_at" AT TIME ZONE 'UTC';
ALTER TABLE "sessions" ALTER COLUMN "expires" TYPE timestamptz USING "expires" AT TIME ZONE 'UTC';
ALTER TABLE "stops" ALTER COLUMN "created_at" TYPE timestamptz USING "created_at" AT TIME ZONE 'UTC';
ALTER TABLE "stops" ALTER COLUMN "updated_at" TYPE timestamptz USING "updated_at" AT TIME ZONE 'UTC';
ALTER TABLE "subscription_events" ALTER COLUMN "received_at" TYPE timestamptz USING "received_at" AT TIME ZONE 'UTC';
ALTER TABLE "subscriptions" ALTER COLUMN "created_at" TYPE timestamptz USING "created_at" AT TIME ZONE 'UTC';
ALTER TABLE "subscriptions" ALTER COLUMN "current_period_end" TYPE timestamptz USING "current_period_end" AT TIME ZONE 'UTC';
ALTER TABLE "subscriptions" ALTER COLUMN "revoked_at" TYPE timestamptz USING "revoked_at" AT TIME ZONE 'UTC';
ALTER TABLE "subscriptions" ALTER COLUMN "updated_at" TYPE timestamptz USING "updated_at" AT TIME ZONE 'UTC';
ALTER TABLE "tasks" ALTER COLUMN "created_at" TYPE timestamptz USING "created_at" AT TIME ZONE 'UTC';
ALTER TABLE "tasks" ALTER COLUMN "due_at" TYPE timestamptz USING "due_at" AT TIME ZONE 'UTC';
ALTER TABLE "tasks" ALTER COLUMN "updated_at" TYPE timestamptz USING "updated_at" AT TIME ZONE 'UTC';
ALTER TABLE "trips" ALTER COLUMN "created_at" TYPE timestamptz USING "created_at" AT TIME ZONE 'UTC';
ALTER TABLE "trips" ALTER COLUMN "declared_range_at" TYPE timestamptz USING "declared_range_at" AT TIME ZONE 'UTC';
ALTER TABLE "trips" ALTER COLUMN "position_updated_at" TYPE timestamptz USING "position_updated_at" AT TIME ZONE 'UTC';
ALTER TABLE "trips" ALTER COLUMN "progress_updated_at" TYPE timestamptz USING "progress_updated_at" AT TIME ZONE 'UTC';
ALTER TABLE "trips" ALTER COLUMN "updated_at" TYPE timestamptz USING "updated_at" AT TIME ZONE 'UTC';
ALTER TABLE "usage_alerts" ALTER COLUMN "fired_at" TYPE timestamptz USING "fired_at" AT TIME ZONE 'UTC';
ALTER TABLE "usage_events" ALTER COLUMN "created_at" TYPE timestamptz USING "created_at" AT TIME ZONE 'UTC';
ALTER TABLE "user_viewport_time" ALTER COLUMN "updated_at" TYPE timestamptz USING "updated_at" AT TIME ZONE 'UTC';
ALTER TABLE "users" ALTER COLUMN "created_at" TYPE timestamptz USING "created_at" AT TIME ZONE 'UTC';
ALTER TABLE "users" ALTER COLUMN "emailVerified" TYPE timestamptz USING "emailVerified" AT TIME ZONE 'UTC';
ALTER TABLE "users" ALTER COLUMN "onboarding_completed_at" TYPE timestamptz USING "onboarding_completed_at" AT TIME ZONE 'UTC';
ALTER TABLE "vehicles" ALTER COLUMN "created_at" TYPE timestamptz USING "created_at" AT TIME ZONE 'UTC';
ALTER TABLE "vehicles" ALTER COLUMN "updated_at" TYPE timestamptz USING "updated_at" AT TIME ZONE 'UTC';
ALTER TABLE "verificationTokens" ALTER COLUMN "expires" TYPE timestamptz USING "expires" AT TIME ZONE 'UTC';
