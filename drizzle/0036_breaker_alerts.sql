-- Circuit-breaker alert de-duplication.
--
-- One row per (breaker, level). The claim is an upsert guarded on `fired_at`
-- being older than the breaker's cooldown, so a breaker that opens, closes and
-- opens again is reported each time, while a breaker that stays open for an
-- hour is reported once.
CREATE TABLE IF NOT EXISTS "breaker_alerts" (
  "breaker" text NOT NULL,
  "level" text NOT NULL,
  "value_at_firing" bigint,
  "fired_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "breaker_alerts_breaker_level_pk" PRIMARY KEY("breaker","level")
);
